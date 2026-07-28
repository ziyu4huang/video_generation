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
