import { WorkflowError, WorkflowErrorCode, wrapError } from "@repo/pi-agent-ext-subagent";
import type { createWorkflowLogger } from "./logger.js";
import type { PipelineFn, RuntimeState, SharedRuntime, WorkflowRunOptions } from "./workflow.js";

/**
 * Deps bag passed into createRuntime. Grows as more closures move in (5.1 = leaf
 * closures only; later sub-moves add agent/parallel/pipeline + their captures).
 */
export interface RuntimeDeps {
  options: WorkflowRunOptions;
  shared: SharedRuntime;
  state: RuntimeState;
  logger: ReturnType<typeof createWorkflowLogger>;
}

/**
 * Runtime closures produced by createRuntime. Grows alongside RuntimeDeps
 * (5.1 = leaf closures only).
 */
export interface Runtime {
  log: (message: string) => void;
  phase: (title: string, phaseOptions?: { budget?: number }) => void;
  budget: Readonly<{ total: number | null; spent: () => number; remaining: () => number }>;
  throwIfAborted: () => void;
  pipeline: PipelineFn;
}

/**
 * Builds the runtime closures (log/phase/budget/throwIfAborted + later
 * agent/parallel/pipeline) that runWorkflow and the vm globals consume. Each
 * closure closes over the deps bag fields instead of runWorkflow locals.
 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  const { options, shared, state, logger } = deps;

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

  return { log, phase, budget, throwIfAborted, pipeline };
}
