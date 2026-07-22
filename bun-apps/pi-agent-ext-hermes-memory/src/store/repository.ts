/**
 * Backend-neutral repository seam for pi-hermes-memory.
 * Pure types only — no implementation, no backend imports.
 * This file IS the abstraction boundary: upstream imports only from here.
 */

export type MemoryTarget = "memory" | "user" | "failure";
export type { MemoryCategory } from "../types.js";

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
}

export interface MemorySyncResult { action: "inserted" | "existing"; entry: MemoryEntry; }
export interface MemoryUpdateResult { matched: number; updated: number; entries: MemoryEntry[]; }
export interface MemoryRemoveResult { matched: number; removed: number; }
export interface MemoryRemoveOptions { target: MemoryTarget; project?: string | null; }
export interface MemorySearchOptions { project?: string | null; target?: MemoryTarget; category?: import("../types.js").MemoryCategory; limit?: number; }
export interface MemoryListOptions { project?: string | null; target?: MemoryTarget; category?: import("../types.js").MemoryCategory; }
export interface MemoryStats { total: number; byProject: { project: string | null; count: number }[]; byTarget: { target: string; count: number }[]; }

export interface MemoryRepository {
  addMemory(input: {
    content: string; target?: MemoryTarget; project?: string | null;
    category?: import("../types.js").MemoryCategory | null;
    failureReason?: string | null; toolState?: string | null; correctedTo?: string | null;
    created?: string; lastReferenced?: string;
  }): Promise<MemoryEntry>;
  syncMemoryEntry(input: MemorySyncInput): Promise<MemorySyncResult>;
  replaceSyncedMemories(oldText: string, updates: {
    content: string; target: MemoryTarget; project?: string | null;
    category?: import("../types.js").MemoryCategory | null;
    failureReason?: string | null; toolState?: string | null; correctedTo?: string | null;
    lastReferenced?: string | null;
  }): Promise<MemoryUpdateResult>;
  removeSyncedMemories(oldText: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult>;
  removeExactSyncedMemories(content: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult>;
  searchMemories(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  getMemories(options?: MemoryListOptions): Promise<MemoryEntry[]>;
  getRecentFailures(maxAgeDays?: number, project?: string | null): Promise<MemoryEntry[]>;
  getMemoryStats(): Promise<MemoryStats>;
  removeMemory(id: number): Promise<boolean>;
  touchMemory(id: number): Promise<void>;
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
  indexSession(session: { id: string; project?: string; cwd?: string; startedAt?: string; endedAt?: string; messages?: unknown[] }): Promise<IndexResult>;
  indexAllSessions(sessionsDir: string, projectDir?: string): Promise<BulkIndexResult>;
  indexChangedSessions(sessionsDir: string, options?: IncrementalIndexOptions): Promise<BulkIndexResult>;
  upsertSessionFileMeta(filePath: string, sessionId: string, options?: { size?: number; mtimeMs?: number }): Promise<void>;
  needsBackfill(sessionsDir: string, now?: number): Promise<boolean>;
  touchBackfillTimestamp(timestamp?: string): Promise<void>;
  searchSessions(query: string, options?: { project?: string | null; role?: "user" | "assistant" | "system"; limit?: number }): Promise<SessionSearchResult[]>;
  getIndexedMessageCount(): Promise<number>;
  getSessionStats(): Promise<SessionStats>;
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
}
