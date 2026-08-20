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

  describe("SurrealSessionRepository.markUsed", () => {
    // UPSP §9 (#06, Task 4) — Surreal parity with the SQLite markUsed tests
    // (sqlite-session-repo.test.ts). SCHEMALESS: a non-matched row never gets
    // `usedAt` written, so the field is absent (SELECT serializes NONE → null).
    // Fresh isolated ns + backend per test, mirroring recordAssembly's per-test
    // uniqueNs + try/finally REMOVE NAMESPACE cleanup.
    async function withRepo(
      fn: (repo: SurrealSessionRepository, backend: SurrealBackend) => Promise<void>,
    ): Promise<void> {
      const ns = uniqueNs();
      const backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      try {
        await fn(new SurrealSessionRepository(backend), backend);
      } finally {
        try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
        await backend.close();
      }
    }

    const selUsedAt = async (backend: SurrealBackend, sid: string): Promise<Record<string, string | null>> => {
      const rows = await backend.client.query<Array<{ mdId: string; usedAt: string | null }>>(
        `SELECT mdId, usedAt FROM session_assembly WHERE sessionId = $sid;`, { sid },
      );
      return Object.fromEntries(rows.map((r) => [r.mdId, r.usedAt]));
    };

    test("sets usedAt on matched rows only; non-matched rows stay null", async () => {
      await withRepo(async (repo, backend) => {
        const sid = "sess-surr-used-1";
        await repo.recordAssembly(sid, ["a", "b", "c"], "hash-1");
        const now = "2026-08-02T12:00:00.000Z";
        await repo.markUsed(sid, ["a", "c"], now);

        const byId = await selUsedAt(backend, sid);
        expect(byId["a"]).toBe(now);
        expect(byId["c"]).toBe(now);
        // SCHEMALESS: the non-matched row never got usedAt written → field absent ≈ null.
        expect(byId["b"]).toBeNull();
      });
    });

    test("is idempotent: a re-mark does not error and re-stamps usedAt", async () => {
      await withRepo(async (repo, backend) => {
        const sid = "sess-surr-used-2";
        await repo.recordAssembly(sid, ["a", "b"], "hash-1");
        const t1 = "2026-08-02T12:00:00.000Z";
        const t2 = "2026-08-02T13:00:00.000Z";
        await repo.markUsed(sid, ["a"], t1);
        // re-mark with the same value → no error (no-op semantics):
        await expect(repo.markUsed(sid, ["a"], t1)).resolves.toBeUndefined();
        // re-mark with a newer value → overwrites (monotonic stamp, allowed):
        await repo.markUsed(sid, ["a"], t2);
        const byId = await selUsedAt(backend, sid);
        expect(byId["a"]).toBe(t2);
        // the never-marked row stays null across all calls:
        expect(byId["b"]).toBeNull();
      });
    });

    test("is a no-op on empty mdIds (no row touched)", async () => {
      await withRepo(async (repo, backend) => {
        const sid = "sess-surr-used-3";
        await repo.recordAssembly(sid, ["a", "b"], "hash-1");
        await repo.markUsed(sid, [], "2026-08-02T12:00:00.000Z");
        const byId = await selUsedAt(backend, sid);
        expect(byId["a"]).toBeNull();
        expect(byId["b"]).toBeNull();
      });
    });

    test("is a no-op for a session that has no assembly rows (no error)", async () => {
      await withRepo(async (repo) => {
        await expect(
          repo.markUsed("no-such-session", ["a"], "2026-08-02T12:00:00.000Z"),
        ).resolves.toBeUndefined();
      });
    });

    test("marks only rows for the given session (a same-mdId row in another session is untouched)", async () => {
      await withRepo(async (repo, backend) => {
        const s1 = "sess-surr-used-4a";
        const s2 = "sess-surr-used-4b";
        const now = "2026-08-02T12:00:00.000Z";
        await repo.recordAssembly(s1, ["shared"], "hash-1");
        await repo.recordAssembly(s2, ["shared"], "hash-2");
        await repo.markUsed(s1, ["shared"], now);
        const a = await selUsedAt(backend, s1);
        const b = await selUsedAt(backend, s2);
        expect(a["shared"]).toBe(now);
        expect(b["shared"]).toBeNull();
      });
    });

    test("never touches session_assembly_meta (hash/capturedAt survive)", async () => {
      await withRepo(async (repo, backend) => {
        const sid = "sess-surr-used-5";
        await repo.recordAssembly(sid, ["a", "b"], "hash-1");
        const metaBefore = await backend.client.query<Array<{ hash: string; capturedAt: string }>>(
          `SELECT hash, capturedAt FROM session_assembly_meta WHERE sessionId = $sid LIMIT 1;`, { sid },
        );
        await repo.markUsed(sid, ["a"], "2026-08-02T12:00:00.000Z");
        const metaAfter = await backend.client.query<Array<{ hash: string; capturedAt: string }>>(
          `SELECT hash, capturedAt FROM session_assembly_meta WHERE sessionId = $sid LIMIT 1;`, { sid },
        );
        expect(metaAfter[0]?.hash).toBe(metaBefore[0]?.hash);
        expect(metaAfter[0]?.capturedAt).toBe(metaBefore[0]?.capturedAt);
      });
    });
  });

  describe("SurrealSessionRepository.getUsedMdIds", () => {
    // Task 2 of #1b decay — #06 used_at as a per-entry boolean ever-used aggregate
    // (UPSP §1/D4). Surreal parity with the SQLite getUsedMdIds tests
    // (sqlite-session-repo.test.ts). SCHEMALESS: a non-matched row never gets
    // `usedAt` written, so the field is absent (usedAt IS NOT NULL is false).
    async function withRepo(
      fn: (repo: SurrealSessionRepository, backend: SurrealBackend) => Promise<void>,
    ): Promise<void> {
      const ns = uniqueNs();
      const backend = new SurrealBackend({ namespace: ns, database: ns });
      await backend.init();
      try {
        await fn(new SurrealSessionRepository(backend), backend);
      } finally {
        try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
        await backend.close();
      }
    }

    test("returns the subset of mdIds with ≥1 usedAt-set row (used ∩ input)", async () => {
      await withRepo(async (repo) => {
        await repo.recordAssembly("sess-surr-gu-1", ["a", "b", "c"], "hash-1");
        await repo.markUsed("sess-surr-gu-1", ["a", "c"], "2026-08-02T12:00:00.000Z");
        const result = await repo.getUsedMdIds(["a", "b", "c", "d"], { project: null });
        expect(result).toBeInstanceOf(Set);
        expect([...result].sort()).toEqual(["a", "c"]);
      });
    });

    test("empty input → empty Set (no-op, no SQL)", async () => {
      await withRepo(async (repo) => {
        await repo.recordAssembly("sess-surr-gu-2", ["a"], "hash-1");
        await repo.markUsed("sess-surr-gu-2", ["a"], "2026-08-02T12:00:00.000Z");
        const result = await repo.getUsedMdIds([], { project: null });
        expect(result).toBeInstanceOf(Set);
        expect(result.size).toBe(0);
      });
    });

    test("all-unused input → empty Set", async () => {
      await withRepo(async (repo) => {
        await repo.recordAssembly("sess-surr-gu-3", ["a", "b"], "hash-1"); // nothing marked
        const result = await repo.getUsedMdIds(["a", "b"], { project: null });
        expect(result.size).toBe(0);
      });
    });

    test("mdId in table but usedAt absent → not returned", async () => {
      await withRepo(async (repo) => {
        await repo.recordAssembly("sess-surr-gu-4", ["x"], "hash-1"); // usedAt never written
        const result = await repo.getUsedMdIds(["x"], { project: null });
        expect([...result]).toEqual([]);
      });
    });

    test("a used row in ANY session makes the mdId ever-used (DISTINCT, dedup)", async () => {
      await withRepo(async (repo) => {
        await repo.recordAssembly("s1", ["shared", "only1"], "h1");
        await repo.recordAssembly("s2", ["shared"], "h2");
        await repo.markUsed("s1", ["shared"], "2026-08-02T12:00:00.000Z");
        const result = await repo.getUsedMdIds(["shared", "only1", "absent"], { project: null });
        expect([...result].sort()).toEqual(["shared"]);
      });
    });

    test("project arg is IGNORED: session_assembly is a global provenance ledger", async () => {
      await withRepo(async (repo) => {
        await repo.recordAssembly("sess-surr-gu-6", ["used-a"], "h1");
        await repo.markUsed("sess-surr-gu-6", ["used-a"], "2026-08-02T12:00:00.000Z");
        const result = await repo.getUsedMdIds(["used-a"], { project: "some-other-project" });
        expect([...result]).toEqual(["used-a"]);
        const resultNull = await repo.getUsedMdIds(["used-a"], { project: null });
        expect([...resultNull]).toEqual(["used-a"]);
      });
    });
  });
}
