/**
 * Batched session_files meta for SurrealSessionRepository.
 *
 * Guards the fix that killed the per-file HTTP N+1 in needsBackfill and
 * indexChangedSessions: previously each method issued ONE `SELECT ... FROM
 * session_files WHERE path = $path` round-trip PER session file. On the real
 * runtime (3515 session files) needsBackfill alone took ~11s/1107 round-trips.
 * Both now fetch ALL meta in a single `SELECT path,size,mtimeMs FROM session_files`
 * and diff in TS — the per-file WHERE-path pattern must never return.
 *
 * Uses the live local SurrealDB server with a query spy. CI-skipped when down.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isSurrealUp, uniqueNs } from "./_helpers.js";
import { SurrealBackend } from "../../../src/store/surreal/surreal-backend.js";
import { SurrealSessionRepository } from "../../../src/store/surreal/surreal-session-repo.js";

const up = await isSurrealUp();
/** The per-file SELECT meta-scan N+1 that must NEVER return once batching
 *  lands. (Does NOT match upsertSessionFileMeta's legitimate single DELETE
 *  ... WHERE path = — that is one statement per re-indexed file, not the scan.) */
const PER_FILE_META = /SELECT .+ FROM session_files WHERE path =/;
const countMatches = (bodies: string[], re: RegExp): number =>
  bodies.reduce((n, s) => n + (s.match(new RegExp(re.source, "g")) ?? []).length, 0);

/** Write a minimal valid JSONL session file (session header + one message). */
function writeSession(dir: string, id: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", id, timestamp: "2026-07-27T00:00:00Z", cwd: dir }),
    JSON.stringify({
      type: "message", id: `${id}-m1`, parentId: null, timestamp: "2026-07-27T00:00:01Z",
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    }),
  ];
  writeFileSync(file, lines.join("\n"));
  return file;
}

function spyQueries(backend: SurrealBackend): string[] {
  const seen: string[] = [];
  const client = backend.client as SurrealBackend["client"] & { query: (sql: string, p?: Record<string, unknown>) => Promise<unknown> };
  const orig = client.query.bind(client);
  client.query = (sql: string, params?: Record<string, unknown>) => {
    seen.push(sql);
    return orig(sql, params);
  };
  return seen;
}

describe.skipIf(!up)("SurrealSessionRepository batched backfill meta", () => {
  it("needsBackfill does not query per-file (bounded round-trips)", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    const repo = new SurrealSessionRepository(backend);
    const seen = spyQueries(backend);

    const root = mkdtempSync(join(tmpdir(), `hm-bf-nb-${ns}-`));
    const sessionsDir = join(root, "sessions");
    const projDir = join(sessionsDir, "proj");
    try {
      // 6 session files, all indexed up front.
      for (let i = 0; i < 6; i++) writeSession(projDir, `bf-${i}`, `content ${i}`);
      await repo.indexAllSessions(sessionsDir);
      // Mark backfill current so needsBackfill's verdict depends only on the
      // (all-matching) meta, not the 24h timestamp gate.
      await repo.touchBackfillTimestamp();

      seen.length = 0;
      const need = await repo.needsBackfill(sessionsDir);

      // All indexed + unchanged → backfill NOT needed.
      expect(need).toBe(false);
      // The per-file WHERE-path pattern must never appear.
      expect(countMatches(seen, PER_FILE_META)).toBe(0);
      // Round-trips are bounded (count + batched-select + timestamp ≈ 3), NOT
      // proportional to file count. Old code would issue 6+ here.
      expect(seen.length).toBeLessThanOrEqual(5);
    } finally {
      try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("indexChangedSessions does not query per-file", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    const repo = new SurrealSessionRepository(backend);
    const seen = spyQueries(backend);

    const root = mkdtempSync(join(tmpdir(), `hm-bf-ic-${ns}-`));
    const sessionsDir = join(root, "sessions");
    const projDir = join(sessionsDir, "proj");
    try {
      for (let i = 0; i < 6; i++) writeSession(projDir, `ic-${i}`, `content ${i}`);
      await repo.indexAllSessions(sessionsDir);

      // Change exactly ONE file by APPENDING a new message (real delta, so
      // the incremental indexOne reports messagesIndexed > 0).
      writeFileSync(join(projDir, "ic-3.jsonl"), [
        JSON.stringify({ type: "session", id: "ic-3", timestamp: "2026-07-27T00:00:00Z", cwd: projDir }),
        JSON.stringify({ type: "message", id: "ic-3-m1", parentId: null, timestamp: "2026-07-27T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "content 3" }], timestamp: Date.now() } }),
        JSON.stringify({ type: "message", id: "ic-3-m2", parentId: null, timestamp: "2026-07-27T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "appended new message" }], timestamp: Date.now() } }),
      ].join("\n"));

      seen.length = 0;
      const result = await repo.indexChangedSessions(sessionsDir, { maxFilesToIndex: 50 });

      // It found and indexed the one changed session.
      expect(result.sessionsIndexed).toBe(1);
      // The per-file WHERE-path pattern must never appear in the meta-scan.
      expect(countMatches(seen, PER_FILE_META)).toBe(0);
    } finally {
      try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
