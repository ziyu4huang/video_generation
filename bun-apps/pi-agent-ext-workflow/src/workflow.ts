import vm from "node:vm";
import type { AgentHistoryEntry, SddReport } from "@repo/pi-agent-ext-core-runtime";
import {
  type AgentRegistry,
  getGlobalRateLimiter,
  loadAgentRegistry,
  providerFromModelSpec,
  WorkflowAgent,
  type WorkflowAgentOptions,
  type WorkflowErrorCode,
} from "@repo/pi-agent-ext-core-runtime";
import type { TSchema } from "typebox";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import type { HostFnRegistry } from "./host-fn-registry.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta } from "./model-routing.js";
import { createRuntime } from "./workflow-runtime.js";
import { parseWorkflowScript } from "./workflow-script-parser.js";
import { createStdlib } from "./workflow-stdlib.js";
import { createLimiter } from "./workflow-timeout.js";

export { hashAgentCall } from "./workflow-runtime.js";
export { parseWorkflowScript } from "./workflow-script-parser.js";
export { createLimiter, runAgentWithTimeout } from "./workflow-timeout.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
  /** Default model for agents whose phase has no route and that set no model/tier. */
  model?: string;
}

/** One cached agent() result, keyed by its deterministic call index. */
export interface JournalEntry {
  index: number;
  /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
  hash: string;
  result: unknown;
  /** The phase the agent ran under, for the disposable intermediate mirror (decision 12). */
  phase?: string;
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  depth: number;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), shown in /workflows for default agents. */
  mainModel?: string;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to scanning `.pi/agents` (project) + `~/.pi/agents`.
   * Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  concurrency?: number;
  /** Retry attempts after a recoverable agent failure. Default 0. */
  agentRetries?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Deterministic host-fn registry for the `call('ns.name', args)` global (sub-project ②). */
  hostFns?: HostFnRegistry;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /**
   * Directory for the persisted run log. Overrides the default cwd-hashed runs
   * dir; absolute or relative to `cwd`. Lets headless callers (pi-agent-cli)
   * redirect output to `PWD/.pi/` or any folder. Absent → existing behavior.
   */
  runsDir?: string;
  /** Resume: cached agent results keyed by deterministic call index. */
  resumeJournal?: Map<number, JournalEntry>;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Called after each live agent completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * Ask the human a checkpoint() question and resolve to their reply. Threaded from
   * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
   * default (and journals it), so a detached/background run never hangs.
   */
  confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { callIndex: number; label: string; phase?: string; prompt: string; model?: string }) => void;
  onAgentEnd?: (event: {
    callIndex: number;
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    worktree?: string;
    model?: string;
    sddReport?: SddReport;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
  }) => void;
  onAgentHistory?: (event: { callIndex: number; label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
   * The workflow author chooses per-agent models per the routing policy in the
   * tool guidelines (e.g. a lighter model for exploration, the main model for
   * analysis). When omitted, the session's main model is used.
   */
  model?: string;
  /**
   * Coarse model tier ("small" | "medium" | "big"), resolved from the user's
   * model-tiers config (see /workflows-models). An explicit `model` takes
   * precedence; a tier takes precedence over the phase model. When the tier has
   * no configured entry it falls back to the session's main model.
   */
  tier?: string;
  isolation?: "worktree";
  /**
   * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
   * user). Binds that definition's tool allow/denylist, model, and body prompt
   * to this agent. An explicit `model` overrides the definition's model; the
   * definition's model overrides `tier`/phase. An unknown name logs a warning
   * and falls back to default tools/model (with the name as a prose hint).
   */
  agentType?: string;
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Retry attempts after a recoverable failure for this specific agent. */
  retries?: number;
  /**
   * HARD mid-run token cap for THIS agent only. WorkflowAgent.run aborts the
   * session mid-run (per-turn check) once cumulative tokens exceed it; the run
   * surfaces status "budget". Distinct from the run-wide soft `tokenBudget`
   * (checked between agents) and phase sub-budgets — this fires DURING the run.
   */
  tokenBudget?: number;
  /** HARD mid-run spend ($) cap for THIS agent only. Pairs with tokenBudget. */
  spendBudget?: number;
}

/** agent() global signature shared between runWorkflow, createStdlib, and createRuntime. */
export type AgentFn = (prompt: string, agentOptions?: AgentOptions) => Promise<unknown>;
/** parallel() global signature shared between runWorkflow, createStdlib, and createRuntime. */
export type ParallelFn = (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
/** pipeline() global signature shared between runWorkflow and createRuntime. */
export type PipelineFn = (
  items: unknown[],
  ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
) => Promise<unknown[]>;

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Reply used when no UI is available (headless/background) and headless != "abort". */
  default?: unknown;
  /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
  headless?: "default" | "abort";
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
  /**
   * The workflow's abort signal, threaded into the confirm callback so a parent
   * abort during a pending checkpoint cancels it instead of orphaning the run
   * (RCA#11). Set internally by runWorkflow — not user-configurable.
   */
  signal?: AbortSignal;
}

export interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling and the run-wide spent at the moment the budget was declared. A phase
   * exceeding its ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall
   * budget is untouched. Soft gate (like the global one): spent accrues after each
   * agent, so an in-flight wave may overshoot slightly.
   */
  phaseBudgets: Map<string, { budget: number; startSpent: number; warned: boolean }>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * When set, agent() uses this frozen phase instead of the shared currentPhase.
   * Set by parallel() to prevent a thunk's phase() call from polluting siblings'
   * phase assignment (RCA#3). Cleared after all parallel thunks complete.
   */
  parallelPhaseOverride?: string;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
}

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body, defaultExport } = parseWorkflowScript(script);
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    runsDir: options.runsDir,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    phaseBudgets: new Map(),
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  // Global caps + budget are shared with any nested workflow() so they hold across nesting.
  const shared: SharedRuntime = options.sharedRuntime ?? {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
  };
  const limiter = shared.limiter;
  // Shared per-provider rate-limit gate (wayfinder tickets 02+03): the OUTER cap
  // across BOTH this workflow's agent dispatch AND the `subagents`/`subagent`
  // tools. Undefined when the session has no resolvable provider model (or no
  // rateLimits cap is configured) → run() is a pass-through, so behavior is
  // byte-identical to before until the user opts in. Lives OUTSIDE the vm: this
  // is the plain-TS orchestrator layer that wraps every agent() call.
  const activeProvider = providerFromModelSpec(options.mainModel);
  const globalRateLimiter = activeProvider ? getGlobalRateLimiter(activeProvider) : undefined;
  const rateLimitGate = <T>(fn: () => Promise<T>): Promise<T> => (globalRateLimiter ? globalRateLimiter.run(fn) : fn());
  // Acquire the global (shared) gate BEFORE the per-run-tree limiter, so a
  // task blocked on the cross-tool budget does not occupy a per-run slot.
  const dispatch = <T>(fn: () => Promise<T>): Promise<T> => rateLimitGate(() => limiter(fn));

  const rt = createRuntime({
    options,
    shared,
    state,
    logger,
    agentRunner,
    maxAgents,
    agentTimeoutMs,
    runId,
    baseCwd,
    agentRegistry,
    routingConfig,
    dispatch,
    runWorkflow,
  });

  const stdlib = createStdlib({ agent: rt.agent, parallel: rt.parallel });

  const context = vm.createContext({
    agent: rt.agent,
    parallel: rt.parallel,
    pipeline: rt.pipeline,
    workflow: rt.workflowFn,
    verify: stdlib.verify,
    judgePanel: stdlib.judgePanel,
    loopUntilDry: stdlib.loopUntilDry,
    completenessCheck: stdlib.completenessCheck,
    retry: stdlib.retry,
    gate: stdlib.gate,
    checkpoint: rt.checkpoint,
    call: rt.call,
    log: rt.log,
    phase: rt.phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget: rt.budget,
    console: {
      log: rt.log,
      info: rt.log,
      warn: (m: unknown) => rt.log(`[warn] ${String(m)}`),
      error: (m: unknown) => rt.log(`[error] ${String(m)}`),
    },
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });
  // Expose the context object itself so an `export default` entry function can
  // receive it: packs destructure {agent, args, log, ...} from their parameter,
  // and this passes every injected global in one object.
  (context as Record<string, unknown>).__ctx = context;

  const wrapped = defaultExport
    ? `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n  const __entry = ${defaultExport};\n  return await __entry(__ctx);\n})()`
    : `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);

  // Persist logs
  const logFile = logger.persist();
  if (logFile) {
    rt.log(`Logs persisted to ${logFile}`);
  }

  // Emit final token usage
  options.onTokenUsage?.(shared.tokenUsage);

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: shared.agentCount,
    durationMs: Date.now() - started,
    runId,
    tokenUsage: shared.tokenUsage,
  };
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}
