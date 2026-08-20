/**
 * cost.ts — budget governance (estimate → reserve → reconcile).
 *
 * Port of OpenMontage's `tools/cost_tracker.py`. Three modes: `observe` (track
 * only), `warn` (log overruns), `cap` (hard limit). Persists to cost_log.json
 * per project. Reserve-pct buffer + single-action approval threshold match the
 * Python defaults.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { costLogPath, projectDir } from "./paths.ts";
import { loadPipeline } from "./pipeline.ts";

export type BudgetMode = "observe" | "warn" | "cap";

export interface BudgetConfig {
  totalUsd: number;
  reservePct: number;
  singleActionApprovalUsd: number;
  mode: BudgetMode;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  totalUsd: 10,
  reservePct: 0.1,
  singleActionApprovalUsd: 0.5,
  mode: "observe",
};

export type EntryStatus = "estimated" | "reserved" | "completed" | "failed" | "refunded";

export interface CostEntry {
  id: string;
  tool: string;
  operation: string;
  status: EntryStatus;
  estimated_usd: number;
  reserved_usd?: number;
  actual_usd?: number;
  success?: boolean;
  created_at: string;
  settled_at?: string;
}

export interface CostLog {
  budget: BudgetConfig;
  entries: CostEntry[];
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

/**
 * When a project's cost log doesn't exist yet, seed its budget from the
 * pipeline manifest's `orchestration.budget_default_usd` (tool-design audit,
 * 2026-07-12: this field was pure YAML documentation with zero runtime
 * consumer — `DEFAULT_BUDGET.totalUsd=10` silently overrode whatever a
 * manifest declared, e.g. talking-head's $0.50 or animated-explainer's
 * $2.00). Falls back to `DEFAULT_BUDGET.totalUsd` when `pipeline` is omitted
 * or the manifest doesn't declare the field — existing callers that don't
 * pass `pipeline` are unaffected.
 */
function freshBudget(pipeline?: string): BudgetConfig {
  const budgetDefaultUsd = pipeline ? (loadPipeline(pipeline) as { orchestration?: { budget_default_usd?: number } }).orchestration?.budget_default_usd : undefined;
  return budgetDefaultUsd !== undefined ? { ...DEFAULT_BUDGET, totalUsd: budgetDefaultUsd } : { ...DEFAULT_BUDGET };
}

function load(projectId: string, env?: Record<string, string | undefined>, pipeline?: string): CostLog {
  const p = costLogPath(projectId, env);
  if (!existsSync(p)) {
    return { budget: freshBudget(pipeline), entries: [] };
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CostLog;
  } catch {
    return { budget: freshBudget(pipeline), entries: [] };
  }
}

function save(projectId: string, log: CostLog, env?: Record<string, string | undefined>): void {
  mkdirSync(projectDir(projectId, env), { recursive: true });
  writeFileSync(costLogPath(projectId, env), JSON.stringify(log, null, 2));
}

export interface CostSnapshot {
  total_spent_usd: number;
  total_reserved_usd: number;
  budget_remaining_usd: number;
}

export function costSnapshot(projectId: string, env?: Record<string, string | undefined>): CostSnapshot {
  const log = load(projectId, env);
  const spent = log.entries
    .filter((e) => e.status === "completed" || e.status === "failed")
    .reduce((s, e) => s + (e.actual_usd ?? 0), 0);
  const reserved = log.entries
    .filter((e) => e.status === "reserved")
    .reduce((s, e) => s + (e.reserved_usd ?? 0), 0);
  return {
    total_spent_usd: round2(spent),
    total_reserved_usd: round2(reserved),
    budget_remaining_usd: round2(log.budget.totalUsd - spent),
  };
}

function usableRemaining(log: CostLog): number {
  return log.budget.totalUsd - log.budget.totalUsd * log.budget.reservePct;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `cost_${Date.now().toString(36)}_${idCounter}`;
}

/**
 * Estimate a cost entry (track only at this stage). Returns the entry id.
 * `pipeline`, when given, seeds a freshly-created project's budget from the
 * manifest's `orchestration.budget_default_usd` — see `freshBudget()`. Has no
 * effect once a cost log already exists (budget is set once, at creation).
 */
export function estimate(
  projectId: string,
  tool: string,
  operation: string,
  estimatedUsd: number,
  env?: Record<string, string | undefined>,
  pipeline?: string,
): string {
  const log = load(projectId, env, pipeline);
  const entry: CostEntry = {
    id: nextId(),
    tool,
    operation,
    status: "estimated",
    estimated_usd: round2(estimatedUsd),
    created_at: new Date().toISOString(),
  };
  log.entries.push(entry);
  save(projectId, log, env);
  return entry.id;
}

/**
 * Reserve budget for an estimated entry. Under `cap` mode, raises
 * BudgetExceededError if the usable remaining budget can't cover it; raises
 * ApprovalRequiredError if the single-action threshold is exceeded (any mode).
 */
export function reserve(
  projectId: string,
  entryId: string,
  env?: Record<string, string | undefined>,
): void {
  const log = load(projectId, env);
  const entry = log.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`cost entry not found: ${entryId}`);
  if (entry.status !== "estimated") throw new Error(`cost entry ${entryId} not in estimated state (is ${entry.status})`);

  if (entry.estimated_usd > log.budget.singleActionApprovalUsd) {
    if (log.budget.mode !== "observe") {
      throw new ApprovalRequiredError(
        `entry ${entryId} (${entry.tool}/${entry.operation}) estimates $${entry.estimated_usd} > single-action ` +
          `threshold $${log.budget.singleActionApprovalUsd}; needs explicit approval.`,
      );
    }
  }
  const remaining = usableRemaining(log) - reservedTotal(log);
  if (log.budget.mode === "cap" && entry.estimated_usd > remaining) {
    throw new BudgetExceededError(
      `entry ${entryId} would exceed usable budget: needs $${entry.estimated_usd}, usable remaining $${round2(remaining)}.`,
    );
  }
  entry.status = "reserved";
  entry.reserved_usd = round2(entry.estimated_usd);
  save(projectId, log, env);
}

/** Reconcile a reserved entry with the actual cost (settles the reservation). */
export function reconcile(
  projectId: string,
  entryId: string,
  actualUsd: number,
  success: boolean,
  env?: Record<string, string | undefined>,
): void {
  const log = load(projectId, env);
  const entry = log.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`cost entry not found: ${entryId}`);
  if (entry.status !== "reserved") throw new Error(`cost entry ${entryId} not reserved (is ${entry.status})`);
  entry.status = success ? "completed" : "failed";
  entry.actual_usd = round2(actualUsd);
  entry.success = success;
  entry.settled_at = new Date().toISOString();
  save(projectId, log, env);
}

/** Refund a reserved entry (e.g. the tool failed before charging). */
export function refund(projectId: string, entryId: string, env?: Record<string, string | undefined>): void {
  const log = load(projectId, env);
  const entry = log.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`cost entry not found: ${entryId}`);
  if (entry.status !== "reserved") throw new Error(`cost entry ${entryId} not reserved (is ${entry.status})`);
  entry.status = "refunded";
  entry.settled_at = new Date().toISOString();
  save(projectId, log, env);
}

function reservedTotal(log: CostLog): number {
  return log.entries.filter((e) => e.status === "reserved").reduce((s, e) => s + (e.reserved_usd ?? 0), 0);
}

export function getLog(projectId: string, env?: Record<string, string | undefined>): CostLog {
  return load(projectId, env);
}

/**
 * Correct a cost entry's `tool` after the fact. GENERATE's cost estimate is
 * necessarily recorded against a pre-resolved provider (needed before the
 * generation call, so a cap-mode budget breach can block spending) — but
 * `selectAndGenerate`'s opportunistic upgrades (e.g. tts trying edge-tts
 * before falling back to the statically-selected `say`) can invoke a
 * DIFFERENT provider than the one estimated against (Item 3,
 * output/next-goal-20260712_135012.md). Call this once the actually-used
 * provider is known so the persisted log attributes cost to the right tool.
 * No-op if the entry doesn't exist (best-effort, matches the rest of the
 * cost lifecycle's error posture).
 */
export function retagTool(
  projectId: string,
  entryId: string,
  tool: string,
  env?: Record<string, string | undefined>,
): void {
  const log = load(projectId, env);
  const entry = log.entries.find((e) => e.id === entryId);
  if (!entry) return;
  entry.tool = tool;
  save(projectId, log, env);
}

/** Override the budget config for a project (creates the cost log if needed). */
export function configureBudget(
  projectId: string,
  partial: Partial<BudgetConfig>,
  env?: Record<string, string | undefined>,
): BudgetConfig {
  const log = load(projectId, env);
  log.budget = { ...log.budget, ...partial };
  save(projectId, log, env);
  return log.budget;
}
