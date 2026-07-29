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

  runMemoryRepositoryContract("SurrealDB", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    return {
      repo: new SurrealMemoryRepository(backend),
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
    return {
      repo: new SurrealMemoryRepository(backend),
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
}
