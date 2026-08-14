/**
 * Subagent run persistence — durable, inspection-only records of completed
 * `subagent`-tool runs, for post-session replay/debug.
 *
 * DELIBERATELY SEPARATE from workflow `RunPersistence` (run-persistence.ts):
 * that layer is workflow-RESUME machinery (journal = replay source-of-truth,
 * cross-process lease, pause/resume, exec caps). A `subagent`-tool run is a
 * one-shot dispatch with NO resume semantics — its record is write-once at
 * completion and exists purely so `/subagents` (and grep) can inspect it after
 * the in-process child session is gone. Mixing the two would muddy the
 * journal's "canonical resume state" invariant (CONTEXT.md).
 *
 * Home: `~/.pi/subagents/runs/<id>.json` (global per-user; the record carries
 * `cwd` so the viewer can scope later). JSON-per-run, atomic tmp+rename write,
 * last-N retention (default 200). Records are write-once (never updated), so no
 * `.bak` is needed (unlike the live-updated workflow run state).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHistoryEntry, AgentUsage, SddReport, TurnExhaustion } from "@repo/pi-agent-ext-core-runtime";
import { homeDir } from "@repo/pi-agent-ext-core-runtime";
import type { SubagentScopeCheck } from "./git-scope.js";
import type { SubagentBudgetDetails } from "./subagent-tool-schema.js";
import type { WatchdogResult } from "./watchdog/types.js";

export const SUBAGENT_HOME_RELATIVE_DIR = ".pi/subagents";
export const SUBAGENT_RUNS_SUBDIR = "runs";

export type SubagentRunStatus = "done" | "failed" | "timedout" | "budget" | "turns" | "aborted";

/**
 * A durable, serializable snapshot of one completed `subagent`-tool run.
 * Written once at completion; never mutated.
 */
export interface SubagentRunRecord {
  /** Stable run id (timestamp+random — see generateSubagentRunId). */
  id: string;
  /** The toolCallId (unique per dispatch). */
  toolCallId: string;
  /** Role label (params.agent), if provided. */
  agent?: string;
  /** Full task prompt — needed for replay context. */
  task: string;
  /** Resolved model (provider/id), or the requested display string. */
  model: string;
  /** The originally-requested model spec, when resolution fell back to a
   *  different model. Absent when resolution succeeded normally. */
  requestedModel?: string;
  /** True when model resolution fell back to a different model. */
  fellBack?: boolean;
  /** Requested tier, if any. */
  tier?: string;
  /** Working directory of the run (for future viewer scoping). */
  cwd: string;
  status: SubagentRunStatus;
  exitCode: number;
  timedOut: boolean;
  /** Non-empty only on failure (mirrors SpawnSubagentResult.stderr). */
  stderr?: string;
  /** ISO timestamp of dispatch start. */
  startedAt: string;
  /** Wall-clock of the run, ms. */
  elapsedMs: number;
  /** Real token/cost usage, when the runner reports it. */
  usage?: AgentUsage;
  /** Final text the parent agent read (content[0].text). */
  output: string;
  /** Compact transcript (ticket 07) — tool calls + results, for replay. */
  history?: AgentHistoryEntry[];
  /** Parsed SDD report block (ticket 04), when the run was an SDD dispatch. */
  report?: SddReport;
  /** Opt-in commit-scope check (`commitScope` param), when the caller set one. */
  scopeCheck?: SubagentScopeCheck;
  /**
   * Budget block: exhaustion fields set when the run was aborted for exceeding
   * tokenBudget/spendBudget; `warning` set when the run COMPLETED at ≥80% of
   * a set budget (informational, fixed 0.8 ratio). See SubagentBudgetDetails.
   */
  budget?: SubagentBudgetDetails;
  /**
   * Turns-exhaustion block: set when the run was aborted for exceeding
   * `maxTurns` (status "turns" — mirrors SpawnSubagentResult.turns /
   * core-runtime TurnExhaustion). Absent on every other path; old records
   * without it parse unchanged (optional field, no migration needed).
   */
  turns?: TurnExhaustion;
  /** Two-layer watchdog review (ticket 02), when `watchdog` was requested on the dispatch. */
  watchdog?: WatchdogResult;
}

export type SubagentFsLayer = {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

export interface SubagentRunPersistence {
  /** Persist a completed run (write-once, atomic). Best-effort: never throws. */
  save(record: SubagentRunRecord): void;
  /** List persisted runs, newest first (by startedAt). */
  list(): SubagentRunRecord[];
  /** Load one run by id. */
  load(id: string): SubagentRunRecord | null;
  /** Delete a run. */
  delete(id: string): boolean;
  /** Runs directory path. */
  getRunsDir(): string;
}

export interface CreateSubagentRunPersistenceOptions {
  /** Injectable home dir (tests). Defaults to homeDir(). */
  home?: string;
  /** Max runs retained (last-N); older are evicted on save. Default 200. */
  maxRuns?: number;
  /** Injectable fs (tests). */
  fsOverride?: Partial<SubagentFsLayer>;
}

/** Resolve the subagent state home (`<home>/.pi/subagents`). */
export function subagentHomeDir(home?: string): string {
  return join(home ?? homeDir(), SUBAGENT_HOME_RELATIVE_DIR);
}

/** Resolve the runs directory (`<home>/.pi/subagents/runs`). */
export function subagentRunsDir(home?: string): string {
  return join(subagentHomeDir(home), SUBAGENT_RUNS_SUBDIR);
}

export function createSubagentRunPersistence(
  options: CreateSubagentRunPersistenceOptions = {},
): SubagentRunPersistence {
  const _existsSync = options.fsOverride?.existsSync ?? existsSync;
  const _mkdirSync = options.fsOverride?.mkdirSync ?? mkdirSync;
  const _readdirSync = options.fsOverride?.readdirSync ?? readdirSync;
  const _readFileSync = options.fsOverride?.readFileSync ?? readFileSync;
  const _renameSync = options.fsOverride?.renameSync ?? renameSync;
  const _unlinkSync = options.fsOverride?.unlinkSync ?? unlinkSync;
  const _writeFileSync = options.fsOverride?.writeFileSync ?? writeFileSync;

  const runsDir = subagentRunsDir(options.home);
  const maxRuns = options.maxRuns ?? 200;

  const ensureDir = () => {
    if (!_existsSync(runsDir)) _mkdirSync(runsDir, { recursive: true });
  };
  const pathFor = (id: string) => join(runsDir, `${id}.json`);

  const listInternal = (): SubagentRunRecord[] => {
    if (!_existsSync(runsDir)) return [];
    const files = _readdirSync(runsDir).filter((f) => f.endsWith(".json"));
    const records: SubagentRunRecord[] = [];
    for (const file of files) {
      try {
        records.push(JSON.parse(_readFileSync(join(runsDir, file), "utf-8")) as SubagentRunRecord);
      } catch {
        // skip corrupt files
      }
    }
    return records.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  };

  // last-N retention: evict the oldest runs beyond the cap (list is newest-first).
  const evict = () => {
    const all = listInternal();
    if (all.length <= maxRuns) return;
    for (const victim of all.slice(maxRuns)) {
      try {
        const p = pathFor(victim.id);
        if (_existsSync(p)) _unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  };

  return {
    save(record: SubagentRunRecord) {
      try {
        ensureDir();
        const path = pathFor(record.id);
        const json = JSON.stringify(record, null, 2);
        // Atomic write (tmp+rename): a crash mid-write can't corrupt the file.
        _writeFileSync(`${path}.tmp`, json);
        _renameSync(`${path}.tmp`, path);
        evict();
      } catch {
        // Persistence is best-effort: never fail the subagent run over a write error.
      }
    },
    list() {
      return listInternal();
    },
    load(id: string) {
      try {
        const path = pathFor(id);
        if (!_existsSync(path)) return null;
        return JSON.parse(_readFileSync(path, "utf-8")) as SubagentRunRecord;
      } catch {
        return null;
      }
    },
    delete(id: string) {
      try {
        const path = pathFor(id);
        if (!_existsSync(path)) return false;
        _unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },
    getRunsDir() {
      return runsDir;
    },
  };
}

/** Generate a stable subagent run id (timestamp+random, mirroring generateRunId). */
export function generateSubagentRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

let _persistenceSingleton: ReturnType<typeof createSubagentRunPersistence> | undefined;
/** Process-wide singleton (see getSubagentInFlightRegistry). */
export function getSubagentRunPersistence() {
  // biome-ignore lint/suspicious/noAssignInExpressions: lazy-init singleton idiom
  return (_persistenceSingleton ??= createSubagentRunPersistence());
}
