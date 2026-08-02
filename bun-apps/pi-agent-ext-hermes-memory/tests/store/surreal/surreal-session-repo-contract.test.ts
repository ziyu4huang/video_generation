/**
 * Contract test for SurrealSessionRepository. Registers the shared
 * runSessionRepositoryContract suite ONLY when the local SurrealDB service
 * is reachable — this keeps CI green when the server is absent while still
 * exercising the full backend-agnostic contract on developer machines.
 */
import { describe, expect, test } from "bun:test";
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

if (up) {
  const { SurrealBackend } = await import("../../../src/store/surreal/surreal-backend.js");
  const { SurrealSessionRepository } = await import("../../../src/store/surreal/surreal-session-repo.js");

  describe("SurrealSessionRepository.recordAssembly", () => {
    test("writes session_assembly rows + meta hash; idempotent; queryable by mdId", async () => {
      const ns = uniqueNs();
      const backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      try {
        const repo = new SurrealSessionRepository(backend);
        const sid = "sess-surr-1";
        await repo.indexSession({ id: sid, project: "p", cwd: "/p", startedAt: new Date().toISOString(), messages: [] } as never);

        await repo.recordAssembly(sid, ["m1", "m2", "m1"], "h1");

        const rows = await backend.client.query<Array<{ mdId: string }>>(
          `SELECT mdId FROM session_assembly WHERE sessionId = $sid;`, { sid },
        );
        expect(rows.map((r) => r.mdId).sort()).toEqual(["m1", "m2"]);

        const meta = await backend.client.query<Array<{ hash: string }>>(
          `SELECT hash FROM session_assembly_meta WHERE sessionId = $sid LIMIT 1;`, { sid },
        );
        expect(meta[0]?.hash).toBe("h1");

        // idempotent replace: prior rows cleared, hash overwritten
        await repo.recordAssembly(sid, ["m3"], "h2");
        const after = await backend.client.query<Array<{ mdId: string }>>(
          `SELECT mdId FROM session_assembly WHERE sessionId = $sid;`, { sid },
        );
        expect(after.map((r) => r.mdId)).toEqual(["m3"]);
      } finally {
        try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
        await backend.close();
      }
    });
  });
}
