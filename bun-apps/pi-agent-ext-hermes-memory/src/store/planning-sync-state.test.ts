import { after, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  planningContentHash,
  getStoredHash,
  upsertHash,
  deleteHash,
  refreshPlanningCard,
  refreshIfStale,
  refreshStaleness, // 10-impl T5 — sole re-validate (re-baseline) primitive
  citedDeps, // 10-impl T3
  depAggregateHash, // 10-impl T3
  writeValidatedBaseline, // 10-impl T3
} from "./planning-sync-state.js";
import { createCardStore } from "./card-store.js";
import { computeStaleness } from "./planning-staleness.js"; // 10-impl T4 — seed + post-revalidate cleanliness probe
import type { Card } from "./card.js";

const card = (overrides: Partial<Card> = {}): Card => ({
  id: "planning-ticket:e:01",
  kind: "planning-ticket",
  content: "body",
  frontmatter: { id: "01", slug: "x", status: "closed" },
  ...overrides,
});

describe("planningContentHash", () => {
  it("is deterministic for identical content + frontmatter", () => {
    assert.equal(planningContentHash(card()), planningContentHash(card()));
  });
  it("is 16 hex chars (hashEntry width)", () => {
    assert.match(planningContentHash(card()), /^[0-9a-f]{16}$/);
  });
  it("changes when content changes", () => {
    assert.notEqual(planningContentHash(card()), planningContentHash(card({ content: "edited" })));
  });
  it("is invariant to frontmatter key ORDER (stable stringify)", () => {
    const a = card({ frontmatter: { id: "01", slug: "x", status: "closed" } });
    const b = card({ frontmatter: { status: "closed", slug: "x", id: "01" } });
    assert.equal(planningContentHash(a), planningContentHash(b));
  });
  it("changes when a frontmatter VALUE changes", () => {
    assert.notEqual(
      planningContentHash(card()),
      planningContentHash(card({ frontmatter: { id: "01", slug: "x", status: "open" } })),
    );
  });
});

describe("card_md_hash round-trip (via CardStore accessors)", () => {
  const dir = mkdtempSync(join(tmpdir(), "planning-hash-rt-"));
  it("getStoredHash returns null when absent", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      assert.equal(await getStoredHash(store, "planning-ticket:e:01"), null);
    } finally {
      await store.close();
    }
  });
  it("upsertHash then getStoredHash round-trips (default kind='mirror')", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      await upsertHash(store, "planning-ticket:e:01", "abc123def456abcd");
      const got = await getStoredHash(store, "planning-ticket:e:01");
      assert.equal(got?.hash, "abc123def456abcd");
      assert.equal(got?.kind, "mirror");
      assert.ok(got?.mirroredAt);
    } finally {
      await store.close();
    }
  });
  it("upsertHash is idempotent UPSERT (re-write overwrites hash + mirrored_at)", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      await upsertHash(store, "planning-ticket:e:01", "firsthash0000000");
      await upsertHash(store, "planning-ticket:e:01", "secondhash0000000", "mirror");
      const got = await getStoredHash(store, "planning-ticket:e:01");
      assert.equal(got?.hash, "secondhash0000000");
    } finally {
      await store.close();
    }
  });
  it("deleteHash removes the row", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      await deleteHash(store, "planning-ticket:e:01");
      assert.equal(await getStoredHash(store, "planning-ticket:e:01"), null);
    } finally {
      await store.close();
    }
  });
  // Best-effort cleanup AFTER the round-trip suite shares one dir.
  after(() => rmSync(dir, { recursive: true, force: true }));
});

describe("refreshPlanningCard — 08→09 migration cohort (09-impl final review B)", () => {
  it("UPDATEs an existing-but-unhashed card (drift), returning {action:'updated'}", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmig2-B-"));
    const mem = mkdtempSync(join(tmpdir(), "pmig2-B-mem-"));
    try {
      const effort = "mig2-eff";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      const id = `planning-ticket:${effort}:01`;
      // Pre-seed an 08-era row directly: OLD content, NO card_md_hash row
      // (stored===null — true for every existing planning card on first 09
      // touch). existing≠null + stored===null is the migration cohort the
      // existing T7 tests cannot reach (they hit UPDATE only via stored≠null).
      const store0 = await createCardStore({ memoryDir: mem });
      await store0.upsertCard({
        id,
        kind: "planning-ticket",
        content: "OLD 08-era body.",
        frontmatter: { id: "01", slug: "x", status: "closed" },
      });
      await store0.close();
      // Source md has DRIFTED to new (current) content relative to the DB row.
      writeFileSync(
        ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nNEW 09-era body.\n",
      );
      const store = await createCardStore({ memoryDir: mem });
      try {
        const r = await refreshPlanningCard(store, id, root);
        assert.equal(r.action, "updated", "existing-but-unhashed card must UPDATE, not insert-no-op");
        const c = await store.getCard(id);
        assert.match(c?.content ?? "", /NEW 09-era body\./, "DB row updated to current md");
        assert.doesNotMatch(c?.content ?? "", /OLD 08-era body\./, "08-era content must be overwritten");
        const hash = await store.getCardMdHash(id);
        assert.ok(hash, "hash seeded on first 09 touch");
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("refreshPlanningCard (09-impl T7)", () => {
  const root = mkdtempSync(join(tmpdir(), "prefresh-"));
  const mem = mkdtempSync(join(tmpdir(), "prefresh-mem-"));
  const effort = "refresh-eff";
  const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
  const id = `planning-ticket:${effort}:01`;

  it("inserts when no stored card exists", async () => {
    mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
    writeFileSync(ticketPath, "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nFirst.\n");
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "inserted");
    } finally {
      await store.close();
    }
  });

  it("updates when the source md changed (drift)", async () => {
    writeFileSync(ticketPath, "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nEDITED.\n");
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "updated");
      const c = await store.getCard(id);
      assert.match(c?.content ?? "", /EDITED\./);
    } finally {
      await store.close();
    }
  });

  it("is unchanged (no write) when the source md is the same", async () => {
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "unchanged");
      assert.equal(await refreshIfStale(store, id, root), false);
    } finally {
      await store.close();
    }
  });

  it("returns {action:'absent'} when the source md vanished (caller may delete)", async () => {
    rmSync(ticketPath);
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal((r as { action: string }).action, "absent");
    } finally {
      await store.close();
    }
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(mem, { recursive: true, force: true });
  });
});

describe("dep aggregate hash (10-impl T3)", () => {
  const root = mkdtempSync(join(tmpdir(), "dephash-"));
  const mem = mkdtempSync(join(tmpdir(), "dephash-mem-"));
  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(mem, { recursive: true, force: true });
  });

  // A card with two cited deps (one under src/, one under docs/) + a depends_on.
  const mkCard = (extraCites: string[] = []): Card => ({
    id: "planning-ticket:dep-eff:01",
    kind: "planning-ticket",
    content: "body",
    frontmatter: { id: "01", slug: "x", status: "closed" },
    graph: {
      relations: [
        { s: "planning-ticket:dep-eff:01", rel: "cites", o: "src/a.ts" },
        { s: "planning-ticket:dep-eff:01", rel: "cites", o: "docs/b.md" },
        { s: "planning-ticket:dep-eff:01", rel: "depends_on", o: "src/c.ts" },
        ...extraCites.map((o) => ({ s: "planning-ticket:dep-eff:01", rel: "cites" as const, o })),
      ],
    },
  });

  it("citedDeps returns distinct cites+depends_on paths (first-occurrence order)", () => {
    assert.deepEqual(citedDeps(mkCard()), ["src/a.ts", "docs/b.md", "src/c.ts"]);
    // duplicate path under cites + depends_on collapses to one.
    assert.deepEqual(citedDeps(mkCard(["src/a.ts"])), ["src/a.ts", "docs/b.md", "src/c.ts"]);
  });

  it("depAggregateHash is deterministic over sorted deps", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "AAA");
    writeFileSync(join(root, "docs", "b.md"), "BBB");
    writeFileSync(join(root, "src", "c.ts"), "CCC");
    const h1 = await depAggregateHash(mkCard(), root);
    const h2 = await depAggregateHash(mkCard(), root);
    assert.equal(h1.hash, h2.hash);
    assert.match(h1.hash, /^[0-9a-f]{16}$/);
    assert.deepEqual(h1.missing, []);
  });

  it("a changed dep file -> different aggregate", async () => {
    const before = await depAggregateHash(mkCard(), root);
    writeFileSync(join(root, "src", "a.ts"), "AAA-EDITED");
    const after = await depAggregateHash(mkCard(), root);
    assert.notEqual(before.hash, after.hash);
  });

  it("a missing dep -> missing[] non-empty + aggregate reflects <missing>", async () => {
    const r = await depAggregateHash(mkCard(), root); // src/c.ts still exists
    assert.deepEqual(r.missing, []);
    writeFileSync(join(root, "src", "gone.ts"), "G");
    const card = { ...mkCard(), graph: { relations: [{ s: "x", rel: "depends_on", o: "src/gone.ts" }] } };
    const presentHash = (await depAggregateHash(card, root)).hash;
    rmSync(join(root, "src", "gone.ts"));
    const r2 = await depAggregateHash(card, root);
    assert.deepEqual(r2.missing, ["src/gone.ts"]);
    assert.notEqual(presentHash, r2.hash); // <missing> token changes the aggregate
  });

  it("writeValidatedBaseline writes via upsertCardDepHash (card_dep_hash, kind-less)", async () => {
    const store = await createCardStore({ memoryDir: mem });
    try {
      const card = mkCard();
      const { hash, missing } = await writeValidatedBaseline(store, card, root);
      assert.deepEqual(missing, []);
      const row = await store.getCardDepHash(card.id);
      assert.equal(row?.depHash, hash);
      assert.ok(row?.validatedAt);
    } finally {
      await store.close();
    }
  });
});

// 10-impl T5 — the SOLE re-baseline op (the agent re-grill flow / T6
// `planning_stale` revalidate action). Mirrors refreshIfStale's boolean envelope:
// reports whether the dep HAD drifted relative to the OLD baseline AND re-baselines
// to CURRENT bytes (clearing the flag). Path B (η): deps come from readSourceCard
// (a re-parse of the source .md -> graph.relations), NOT store.getCard (row drops
// graph). Per-case temp dirs (no cross-test baseline pollution).
describe("refreshStaleness (10-impl T5 — sole re-validate primitive)", () => {
  /** Write a ticket source .md (depends_on: src/d.ts) + the dep file at `v`. */
  const seedTicket = (root: string, effort: string, depContent: string): string => {
    mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
    writeFileSync(
      join(root, ".planning", effort, "tickets", "01-x.md"),
      "---\ntype: task\nstatus: closed\ndepends_on: src/d.ts\n---\n# 01 — x\n\n## Resolution\n\nDepends on src/d.ts.\n",
    );
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "d.ts"), depContent);
    return `planning-ticket:${effort}:01`;
  };

  it("reports stale=true + clears the flag when the dep had drifted (re-baseline to current)", async () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-drift-"));
    const mem = mkdtempSync(join(tmpdir(), "refresh-drift-mem-"));
    try {
      const id = seedTicket(root, "drift-eff", "v1");
      const store = await createCardStore({ memoryDir: mem });
      try {
        // Seed the baseline @ v1 (first-touch computeStaleness seeds, NOT stale).
        assert.equal((await computeStaleness(store, id, root)).stale, false);
        // Drift the dep AFTER the baseline is seeded.
        writeFileSync(join(root, "src", "d.ts"), "v2-EDITED");
        assert.equal((await computeStaleness(store, id, root)).stale, true, "precondition: dep change flags stale");
        // Re-validate: reports it HAD drifted + re-baselines to current (clears).
        const wasStale = await refreshStaleness(store, id, root);
        assert.equal(wasStale, true, "reports it HAD drifted relative to the old baseline");
        // ...and the re-baseline cleared the flag against current bytes:
        assert.equal(
          (await computeStaleness(store, id, root)).stale,
          false,
          "re-validate clears the flag against current bytes",
        );
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("reports stale=false + leaves the baseline value unchanged when the dep is current", async () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-clean-"));
    const mem = mkdtempSync(join(tmpdir(), "refresh-clean-mem-"));
    try {
      const id = seedTicket(root, "clean-eff", "v1");
      const store = await createCardStore({ memoryDir: mem });
      try {
        // Seed baseline @ v1.
        await computeStaleness(store, id, root);
        const before = await store.getCardDepHash(id);
        assert.ok(before, "precondition: baseline seeded");
        // Re-validate WITHOUT changing the dep -> false + baseline value unchanged
        // (writeValidatedBaseline is an idempotent UPSERT of the same hash).
        const wasStale = await refreshStaleness(store, id, root);
        assert.equal(wasStale, false, "no drift -> false");
        const after = await store.getCardDepHash(id);
        assert.equal(after?.depHash, before?.depHash, "baseline depHash value unchanged (idempotent re-write)");
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("returns false + writes NO baseline for an unresolvable source", async () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-absent-"));
    const mem = mkdtempSync(join(tmpdir(), "refresh-absent-mem-"));
    try {
      const store = await createCardStore({ memoryDir: mem });
      try {
        const wasStale = await refreshStaleness(store, "planning-ticket:nope:99", root);
        assert.equal(wasStale, false);
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
});
