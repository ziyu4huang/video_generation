import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { computeStaleness, getStaleCards } from "./planning-staleness.js";
import { createCardStore } from "./card-store.js";

// Path B (decision η): deps are re-parsed from the git-canonical source .md,
// NOT from store.getCard().graph.relations — the 06a store does NOT persist
// card.graph (card.ts: "round-trips as undefined"; rowToCard emits no graph).
// So each test writes a real .planning ticket .md (+ its cited + depends_on dep
// files) under a temp fsRoot, mirroring refreshPlanningCard's 09-impl test
// setup. computeStaleness reads deps via readSourceCard (NOT the store row), so
// the computeStaleness cases need NO store row. getStaleCards enumerates via
// store.getCardsByKind("planning-ticket") (card.id only) — so a card is
// store.upsertCard'd for THAT case, but its row needs NO graph.

/** Write a dep file under root (creating its parent dir). */
function writeDep(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Write a source .md ticket that cites `citesPath` in the body + declares
 *  `depends_on: <depPath>` in frontmatter, plus writes BOTH dep files (v1).
 *  ticketCard() emits a `cites` + a `depends_on` relation -> citedDeps =
 *  [citesPath, depPath]. Returns the ticket card id. */
function seedSource(root: string, effort: string, citesPath: string, depPath: string): string {
  const ticketPath = join(root, ".planning", effort, "tickets", "01-dep-ticket.md");
  mkdirSync(dirname(ticketPath), { recursive: true });
  writeFileSync(
    ticketPath,
    `---\ntype: task\nstatus: closed\ndepends_on: ${depPath}\n---\n# 01 — dep-ticket\n\n## Resolution\n\nThis decision cites ${citesPath} in the body.\n`,
  );
  writeDep(root, citesPath, "v1");
  writeDep(root, depPath, "v1");
  return `planning-ticket:${effort}:01`;
}

describe("computeStaleness (10-impl T4 — Path B, deps from source .md)", () => {
  it("unresolvable cardId (no source .md) -> {stale:false, missing:[]} + NO baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "stale-noop-"));
    const mem = mkdtempSync(join(tmpdir(), "stale-noop-mem-"));
    try {
      const store = await createCardStore({ memoryDir: mem });
      try {
        const r = await computeStaleness(store, "planning-ticket:nope:99", root);
        assert.equal(r.stale, false);
        assert.deepEqual(r.missing, []);
        assert.equal(
          await store.getCardDepHash("planning-ticket:nope:99"),
          null,
          "no baseline written for an unresolvable source",
        );
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("first touch seeds the baseline + is NOT stale; second unchanged call also NOT stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "stale-seed-"));
    const mem = mkdtempSync(join(tmpdir(), "stale-seed-mem-"));
    try {
      const id = seedSource(root, "seed-eff", "src/a.ts", "src/b.ts");
      const store = await createCardStore({ memoryDir: mem });
      try {
        const r1 = await computeStaleness(store, id, root);
        assert.equal(r1.stale, false);
        assert.deepEqual(r1.missing, []);
        assert.ok(await store.getCardDepHash(id), "baseline seeded on first touch");
        // second call, deps UNCHANGED -> still not stale (compare-only)
        const r2 = await computeStaleness(store, id, root);
        assert.equal(r2.stale, false);
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("a cited dep file CHANGED -> {stale:true} (compare-only, NO rebaseline)", async () => {
    const root = mkdtempSync(join(tmpdir(), "stale-chg-"));
    const mem = mkdtempSync(join(tmpdir(), "stale-chg-mem-"));
    try {
      const id = seedSource(root, "chg-eff", "src/a.ts", "src/b.ts");
      const store = await createCardStore({ memoryDir: mem });
      try {
        await computeStaleness(store, id, root); // seed baseline @ v1
        writeFileSync(join(root, "src", "a.ts"), "v2-EDITED");
        const r = await computeStaleness(store, id, root);
        assert.equal(r.stale, true);
        // NO rebaseline: a second call is STILL stale against the OLD baseline
        // (compare-only — stale stays flagged until the explicit T5 re-validate).
        const r2 = await computeStaleness(store, id, root);
        assert.equal(r2.stale, true, "compare-only — stale stays flagged until explicit re-validate");
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("a depends_on dep file MISSING -> {stale:true, missing:[\"src/b.ts\"]}", async () => {
    const root = mkdtempSync(join(tmpdir(), "stale-miss-"));
    const mem = mkdtempSync(join(tmpdir(), "stale-miss-mem-"));
    try {
      const id = seedSource(root, "miss-eff", "src/a.ts", "src/b.ts");
      const store = await createCardStore({ memoryDir: mem });
      try {
        await computeStaleness(store, id, root); // seed baseline (file present)
        rmSync(join(root, "src", "b.ts"));
        const r = await computeStaleness(store, id, root);
        assert.equal(r.stale, true);
        assert.deepEqual(r.missing, ["src/b.ts"]);
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("getStaleCards (10-impl T4 — Path B)", () => {
  it("clean effort -> []; stale card surfaced w/ effort; filter scopes; missing dep -> missingDeps", async () => {
    const root = mkdtempSync(join(tmpdir(), "stale-multi-"));
    const mem = mkdtempSync(join(tmpdir(), "stale-multi-mem-"));
    try {
      // Two efforts, each with its OWN dep files (so drifting one does NOT
      // affect the other). Enumeration needs the cards in the store (id only —
      // the row needs NO graph; deps come from readSourceCard).
      const cleanId = seedSource(root, "clean-eff", "src/clean-a.ts", "src/clean-b.ts");
      const staleId = seedSource(root, "stale-eff", "src/stale-a.ts", "src/stale-b.ts");
      const store = await createCardStore({ memoryDir: mem });
      try {
        await store.upsertCard({
          id: cleanId,
          kind: "planning-ticket",
          content: "",
          frontmatter: { id: "01" },
        });
        await store.upsertCard({
          id: staleId,
          kind: "planning-ticket",
          content: "",
          frontmatter: { id: "01" },
        });
        await computeStaleness(store, cleanId, root); // seed (clean)
        await computeStaleness(store, staleId, root); // seed (clean)
        // clean effort -> [] (no drift).
        assert.deepEqual(await getStaleCards(store, "clean-eff", root), []);
        // drift the stale-eff cited dep.
        writeFileSync(join(root, "src", "stale-a.ts"), "v2-EDITED");
        const all = await getStaleCards(store, undefined, root);
        assert.equal(all.length, 1, "only the stale-eff card is stale");
        assert.equal(all[0]!.cardId, staleId);
        assert.equal(all[0]!.effort, "stale-eff");
        assert.equal(all[0]!.missingDeps, undefined, "an edit (not a vanishing) -> no missingDeps");
        // effort filter scopes: clean-eff still empty.
        assert.deepEqual(await getStaleCards(store, "clean-eff", root), []);
        // now make a dep VANISH -> missingDeps populated.
        rmSync(join(root, "src", "stale-b.ts"));
        const withMissing = await getStaleCards(store, "stale-eff", root);
        assert.equal(withMissing.length, 1);
        assert.deepEqual(withMissing[0]!.missingDeps, ["src/stale-b.ts"]);
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
