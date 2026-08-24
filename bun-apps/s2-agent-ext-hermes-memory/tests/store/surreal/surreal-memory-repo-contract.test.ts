/**
 * Contract test for SurrealMemoryRepository. Registers the shared
 * runMemoryRepositoryContract suite ONLY when the local SurrealDB service
 * is reachable — this keeps CI green when the server is absent while still
 * exercising the full backend-agnostic contract on developer machines.
 */
import { describe, it, expect } from "bun:test";
import { isSurrealUp, uniqueNs } from "./_helpers.js";
import type { SurrealBackend } from "../../../src/store/surreal/surreal-backend.js";

const up = await isSurrealUp();

if (up) {
  const { runMemoryRepositoryContract, runMarkdownSyncContract } = await import("../repository-contract.test.js");
  const { SurrealBackend } = await import("../../../src/store/surreal/surreal-backend.js");
  const { SurrealMemoryRepository } = await import("../../../src/store/surreal/surreal-memory-repo.js");
  const { createCardStore } = await import("../../../src/store/card-store.js");

  runMemoryRepositoryContract("SurrealDB", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    return {
      repo: new SurrealMemoryRepository(backend),
      backendKind: "surreal" as const,
      close: async () => {
        try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
        await backend.close();
      },
    };
  });

  runMarkdownSyncContract("SurrealDB", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    const repo = new SurrealMemoryRepository(backend);
    return {
      repo,
      // kp13 Wave B: card mirror on the same surreal repo (rows land in the
      // same memories store; close is the backend's — the card store is
      // stateless on this branch).
      cardStore: await createCardStore({ memoryDir: ns, dbBackend: "surrealdb", surrealRepo: repo }),
      close: async () => {
        try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
        await backend.close();
      },
    };
  });

  describe("SurrealMemoryRepository worth columns (gated on SurrealDB)", () => {
    let backend: SurrealBackend;
    let repo: SurrealMemoryRepository;
    let ns: string;

    it("addMemory seeds mwSuccess/mwFail = 0; bumpMemoryWorth increments them", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);

      const entry = await repo.addMemory({ content: "worth-test", target: "memory" });
      expect(entry.mwSuccess).toBe(0);
      expect(entry.mwFail).toBe(0);
      await repo.bumpMemoryWorth(entry.id, 3, 1);
      const list = await repo.getMemories({ target: "memory" });
      const found = list.find((m) => m.id === entry.id)!;
      expect(found.mwSuccess).toBe(3);
      expect(found.mwFail).toBe(1);

      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });

    it("syncMemoryEntry seeds worth from input on insert; merge preserves DB worth", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);

      const ins = await repo.syncMemoryEntry({ content: "seeded", target: "memory", mwSuccess: 2, mwFail: 0 });
      expect(ins.entry.mwSuccess).toBe(2);
      await repo.bumpMemoryWorth(ins.entry.id, 1, 0); // DB now 3
      // re-sync (merge path) must NOT overwrite the bumped DB counter
      await repo.syncMemoryEntry({ content: "seeded", target: "memory", mwSuccess: 2, mwFail: 0 });
      const list = await repo.getMemories({ target: "memory" });
      const found = list.find((m) => m.id === ins.entry.id)!;
      expect(found.mwSuccess).toBe(3);

      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });
  });

  describe("SurrealMemoryRepository supersession (Task 4) (gated on SurrealDB)", () => {
    let backend: SurrealBackend;
    let repo: SurrealMemoryRepository;
    let ns: string;

    it("addMemory surfaces status='active' + null lineage (defaults via mapRow)", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);

      const entry = await repo.addMemory({ content: "lineage-defaults", target: "memory" });
      expect(entry.status).toBe("active");
      expect(entry.supersedes).toBeNull();
      expect(entry.supersededBy).toBeNull();
      expect(entry.parentIds).toEqual([]);
      const list = await repo.getMemories({ target: "memory" });
      const back = list.find((m) => m.id === entry.id)!;
      expect(back.status).toBe("active");
      expect(back.supersedes).toBeNull();
      expect(back.supersededBy).toBeNull();
      expect(back.parentIds).toEqual([]);

      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });

    it("supersedeMemory flips prior lineage + sets new lineage", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);

      const prior = await repo.addMemory({ content: "deploy strategy alpha variant", target: "memory" });
      const next = await repo.addMemory({ content: "deploy strategy beta variant", target: "memory" });
      await repo.supersedeMemory(prior.id, next.id);

      const all = await repo.getMemories();
      const priorRow = all.find((m) => m.id === prior.id)!;
      const nextRow = all.find((m) => m.id === next.id)!;
      expect(priorRow.status).toBe("superseded");
      expect(priorRow.supersededBy).toBe(next.id);
      expect(nextRow.supersedes).toBe(prior.id);
      expect(nextRow.parentIds).toEqual([prior.id]);

      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });

    it("searchMemories hides superseded prior by default, surfaces with includeSuperseded", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);

      const prior = await repo.addMemory({ content: "deploy strategy alpha variant", target: "memory" });
      const next = await repo.addMemory({ content: "deploy strategy beta variant", target: "memory" });
      await repo.supersedeMemory(prior.id, next.id);

      const hidden = await repo.searchMemories("deploy strategy");
      expect(hidden.some((m) => m.id === prior.id)).toBe(false);
      expect(hidden.some((m) => m.id === next.id)).toBe(true);

      const shown = await repo.searchMemories("deploy strategy", { includeSuperseded: true });
      expect(shown.some((m) => m.id === prior.id)).toBe(true);
      expect(shown.some((m) => m.id === next.id)).toBe(true);

      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Failure lifecycle state/severity (Task 4 of hermes-failure-lifecycle).
  // Surreal parity with the SQLite repo: addMemory writes state explicitly
  // (SCHEMALESS has no column default), the active-only injection filter holds,
  // and replace carries/inherits state through the UPDATE.
  // ---------------------------------------------------------------------------
  describe("SurrealMemoryRepository failure state/severity (Task 4) (gated on SurrealDB)", () => {
    let backend: SurrealBackend;
    let repo: SurrealMemoryRepository;
    let ns: string;

    it("getRecentFailures excludes resolved/acquired; keeps active; round-trips state", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);

      await repo.addMemory({ content: "[failure] active one", target: "failure", category: "failure", state: "active" });
      await repo.addMemory({ content: "[failure] fixed one", target: "failure", category: "failure", state: "resolved" });
      await repo.addMemory({ content: "[tool-quirk] known quirk", target: "failure", category: "tool-quirk", state: "acquired" });
      const recent = await repo.getRecentFailures(7);
      const contents = recent.map((m) => m.content);
      expect(contents.some((c) => c === "[failure] active one")).toBe(true);
      expect(contents.some((c) => c === "[failure] fixed one")).toBe(false);
      expect(contents.some((c) => c === "[tool-quirk] known quirk")).toBe(false);
      const active = recent.find((m) => m.content === "[failure] active one");
      expect(active?.state).toBe("active");

      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });

    it("replace writes explicit state onto the row; getRecentFailures reflects it", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);

      await repo.addMemory({ content: "[failure] live bug", target: "failure", category: "failure", state: "active" });
      expect((await repo.getRecentFailures(7)).map((m) => m.content)).toContain("[failure] live bug");
      await repo.replaceSyncedMemories("[failure] live bug", {
        content: "[failure] live bug — fixed",
        target: "failure",
        category: "failure",
        state: "resolved",
      });
      const recent = (await repo.getRecentFailures(7)).map((m) => m.content);
      expect(recent).not.toContain("[failure] live bug — fixed");
      const all = await repo.getMemories({ target: "failure" });
      expect(all.find((m) => m.content === "[failure] live bug — fixed")?.state).toBe("resolved");

      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });

    it("replace with no explicit state inherits the row's prior state", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);

      await repo.addMemory({ content: "[failure] quirk A", target: "failure", category: "failure", state: "resolved" });
      await repo.replaceSyncedMemories("[failure] quirk A", {
        content: "[failure] quirk A — edited",
        target: "failure",
      });
      const all = await repo.getMemories({ target: "failure" });
      expect(all.find((m) => m.content === "[failure] quirk A — edited")?.state).toBe("resolved");

      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });
  });

  describe("SurrealMemoryRepository updateCardsByMdIdBatch (gated on SurrealDB)", () => {
    let backend: SurrealBackend;
    let repo: SurrealMemoryRepository;
    let ns: string;

    it("updates N drifted cards in one call, mdId-keyed, envelope stamped", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);

      // Seed 3 card rows via the card seam (addMemory + envelope stamp).
      for (let i = 1; i <= 3; i++) {
        const entry = await repo.addMemory({ content: `batch card ${i}`, target: "memory", mdId: `md-batch-${i}` });
        await repo.setCardEnvelopeBySeq(Number(entry.id), JSON.stringify({ last: "2026-05-08" }), null);
      }

      await repo.updateCardsByMdIdBatch([
        { mdId: "md-batch-1", content: "batch card 1 v2", frontmatter: JSON.stringify({ last: "2026-05-20" }), graph: null },
        { mdId: "md-batch-2", content: "batch card 2 v2", frontmatter: JSON.stringify({ last: "2026-05-20" }), graph: null },
        { mdId: "md-batch-3", content: "batch card 3 v2", frontmatter: JSON.stringify({ last: "2026-05-20" }), graph: null },
      ]);

      const cards = await repo.listCardsByTarget("memory");
      expect(cards.length).toBe(3, "update-in-place: no new rows");
      for (const card of cards) {
        expect(card.content.endsWith(" v2")).toBe(true);
        expect(JSON.parse(card.frontmatter!).last).toBe("2026-05-20");
      }
      // Untouched mdIds stay put (WHERE mdId — no cross-card bleed).
      expect(cards.map((c) => c.mdId).sort()).toEqual(["md-batch-1", "md-batch-2", "md-batch-3"]);

      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });

    it("empty input is a no-op (early return, no mutation)", async () => {
      ns = uniqueNs();
      backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      repo = new SurrealMemoryRepository(backend);
      await repo.updateCardsByMdIdBatch([]);
      await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      await backend.close();
    });
  });
}
