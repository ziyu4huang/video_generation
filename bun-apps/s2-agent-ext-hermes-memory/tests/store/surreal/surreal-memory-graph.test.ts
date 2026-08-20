/**
 * SurrealDB-specific graph-edge behavior not covered by the shared contract:
 *   - bulk-remove must clean orphan `tagged` edges (deferred spec item B)
 *   - backfillGraphEdges must rebuild edges for pre-feature rows (deferred item A)
 *
 * Runs only when the local SurrealDB service is up (localDescribe). Each test
 * gets a throwaway namespace so concurrent runs never collide.
 */
import { describe, it, expect } from "bun:test";
import { isSurrealUp, localDescribe, uniqueNs } from "./_helpers.js";
import { SurrealBackend } from "../../../src/store/surreal/surreal-backend.js";
import { SurrealMemoryRepository } from "../../../src/store/surreal/surreal-memory-repo.js";
import { createBackendBundle } from "../../../src/store/backend-factory.js";
import type { MemoryConfig } from "../../../src/types.js";

const up = await isSurrealUp();

localDescribe("SurrealMemoryRepository graph edges", up, () => {
  let backend: SurrealBackend;
  let repo: SurrealMemoryRepository;
  let ns = "";

  async function freshRepo(): Promise<void> {
    ns = uniqueNs();
    backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    repo = new SurrealMemoryRepository(backend);
  }
  async function cleanup(): Promise<void> {
    try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch { /* best-effort */ }
    await backend.close();
  }

  /** Count of `tagged` edges whose source (`in`) is a given memory seq. */
  async function taggedEdgeCount(seq: number): Promise<number> {
    const rows = await backend.client.query<Array<{ c: number }>>(
      `SELECT count() AS c FROM tagged WHERE in = type::record("memories", $seq) GROUP ALL;`,
      { seq },
    );
    return rows[0]?.c ?? 0;
  }
  /** Total `tagged` edge rows in the namespace. */
  async function totalTaggedEdges(): Promise<number> {
    const rows = await backend.client.query<Array<{ c: number }>>(`SELECT count() AS c FROM tagged GROUP ALL;`);
    return rows[0]?.c ?? 0;
  }

  describe("bulk-remove edge cleanup", () => {
    it("removes tagged edges for memories removed via removeSyncedMemories", async () => {
      await freshRepo();
      try {
        const a = (await repo.syncMemoryEntry({ content: "needle alpha", project: "p1", target: "memory" })).entry;
        const b = (await repo.syncMemoryEntry({ content: "needle beta", project: "p1", target: "memory" })).entry;
        const c = (await repo.syncMemoryEntry({ content: "gamma delta", project: "p2", target: "memory" })).entry;
        // sanity: edges were written on insert
        expect(await taggedEdgeCount(a.id)).toBeGreaterThan(0);
        expect(await taggedEdgeCount(c.id)).toBeGreaterThan(0);

        await repo.removeSyncedMemories("needle", { target: "memory" });

        // removed memories' edges are gone (no orphans)
        expect(await taggedEdgeCount(a.id)).toBe(0);
        expect(await taggedEdgeCount(b.id)).toBe(0);
        // untouched memory keeps its edges (no over-deletion)
        expect(await taggedEdgeCount(c.id)).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });

    it("removes tagged edges for memories removed via removeExactSyncedMemories", async () => {
      await freshRepo();
      try {
        const a = (await repo.syncMemoryEntry({ content: "exact one", project: "p1", target: "memory" })).entry;
        const b = (await repo.syncMemoryEntry({ content: "unrelated two", project: "p2", target: "memory" })).entry;
        expect(await taggedEdgeCount(a.id)).toBeGreaterThan(0);

        await repo.removeExactSyncedMemories("exact one", { target: "memory" });

        expect(await taggedEdgeCount(a.id)).toBe(0);
        expect(await taggedEdgeCount(b.id)).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });
  });

  describe("backfill graph edges", () => {
    it("rebuilds tagged edges for memories that have none", async () => {
      await freshRepo();
      try {
        const a = (await repo.syncMemoryEntry({ content: "alpha story", project: "p1", target: "memory" })).entry;
        const b = (await repo.syncMemoryEntry({ content: "beta story", project: "p1", target: "memory" })).entry;
        // Strip all edges — simulate pre-feature rows that were never synced.
        await backend.client.query(`DELETE FROM tagged;`);
        expect(await totalTaggedEdges()).toBe(0);
        // Before backfill, graph-recall cannot reach the sibling.
        const before = await repo.searchMemories("alpha", { target: "memory" });
        expect(before.some((m) => m.id === b.id)).toBe(false);

        const count = await repo.backfillGraphEdges();
        expect(count).toBe(2); // rebuilt for both rows

        // Edges present again
        expect(await taggedEdgeCount(a.id)).toBeGreaterThan(0);
        expect(await taggedEdgeCount(b.id)).toBeGreaterThan(0);
        // Behavioral: graph-recall now reaches the sibling via shared project.
        const after = await repo.searchMemories("alpha", { target: "memory" });
        expect(after.some((m) => m.id === b.id)).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("is idempotent (re-running after backfill is a no-op)", async () => {
      await freshRepo();
      try {
        await repo.syncMemoryEntry({ content: "already synced", project: "p1", target: "memory" });
        // Edges already exist (written by sync). Backfill finds nothing missing.
        const before = await totalTaggedEdges();
        const count = await repo.backfillGraphEdges();
        expect(count).toBe(0);
        expect(await totalTaggedEdges()).toBe(before);
      } finally {
        await cleanup();
      }
    });

    it("rebuilds only orphans in a mixed corpus and is idempotent", async () => {
      // Mixed corpus: some memories WITH `->tagged->tag` edges, some WITHOUT.
      // This is the real correctness check for the `count(->tagged) = 0`
      // orphan query — it must select exactly the edge-less rows and skip
      // the rest. (The 10s timeout only reproduces on large corpora and is
      // NOT testable here; perf is the controller's validated 10001ms -> 17ms
      // probe, cited in the task report.)
      await freshRepo();
      try {
        const withEdgesA = (await repo.syncMemoryEntry({ content: "alpha story", project: "p1", target: "memory" })).entry;
        const withEdgesB = (await repo.syncMemoryEntry({ content: "beta story", project: "p1", target: "memory" })).entry;
        const orphanC = (await repo.syncMemoryEntry({ content: "gamma story", project: "p2", target: "memory" })).entry;
        const orphanD = (await repo.syncMemoryEntry({ content: "delta story", project: "p2", target: "memory" })).entry;

        // Sanity: every freshly-synced row has edges.
        expect(await taggedEdgeCount(withEdgesA.id)).toBeGreaterThan(0);
        expect(await taggedEdgeCount(withEdgesB.id)).toBeGreaterThan(0);
        expect(await taggedEdgeCount(orphanC.id)).toBeGreaterThan(0);
        expect(await taggedEdgeCount(orphanD.id)).toBeGreaterThan(0);

        // Selectively strip edges from C and D only — simulate two pre-feature
        // rows sitting alongside two already-synced rows.
        await backend.client.query(
          `DELETE FROM tagged WHERE in = type::record("memories", $c) OR in = type::record("memories", $d);`,
          { c: orphanC.id, d: orphanD.id },
        );
        // Mixed state confirmed: A/B keep edges, C/D are now orphans.
        const edgesABefore = await taggedEdgeCount(withEdgesA.id);
        const edgesBBefore = await taggedEdgeCount(withEdgesB.id);
        expect(edgesABefore).toBeGreaterThan(0);
        expect(edgesBBefore).toBeGreaterThan(0);
        expect(await taggedEdgeCount(orphanC.id)).toBe(0);
        expect(await taggedEdgeCount(orphanD.id)).toBe(0);

        // (a) backfill returns exactly the orphan count (C and D).
        const count = await repo.backfillGraphEdges();
        expect(count).toBe(2);

        // (b) previously-orphan memories now have edges; non-orphans unchanged.
        expect(await taggedEdgeCount(orphanC.id)).toBeGreaterThan(0);
        expect(await taggedEdgeCount(orphanD.id)).toBeGreaterThan(0);
        expect(await taggedEdgeCount(withEdgesA.id)).toBe(edgesABefore);
        expect(await taggedEdgeCount(withEdgesB.id)).toBe(edgesBBefore);

        // (c) idempotent: second call finds no new orphans and adds no edges.
        const edgesCTotal = await taggedEdgeCount(orphanC.id);
        const edgesDTotal = await taggedEdgeCount(orphanD.id);
        const totalBefore = await totalTaggedEdges();
        const secondCount = await repo.backfillGraphEdges();
        expect(secondCount).toBe(0);
        expect(await taggedEdgeCount(orphanC.id)).toBe(edgesCTotal); // no duplicates
        expect(await taggedEdgeCount(orphanD.id)).toBe(edgesDTotal);
        expect(await totalTaggedEdges()).toBe(totalBefore);
      } finally {
        await cleanup();
      }
    });
  });

  describe("normalizeLegacyMemoryIds", () => {
    it("migrates random-id rows to memories:<seq>, preserving fields, and is idempotent", async () => {
      await freshRepo();
      try {
        // Legacy shape: CREATE without an explicit id → Surreal auto-generates a
        // random id; seq is stored as a field. Reproduces pre-type::record() rows.
        await backend.client.query(
          `CREATE memories SET seq = 55, project = "demo", target = "memory",
            category = NONE, content = "legacy body", failureReason = NONE,
            toolState = NONE, correctedTo = NONE, created = "2026-01-01",
            lastReferenced = "2026-01-02", mwSuccess = 0, mwFail = 0,
            status = "active", supersedes = NONE, supersededBy = NONE, parentIds = [];`,
        );

        const migrated = await repo.normalizeLegacyMemoryIds();
        expect(migrated).toBe(1);

        // The row now lives at memories:55 (seq-based); fields preserved.
        const rows = await backend.client.query<Array<{ id: string; seq: number; content: string; project: string | null }>>(
          `SELECT id, seq, content, project FROM memories WHERE seq = 55;`,
        );
        expect(rows.length).toBe(1);
        expect(rows[0]!.id).toBe("memories:55");
        expect(rows[0]!.content).toBe("legacy body");
        expect(rows[0]!.project).toBe("demo");

        // Idempotent: a second run migrates nothing.
        expect(await repo.normalizeLegacyMemoryIds()).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("wipes tagged edges when it migrates, so the following backfill rebuilds them cleanly", async () => {
      await freshRepo();
      try {
        await backend.client.query(
          `CREATE memories SET seq = 77, target = "failure", category = "insight",
            content = "x", created = "2026-01-01", lastReferenced = "2026-01-01",
            status = "active", parentIds = [];`,
        );
        // Two DUPLICATE phantom edges on the phantom node memories:77 — the
        // exact bloat shape backfill produced every boot for legacy rows.
        await backend.client.query(`RELATE memories:77->tagged->tag:\`target:failure\`;`);
        await backend.client.query(`RELATE memories:77->tagged->tag:\`target:failure\`;`);

        const migrated = await repo.normalizeLegacyMemoryIds();
        expect(migrated).toBe(1);

        // Migration wiped tagged (the caller's backfillGraphEdges rebuilds).
        expect(await totalTaggedEdges()).toBe(0);

        // Now backfill rebuilds exactly one correct edge set on the real memories:77.
        const built = await repo.backfillGraphEdges();
        expect(built).toBe(1);
        // Healed: the row now has traversable edges (count(->tagged) > 0) — i.e. it
        // is no longer an orphan by the backfill orphan-query's own definition.
        const after = await backend.client.query<Array<{ c: number }>>(
          `SELECT count(->tagged) AS c FROM memories:77 GROUP ALL;`,
        );
        expect(after[0]?.c ?? 0).toBeGreaterThan(0);
        // Minimal — exactly the two implicit tags (target:failure + category:insight),
        // no duplicate bloat (the original symptom was ~45 dupes/row).
        expect(await taggedEdgeCount(77)).toBe(2);
        // Converged: a second backfill finds no orphans (the rebuilt edges persist).
        expect(await repo.backfillGraphEdges()).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("is a no-op (returns 0, does not wipe tagged) when all rows are already seq-based", async () => {
      await freshRepo();
      try {
        // A correctly-shaped row + a legit edge that must survive.
        await backend.client.query(
          `CREATE type::record("memories", 99) SET seq = 99, target = "memory",
            content = "ok", created = "2026-01-01", lastReferenced = "2026-01-01",
            status = "active", parentIds = [];`,
        );
        await backend.client.query(`RELATE memories:99->tagged->tag:\`target:memory\`;`);

        const migrated = await repo.normalizeLegacyMemoryIds();
        expect(migrated).toBe(0);
        expect(await totalTaggedEdges()).toBe(1); // legit edge NOT wiped when nothing migrated
      } finally {
        await cleanup();
      }
    });
  });

  describe("createBackendBundle backfill wiring", () => {
    it("backfills edges for pre-existing rows on surrealdb init", async () => {
      // Seed phase: raw-insert two pre-feature rows sharing a project, with NO
      // graph edges (simulating data written before graph-augmented search).
      ns = uniqueNs();
      const seed = new SurrealBackend({ namespace: ns, database: ns });
      await seed.init();
      await seed.client.query(
        `LET $n = (UPDATE seq:memory SET value += 1 RETURN VALUE value)[0]; CREATE type::record("memories", $n) SET seq = $n, project = "p1", target = "memory", content = "alpha story";`,
      );
      await seed.client.query(
        `LET $n = (UPDATE seq:memory SET value += 1 RETURN VALUE value)[0]; CREATE type::record("memories", $n) SET seq = $n, project = "p1", target = "memory", content = "beta story";`,
      );
      const seededEdges = await seed.client.query<Array<{ c: number }>>(`SELECT count() AS c FROM tagged GROUP ALL;`);
      expect(seededEdges[0]?.c ?? 0).toBe(0);
      await seed.close();

      // createBackendBundle should trigger backfill on init (auto-heal).
      const config: MemoryConfig = { dbBackend: "surrealdb", surreal: { namespace: ns, database: ns } };
      const bundle = await createBackendBundle(config, "/tmp/unused-by-surrealdb");
      try {
        // Graph-recall now reaches the sibling via the backfilled shared-project edge.
        const results = await bundle.memoryRepo.searchMemories("alpha", { target: "memory" });
        expect(results.some((m) => m.content === "beta story")).toBe(true);
      } finally {
        try { await (bundle.backend as SurrealBackend).client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch { /* best-effort */ }
        await bundle.backend.close();
      }
    });
  });
});
