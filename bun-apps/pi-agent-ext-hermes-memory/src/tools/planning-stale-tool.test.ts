// src/tools/planning-stale-tool.test.ts — T6 unit tests for the `planning_stale`
// tool's pure resolvers (parseStaleQuery / runStaleQuery / revalidateCard).
//
// Path B (decision η): a card's deps are re-parsed from the git-canonical source
// .md via readSourceCard — NOT from store.getCard().graph.relations (the 06a store
// does NOT persist card.graph). So each test writes a REAL source .md ticket (with
// a `depends_on:` frontmatter dep + a `cites <path>` body line) under a temp
// fsRoot, mirroring the T4 planning-staleness.test.ts `seedSource`/`writeDep`
// idiom — NOT the plan's verbatim "upsertCard(card with graph.relations)" seed,
// which would read null from readSourceCard and never flag stale (see the T6
// brief's pre-implementation adjustment #1).
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseStaleQuery, runStaleQuery, revalidateCard } from "./planning-stale-tool.js";
import { createCardStore } from "../store/card-store.js";
import { computeStaleness } from "../store/planning-staleness.js";

/** Write a dep file under root (creating its parent dir). Mirrors T4's writeDep. */
function writeDep(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Write a source .md ticket that cites `citesPath` in the body + declares
 *  `depends_on: <depPath>` in frontmatter, plus writes BOTH dep files (v1).
 *  Returns the ticket card id `planning-ticket:<effort>:01`. Mirrors T4's
 *  seedSource — the deserialized card carries a `cites` + a `depends_on` relation
 *  so citedDeps = [citesPath, depPath]. */
function seedSource(root: string, effort: string, citesPath: string, depPath: string): string {
  const ticketPath = join(root, ".planning", effort, "tickets", "01-stale-ticket.md");
  mkdirSync(dirname(ticketPath), { recursive: true });
  writeFileSync(
    ticketPath,
    `---\ntype: task\nstatus: closed\ndepends_on: ${depPath}\n---\n# 01 — stale-ticket\n\n## Resolution\n\nThis decision cites ${citesPath} in the body.\n`,
  );
  writeDep(root, citesPath, "v1");
  writeDep(root, depPath, "v1");
  return `planning-ticket:${effort}:01`;
}

/** Seed a ticket into the store at `mem`: write the source .md + dep files, upsert
 *  the ticket ROW (id only — the row needs NO graph; getStaleCards enumerates via
 *  getCardsByKind), and seed the dep baseline via computeStaleness (first touch). */
async function seedTicket(
  root: string,
  mem: string,
  effort: string,
  citesPath: string,
  depPath: string,
): Promise<string> {
  const id = seedSource(root, effort, citesPath, depPath);
  const store = await createCardStore({ memoryDir: mem });
  try {
    await store.upsertCard({
      id,
      kind: "planning-ticket",
      content: "",
      frontmatter: { id: "01" },
    });
    await computeStaleness(store, id, root); // seed baseline @ v1
  } finally {
    await store.close();
  }
  return id;
}

describe("parseStaleQuery", () => {
  it("'stale' -> unscoped", () => assert.deepEqual(parseStaleQuery("stale"), {}));
  it("'stale:<effort>' -> scoped", () =>
    assert.deepEqual(parseStaleQuery("stale:my-effort"), { effort: "my-effort" }));
  it("unknown prefix -> lenient unscoped", () => assert.deepEqual(parseStaleQuery("anything"), {}));
  it("empty -> unscoped", () => assert.deepEqual(parseStaleQuery(""), {}));
  it("nullish -> unscoped (lenient)", () => assert.deepEqual(parseStaleQuery(undefined as unknown as string), {}));
});

describe("runStaleQuery (10-impl T6)", () => {
  it("query (no effort) returns only stale cards; clean excluded; empty effort -> []", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-root-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-mem-"));
    try {
      const staleId = await seedTicket(root, mem, "q-eff", "src/stale-a.ts", "src/stale-b.ts");
      const cleanId = await seedTicket(root, mem, "clean-eff", "src/clean-a.ts", "src/clean-b.ts");
      // drift ONLY the q-eff cited dep (clean-eff stays at v1).
      writeFileSync(join(root, "src", "stale-a.ts"), "v2-EDITED");

      const all = await runStaleQuery(mem, "stale", root);
      assert.equal(all.ok, true);
      assert.ok(all.stale.some((s) => s.cardId === staleId), "stale card surfaced");
      assert.ok(!all.stale.some((s) => s.cardId === cleanId), "clean card excluded");

      // scoped to an effort with no tickets -> []
      const scoped = await runStaleQuery(mem, "stale:nope-eff", root);
      assert.equal(scoped.ok, true);
      assert.deepEqual(scoped.stale, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("'stale:<effort>' returns only that effort's stale cards", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-scope-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-scope-mem-"));
    try {
      const effOne = await seedTicket(root, mem, "eff-one", "src/o-a.ts", "src/o-b.ts");
      const effTwo = await seedTicket(root, mem, "eff-two", "src/t-a.ts", "src/t-b.ts");
      // drift BOTH — only the scoped one should surface for "stale:eff-one".
      writeFileSync(join(root, "src", "o-a.ts"), "v2-EDITED");
      writeFileSync(join(root, "src", "t-a.ts"), "v2-EDITED");

      const scoped = await runStaleQuery(mem, "stale:eff-one", root);
      assert.equal(scoped.ok, true);
      assert.equal(scoped.stale.length, 1, "only eff-one's stale card");
      assert.equal(scoped.stale[0]!.cardId, effOne);
      assert.equal(scoped.stale[0]!.effort, "eff-one");

      const scopedTwo = await runStaleQuery(mem, "stale:eff-two", root);
      assert.equal(scopedTwo.stale.length, 1);
      assert.equal(scopedTwo.stale[0]!.cardId, effTwo);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("a vanishing dep surfaces missingDeps on the StaleCard", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-miss-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-miss-mem-"));
    try {
      const id = await seedTicket(root, mem, "miss-eff", "src/gone-a.ts", "src/gone-b.ts");
      rmSync(join(root, "src", "gone-b.ts")); // depends_on dep vanishes

      const r = await runStaleQuery(mem, "stale:miss-eff", root);
      assert.equal(r.ok, true);
      assert.equal(r.stale.length, 1);
      assert.equal(r.stale[0]!.cardId, id);
      assert.deepEqual(r.stale[0]!.missingDeps, ["src/gone-b.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("revalidateCard (10-impl T6)", () => {
  it("on a stale card -> {ok:true, stale:true} AND clears staleness", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-rev-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-rev-mem-"));
    try {
      const id = await seedTicket(root, mem, "rev-eff", "src/r-a.ts", "src/r-b.ts");
      writeFileSync(join(root, "src", "r-a.ts"), "v2-EDITED"); // drift

      // before revalidate the query lists it
      const before = await runStaleQuery(mem, "stale:rev-eff", root);
      assert.equal(before.stale.length, 1);

      const r = await revalidateCard(mem, id, root);
      assert.equal(r.ok, true);
      assert.equal(r.stale, true, "reports it HAD drifted");

      // after revalidate the query no longer lists it (re-baseline cleared the flag)
      const after = await runStaleQuery(mem, "stale:rev-eff", root);
      assert.ok(!after.stale.some((s) => s.cardId === id), "no longer stale after revalidate");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("on a non-stale (current) card -> {ok:true, stale:false}", async () => {
    const root = mkdtempSync(join(tmpdir(), "staleq-cur-"));
    const mem = mkdtempSync(join(tmpdir(), "staleq-cur-mem-"));
    try {
      const id = await seedTicket(root, mem, "cur-eff", "src/c-a.ts", "src/c-b.ts");
      // no drift — baseline is current
      const r = await revalidateCard(mem, id, root);
      assert.equal(r.ok, true);
      assert.equal(r.stale, false, "current card was not stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
