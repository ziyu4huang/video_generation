/**
 * Contract test for SurrealMemoryRepository. Registers the shared
 * runMemoryRepositoryContract suite ONLY when the local SurrealDB service
 * is reachable — this keeps CI green when the server is absent while still
 * exercising the full backend-agnostic contract on developer machines.
 */
import { isSurrealUp } from "./_helpers.js";

const up = await isSurrealUp();

if (up) {
  const { runMemoryRepositoryContract } = await import("../repository-contract.test.js");
  const { SurrealBackend } = await import("../../../src/store/surreal/surreal-backend.js");
  const { SurrealMemoryRepository } = await import("../../../src/store/surreal/surreal-memory-repo.js");
  const { uniqueNs } = await import("./_helpers.js");

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
}
