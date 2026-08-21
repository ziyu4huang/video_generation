/**
 * Workflow run state persistence for pause/resume support.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHistoryEntry, WorkflowErrorCode } from "@repo/s2-agent-core-runtime";
import { agentCounts, type WorkflowSnapshot } from "./display.js";
import type { ManifestIo } from "./workflow-pack-manifest.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  startedAt?: string;
  endedAt?: string;
  /** Tokens used by this agent; absent on runs persisted before this field
   *  existed (mapped back as undefined → UI renders 0 via `?? 0`). */
  tokens?: number;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
}

/**
 * The serializable subset of a run's ExecOptions, captured at start so that
 * resume() re-runs with the SAME caps the run was started with. Without this a
 * run paused precisely because it hit its token budget would resume unbounded,
 * and maxAgents/concurrency/timeout/retries would silently reset to defaults.
 */
export interface PersistedExecOptions {
  maxAgents?: number;
  agentTimeoutMs?: number | null;
  tokenBudget?: number | null;
  concurrency?: number;
  agentRetries?: number;
  /** Pack identity (decision 08); absent for inline scripts. */
  packId?: string;
  /** Pack-local state root; routes resume() to the pack store (T5b). */
  stateRoot?: string;
  /** Pack dirs + io contract; re-threaded into executeRun on resume (T5b). */
  intermediateDir?: string;
  outputsDir?: string;
  io?: ManifestIo;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** Execution caps captured at start; rehydrated by resume(). */
  exec?: PersistedExecOptions;
  /** The pi session this run belongs to. Runs persist on disk across sessions but
   * the navigator shows only the current session's runs (undefined = legacy/global). */
  sessionId?: string;
  /** True if this run was started (or resumed) in the background — i.e. its result
   * is delivered via installResultDelivery rather than returned inline as the tool
   * result. Used by session_start re-delivery to pick runs eligible for redelivery
   * (a foreground sync run already returned its result inline). Absent on runs
   * persisted before this field existed → treated as "not eligible" (manual
   * `/workflows result <id>` recovery only). */
  background?: boolean;
  /** ISO timestamp marking when a background run's result was delivered into a
   * conversation. Absent = never delivered → eligible for session_start
   * re-delivery (the originating session closed before the run finished). Set
   * once by installResultDelivery's complete handler and by redeliverPendingResults. */
  deliveredAt?: string;
  /** Pack identity (decision 08) when this run is pack-sourced; ABSENT for inline
   *  scripts. Presence is the branch signal (13): packId set → pack-local state;
   *  absent → unchanged createRunPersistence(cwd) (~/.pi/workflows/projects/<key>/). */
  packId?: string;
  status: RunStatus;
  /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Cached agent results for resume, keyed by deterministic call index. */
  journal?: Array<{ index: number; hash: string; result: unknown }>;
}

/**
 * Project a persisted run back into the UI's WorkflowSnapshot shape. Moved
 * from workflow-ui.ts (snapshot-row-single-source, ticket 01) so the mapping
 * lives beside the type it must stay exhaustive over.
 *
 * `agentProjection` has one row per key of PersistedAgentState; the
 * `Record<keyof PersistedAgentState, …>` annotation makes the table exhaustive
 * in both directions: a NEW persisted field without a row is a compile error
 * (the PR-#1362 bug class — new field, silently blank resumed row), and a row
 * for a REMOVED field is an excess-property error. The gate's `bun run build`
 * (tsc) step is what enforces this.
 */
const agentProjection: Record<keyof PersistedAgentState, (a: PersistedAgentState) => unknown> = {
  id: (a) => a.id,
  label: (a) => a.label,
  phase: (a) => a.phase,
  prompt: (a) => a.prompt,
  status: (a) => a.status,
  result: (a) =>
    a.result == null ? undefined : String(typeof a.result === "string" ? a.result : JSON.stringify(a.result)),
  error: (a) => a.error,
  errorCode: (a) => a.errorCode,
  recoverable: (a) => a.recoverable,
  history: (a) => a.history,
  startedAt: (a) => (a.startedAt ? Date.parse(a.startedAt) : undefined),
  endedAt: () => undefined, // persisted-only (resume bookkeeping); no snapshot field
  tokens: (a) => a.tokens,
  model: (a) => a.model,
};

/** Run every projection row, then rename `result` → the snapshot's `resultPreview`. */
function projectAgent(a: PersistedAgentState): WorkflowSnapshot["agents"][number] {
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(agentProjection) as Array<keyof PersistedAgentState>) {
    projected[key] = agentProjection[key](a);
  }
  const { result, endedAt: _endedAt, ...rest } = projected;
  void _endedAt;
  return { ...rest, resultPreview: result } as WorkflowSnapshot["agents"][number];
}

export function persistedToSnapshot(p: PersistedRunState): WorkflowSnapshot {
  const counts = agentCounts(p.agents);
  return {
    name: p.workflowName,
    phases: p.phases,
    currentPhase: p.currentPhase,
    logs: p.logs,
    agents: p.agents.map(projectAgent),
    agentCount: counts.total,
    runningCount: counts.running,
    doneCount: counts.done,
    errorCount: counts.error,
    tokenUsage: p.tokenUsage ? { ...p.tokenUsage } : undefined,
    durationMs: p.durationMs,
    result: p.result,
    runId: p.runId,
  };
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run; stale/corrupt lock files are removed and retried.
   */
  acquireRunLease(runId: string): RunLease | null;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 */
export type FsLayer = {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

export function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>, stateRoot?: string): RunPersistence {
  const _existsSync = fsOverride?.existsSync ?? existsSync;
  const _mkdirSync = fsOverride?.mkdirSync ?? mkdirSync;
  const _readdirSync = fsOverride?.readdirSync ?? readdirSync;
  const _readFileSync = fsOverride?.readFileSync ?? readFileSync;
  const _renameSync = fsOverride?.renameSync ?? renameSync;
  const _unlinkSync = fsOverride?.unlinkSync ?? unlinkSync;
  const _writeFileSync = fsOverride?.writeFileSync ?? writeFileSync;

  const paths = workflowProjectPaths(cwd);
  const runsDir = stateRoot ? join(stateRoot, "runs") : paths.runsDir;
  const legacyRunsDir = paths.legacyRunsDir;

  const ensureDir = () => {
    if (!_existsSync(runsDir)) {
      _mkdirSync(runsDir, { recursive: true });
    }
  };

  const runPath = (dir: string, runId: string) => join(dir, `${runId}.json`);
  const primaryRunPath = (runId: string) => runPath(runsDir, runId);
  const legacyRunPath = (runId: string) => runPath(legacyRunsDir, runId);
  const lockPath = (dir: string, runId: string) => join(dir, `${runId}.lock`);
  const primaryLockPath = (runId: string) => lockPath(runsDir, runId);
  const legacyLockPath = (runId: string) => lockPath(legacyRunsDir, runId);
  const candidateRunPaths = (runId: string) => [primaryRunPath(runId), legacyRunPath(runId)];

  const pidIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "EPERM") return true;
      return false;
    }
  };

  const readLockAt = (path: string): LockFile | null => {
    try {
      return JSON.parse(_readFileSync(path, "utf-8")) as LockFile;
    } catch {
      return null;
    }
  };

  const readLock = (runId: string): LockFile | null => readLockAt(primaryLockPath(runId));

  const removeStaleLegacyLock = (runId: string): boolean => {
    const lock = legacyLockPath(runId);
    const existing = readLockAt(lock);
    if (existing?.runId === runId && pidIsAlive(existing.pid)) return false;
    try {
      if (_existsSync(lock)) _unlinkSync(lock);
    } catch {
      return false;
    }
    return true;
  };

  return {
    save(state: PersistedRunState) {
      ensureDir();
      state.updatedAt = new Date().toISOString();
      const path = primaryRunPath(state.runId);
      const json = JSON.stringify(state, null, 2);
      // Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
      // atomic on the same filesystem). A .bak from the previous good save is the
      // recovery fallback if the primary is somehow truncated.
      _writeFileSync(`${path}.tmp`, json);
      _renameSync(`${path}.tmp`, path);
      try {
        _writeFileSync(`${path}.bak`, json);
      } catch {
        // backup is best-effort; the primary write already succeeded
      }
    },

    load(runId: string): PersistedRunState | null {
      // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
      for (const path of candidateRunPaths(runId)) {
        for (const candidate of [path, `${path}.bak`]) {
          try {
            if (!_existsSync(candidate)) continue;
            return JSON.parse(_readFileSync(candidate, "utf-8")) as PersistedRunState;
          } catch {
            // corrupt candidate -> fall through to the next candidate
          }
        }
      }
      return null;
    },

    list(): PersistedRunState[] {
      const byRunId = new Map<string, PersistedRunState>();
      for (const dir of [runsDir, legacyRunsDir]) {
        try {
          if (!_existsSync(dir)) continue;
          const files = _readdirSync(dir).filter((f) => f.endsWith(".json"));
          for (const file of files) {
            try {
              const state = JSON.parse(_readFileSync(join(dir, file), "utf-8")) as PersistedRunState;
              if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
            } catch {
              // Skip corrupted files
            }
          }
        } catch {
          // Skip unreadable directories; another storage location may still work.
        }
      }
      return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },

    delete(runId: string): boolean {
      let deleted = false;
      try {
        for (const path of candidateRunPaths(runId)) {
          const dir = path === primaryRunPath(runId) ? runsDir : legacyRunsDir;
          // Best-effort cleanup of the sidecar files alongside the primary.
          for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(dir, runId)]) {
            try {
              if (_existsSync(sidecar)) _unlinkSync(sidecar);
            } catch {
              // ignore sidecar cleanup failures
            }
          }
          try {
            if (_existsSync(path)) {
              _unlinkSync(path);
              deleted = true;
            }
          } catch {
            // ignore per-file cleanup failures
          }
        }
        return deleted;
      } catch {
        return deleted;
      }
    },

    acquireRunLease(runId: string): RunLease | null {
      ensureDir();
      const path = primaryRunPath(runId);
      const lock = primaryLockPath(runId);
      if (!removeStaleLegacyLock(runId)) return null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const payload: LockFile = {
          runId,
          runPath: path,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token,
        };
        try {
          _writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
          return { runId, token };
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "EEXIST") throw err;
          const existing = readLock(runId);
          if (existing && existing.runPath === path && pidIsAlive(existing.pid)) {
            return null;
          }
          try {
            _unlinkSync(lock);
          } catch {
            return null;
          }
        }
      }
      return null;
    },

    releaseRunLease(lease: RunLease): void {
      try {
        const existing = readLock(lease.runId);
        if (existing?.token === lease.token) _unlinkSync(primaryLockPath(lease.runId));
      } catch {
        // Best-effort cleanup only.
      }
    },

    getRunsDir(): string {
      return runsDir;
    },
  };
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
