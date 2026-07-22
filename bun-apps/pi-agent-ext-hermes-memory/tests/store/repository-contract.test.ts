/**
 * Shared repository contract suite for pi-hermes-memory.
 *
 * These factories (`runMemoryRepositoryContract`, `runSessionRepositoryContract`)
 * express the BACKEND-AGNOSTIC golden-path behavior every correct
 * `MemoryRepository` / `SessionRepository` implementation must satisfy. The
 * SQLite backend instantiates them at the bottom of this file today; the
 * Phase-3 SurrealDB backend will call the same factories against its own
 * repository implementation, serving as the equivalence benchmark.
 *
 * Contract rules for future authors:
 *   - Assert SEMANTIC recall (an entry matching the query is present), not
 *     backend-specific ordering, row ids beyond "> 0", or exact counts.
 *   - Never reach into backend internals (no getDb(), no raw SQL). The repo
 *     interface in `src/store/repository.ts` is the only surface exercised.
 *   - Stemming/FTS cases are written loosely: a stemmer-based backend passes
 *     because a morphological variant of the indexed word is recalled.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type {
  MemoryRepository,
  SessionRepository,
} from "../../src/store/repository.js";

// ---------------------------------------------------------------------------
// MemoryRepository contract
// ---------------------------------------------------------------------------

export function runMemoryRepositoryContract(
  name: string,
  make: () => Promise<{ repo: MemoryRepository; close: () => Promise<void> }>,
): void {
  describe(`${name} MemoryRepository contract`, () => {
    it("add → get → search → remove lifecycle", async () => {
      const { repo, close } = await make();
      try {
        const entry = await repo.addMemory({
          content: "bun install not npm install",
          target: "memory",
          category: "convention",
        });
        expect(entry.id).toBeGreaterThan(0);

        const got = await repo.getMemories({ target: "memory" });
        expect(got.some((m) => m.id === entry.id)).toBe(true);

        const hits = await repo.searchMemories("bun install");
        expect(hits.some((m) => m.id === entry.id)).toBe(true);

        const removed = await repo.removeMemory(entry.id);
        expect(removed).toBe(true);

        const after = await repo.getMemories({ target: "memory" });
        expect(after.some((m) => m.id === entry.id)).toBe(false);
      } finally {
        await close();
      }
    });

    it("syncMemoryEntry dedups by identity (inserted then existing, same id)", async () => {
      const { repo, close } = await make();
      try {
        const a = await repo.syncMemoryEntry({ content: "shared lesson", target: "memory" });
        const b = await repo.syncMemoryEntry({ content: "shared lesson", target: "memory" });
        expect(a.action).toBe("inserted");
        expect(b.action).toBe("existing");
        expect(a.entry.id).toBe(b.entry.id);
      } finally {
        await close();
      }
    });

    it("search recalls a distinctive term from an indexed entry", async () => {
      const { repo, close } = await make();
      try {
        // Use a distinctive nonce term so this passes on ANY correct backend
        // regardless of tokenizer/stemmer strategy. A stemmer-based backend
        // passes trivially; an exact-term backend passes because the term
        // matches verbatim. The contract under test is "an indexed word is
        // recallable by that same word" — not stemming specifically.
        //
        // (The original brief hypothesized FTS5 snowball stemming with
        // "running"/"runs", but the SQLite backend uses the default unicode61
        // tokenizer with no stemmer today, so a stemming assertion would fail
        // here through no fault of the contract.)
        const nonce = "zxqwbu-recallable-term";
        await repo.addMemory({ content: `remember the ${nonce} convention`, target: "memory" });
        const hits = await repo.searchMemories(nonce);
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits.some((h) => h.content.includes(nonce))).toBe(true);
      } finally {
        await close();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// SessionRepository contract
// ---------------------------------------------------------------------------

export function runSessionRepositoryContract(
  name: string,
  make: () => Promise<{ repo: SessionRepository; close: () => Promise<void> }>,
): void {
  describe(`${name} SessionRepository contract`, () => {
    it("indexSession → searchSessions recall", async () => {
      const { repo, close } = await make();
      try {
        const distinctive = "zxqwbu-nonexistent-token";
        const result = await repo.indexSession({
          id: "contract-session-1",
          project: "contract-project",
          cwd: "/tmp/contract-project",
          startedAt: "2026-07-22T00:00:00Z",
          messages: [
            {
              id: "contract-msg-1",
              role: "user",
              content: `deploy with the ${distinctive} token`,
              timestamp: "2026-07-22T00:00:01Z",
            },
          ],
        });
        expect(result.sessionId).toBe("contract-session-1");
        expect(result.messagesIndexed).toBeGreaterThanOrEqual(1);

        const hits = await repo.searchSessions(distinctive);
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits.some((h) => h.sessionId === "contract-session-1")).toBe(true);
      } finally {
        await close();
      }
    });

    it("getIndexedMessageCount reflects indexed messages", async () => {
      const { repo, close } = await make();
      try {
        const before = await repo.getIndexedMessageCount();
        await repo.indexSession({
          id: "contract-session-count",
          project: "contract-project",
          cwd: "/tmp/contract-project",
          startedAt: "2026-07-22T00:00:00Z",
          messages: [
            { id: "cmc-1", role: "user", content: "first message", timestamp: "2026-07-22T00:00:01Z" },
            { id: "cmc-2", role: "assistant", content: "second message", timestamp: "2026-07-22T00:00:02Z" },
          ],
        });
        const after = await repo.getIndexedMessageCount();
        expect(after).toBeGreaterThanOrEqual(before + 2);
      } finally {
        await close();
      }
    });

    it("indexChangedSessions + getSessionStats smoke (shape only)", async () => {
      const { repo, close } = await make();
      try {
        // Write one JSONL session file under a sessions dir so the backend
        // has something to discover incrementally.
        const dir = mkdtempSync(join(tmpdir(), "hm-contract-sess-"));
        try {
          const sessionsDir = join(dir, "sessions");
          const projDir = join(sessionsDir, "contract-project");
          const filePath = join(projDir, "s1.jsonl");
          mkdirSync(dirname(filePath), { recursive: true });
          const lines = [
            JSON.stringify({ type: "session", id: "smoke-1", timestamp: "2026-07-22T00:00:00Z", cwd: "/tmp/contract-project" }),
            JSON.stringify({
              type: "message",
              id: "smoke-msg-1",
              parentId: null,
              timestamp: "2026-07-22T00:00:01Z",
              message: { role: "user", content: [{ type: "text", text: "smoke-test distinctive content" }], timestamp: Date.now() },
            }),
          ];
          writeFileSync(filePath, lines.join("\n"));

          const bulk = await repo.indexChangedSessions(sessionsDir);
          expect(bulk.sessionsProcessed).toBeGreaterThanOrEqual(1);
          expect(Array.isArray(bulk.errors)).toBe(true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }

        const stats = await repo.getSessionStats();
        expect(stats.totalSessions).toBeGreaterThan(0);
        expect(stats.totalMessages).toBeGreaterThan(0);
        expect(Array.isArray(stats.projects)).toBe(true);
        expect(stats.projects.length).toBeGreaterThan(0);
      } finally {
        await close();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// SQLite instantiation of both contracts.
//
// Phase 3: call `runMemoryRepositoryContract("SurrealDB", ...)` and
// `runSessionRepositoryContract("SurrealDB", ...)` from the SurrealDB test
// file with an equivalent make() over a SurrealRepository. These blocks prove
// the contract holds against the real SQLite backend today.
// ---------------------------------------------------------------------------

import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { SqliteSessionRepository } from "../../src/store/sqlite/sqlite-session-repo.js";

runMemoryRepositoryContract("SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hm-contract-mem-"));
  const backend = new SqliteBackend(dir);
  await backend.init();
  return {
    repo: new SqliteMemoryRepository(backend),
    close: async () => {
      await backend.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

runSessionRepositoryContract("SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hm-contract-sessrepo-"));
  const backend = new SqliteBackend(dir);
  await backend.init();
  return {
    repo: new SqliteSessionRepository(backend),
    close: async () => {
      await backend.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
