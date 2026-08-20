/**
 * Backend-neutral repository seam for pi-hermes-memory.
 * Pure types only — no implementation, no backend imports.
 * This file IS the abstraction boundary: upstream imports only from here.
 */

export type MemoryTarget = "memory" | "user" | "failure";
import type { FailureState } from "../types.js";
import type { CardStore } from "./card-store.js";

export type { MemoryCategory, FailureState } from "../types.js";

export interface MemoryEntry {
  id: number;
  project: string | null;
  target: MemoryTarget;
  category: import("../types.js").MemoryCategory | null;
  content: string;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  created: string;
  lastReferenced: string;
  mwSuccess?: number;
  mwFail?: number;
  status?: "active" | "superseded";
  supersedes?: number | null;
  supersededBy?: number | null;
  parentIds?: number[];
  /** Stable markdown-side id mirrored from the `.md` frontmatter (ticket 05).
   *  SQLite column `md_id`; Surreal field `mdId`. Nullable until backfilled. */
  mdId?: string | null;
  /** Failure lifecycle state (Task 2 of hermes-failure-lifecycle).
   *  Failure-target only; defaults to `active` when absent. */
  state?: FailureState;
  /** Advisory failure severity (1–3) for failure-target entries. */
  severity?: number | null;
  /** Pin lock (ticket 02): a pinned entry is never eligible for overflow-driven
   *  eviction. Target-agnostic (memory/user/failure, unlike state/severity).
   *  Absent / false → unpinned; `true` is the only pinned state. Mirrors the
   *  `.md` frontmatter `pin` and the DB `pin` column (SQLite 0/1, Surreal bool). */
  pin?: boolean;
}

export interface MemorySyncInput {
  content: string;
  target: MemoryTarget;
  project?: string | null;
  category?: import("../types.js").MemoryCategory | null;
  failureReason?: string | null;
  toolState?: string | null;
  correctedTo?: string | null;
  created?: string | null;
  lastReferenced?: string | null;
  mwSuccess?: number | null;
  mwFail?: number | null;
  /** Stable markdown-side id to mirror onto the row (Task 7 / F1 fix). When
   *  set, BOTH the INSERT and the existing-row UPDATE stamp `md_id` with it so
   *  a birth / orphan-readd always lands the SAME uuid the `.md` frontmatter
   *  carries (SQLite column `md_id`; Surreal field `mdId`). Absent → leave the
   *  row's md_id untouched (preserves a backfilled id on a no-id re-sync). */
  mdId?: string | null;
  /** Failure lifecycle state to mirror onto the row (Task 2). Absent on INSERT
   *  → column default `active` applies; on UPDATE absent → leave untouched. */
  state?: FailureState;
  /** Advisory failure severity to mirror onto the row (Task 2). */
  severity?: number | null;
  /** Pin lock to mirror onto the row (ticket 02). Absent → column default 0
   *  (unpinned) applies; only literal `true` writes 1. */
  pin?: boolean;
}

export interface MemorySyncResult { action: "inserted" | "existing"; entry: MemoryEntry; }
export interface MemoryUpdateResult { matched: number; updated: number; entries: MemoryEntry[]; }
export interface MemoryRemoveResult { matched: number; removed: number; }
export interface MemoryRemoveOptions { target: MemoryTarget; project?: string | null; }
export interface MemorySearchOptions { project?: string | null; target?: MemoryTarget; category?: import("../types.js").MemoryCategory; limit?: number; includeSuperseded?: boolean; }
export interface MemoryListOptions { project?: string | null; target?: MemoryTarget; category?: import("../types.js").MemoryCategory; /** When set, filter by the supersession status column. Omit = return all. */ status?: "active" | "superseded"; }
export interface MemoryStats { total: number; byProject: { project: string | null; count: number }[]; byTarget: { target: string; count: number }[]; }

export interface MemoryRepository {
  /** C6: exact-dup dedup is part of THIS contract. Dedup identity mirrors
   *  syncMemoryEntry's: target + project + category + content (exact
   *  equality, NULL-aware). When a row with the identical identity already
   *  exists, NO duplicate row is inserted and the EXISTING entry is returned
   *  (identical calls return the same id). Contrast syncMemoryEntry, which
   *  additionally merges into the existing row and reports its action.
   *  Near-dup / topic-level dedup (similarity, semantic keys) stays a
   *  MemoryStore-layer concern — NOT part of this repository contract. */
  addMemory(input: {
    content: string; target?: MemoryTarget; project?: string | null;
    category?: import("../types.js").MemoryCategory | null;
    failureReason?: string | null; toolState?: string | null; correctedTo?: string | null;
    created?: string; lastReferenced?: string;
    /** Stable markdown-side id to stamp on the new row's md_id (Task 7). */
    mdId?: string | null;
    /** Failure lifecycle state to stamp on the new row (Task 2). */
    state?: FailureState;
    /** Advisory failure severity to stamp on the new row (Task 2). */
    severity?: number | null;
    /** Pin lock to stamp on the new row (ticket 02). Only literal `true` writes 1. */
    pin?: boolean;
  }): Promise<MemoryEntry>;
  syncMemoryEntry(input: MemorySyncInput): Promise<MemorySyncResult>;
  /** Sync N entries in ONE batched round-trip (Surreal: a single transaction;
   *  SQLite: a single BEGIN IMMEDIATE transaction). Returns one result per
   *  input, preserving order, so callers can classify inserted vs existing.
   *  Behavior is identical to N sequential `syncMemoryEntry` calls; only the
   *  transport is collapsed. Keeps `syncMemoryEntry` for non-batch callers. */
  syncMemoryEntriesBatch(inputs: MemorySyncInput[]): Promise<MemorySyncResult[]>;
  replaceSyncedMemories(oldText: string, updates: {
    content: string; target: MemoryTarget; project?: string | null;
    category?: import("../types.js").MemoryCategory | null;
    failureReason?: string | null; toolState?: string | null; correctedTo?: string | null;
    lastReferenced?: string | null;
    /** Stable markdown-side id to stamp onto the updated row's md_id (Task 7):
     *  a replace births a NEW entry, so the row's md_id tracks the replacement's
     *  fresh uuid, not the superseded entry's id. Absent → md_id untouched. */
    mdId?: string | null;
    /** Failure lifecycle state to stamp onto the updated row (Task 2).
     *  Absent → state untouched. */
    state?: FailureState;
    /** Advisory failure severity to stamp onto the updated row (Task 2). */
    severity?: number | null;
    /** Pin lock to stamp onto the updated row (ticket 02). Absent → pin untouched. */
    pin?: boolean;
  }): Promise<MemoryUpdateResult>;
  removeSyncedMemories(oldText: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult>;
  /** @deprecated backfill-only — use {@link removeByMdId} in steady state.
   *  Retained for the Task 4 content-key backfill + the surreal graph-edge
   *  test; steady-state eviction/transfer/supersede DB-sync keys on md_id. */
  removeExactSyncedMemories(content: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult>;
  /** Remove the (scope-matched) row whose `md_id = mdId`. Steady-state DB-sync
   *  for eviction / transfer / offloaded-superseded (ticket 04: full replace,
   *  no content-key fallback). SQLite column `md_id`; Surreal field `mdId`. */
  removeByMdId(mdId: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult>;
  /** Return the `md_id` of the (scope-matched) row whose `content = content.trim()`,
   *  or `null` when no such row exists / its `md_id` is not yet backfilled.
   *  Used by the Task 4 backfill to avoid double-assigning a stable id. */
  getMdIdByContent(content: string, options: MemoryRemoveOptions): Promise<string | null>;
  /** Mirror a freshly-minted stable id onto the (scope-matched) row whose
   *  `content = content.trim()`. Returns the number of rows updated (0 when no
   *  DB row matches the content key yet — the .md entry is upgraded regardless,
   *  and a later sync will create the row). Best-effort: callers swallow errors.
   *  SQLite stores the column as `md_id`; Surreal stores the field as `mdId`. */
  setMdIdByContent(content: string, mdId: string, options: MemoryRemoveOptions): Promise<number>;
  searchMemories(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  getMemories(options?: MemoryListOptions): Promise<MemoryEntry[]>;
  getRecentFailures(maxAgeDays?: number, project?: string | null): Promise<MemoryEntry[]>;
  getMemoryStats(): Promise<MemoryStats>;
  removeMemory(id: number): Promise<boolean>;
  touchMemory(id: number): Promise<void>;
  bumpMemoryWorth(id: number, successDelta?: number, failDelta?: number): Promise<void>;
  supersedeMemory(priorId: number, newId: number): Promise<void>;
}

export interface SessionRecord { id: string; project: string; cwd: string; startedAt: string; endedAt: string | null; messageCount: number; }
export interface MessageRecord { id: string; sessionId: string; role: "user" | "assistant" | "system"; content: string; timestamp: string; toolCalls: string | null; }
export interface SessionFileMeta { path: string; sessionId: string; size: number; mtimeMs: number; indexedAt: string; }
export interface SessionSearchResult { sessionId: string; messageId: string; role: "user" | "assistant" | "system"; content: string; timestamp: string; project: string; cwd: string; }

/** Result of indexing a single session (mirrors the original IndexResult). */
export interface IndexResult { sessionId: string; messagesIndexed: number; skipped: boolean; }

/** Result of a bulk index run (mirrors the original BulkIndexResult). Callers consume every field. */
export interface BulkIndexResult {
  sessionsProcessed: number;
  sessionsIndexed: number;
  sessionsSkipped: number;
  messagesIndexed: number;
  errors: string[];
  reachedLimit?: boolean;
}

export interface IncrementalIndexOptions { projectDir?: string; maxFilesToIndex?: number; }

export interface SessionStats {
  totalSessions: number;
  totalMessages: number;
  projects: { project: string; sessions: number; messages: number }[];
}

export interface SessionRepository {
  indexSession(session: { id: string; project?: string; cwd?: string; startedAt?: string; endedAt?: string | null; messages?: unknown[] }): Promise<IndexResult>;
  indexAllSessions(sessionsDir: string, projectDir?: string): Promise<BulkIndexResult>;
  indexChangedSessions(sessionsDir: string, options?: IncrementalIndexOptions): Promise<BulkIndexResult>;
  upsertSessionFileMeta(filePath: string, sessionId: string, options?: { size?: number; mtimeMs?: number }): Promise<void>;
  needsBackfill(sessionsDir: string, now?: number): Promise<boolean>;
  touchBackfillTimestamp(timestamp?: string): Promise<void>;
  searchSessions(query: string, options?: { project?: string | null; role?: "user" | "assistant" | "system"; limit?: number }): Promise<SessionSearchResult[]>;
  getIndexedMessageCount(): Promise<number>;
  getSessionStats(): Promise<SessionStats>;
  /** Per-session prompt-provenance (UPSP §5): record the assembled md_id set + block hash.
   *  Idempotent (re-call replaces). Best-effort: callers swallow throws. */
  recordAssembly(sessionId: string, mdIds: readonly string[], hash: string): Promise<void>;
  /** Per-session "used vs dropped" signal (UPSP §9, ticket #06): stamp `used_at` on the
   *  surfaced assembly rows the agent's output actually referenced. Sets ONLY the
   *  matched `(sessionId, mdId)` rows for that session; non-matched rows stay null.
   *  Idempotent (a re-mark re-stamps / no-ops). Empty `mdIds` is a no-op. Best-effort:
   *  callers swallow throws. NEVER touches `session_assembly_meta` or any other table. */
  markUsed(sessionId: string, mdIds: readonly string[], usedAt: string): Promise<void>;
  /** Per-entry boolean ever-used aggregate (UPSP §1/D4, ticket #1b decay): returns
   *  the subset of `mdIds` that have ≥1 `session_assembly` row with
   *  `used_at IS NOT NULL` (the entry was content-matched in assistant text when
   *  surfaced, per #06). One batched query; empty `mdIds` → empty Set (no-op, no SQL).
   *
   *  `session_assembly` is a GLOBAL provenance ledger — FK-free by design (the
   *  sessions row is created later by deferred backfill) and carries NO `project`
   *  column in either backend (SQLite `session_assembly(session_id, md_id, used_at)`;
   *  Surreal SCHEMALESS `session_assembly{sessionId, mdId, usedAt}`). The boolean
   *  ever-used signal is therefore cross-project by construction (a row landed
   *  here regardless of which session/project surfaced it), so `opts.project` is
   *  ACCEPTED for interface symmetry but IGNORED — the result is never scoped to a
   *  project. (Project lives on `sessions`, and joining `session_assembly`→`sessions`
   *  for scoping would miss not-yet-backfilled rows; intentionally avoided.) */
  getUsedMdIds(mdIds: string[], opts: { project: string | null }): Promise<Set<string>>;
}

/**
 * Backend lifecycle. NO getDb(), NO withCorruptionRecovery() — those are
 * SQLite implementation details. Retry/corruption recovery is internal to
 * each backend's repository methods.
 */
export interface Backend {
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<void>;
}

export interface BackendBundle {
  backend: Backend;
  memoryRepo: MemoryRepository;
  sessionRepo: SessionRepository;
  /** kp13 Wave A: the kind-agnostic Card store joined onto the bundle —
   *  SAME backend lifetime as the repos (sqlite: shares the bundle's backend
   *  handle, so closing the bundle closes it; surrealdb: built on the bundle's
   *  SurrealMemoryRepository). A live backend swap (see index.ts switchTo)
   * re-bundles, so a cardStore captured through the bundle always follows the
   * active backend. */
  cardStore: CardStore;
}
