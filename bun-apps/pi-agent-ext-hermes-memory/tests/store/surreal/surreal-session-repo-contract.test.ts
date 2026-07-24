/**
 * Contract test for SurrealSessionRepository. Registers the shared
 * runSessionRepositoryContract suite ONLY when the local SurrealDB service
 * is reachable — this keeps CI green when the server is absent while still
 * exercising the full backend-agnostic contract on developer machines.
 */
import { isSurrealUp, uniqueNs } from "./_helpers.js";

const up = await isSurrealUp();

if (up) {
  const { runSessionRepositoryContract } = await import("../repository-contract.test.js");
  const { SurrealBackend } = await import("../../../src/store/surreal/surreal-backend.js");
  const { SurrealSessionRepository } = await import("../../../src/store/surreal/surreal-session-repo.js");
  runSessionRepositoryContract("SurrealDB", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    return {
      repo: new SurrealSessionRepository(backend),
      close: async () => {
        try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
        await backend.close();
      },
    };
  });
}
