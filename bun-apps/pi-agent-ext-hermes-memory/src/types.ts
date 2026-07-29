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

export interface MemoryConfig {
  /** Prompt memory mode. Default: policy-only */
  memoryMode: "policy-only" | "legacy-inject";
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
  evicted_entries?: string[];
  evicted_count?: number;
  matches?: string[];
  transferred_entries?: string[];
  transferred_count?: number;
  freed_chars?: number;
  archive_path?: string;
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
