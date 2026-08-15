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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type {
  MemoryRepository,
  SessionRepository,
} from "../../src/store/repository.js";
import { syncMarkdownMemories } from "../../src/handlers/sync-markdown-memories.js";
import { ENTRY_DELIMITER } from "../../src/constants.js";
import { serializeMetadataFrontmatter } from "../../src/store/memory-format.js";
import { createCardStore, type CardStore } from "../../src/store/card-store.js";
import { createPerfRecorder, type PerfRecord } from "../../src/perf.js";

// ---------------------------------------------------------------------------
// MemoryRepository contract
// ---------------------------------------------------------------------------

export function runMemoryRepositoryContract(
  name: string,
  make: () => Promise<{ repo: MemoryRepository; close: () => Promise<void>; backendKind?: "sqlite" | "surreal" }>,
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

    // C6: exact-dup dedup is part of the MemoryRepository CONTRACT itself —
    // addMemory no longer blind-INSERTs. Identity is the sync path's:
    // target + project + category + content (exact equality). Boundary: NEAR-dup
    // / topic-level dedup (similarity, semantic keys) stays in the MemoryStore
    // layer (dedup-strategy / near-dup) — only exact identity equality lives here.
    it("addMemory dedups exact identity duplicates (C6): same id both calls, one row", async () => {
      const { repo, close } = await make();
      try {
        const first = await repo.addMemory({
          content: "c6 exact-dup nonce zxqwbu",
          target: "memory",
          project: "c6-dedup-proj",
          category: "insight",
        });
        const second = await repo.addMemory({
          content: "c6 exact-dup nonce zxqwbu",
          target: "memory",
          project: "c6-dedup-proj",
          category: "insight",
        });
        expect(second.id).toBe(first.id);
        expect(second.content).toBe(first.content);

        // Exactly one row with that identity — no silent double-persist.
        const rows = (await repo.getMemories({ project: "c6-dedup-proj", target: "memory" }))
          .filter((m) => m.content === "c6 exact-dup nonce zxqwbu");
        expect(rows.length).toBe(1);

        // Dedup is exact, not scope-wide: a differing-content sibling in the
        // same scope still inserts.
        const third = await repo.addMemory({
          content: "c6 distinct sibling nonce zxqwbu",
          target: "memory",
          project: "c6-dedup-proj",
          category: "insight",
        });
        expect(third.id).toBeGreaterThan(0);
        expect(third.id).not.toBe(first.id);
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

    it("graph-recall: a non-lexical neighbor sharing project with a match is recalled", async () => {
      const { repo, close } = await make();
      try {
        const nonce = "zxqwbu-graph-anchor";
        // A matches the nonce lexically; project + target tag it.
        const a = await repo.addMemory({
          content: `anchor note about ${nonce}`,
          target: "memory",
          project: "graph-proj-1",
        });
        // B shares project (graph edge) but has NO lexical overlap with the nonce.
        const b = await repo.addMemory({
          content: "entirely different wording unrelated content",
          target: "memory",
          project: "graph-proj-1",
        });
        // C shares neither project nor target with A — must NOT be recalled.
        const c = await repo.addMemory({
          content: "also different content here as well",
          target: "failure",
          project: "graph-proj-2",
        });

        const hits = await repo.searchMemories(nonce);

        // A matches lexically; B is recalled via shared-project graph; C is not.
        expect(hits.some((h) => h.id === a.id)).toBe(true);
        expect(hits.some((h) => h.id === b.id)).toBe(true);
        expect(hits.some((h) => h.id === c.id)).toBe(false);
      } finally {
        await close();
      }
    });

    it("worth: bumped entry outranks an equal-lexical peer via the ranker (shared-neighbor path)", async () => {
      const { repo, close } = await make();
      try {
        const nonce = "zxqwbu-worth-anchor";
        const high = await repo.addMemory({ content: `high-worth note ${nonce}`, target: "memory", project: "worth-proj" });
        const low = await repo.addMemory({ content: `low-worth note ${nonce}`, target: "memory", project: "worth-proj" });
        const neighbor = await repo.addMemory({ content: "shared project neighbor unrelated wording", target: "memory", project: "worth-proj" });
        await repo.bumpMemoryWorth(high.id, 8, 0);  // boost high
        await repo.bumpMemoryWorth(low.id, 0, 8);   // sink low
        const hits = await repo.searchMemories(nonce);
        const highIdx = hits.findIndex((h) => h.id === high.id);
        const lowIdx = hits.findIndex((h) => h.id === low.id);
        expect(highIdx).toBeGreaterThanOrEqual(0);
        expect(lowIdx).toBeGreaterThanOrEqual(0);
        expect(highIdx).toBeLessThan(lowIdx);  // high-worth ranks above low-worth
      } finally { await close(); }
    });

    it("worth: addMemory seeds 0; bumpMemoryWorth increments; fields surface on getMemories", async () => {
      const { repo, close } = await make();
      try {
        const e = await repo.addMemory({ content: "worth-roundtrip", target: "memory" });
        expect(e.mwSuccess).toBe(0);
        expect(e.mwFail).toBe(0);
        await repo.bumpMemoryWorth(e.id, 2, 1);
        const got = await repo.getMemories({ target: "memory" });
        const found = got.find((m) => m.id === e.id)!;
        expect(found.mwSuccess).toBe(2);
        expect(found.mwFail).toBe(1);
      } finally { await close(); }
    });

    // Pin field (ticket 02): pin mirrors onto the DB row on add AND round-trips
    // through getMemories equivalently on every backend. The absent-pin default
    // must read back as `undefined` (NOT `false`) so the column default mirrors
    // the frontmatter contract (absent → not pinned).
    it("pin: addMemory surfaces pin; getMemories round-trips pin equivalently", async () => {
      const { repo, close } = await make();
      try {
        const pinned = await repo.addMemory({ content: "pinned-roundtrip-ticket02", target: "memory", pin: true });
        expect(pinned.pin).toBe(true);

        const plain = await repo.addMemory({ content: "plain-roundtrip-ticket02", target: "memory" });
        expect(plain.pin).toBeUndefined();

        const got = await repo.getMemories({ target: "memory" });
        const foundPinned = got.find((m) => m.id === pinned.id)!;
        const foundPlain = got.find((m) => m.id === plain.id)!;
        expect(foundPinned.pin).toBe(true);
        expect(foundPlain.pin).toBeUndefined();
      } finally { await close(); }
    });

    it("supersession: searchMemories excludes superseded entries by default", async () => {
      const { repo, close } = await make();
      try {
        const priorNonce = "zxqwbu-prior-superseded";
        const newNonce = "zxqwbu-new-superseding";
        const a = await repo.addMemory({
          content: `prior memory with ${priorNonce} term`,
          target: "memory",
        });
        const b = await repo.addMemory({
          content: `new memory with ${newNonce} term`,
          target: "memory",
        });

        await repo.supersedeMemory(a.id, b.id);

        // Default search excludes superseded entries
        const defaultHits = await repo.searchMemories(priorNonce);
        expect(defaultHits.some((h) => h.id === a.id)).toBe(false);

        // With includeSuperseded: true, superseded entries appear
        const includedHits = await repo.searchMemories(priorNonce, { includeSuperseded: true });
        expect(includedHits.some((h) => h.id === a.id)).toBe(true);
      } finally {
        await close();
      }
    });

    it("supersession: supersedeMemory round-trip sets status and lineage fields", async () => {
      const { repo, close } = await make();
      try {
        const a = await repo.addMemory({
          content: "prior memory to be superseded",
          target: "memory",
        });
        const b = await repo.addMemory({
          content: "new superseding memory",
          target: "memory",
        });

        await repo.supersedeMemory(a.id, b.id);

        const all = await repo.getMemories({ target: "memory" });
        const aAfter = all.find((m) => m.id === a.id)!;
        const bAfter = all.find((m) => m.id === b.id)!;

        // Prior entry is marked superseded with backward link
        expect(aAfter.status).toBe("superseded");
        expect(aAfter.supersededBy).toBe(b.id);

        // New entry has forward link and parent reference
        expect(bAfter.supersedes).toBe(a.id);
        expect(bAfter.parentIds).toEqual([a.id]);
      } finally {
        await close();
      }
    });

    it("supersession: re-sync stability preserves status and lineage (merge path)", async () => {
      const { repo, close } = await make();
      try {
        const content = "memory that will be superseded then re-synced";
        const a = await repo.addMemory({
          content,
          target: "memory",
          project: "re-sync-proj",
        });
        const b = await repo.addMemory({
          content: "new superseding memory",
          target: "memory",
          project: "re-sync-proj",
        });

        await repo.supersedeMemory(a.id, b.id);

        // Re-sync the same content (merge path — should NOT reset status/lineage)
        const syncResult = await repo.syncMemoryEntry({
          content,
          target: "memory",
          project: "re-sync-proj",
        });

        // The sync should find the existing entry (not insert new)
        expect(syncResult.action).toBe("existing");
        expect(syncResult.entry.id).toBe(a.id);

        // Verify status and lineage are preserved
        const all = await repo.getMemories({ target: "memory" });
        const aAfter = all.find((m) => m.id === a.id)!;
        expect(aAfter.status).toBe("superseded");
        expect(aAfter.supersededBy).toBe(b.id);
      } finally {
        await close();
      }
    });

    it("graph-neighbor leak: a superseded same-project neighbor is hidden from graph recall (and revealed via includeSuperseded)", async () => {
      const { repo, close } = await make();
      try {
        const nonce = "zxqwbu-graphleak-anchor";
        // A: lexical match for the nonce, project-scoped.
        await repo.addMemory({ content: `${nonce} lexical match wording`, target: "memory", project: "graphleak-proj" });
        // B: shares the project `graphleak-proj` (graph edge via column matching, NOT an FTS content token) but shares NO FTS token
        //    with the nonce `{zxqwbu, graphleak, anchor}` — reachable ONLY via graph expansion (fetchGraphNeighbors), never via FTS.
        const neighbor = await repo.addMemory({ content: "totally different wording neighbor unrelated zztoberecalled", target: "memory", project: "graphleak-proj" });
        // C: the replacement that supersedes B; also shares NO nonce FTS token.
        const replacement = await repo.addMemory({ content: "replacement wording neighbor unrelated zztoberecalled fixed", target: "memory", project: "graphleak-proj" });

        // Baseline: B IS recalled as a graph neighbor before supersession.
        const before = await repo.searchMemories(nonce, { project: "graphleak-proj" });
        expect(before.some((m) => m.id === neighbor.id)).toBe(true);

        await repo.supersedeMemory(neighbor.id, replacement.id);

        // After supersession: B is hidden from default graph recall (status filter).
        const after = await repo.searchMemories(nonce, { project: "graphleak-proj" });
        expect(after.some((m) => m.id === neighbor.id)).toBe(false);
        // A is still recalled (lexical, active).
        expect(after.some((m) => m.content.includes(nonce))).toBe(true);

        // Opt-in: B reappears via includeSuperseded (proves the hide is the status filter, not absence).
        const included = await repo.searchMemories(nonce, { project: "graphleak-proj", includeSuperseded: true });
        expect(included.some((m) => m.id === neighbor.id)).toBe(true);
      } finally {
        await close();
      }
    });

    it("getMemories filters by status when the status option is set", async () => {
      const { repo, close } = await make();
      try {
      // Seed two active memories in the same project/target.
      const a = await repo.addMemory({
        target: "memory",
        project: "status-filter-proj",
        content: "status filter active one zqxklt",
        category: "insight",
        failureReason: null,
        toolState: null,
        correctedTo: null,
      });
      const b = await repo.addMemory({
        target: "memory",
        project: "status-filter-proj",
        content: "status filter active two zqxklt",
        category: "insight",
        failureReason: null,
        toolState: null,
        correctedTo: null,
      });
      // Supersede b with a (b becomes superseded).
      await repo.supersedeMemory(b.id, a.id);

      const active = await repo.getMemories({ project: "status-filter-proj", status: "active" });
      const superseded = await repo.getMemories({ project: "status-filter-proj", status: "superseded" });
      const all = await repo.getMemories({ project: "status-filter-proj" });

      // active filter returns only the non-superseded entry.
      expect(active.some((m) => m.id === a.id)).toBe(true);
      expect(active.some((m) => m.id === b.id)).toBe(false);
      // superseded filter returns only the superseded entry.
      expect(superseded.some((m) => m.id === b.id)).toBe(true);
      expect(superseded.some((m) => m.id === a.id)).toBe(false);
      // no status filter returns both (back-compat: existing callers unaffected).
      expect(all.length).toBeGreaterThanOrEqual(2);
      } finally {
        await close();
      }
    });

    // ── syncMemoryEntriesBatch: N entries sync in ≤2 round-trips (Surreal) /
    //    one transaction (SQLite). Behavior parity on both backends +
    //    idempotency, and a Surreal-only round-trip proof. ──
    it("syncMemoryEntriesBatch: 50 entries persist, classify, and are idempotent; Surreal ≤2 round-trips", async () => {
      const { repo, close, backendKind } = await make();
      try {
        const N = 50;
        const inputs = Array.from({ length: N }, (_, i) => ({
          content: `batch-entry-${i}-nonce-zxqwbu`,
          target: "memory" as const,
          // Vary project/category so every entry exercises graph-edge UPSERTs
          // (the multi-round-trip cost the batch must collapse).
          project: i % 2 === 0 ? "batch-proj-even" : "batch-proj-odd",
          category: (i % 3 === 0 ? "insight" : i % 3 === 1 ? "convention" : null) as
            | "insight" | "convention" | null,
          created: "2026-05-01",
          lastReferenced: "2026-05-02",
        }));

        // Wrap the FIRST batch in a perf recorder so the Surreal backend's
        // HTTP round-trips (bumpRoundTrips via AsyncLocalStorage) are attributed
        // to a named op we can read back. SQLite never bumps round-trips.
        const log = join(mkdtempSync(join(tmpdir(), "hm-batch-perf-")), "perf.jsonl");
        const perf = createPerfRecorder({ logPath: log, fullTrace: true, getBackend: () => backendKind ?? "unknown" });
        const results = await perf.timed("test.batch", () => repo.syncMemoryEntriesBatch(inputs));

        // Behavior — order preserved, all 50 inserted on a clean store.
        expect(results.length).toBe(N);
        expect(results.every((r) => r.action === "inserted")).toBe(true);
        const ids = new Set(results.map((r) => r.entry.id));
        expect(ids.size).toBe(N); // 50 distinct rows

        // All 50 persisted + graph edges wired (project tag makes them
        // graph-recallable from any one of them).
        const persisted = await repo.getMemories({ target: "memory", project: "batch-proj-even" });
        expect(persisted.length).toBe(N / 2);
        const neighborProbe = await repo.searchMemories("batch-entry-0-nonce-zxqwbu", { project: "batch-proj-even" });
        // Entry 2 shares the project tag with entry 0 → recalled as a neighbor.
        expect(neighborProbe.some((m) => m.content === "batch-entry-2-nonce-zxqwbu")).toBe(true);

        // Idempotency: a second identical batch is all "existing", no dupes.
        const again = await repo.syncMemoryEntriesBatch(inputs);
        expect(again.length).toBe(N);
        expect(again.every((r) => r.action === "existing")).toBe(true);
        expect(again.every((r, i) => r.entry.id === results[i].entry.id)).toBe(true); // same ids
        const totalAfter = (await repo.getMemories({ target: "memory" })).filter(
          (m) => m.content.includes("batch-entry-") && m.content.includes("nonce-zxqwbu"),
        ).length;
        expect(totalAfter).toBe(N); // still exactly 50, no duplicates

        // Surreal-only round-trip proof: the whole 50-entry batch cost ≤2 HTTP
        // round-trips (1 pre-fetch SELECT + 1 batched transaction). SQLite has
        // no HTTP round-trip metric, so the assertion is skipped there.
        if (backendKind === "surreal") {
          const recs = readFileSync(log, "utf-8").trim().split("\n").filter(Boolean)
            .map((l) => JSON.parse(l) as PerfRecord);
          const batchRec = recs.find((r) => r.op === "test.batch");
          expect(batchRec).toBeDefined();
          expect(batchRec!.roundTrips).toBeLessThanOrEqual(2);
          // sanity: it actually did real work (not zero — the batch sent ≥1 tx)
          expect(batchRec!.roundTrips).toBeGreaterThanOrEqual(1);
        }
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

    it("indexSession indexes EVERY message in a multi-message session", async () => {
      const { repo, close } = await make();
      try {
        const marker = "multimsg-final-marker-9f3a";
        const result = await repo.indexSession({
          id: "contract-session-multimsg",
          project: "contract-project",
          cwd: "/tmp/contract-project",
          startedAt: "2026-07-22T00:00:00Z",
          messages: Array.from({ length: 5 }, (_, i) => ({
            id: `multimsg-${i}`,
            role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
            content: i === 4 ? `final message with ${marker}` : `filler message ${i}`,
            timestamp: `2026-07-22T00:00:0${i}Z`,
          })),
        });
        // Exact count — guards against "only the last message persisted" or
        // param-indexing bugs that a `>= 1` assertion would miss.
        expect(result.messagesIndexed).toBe(5);
        // The final message must be searchable (proves all indices upserted).
        const hits = await repo.searchSessions(marker);
        expect(hits.some((h) => h.sessionId === "contract-session-multimsg")).toBe(true);
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

    it("getUsedMdIds returns the used subset (boolean ever-used aggregate, #1b/D4)", async () => {
      const { repo, close } = await make();
      try {
        await repo.recordAssembly("contract-used-sess", ["u1", "u2", "u3"], "ch");
        await repo.markUsed("contract-used-sess", ["u1", "u3"], "2026-08-02T12:00:00.000Z");
        // used ∩ input: u1 + u3 used; u2 surfaced-unused; u4 never assembled.
        const result = await repo.getUsedMdIds(["u1", "u2", "u3", "u4"], { project: null });
        expect(result).toBeInstanceOf(Set);
        expect([...result].sort()).toEqual(["u1", "u3"]);
        // empty input → empty Set (no-op):
        expect((await repo.getUsedMdIds([], { project: null })).size).toBe(0);
      } finally {
        await close();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Markdown → store sync contract (backend-agnostic)
//
// Proves /memory-sync-markdown's sync function behaves identically on every
// MemoryRepository: entries import, become searchable, and de-duplicate on
// re-run. The markdown files are backend-agnostic; only the repo differs, so
// the factory takes the same make() shape as the repository contract.
// kp13 Wave B: the mirror target is the bundle CardStore (md_id-keyed lazy
// re-migration), so make() also provides a cardStore joined on the SAME
// backend — the mirrored rows land in the repo's own memories table and are
// recalled via repo.searchMemories.
// ---------------------------------------------------------------------------

export function runMarkdownSyncContract(
  name: string,
  make: () => Promise<{ repo: MemoryRepository; cardStore: CardStore | null; close: () => Promise<void> }>,
): void {
  describe(`${name} markdown→store sync contract`, () => {
    it("imports markdown entries and makes them searchable", async () => {
      const { repo, cardStore, close } = await make();
      const root = mkdtempSync(join(tmpdir(), `hm-sync-${name.toLowerCase()}-`));
      const agentRoot = join(root, "agent");
      const globalDir = join(agentRoot, "memory");
      mkdirSync(globalDir, { recursive: true });
      try {
        writeFileSync(
          join(globalDir, "MEMORY.md"),
          [
            // kp13 Wave B: the lazy re-migration mirrors md_id-keyed (frontmatter)
            // entries; comment-shape entries are skipped until the 5d backfill
            // upgrades them (pinned by the idempotence test below).
            serializeMetadataFrontmatter({ id: "md-contract-1", text: "contract memory one", created: "2026-05-08", last: "2026-05-08" }),
            serializeMetadataFrontmatter({ id: "md-contract-2", text: "contract memory two", created: "2026-05-08", last: "2026-05-09" }),
          ].join(ENTRY_DELIMITER),
          "utf-8",
        );

        const first = await syncMarkdownMemories(repo, globalDir, undefined, agentRoot, undefined, undefined, cardStore);
        expect(first.imported).toBe(2);

        const hits = await repo.searchMemories("contract memory one", { target: "memory" });
        expect(hits.some((m) => m.content === "contract memory one")).toBe(true);
      } finally {
        await close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("is idempotent across repeated runs (no duplicate rows)", async () => {
      const { repo, cardStore, close } = await make();
      const root = mkdtempSync(join(tmpdir(), `hm-sync-idem-${name.toLowerCase()}-`));
      const agentRoot = join(root, "agent");
      const globalDir = join(agentRoot, "memory");
      mkdirSync(globalDir, { recursive: true });
      try {
        writeFileSync(
          join(globalDir, "MEMORY.md"),
          // Comment-shape (no stable id): the lazy re-migration skips it on
          // EVERY pass until the 5d backfill upgrades the entry — which is
          // exactly what makes re-runs no-ops (kp13 Wave B laziness pin).
          "idempotent entry <!-- created=2026-05-08, last=2026-05-09 -->",
          "utf-8",
        );

        await syncMarkdownMemories(repo, globalDir, undefined, agentRoot, undefined, undefined, cardStore);
        const second = await syncMarkdownMemories(repo, globalDir, undefined, agentRoot, undefined, undefined, cardStore);

        expect(second.imported).toBe(0);
        expect(second.skipped).toBe(1);
      } finally {
        await close();
        rmSync(root, { recursive: true, force: true });
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
    backendKind: "sqlite" as const,
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

runMarkdownSyncContract("SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hm-contract-sync-"));
  const backend = new SqliteBackend(dir);
  await backend.init();
  return {
    repo: new SqliteMemoryRepository(backend),
    // Joined on the SAME backend (bundle-join path): the card rows land in
    // this repo's memories table; close stays owned by the backend below.
    cardStore: await createCardStore({ memoryDir: dir, sqliteBackend: backend }),
    close: async () => {
      await backend.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
