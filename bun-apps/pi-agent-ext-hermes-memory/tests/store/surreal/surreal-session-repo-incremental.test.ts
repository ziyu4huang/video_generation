/**
 * Incremental indexSession for SurrealSessionRepository.
 *
 * Guards the optimization that a CAUGHT-UP re-index (zero new messages) must
 * NOT re-UPSERT every message — it skips the batched message-UPSERT loop
 * entirely, paying only one id-select + one session UPSERT. Previously every
 * indexSession (shutdown + every message_end live-index) re-UPSERTed ALL
 * messages even when nothing changed (~400ms wasted on a 1348-msg session).
 *
 * Uses the live local SurrealDB server with a query spy that records every
 * SQL body sent, so we can assert precisely which statements ran. Skipped
 * wholesale when the server is absent (CI-safe).
 */
import { describe, it, expect } from "bun:test";
import { isSurrealUp, uniqueNs } from "./_helpers.js";
import { SurrealBackend } from "../../../src/store/surreal/surreal-backend.js";
import { SurrealSessionRepository } from "../../../src/store/surreal/surreal-session-repo.js";

const up = await isSurrealUp();

/** Matches a message UPSERT statement (NOT the session UPSERT). */
const MSG_UPSERT = /UPSERT type::record\("messages"/;
/** Count message-UPSERT statements across all recorded SQL bodies. A batch
 *  body concatenates many UPSERTs, so body-count is meaningless — only the
 *  statement count reveals whether the delta alone was written. */
const countMsgUpserts = (bodies: string[]): number =>
  bodies.reduce((n, s) => n + (s.match(/UPSERT type::record\("messages"/g) ?? []).length, 0);

describe.skipIf(!up)("SurrealSessionRepository incremental indexSession", () => {
  it("does not re-UPSERT any message on a caught-up re-index", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    const repo = new SurrealSessionRepository(backend);

    // Spy: record every SQL body the repo sends to the server.
    const seen: string[] = [];
    const client = backend.client;
    const origQuery = client.query.bind(client);
    (client as { query: (sql: string, params?: Record<string, unknown>) => Promise<unknown> }).query = (
      sql: string,
      params?: Record<string, unknown>,
    ) => {
      seen.push(sql);
      return origQuery(sql, params);
    };

    try {
      const session = {
        id: `inc-caughtup-${ns}`,
        project: ns,
        cwd: "/tmp/inc",
        startedAt: "2026-07-27T00:00:00Z",
        messages: [
          { id: "inc-m1", role: "user" as const, content: "first", timestamp: "2026-07-27T00:00:01Z" },
          { id: "inc-m2", role: "assistant" as const, content: "second", timestamp: "2026-07-27T00:00:02Z" },
        ],
      };

      // First index: both messages are new.
      const r1 = await repo.indexSession(session);
      expect(r1.messagesIndexed).toBe(2);

      // Re-index the SAME session: nothing new.
      seen.length = 0;
      const r2 = await repo.indexSession(session);
      expect(r2.messagesIndexed).toBe(0);
      expect(r2.skipped).toBe(true);

      // Zero message-UPSERT statements may run on a caught-up re-index.
      expect(countMsgUpserts(seen)).toBe(0);
    } finally {
      try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
      await backend.close();
    }
  });

  it("indexes only the delta when some messages are new", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    const repo = new SurrealSessionRepository(backend);

    const seen: string[] = [];
    const client = backend.client;
    const origQuery = client.query.bind(client);
    (client as { query: (sql: string, params?: Record<string, unknown>) => Promise<unknown> }).query = (
      sql: string,
      params?: Record<string, unknown>,
    ) => {
      seen.push(sql);
      return origQuery(sql, params);
    };

    try {
      // Seed with two messages.
      await repo.indexSession({
        id: `inc-delta-${ns}`,
        project: ns,
        cwd: "/tmp/inc",
        startedAt: "2026-07-27T00:00:00Z",
        messages: [
          { id: "d1", role: "user" as const, content: "old one", timestamp: "2026-07-27T00:00:01Z" },
          { id: "d2", role: "assistant" as const, content: "old two", timestamp: "2026-07-27T00:00:02Z" },
        ],
      });

      // Re-index with one NEW message appended.
      seen.length = 0;
      const r = await repo.indexSession({
        id: `inc-delta-${ns}`,
        project: ns,
        cwd: "/tmp/inc",
        startedAt: "2026-07-27T00:00:00Z",
        messages: [
          { id: "d1", role: "user" as const, content: "old one", timestamp: "2026-07-27T00:00:01Z" },
          { id: "d2", role: "assistant" as const, content: "old two", timestamp: "2026-07-27T00:00:02Z" },
          { id: "d3", role: "user" as const, content: "new three", timestamp: "2026-07-27T00:00:03Z" },
        ],
      });
      expect(r.messagesIndexed).toBe(1);

      // Exactly ONE message-UPSERT statement — the single new message only.
      // (Old behavior re-UPSERTed all 3 → count would be 3.)
      expect(countMsgUpserts(seen)).toBe(1);
    } finally {
      try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
      await backend.close();
    }
  });
});
