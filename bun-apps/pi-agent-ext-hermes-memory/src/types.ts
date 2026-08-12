/**
 * Shared TypeScript types for the Hermes Memory extension.
 */

import type { TextContent } from "@earendil-works/pi-ai";

export type MemoryOverflowStrategy = "auto-consolidate" | "reject" | "fifo-evict" | "vault-offload";

export type SessionSearchVariant = "legacy" | "anchors";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// "subprocess" removed in the spawnSubagent migration — the fallback is now spawnSubagent, not a pi -p subprocess.
export type ReviewTransport = "direct";

export type DbBackend = "sqlite" | "surrealdb";

export interface SurrealConnection {
  endpoint: string;
  namespace: string;
  database: string;
  username: string;
  password: string;
}

export interface SessionSearchConfig {
  /** Session search implementation variant. Default: legacy */
  variant: SessionSearchVariant;
}

/** Failure-memory model generation. "legacy" (default) = today's behavior;
 *  "v1" = topic-key dedup + recurrence→skill graduation warning + deterministic
 *  backlog canonicalization (wayfind effort 2026-08-05). Mirrors `memoryMode`'s
 *  flag shape. ⚠ paired with config.ts loadConfig allowlist (the drift trap). */
export type FailureModel = "legacy" | "v1";

export interface MemoryConfig {
  /** Prompt memory mode. Default: policy-only */
  memoryMode: "policy-only" | "legacy-inject";
  /** Failure-memory model generation. Default "legacy". See `FailureModel`. */
  failureModel?: FailureModel;
  /** Policy prompt style used when memoryMode is policy-only. Default: full */
  memoryPolicyStyle?: "full" | "compact" | "custom" | "none";
  /** Custom policy prompt text used when memoryPolicyStyle is custom */
  memoryPolicyCustomText?: string;
  /** Max chars for MEMORY.md (agent notes). Default: 5000 */
  memoryCharLimit: number;
  /** Max chars for USER.md (user profile). Default: 5000 */
  userCharLimit: number;
  /** Max chars for project-level MEMORY.md. Default: 5000 */
  projectCharLimit: number;
  /** Max chars for failures.md (shared global failure store). Default: 40000 */
  failureCharLimit?: number;
  /** Turns between background auto-reviews. Default: 10 */
  nudgeInterval: number;
  /** Recent conversation messages included in background review. 0 = all. Default: 0 */
  reviewRecentMessages?: number;
  /** Enable background learning loop. Default: true */
  reviewEnabled: boolean;
  /** How background review invokes the LLM. Default: direct */
  reviewTransport?: ReviewTransport;
  /** Flush memories before compaction. Default: true */
  flushOnCompact: boolean;
  /** Flush memories on session shutdown. Default: true */
  flushOnShutdown: boolean;
  /** Minimum user turns before flush triggers. Default: 6 */
  flushMinTurns: number;
  /** Recent conversation messages included in session flush. 0 = all. Default: 0 */
  flushRecentMessages?: number;
  /** Override extension storage directory. Default: ~/.pi/agent/pi-hermes-memory */
  memoryDir?: string;
  /** Directory for project-scoped memory (relative to ~/.pi/agent). Default: "projects-memory" */
  projectsMemoryDir?: string;
  /** Project memory source-of-truth location (ticket 04, decision 01). Default:
   *  <cwd>/.agents/memory/ (in-repo, git-trackable); null → opt-out (legacy
   *  ~/.pi/agent/<projectsMemoryDir>/<project>/); explicit string → that path
   *  (cwd-relative). See resolveProjectStoreDir(). */
  projectMemoryDir?: string | null;
  /** Opt-in: autocommit agent-written `.agents/memory/MEMORY.md` to the current
   *  (non-protected) git branch, batched per session via a trailing debounce on
   *  message_end (autocommit-hook effort, ticket 01). Default: false. Set
   *  `true` via the repo-local overlay at `<cwd>/.agents/memory/config.json`
   *  (narrow — only project-memory keys ride that overlay). */
  autoCommitProjectMemory?: boolean;
  /** Stable project tag for cross-worktree coherence (ticket 09). When set
   *  (via the repo-local overlay `<cwd>/.agents/memory/config.json`), it
   *  overrides `path.basename(cwd)` so all worktrees of one repo tag the same
   *  committed MEMORY.md under one project name. Default: undefined → cwd
   *  basename (legacy detectProject behavior). */
  projectName?: string;
  /** Session search configuration. Default: { variant: "legacy" } */
  sessionSearch?: SessionSearchConfig;
  /** Override model used for child pi -p subprocess LLM calls. Default: unset */
  llmModelOverride?: string;
  /** Override thinking level used for child pi -p subprocess LLM calls. Default: unset */
  llmThinkingOverride?: ThinkingLevel;
  /** Strategy when memory is full. Default: auto-consolidate */
  memoryOverflowStrategy?: MemoryOverflowStrategy;
  /** Legacy alias for memoryOverflowStrategy. Default: true */
  autoConsolidate: boolean;
  /** Detect user corrections and trigger immediate memory save. Default: true */
  correctionDetection: boolean;
  /** Auto-capture lesson-worthy tool errors (stack traces, definitive
   *  failures) to the failure store without an agent memory call. Default: true */
  errorCapture?: boolean;
  /** Increment memory-worth counters on session outcome (correction→fail, else→success). Default: true */
  worthScoring?: boolean;
  /** Min normalized fragment length (chars) for an entry to earn a "used"
   *  signature (UPSP §9 / ticket #06). Entries whose longest fragment is
   *  shorter are surfaced but never credited as "used" — too generic to
   *  attribute. Default: 24. */
  usedSignatureMinChars?: number;
  /** Detect "used" surfaced entries by content-signature match at turn_end and
   *  stamp `used_at` on the matched assembly rows (UPSP §9 / ticket #06).
   *  INDEPENDENT of `worthScoring`. Default: true (set `false` to disable). */
  usedDetection?: boolean;
  /** Per-entry heat decay (UPSP §1 / ticket #1b). When true, eviction victim
   *  selection prefers lowest-heat non-pinned entries (stale-unused first,
   *  used+high-worth spared last). When false, eviction reverts to FIFO/file
   *  order — the disable path is a first-class, byte-identical-parity
   *  invariant. Default: true. */
  decayEnabled?: boolean;
  /** Recency-exp halflife in days for heat decay (UPSP §1 / ticket #1b).
   *  recencySpine = exp(-ageDays / halflifeDays). Default: 14. */
  decayHalflifeDays?: number;
  /** Worth multiplier weight (0..1) for heat decay (UPSP §1 / ticket #1b).
   *  worthMult = 1 + worthWeight * (laplace - 0.5); neutral 1.0 at laplace 0.5.
   *  Default: 0.15. */
  decayWorthWeight?: number;
  /** Heat bonus added for ever-used entries (UPSP §1 / ticket #1b). A small
   *  relative nudge; recency spine still drives staleness. Default: 0.1. */
  decayUsedBonus?: number;
  /** UPSP §1 proactive consolidation — fire a bounded pass over the decayed
   *  tail before overflow. Off by default (opt-in). The other four knobs tune
   *  the candidate set, trigger threshold, and rate limit. */
  proactiveConsolidateEnabled: boolean;
  /** Heat floor: an entry with heat < floor is a decay-pressure candidate.
   *  Range [0, 1]. Default: 0.25. */
  proactiveHeatFloor: number;
  /** K cap on the proactive candidate set (positive int). Default: 20. */
  proactiveMaxCandidates: number;
  /** Min below-floor count required to trigger a proactive pass (>= 0).
   *  Default: 10. */
  proactivePressureThreshold: number;
  /** Min interval (minutes) between proactive passes (>= 0). Default: 30. */
  proactiveCooldownMinutes: number;
  /** Auto-supersede a recalled memory when a correction contradicts it (judge-gated).
   *  Default: false (opt-in — supersession hides the prior from search). */
  autoSupersede?: boolean;
  /** Per-session errorCapture rate limit (0 = unlimited). #854 */
  errorCaptureRateLimit?: number;
  /** errorCapture sliding-window length in ms. #854 */
  errorCaptureRateWindowMs?: number;
  /** errorCapture this-session dedup LRU capacity (0 = no fast-path). #854 */
  errorCaptureDedupCacheSize?: number;
  /** Override strong correction regex sources. Missing = defaults; [] = none. */
  correctionStrongPatterns?: string[];
  /** Override weak correction regex sources. Missing = defaults; [] = none. */
  correctionWeakPatterns?: string[];
  /** Override negative correction regex sources. Missing = defaults; [] = none. */
  correctionNegativePatterns?: string[];
  /** Override directive words used after weak correction patterns. Missing = defaults; [] = none. */
  correctionDirectiveWords?: string[];
  /** Inject recent failure memories into the system prompt. Default: true */
  failureInjectionEnabled: boolean;
  /** Maximum age in days for injected failure memories. Default: 7 */
  failureInjectionMaxAgeDays: number;
  /** Maximum number of failure memories to inject. Default: 5 */
  failureInjectionMaxEntries: number;
  /** Tool calls before triggering background review (in addition to turn count). Default: 15 */
  nudgeToolCalls: number;
  /** Maximum time in milliseconds for auto-consolidation to complete. Default: 60000 */
  consolidationTimeoutMs: number;
  /** Database backend selection. Default: sqlite */
  dbBackend?: DbBackend;
  /** Optional SurrealDB connection configuration (only used when dbBackend is surrealdb) */
  surreal?: Partial<SurrealConnection>;
  /** proper-lockfile acquire retry budget per lock attempt. Default: 200 (~50s poll). */
  lockAcquireRetries?: number;
  /** Op-level retries when cross-process lock acquisition throws ELOCKED. Default: 3 */
  lockOpRetries?: number;
  /** Backoff (ms) between op-level lock retries. Default: 2000 */
  lockOpBackoffMs?: number;

  // ─── Vector / semantic search (ticket 14 phase A / HNSW embed index) ──
  // The card_vectors HNSW side-table is INDEPENDENT of the CRUD backend
  // (sqlite-vec is not loadable under Bun — Decision 04 Fork C). These knobs
  // configure the embedding model + KNN query. Registered in DEFAULT_CONFIG +
  // the parse allowlist from day one (#06 config-gap lesson).
  /** LM Studio embedding model id (the card_vectors index is keyed by
   *  embedModelVersion so a swap re-embeds). Default: nomic-embed-text-v1.5. */
  embedModel?: string;
  /** Stable model-lineage tag in the card_vectors delta-key (distinct from
   *  embedModel which is the endpoint id). Default: "nomic-embed-text-v1.5". */
  embedModelVersion?: string;
  /** LM Studio base URL serving the embedding model. Default: http://127.0.0.1:1234. */
  lmStudioBaseUrl?: string;
  /** K for the HNSW KNN query (top-K nearest neighbors). Default: 10. */
  vectorTopK?: number;
  /** HNSW exploration factor (ef) for the KNN query. Default: 100. */
  vectorEf?: number;
}

/** Trust/auditability marker for a memory entry. Markdown-resident only. */
export type Provenance = "verified" | "unverified" | "none";

/** A grounding source attached to a memory entry (quote, doc ref, etc.). */
export interface MemorySource {
  kind: string;     // e.g. "quote", "doc", "url"
  locator: string;  // stable ref into the source (session id, url, line)
  capture: string;  // the verbatim text/anchor
}

export type MemoryCategory =
  | "failure"
  | "correction"
  | "insight"
  | "preference"
  | "convention"
  | "tool-quirk";

/** Lifecycle state for failure-target entries. Default/invalid → `active`. */
export type FailureState = "active" | "resolved" | "acquired";

export interface MemoryResult {
  success: boolean;
  error?: string;
  message?: string;
  warning?: string;
  warnings?: string[];
  target?: "memory" | "user" | "failure" | "project";
  entries?: string[];
  usage?: string;
  entry_count?: number;
  /** CONTENT of evicted entries (archive + display consumer). Paired with
   *  `evicted_md_ids` (DB-sync consumer). Steady-state DB removal keys on
   *  `evicted_md_ids` (md_id), NOT this content field — see ticket 04. */
  evicted_entries?: string[];
  /** Stable frontmatter ids of evicted entries (DB-sync consumer). One id per
   *  `evicted_entries` item that HAD a frontmatter id; comment-shape entries
   *  (no id) are skipped here — their DB-sync is intentionally dropped rather
   *  than falling back to content-key matching. */
  evicted_md_ids?: string[];
  evicted_count?: number;
  matches?: string[];
  /** CONTENT of transferred entries (archive via writeTransferArchive + display
   *  consumer). Paired with `transferred_md_ids` (DB-sync consumer). */
  transferred_entries?: string[];
  /** Stable frontmatter ids of transferred entries (DB-sync consumer). */
  transferred_md_ids?: string[];
  transferred_count?: number;
  freed_chars?: number;
  archive_path?: string;
  /** md_ids of superseded entries purged from .md on overflow (D2). md_id-ONLY —
   *  this path has NO archive/display consumer (destructive, no audit row), so
   *  it never carried content. Caller syncs the DB rows via `removeByMdId`
   *  (ticket 04: full replace, no content-key fallback). */
  offloaded_superseded?: string[];
  /** INTERNAL sentinel (2-phase consolidation): set by `_addInner`'s overflow
   *  branch to signal `_add` that consolidation must run OUTSIDE the held
   *  cross-process file lock (step 2 is lock-free). Never returned to the tool
   *  layer — `_add` always consumes it. Carries the accrued superseded purge
   *  set on `offloaded_superseded` so the retried write threads it down. */
  needsConsolidation?: boolean;

  /** The minted stable id of the entry just BIRTHED by this op (add/replace),
   *  written to BOTH sides: the `.md` frontmatter `id` AND the DB row's `md_id`
   *  (the caller threads it into `syncMemoryEntry`/`replaceSyncedMemories`).
   *  Absent when nothing was birthed (duplicate / hard-reject). This is the
   *  write-path half of the 5d bridge (Task 7 / F1 fix): pre-5d an in-session
   *  birth stayed id-less until the next restart's backfill, so an evicted /
   *  transferred / superseded in-session entry had an empty md_id set and
   *  orphaned its DB row. */
  added_md_id?: string;
}

export interface MemorySnapshot {
  memory: string;
  user: string;
}

export interface ConsolidationResult {
  /** Whether consolidation succeeded */
  consolidated: boolean;
  /** Error message if consolidation failed */
  error?: string;
  /** Whether the consolidator child was terminated (the 60s cap / cancellation).
   *  Surfaced so perf tracking can stamp `timedOut` on the consolidation record. */
  terminated?: boolean;
}

export type SkillScope = "global" | "project";

export interface SkillIndex {
  /** Stable id for read/update/delete operations */
  skillId: string;
  /** Whether the skill is global or project-scoped */
  scope: SkillScope;
  /** File name on disk (usually SKILL.md) */
  fileName: string;
  /** Absolute path to the skill file */
  path: string;
  /** Active project name for project-scoped skills */
  projectName?: string;
  /** Pi skill slug stored in frontmatter and folder name */
  name: string;
  /** Optional human-friendly title preserved for UI output */
  displayName?: string;
  /** Short description shown in skill listings */
  description: string;
  /** ISO date created */
  created: string;
  /** ISO date last updated */
  updated: string;
}

export interface SkillDocument extends SkillIndex {
  /** Full markdown body (after frontmatter) */
  body: string;
  /** Version number */
  version: number;
}

export interface SkillResult {
  success: boolean;
  error?: string;
  message?: string;
  fileName?: string;
  skillId?: string;
  scope?: SkillScope;
  path?: string;
  conflictType?: "duplicate" | "similar" | "name-collision" | "scope-conflict";
  similarSkillIds?: string[];
  suggestedAction?: "patch" | "update" | "rename";
}

/**
 * Extract displayable text from a Pi session entry message.
 *
 * Accepts any value — returns null for non-message entries (BashExecutionMessage,
 * NotificationMessage, etc.) that lack a `content` property.
 *
 * Returns the concatenated text, truncated to `maxLength` chars.
 */
export function getMessageText(msg: unknown, maxLength = 500): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const { role, content } = msg as Record<string, unknown>;
  if (typeof role !== "string") return null;

  if (typeof content === "string") {
    return content.slice(0, maxLength);
  }
  if (Array.isArray(content)) {
    const text = (content as TextContent[])
      .filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return text.length > 0 ? text.slice(0, maxLength) : null;
  }
  return null;
}
