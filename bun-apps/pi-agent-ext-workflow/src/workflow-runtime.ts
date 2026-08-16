import { createHash } from "node:crypto";
import {
  type AgentDefinition,
  type AgentHistoryEntry,
  type AgentRegistry,
  type AgentUsage,
  agentDefinitionKey,
  createWorktree,
  removeWorktree,
  resolveAgentType,
  type SddReport,
  type WorkflowAgent,
  WorkflowError,
  WorkflowErrorCode,
  type Worktree,
  wrapError,
} from "@repo/pi-agent-ext-core-runtime";
import type { TSchema } from "typebox";
import { buildCallGlobal } from "./call-global.js";
import { MAX_AGENT_RETRIES } from "./config.js";
import type { HostFnAskOptions } from "./host-fn-registry.js";
import type { createWorkflowLogger } from "./logger.js";
import { clampModelToScope, type parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import type {
  AgentFn,
  AgentOptions,
  CheckpointOptions,
  ParallelFn,
  PipelineFn,
  RuntimeState,
  SharedRuntime,
  WorkflowRunOptions,
  WorkflowRunResult,
} from "./workflow.js";
import { runAgentWithTimeout } from "./workflow-timeout.js";

/**
 * Deps bag passed into createRuntime. Holds the heavy runtime state the closures
 * close over (options/shared/state/logger + agent captures). Task 6 will add the
 * injected runWorkflow for workflowFn() recursion.
 */
export interface RuntimeDeps {
  options: WorkflowRunOptions;
  shared: SharedRuntime;
  state: RuntimeState;
  agentRunner: Pick<WorkflowAgent, "run">;
  maxAgents: number;
  agentTimeoutMs: number | null;
  runId: string;
  baseCwd: string;
  agentRegistry: AgentRegistry;
  routingConfig: ReturnType<typeof parseModelRoutingFromMeta>;
  dispatch: <T>(fn: () => Promise<T>) => Promise<T>;
  logger: ReturnType<typeof createWorkflowLogger>;
  /** Injected (not back-imported) so workflowFn() can recurse without a runtime cycle. */
  runWorkflow: (script: string, options: WorkflowRunOptions) => Promise<WorkflowRunResult>;
}

/**
 * Runtime closures produced by createRuntime (log/phase/budget/throwIfAborted +
 * parallel/pipeline/agent). Task 6 will add workflowFn/checkpoint/call.
 */
export interface Runtime {
  log: (message: string) => void;
  phase: (title: string, phaseOptions?: { budget?: number }) => void;
  budget: Readonly<{ total: number | null; spent: () => number; remaining: () => number }>;
  throwIfAborted: () => void;
  agent: AgentFn;
  parallel: ParallelFn;
  pipeline: PipelineFn;
  workflowFn: (nameOrScript: string, childArgs?: unknown) => Promise<unknown>;
  checkpoint: (promptText: string, checkpointOptions?: CheckpointOptions) => Promise<unknown>;
  call: ReturnType<typeof buildCallGlobal>;
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

/** Stable identity hash for an agent() call — a cache miss on resume when anything changes. */
export function hashAgentCall(
  prompt: string,
  model: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
): string {
  const identity = JSON.stringify({
    prompt,
    model: model ?? null,
    tier: options.tier ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
    // isolation changes which filesystem the agent runs in (worktree vs main) — a
    // cached result from the non-isolated run MUST NOT be replayed when isolation
    // is toggled, so it is part of the identity (RCA regression guard).
    isolation: options.isolation ?? null,
    // Budget is part of an agent's identity — a different cap is a different run
    // (changing it MUST invalidate the cached result on resume).
    tokenBudget: options.tokenBudget ?? null,
    spendBudget: options.spendBudget ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

/** Stable identity hash for a checkpoint() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string, options: CheckpointOptions): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
  resolvedIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  if (def?.prompt) lines.push(def.prompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  // Use resolvedIsolation so the annotation fires whether isolation came from
  // the call site or from the agentDef's isolation field.
  if (resolvedIsolation) lines.push(`Requested isolation: ${resolvedIsolation}`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

/**
 * Builds the runtime closures (log/phase/budget/throwIfAborted + agent/parallel/
 * pipeline) that runWorkflow and the vm globals consume. Each closure closes over
 * the deps bag fields instead of runWorkflow locals. Task 6 adds workflowFn/checkpoint/call.
 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  const {
    options,
    shared,
    state,
    agentRunner,
    maxAgents,
    agentTimeoutMs,
    runId,
    baseCwd,
    agentRegistry,
    routingConfig,
    dispatch,
    logger,
  } = deps;

  // Leaf closures relocated UNCHANGED from workflow.ts; they now close over
  // deps fields (state/logger/options/shared) instead of runWorkflow locals.
  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current spent (idempotent across resume: the
    // script re-runs phase() and the ceiling is recomputed from live spent).
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
    }
    options.onPhase?.(title);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  // agent relocated UNCHANGED from workflow.ts; every captured runWorkflow local is
  // now a deps field (options/shared/state/agentRunner/maxAgents/agentTimeoutMs/
  // runId/baseCwd/agentRegistry/routingConfig/dispatch/logger) or a local above
  // (log/throwIfAborted/budget) or a module helper. rt.* references from the inline
  // version are rebound to the locals (throwIfAborted/budget/log).
  const agent: AgentFn = async (prompt: string, agentOptions: AgentOptions = {}) => {
    throwIfAborted();

    // Check agent limit
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }

    if (budget.total !== null && budget.remaining() <= 0) {
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    }

    const assignedPhase = agentOptions.phase ?? state.parallelPhaseOverride ?? state.currentPhase;

    // Per-phase soft sub-budget gate: a noisy phase can exhaust its own ceiling
    // without touching the run's overall budget. Soft (spent accrues post-agent),
    // warns once at ~80%, throws at 100%. Scripts can try/catch around a phase's
    // work so later phases still proceed.
    if (assignedPhase) {
      const pb = state.phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = shared.spent - pb.startSpent;
        if (phaseSpent >= pb.budget) {
          throw new WorkflowError(
            `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
            WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
            { recoverable: false },
          );
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
        }
      }
    }

    const requestedLabel = agentOptions.label?.trim();

    // Resolve a named agentType to its bound definition (tools/model/prompt).
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    if (agentOptions.agentType && !agentDef) {
      log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }

    // Model precedence: explicit agentOptions.model > agentType.model > tier > phase model.
    // The "explicit-level" model is opts.model, else the definition's model — either
    // beats tier/phase. When only a tier is set, pass undefined here so the tier (not
    // the phase model) decides inside WorkflowAgent.run().
    const explicitModel = agentOptions.model ?? agentDef?.model;
    const modelSpec =
      explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
    // For display in /workflows: the model this agent runs on — its explicit/phase
    // spec, else the session's main model. The real resolved id overrides this via
    // onModelResolved once the subagent session is created.
    let displayModel = modelSpec ?? options.mainModel;

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const callIndex = state.callSeq++;
    const callHash = hashAgentCall(prompt, modelSpec, assignedPhase, agentOptions, agentDefinitionKey(agentDef));

    // Reserve the agent slot synchronously — atomic with the limit/budget gate
    // above (no await in between) — so a parallel() fan-out can't all observe the
    // same agentCount and overshoot maxAgents. (Token budget stays a soft gate:
    // spent accrues after each agent, matching Claude Code; in-flight agents may
    // push slightly past total, then further agent() calls throw.)
    shared.agentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);

    // Session scope (ticket 11): clamp an out-of-scope spec to the first scoped
    // model — warn-and-clamp, never a hard error. Empty scope = full catalog.
    // callHash deliberately keeps the UNCLAMPED spec so the journal key stays
    // stable across scope toggles (a resumed prefix replays identically), and
    // in-flight runs are not mutated — scope is applied per dispatch only.
    let effectiveSpec = modelSpec;
    if (modelSpec && options.scopedModels && options.scopedModels.length > 0) {
      const { spec, clamped } = clampModelToScope(modelSpec, options.scopedModels);
      if (clamped) {
        log(`${label}: model "${modelSpec}" out of session scope — clamped to "${spec}"`);
        effectiveSpec = spec;
        displayModel = spec;
      }
    }

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    const cached = options.resumeJournal?.get(callIndex);
    const hashMatches = cached != null && cached.hash === callHash;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
      options.onAgentStart?.({ callIndex, label, phase: assignedPhase, prompt, model: displayModel });
      options.onAgentEnd?.({
        callIndex,
        label,
        phase: assignedPhase,
        result: cached.result,
        tokens: 0,
        model: displayModel,
      });
      return cached.result;
    }
    // A genuine miss (no journal entry, or the hash changed) marks where the
    // unchanged prefix ends; this call and every later one then run live.
    if (!hashMatches || cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);

    return dispatch(async () => {
      const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
      const retryAttempts = normalizeAgentRetries(agentOptions.retries ?? options.agentRetries ?? 0);
      const maxAttempts = retryAttempts + 1;

      options.onAgentStart?.({ callIndex, label, phase: assignedPhase, prompt, model: displayModel });

      // Optional per-agent worktree isolation (deterministic name -> stable resume keys).
      // Precedence: explicit call-site isolation > agentDef isolation.
      // Note: passing { isolation: undefined } falls through ?? to the def's value — there
      // is no sentinel to suppress a def's isolation at the call site. Remove the agentType
      // or override with a def that has no isolation field if opt-out is needed.
      let worktree: Worktree | undefined;
      const resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation;
      if (resolvedIsolation === "worktree") {
        worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
        if (!worktree.isolated) log(`isolation ignored for "${label}" (${worktree.reason})`);
      }
      const runCwd = worktree?.isolated ? worktree.cwd : undefined;

      // Captured from the subagent's real session usage; falls back to an
      // estimate when the provider reports no usage (total === 0). Usage is reset
      // per retry attempt so a failed attempt does not double-count the next one.
      let usage: AgentUsage | undefined;
      let sddReport: SddReport | undefined;
      const recordTokens = (result: unknown): number => {
        const tokens = usage && usage.total > 0 ? usage.total : estimateTokens(result) + estimateTokens(prompt);
        if (usage) {
          shared.tokenUsage.input += usage.input;
          shared.tokenUsage.output += usage.output;
          shared.tokenUsage.cost += usage.cost;
          shared.tokenUsage.cacheRead += usage.cacheRead;
          shared.tokenUsage.cacheWrite += usage.cacheWrite;
        }
        shared.tokenUsage.total += tokens;
        shared.spent += tokens;
        return tokens;
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          usage = undefined;
          sddReport = undefined;
          try {
            throwIfAborted();

            // Run agent with timeout. The timeout aborts the agent's OWN child
            // signal (derived from options.signal), so a timed-out session is
            // cancelled and its partial usage counted — not left as an orphan
            // burning uncounted tokens (RCA#10).
            const result = await runAgentWithTimeout(
              (signal) =>
                agentRunner.run(prompt, {
                  label,
                  schema: agentOptions.schema,
                  signal,
                  instructions: buildAgentInstructions(assignedPhase, agentOptions, agentDef, resolvedIsolation),
                  model: effectiveSpec,
                  tier: agentOptions.tier,
                  toolNames: agentDef?.tools,
                  disallowedToolNames: agentDef?.disallowedTools,
                  tokenBudget: agentOptions.tokenBudget,
                  spendBudget: agentOptions.spendBudget,
                  cwd: runCwd,
                  onModelResolved: (id: string) => {
                    displayModel = id;
                  },
                  onModelFallback: (spec: string) => {
                    // Make the silent degrade visible in /workflows, not just console.
                    log(`${label}: model "${spec}" unavailable — using the session default`);
                  },
                  onUsage: (u: AgentUsage) => {
                    usage = u;
                  },
                  onHistory: (history: AgentHistoryEntry[]) => {
                    options.onAgentHistory?.({ callIndex, label, phase: assignedPhase, history });
                  },
                  onSddReport: (report: SddReport | undefined) => {
                    sddReport = report;
                  },
                } as any),
              timeout,
              options.signal,
              label,
            );

            throwIfAborted();
            if (isEmptyTextAgentResult(result, agentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }

            const tokens = recordTokens(result);
            options.onAgentJournal?.({ index: callIndex, hash: callHash, result, phase: assignedPhase });
            options.onAgentEnd?.({
              callIndex,
              label,
              phase: assignedPhase,
              result,
              tokens,
              worktree: runCwd,
              model: displayModel,
              sddReport,
            });
            return result;
          } catch (error) {
            if (options.signal?.aborted) throw error;

            const workflowError = wrapError(error, { agentLabel: label });
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            const tokens = recordTokens(null);

            if (workflowError.recoverable && attempt < maxAttempts) {
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              continue;
            }

            options.onAgentEnd?.({
              callIndex,
              label,
              phase: assignedPhase,
              result: null,
              tokens,
              worktree: runCwd,
              model: displayModel,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
            });

            if (workflowError.recoverable) {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              return null;
            }
            throw workflowError;
          }
        }
        return null;
      } finally {
        // Always tear down the worktree, even on timeout/abort.
        if (worktree?.isolated) await removeWorktree(worktree);
      }
    });
  };

  // parallel relocated UNCHANGED from workflow.ts; it closes over throwIfAborted
  // (local above), state/options (deps fields), log (local), and wrapError (import).
  const parallel: ParallelFn = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    // RCA#3: freeze the phase for the entire parallel scope so a thunk's
    // phase() call can't pollute siblings. Restore after all thunks complete.
    const savedOverride = state.parallelPhaseOverride;
    const savedPhase = state.currentPhase;
    state.parallelPhaseOverride = savedPhase;
    try {
      return await Promise.all(
        thunks.map(async (thunk, index) => {
          try {
            return await thunk();
          } catch (error) {
            if (options.signal?.aborted) throw error;
            const workflowError = wrapError(error);
            if (!workflowError.recoverable) throw workflowError;
            log(`parallel[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }),
      );
    } finally {
      state.parallelPhaseOverride = savedOverride;
      state.currentPhase = savedPhase;
    }
  };

  // pipeline relocated UNCHANGED from workflow.ts; it closes over throwIfAborted
  // (local above), options (deps field), log (local), and wrapError (import).
  const pipeline: PipelineFn = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (options.signal?.aborted) throw error;
            const workflowError = wrapError(error);
            // Non-recoverable failures halt the whole run (see parallel()).
            if (!workflowError.recoverable) throw workflowError;
            log(`pipeline[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  // workflowFn relocated UNCHANGED from workflow.ts; the recursive runWorkflow
  // call now uses deps.runWorkflow (injected) instead of the module binding.
  const workflowFn = async (nameOrScript: string, childArgs?: unknown) => {
    throwIfAborted();
    if (shared.depth >= 1) {
      throw new WorkflowError("workflow() can nest only one level deep", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    const resolved = options.loadSavedWorkflow?.(String(nameOrScript));
    const childScript = resolved ?? String(nameOrScript);
    shared.depth++;
    try {
      const child = await deps.runWorkflow(childScript, {
        ...options,
        args: childArgs,
        sharedRuntime: shared,
        // A nested run is its own script; never reuse the parent's resume journal.
        resumeJournal: undefined,
        resumeFromRunId: undefined,
        runId: `${runId}-nested${shared.depth}`,
        persistLogs: false,
      });
      return child.result;
    } finally {
      shared.depth--;
    }
  };

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless (no UI threaded in): takes the
  // declared default and journals THAT, so a detached/background run never hangs.
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    throwIfAborted();
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    const callIndex = state.callSeq++;
    const callHash = hashCheckpoint(promptText, checkpointOptions);
    const cached = options.resumeJournal?.get(callIndex);
    if (cached != null && cached.hash === callHash && callIndex < state.firstMiss) {
      shared.agentCount++;
      return cached.result; // replay the journaled human reply
    }
    if (cached == null || cached.hash !== callHash) state.firstMiss = Math.min(state.firstMiss, callIndex);
    shared.agentCount++;

    let reply: unknown;
    if (options.confirm) {
      const confirmCtx: CheckpointOptions & { signal?: AbortSignal } = { ...checkpointOptions };
      if (options.signal) confirmCtx.signal = options.signal;
      reply = await options.confirm(promptText, confirmCtx);
    } else if (checkpointOptions.headless === "abort") {
      throw new WorkflowError(
        `checkpoint "${promptText}" needs human input but none is available (headless run)`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
    } else {
      reply = checkpointOptions.default ?? true;
    }
    throwIfAborted();
    options.onAgentJournal?.({ index: callIndex, hash: callHash, result: reply, phase: state.currentPhase });
    return reply;
  };

  // Deterministic, journaled, zero-token host-fn call (sub-project ②). Mirrors
  // checkpoint()'s journaling + maxAgents accounting; bypasses the concurrency
  // limiter (local compute). Value comes from a registered host fn, not an LLM.
  // Capture confirm in a const so the ctx.ask closure keeps the non-undefined
  // narrowing (avoids a non-null assertion). Undefined when headless.
  const confirm = options.confirm;
  const call = buildCallGlobal({
    hostFns: options.hostFns,
    state,
    shared,
    maxAgents,
    options: {
      resumeJournal: options.resumeJournal,
      onAgentJournal: options.onAgentJournal,
      onAgentStart: options.onAgentStart as Parameters<typeof buildCallGlobal>[0]["options"]["onAgentStart"],
      onAgentEnd: options.onAgentEnd as Parameters<typeof buildCallGlobal>[0]["options"]["onAgentEnd"],
      cwd: options.cwd ?? process.cwd(),
      signal: options.signal,
      // Thread the UI-bearing confirm() (the same callback checkpoint() uses)
      // into host-fns as ctx.ask. Wrapped because confirm() requires a
      // CheckpointOptions arg while ctx.ask takes an optional HostFnAskOptions;
      // `{ ...o }` is a valid all-optional CheckpointOptions. Undefined when
      // headless (no confirm threaded) → ctx.ask undefined → host-fn falls back.
      ask: confirm ? (promptText: string, o?: HostFnAskOptions) => confirm(promptText, { ...o }) : undefined,
    },
    runId,
    throwIfAborted,
  });

  return { log, phase, budget, throwIfAborted, agent, parallel, pipeline, workflowFn, checkpoint, call };
}
