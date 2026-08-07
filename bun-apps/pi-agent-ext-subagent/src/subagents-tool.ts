/**
 * `subagents` tool — agent-callable PARALLEL read-only fan-out. Dispatches N
 * isolated subagents (via spawnSubagent) with bounded concurrency, returning a
 * positional array of results. Read-only is ENFORCED: edit/write/bash are
 * always excluded (non-overridable) so children sharing the parent's working
 * tree can never race on writes. See .planning/done/2026-08-01-what-s-next-for-subagent-develop-map/.
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentUsage, BudgetExhaustion } from "./agent.js";
import { checkBudgetExhaustion } from "./agent.js";
import { summarizeLatestAction } from "./agent-history.js";
import { DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_TASKS, MAX_CONCURRENCY } from "./config.js";
import { getGlobalRateLimiter, providerFromModelSpec } from "./rate-limiter.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "./spawn-subagent.js";
import { spawnSubagent } from "./spawn-subagent.js";
import type { SubagentInFlightRegistry } from "./subagent-in-flight.js";
import { generateSubagentRunId, type SubagentRunPersistence } from "./subagent-run-persistence.js";
import { DEFAULT_TIMEOUT_MS, deriveSubagentStatus, taskPreview } from "./subagent-tool.js";

/** Tree-mutating tools a read-only child may NEVER carry (non-overridable). */
export const READ_ONLY_EXCLUDED = ["edit", "write", "bash"] as const;

/** One task in a batch. Mirrors the singular tool's surface, minus mutating hooks. */
export interface BatchTask {
  task: string;
  id?: string;
  model?: string;
  tier?: string;
  capability?: string;
  cwd?: string;
  tools?: string[];
  excludeTools?: string[];
  timeoutMs?: number;
  tokenBudget?: number;
  spendBudget?: number;
}

/** A positional result slot (input order). `null` = the child failed. */
export type BatchResultSlot =
  | {
      output: string;
      status: "done" | "timedout" | "aborted";
      id?: string;
      index: number;
      usage?: AgentUsage;
      /** Task preview (Completed-section display). */
      task: string;
      /** Resolved child model (never a hardcoded id). */
      model: string;
      /** Per-child wall-clock from dispatch start. */
      elapsedMs: number;
    }
  | {
      status: "budget";
      exhaustion: BudgetExhaustion;
      /** Did this cap fire on the child's OWN per-child budget, or the batch-wide soft gate? */
      source: "batch" | "child";
      id?: string;
      index: number;
      /** Task preview (Completed-section display). */
      task: string;
      /** Resolved child model (never a hardcoded id). */
      model: string;
      /** 0 for gate-skipped (never ran); real for per-child budget aborts. */
      elapsedMs: number;
    }
  | null;

export interface SubagentsToolDetails {
  results: BatchResultSlot[];
  /** Present when the batch-wide soft gate tripped. */
  budgetExhaustion?: BudgetExhaustion;
  dispatched: number;
  skipped: number;
  elapsedMs: number;
}

export interface SubagentsToolOptions {
  cwd?: string;
  getExtensionTools?: () => ToolDefinition[] | undefined;
  getMainModel?: () => string | undefined;
  /** Injectable spawn for tests (defaults to the real spawnSubagent). */
  spawn?: (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
  inFlight?: SubagentInFlightRegistry;
  persistence?: SubagentRunPersistence;
}

export const subagentsToolSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      task: Type.String({
        description: "Full self-contained prompt — the child has NO access to this session's history.",
      }),
      id: Type.Optional(Type.String({ description: "Optional caller tag echoed in the result for correlation." })),
      model: Type.Optional(
        Type.String({ description: "Model override `provider/model-id`; omit to inherit the session model." }),
      ),
      tier: Type.Optional(Type.String({ description: "Model tier: 'small'|'medium'|'big'." })),
      capability: Type.Optional(
        Type.String({ description: "Model capability (e.g. 'vision'), resolved from model-tiers config." }),
      ),
      cwd: Type.Optional(Type.String({ description: "Child working directory (defaults to parent session cwd)." })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Curated tool allowlist." })),
      excludeTools: Type.Optional(
        Type.Array(Type.String(), {
          description: "Denied after the allowlist. edit/write/bash are ALWAYS also excluded (non-overridable).",
        }),
      ),
      timeoutMs: Type.Optional(Type.Integer({ description: "Per-child wall-clock cap (ms). Defaults to 15 min." })),
      tokenBudget: Type.Optional(Type.Integer({ description: "Per-child token cap (hard — aborts that one child)." })),
      spendBudget: Type.Optional(Type.Number({ description: "Per-child cost cap in $ (hard)." })),
    }),
    { description: "Read-only fan-out: each task runs as an isolated subagent with edit/write/bash always excluded." },
  ),
  concurrency: Type.Optional(Type.Integer({ description: "Max parallel children. Clamped to [1,16]; default 4." })),
  tokenBudget: Type.Optional(
    Type.Integer({
      description:
        "Optional batch-wide token cap (soft gate — stops dispatching new children; never aborts in-flight).",
    }),
  ),
  spendBudget: Type.Optional(Type.Number({ description: "Optional batch-wide cost cap in $ (soft gate)." })),
});

/** Clamp a concurrency value to [1, MAX_CONCURRENCY], defaulting when undefined. */
export function clampConcurrency(n: number | undefined, max = MAX_CONCURRENCY): number {
  if (n === undefined) return Math.min(DEFAULT_BATCH_CONCURRENCY, max);
  if (n < 1) return 1;
  return Math.min(Math.floor(n), max);
}

/** Build the per-child spawn opts, folding in the non-overridable read-only exclusion. */
export function mergeReadOnlyExclusion(
  task: BatchTask,
  ctx: { defaultCwd: string; mainModel?: string; extensionTools?: ToolDefinition[] },
): SpawnSubagentOptions {
  const excludeTools = Array.from(new Set([...(task.excludeTools ?? []), ...READ_ONLY_EXCLUDED]));
  const opts: SpawnSubagentOptions = {
    task: task.task,
    cwd: task.cwd ?? ctx.defaultCwd,
    tools: task.tools,
    excludeTools,
    timeoutMs: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tokenBudget: task.tokenBudget,
    spendBudget: task.spendBudget,
  };
  if (task.model) opts.model = task.model;
  if (task.tier) opts.tier = task.tier;
  if (task.capability) opts.capability = task.capability;
  if (ctx.mainModel) opts.mainModel = ctx.mainModel;
  if (ctx.extensionTools?.length) opts.extensionTools = ctx.extensionTools;
  return opts;
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createSubagentsTool(options: SubagentsToolOptions = {}): ToolDefinition {
  const spawn = options.spawn ?? spawnSubagent;
  const defaultCwd = options.cwd ?? process.cwd();

  return defineTool({
    name: "subagents",
    label: "Subagents",
    description:
      "Dispatch N isolated read-only subagents in parallel (bounded) and return a positional array of results.",
    gating: {
      keywords: ["workflow", "pipeline", "orchestrate", "fan-out", "fan out", "parallel agent", "multi-step"],
    },
    promptSnippet:
      "Fan out read-only research/review subagents in parallel. Each child has edit/write/bash excluded. Returns one result per task in input order (null for a failed child).",
    executionMode: "sequential",
    parameters: subagentsToolSchema,
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      const t0 = Date.now();
      const tasks = params.tasks as BatchTask[];
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "tasks must be a non-empty array." }],
          details: { results: [], dispatched: 0, skipped: 0, elapsedMs: 0 } as SubagentsToolDetails,
        };
      }
      if (tasks.length > MAX_BATCH_TASKS) {
        return {
          content: [
            {
              type: "text" as const,
              text: `tasks array too large: ${tasks.length} > ${MAX_BATCH_TASKS}. Split into smaller batches.`,
            },
          ],
          details: { results: [], dispatched: 0, skipped: 0, elapsedMs: 0 } as SubagentsToolDetails,
        };
      }
      const concurrency = clampConcurrency(params.concurrency);
      const mainModel = options.getMainModel?.();
      const extensionTools = options.getExtensionTools?.();
      // Shared per-provider rate-limit gate (the OUTER cap across subagents +
      // workflow). Undefined when the session has no resolvable provider model
      // → run() is a pass-through and behavior is unchanged. The provider is the
      // SESSION's provider (mainModel), so every child in the batch shares one
      // budget regardless of per-task model overrides.
      const activeProvider = providerFromModelSpec(mainModel);
      const globalRateLimiter = activeProvider ? getGlobalRateLimiter(activeProvider) : undefined;

      const slots: (BatchResultSlot | undefined)[] = new Array<BatchResultSlot | undefined>(tasks.length).fill(
        undefined,
      );
      let dispatched = 0;
      // Batch-wide budget SOFT GATE state. `gateTripped` stops NEW children from
      // starting; in-flight children always finish. `acc` accumulates usage across
      // every child that reported usage; `budgetExhaustion` (if set) is surfaced on
      // `details` and used to label the skipped slots.
      let gateTripped = false;
      let budgetExhaustion: BudgetExhaustion | undefined;
      const acc = { tokens: { total: 0 }, cost: 0 };
      const batchBudget = {
        ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
        ...(params.spendBudget !== undefined ? { spendBudget: params.spendBudget } : {}),
      };
      const hasBatchBudget = params.tokenBudget !== undefined || params.spendBudget !== undefined;

      const dispatchChild = async (task: BatchTask, index: number): Promise<void> => {
        // Effective model string + task preview — computed up front so BOTH the
        // soft-gate skip branch and the normal dispatch branch can enrich the
        // result slot (deficit 4b: Completed-section display needs task/model).
        const childModel = task.model ?? task.tier ?? task.capability ?? mainModel ?? "default";
        const preview = taskPreview(task.task);
        // Soft gate: once tripped, no NEW children start; in-flight ones finish.
        // `gateTripped` is set only together with `budgetExhaustion` (see the
        // between-dispatch check below), so it is always defined here; the guard
        // narrows the type for TypeScript and leaves a defensive no-op if that
        // invariant ever breaks.
        if (gateTripped) {
          if (budgetExhaustion) {
            slots[index] = {
              status: "budget",
              exhaustion: budgetExhaustion,
              source: "batch",
              id: task.id,
              index,
              task: preview,
              model: childModel,
              elapsedMs: 0,
            };
          }
          return;
        }
        const childOpts = mergeReadOnlyExclusion(task, { defaultCwd, mainModel, extensionTools });
        // Register in-flight so `/subagents` shows this child while it runs.
        const childRunId = `${toolCallId}:${index}`;
        const childT0 = Date.now();
        // Per-child AbortController (Frontier A): the user can abort ONE child via
        // registry.abort(childRunId) → this controller fires. We FAN IN the parent
        // turn `signal` so a whole-turn Esc still aborts batch children (new —
        // previously batch children ignored the turn signal entirely).
        const childAc = new AbortController();
        if (signal?.aborted) childAc.abort();
        else signal?.addEventListener("abort", () => childAc.abort(), { once: true });
        options.inFlight?.start({
          id: childRunId,
          model: childModel,
          taskPreview: preview,
          startedAt: childT0,
          batchId: toolCallId,
          abort: () => childAc.abort(),
        });
        // Forward live callbacks so /subagents shows each child's resolved model and
        // activity trace (deficit 1). Added here — not in mergeReadOnlyExclusion — because
        // the callbacks close over the registry + childRunId, which that pure helper lacks.
        const childSpawnOpts: SpawnSubagentOptions = {
          ...childOpts,
          externalSignal: childAc.signal,
          onModelResolved: (modelId) => options.inFlight?.updateModel(childRunId, modelId),
          onHistory: (history) => {
            options.inFlight?.update(childRunId, history);
            // Single-line batch progress feed — kills the blind spinner on the
            // batch's own call line. Diagnostic only: a throwing onUpdate must
            // never change the batch result or fail a child (mirrors the singular
            // tool's try/catch discipline at subagent-tool.ts).
            try {
              const group = (options.inFlight?.list() ?? []).filter((e) => e.batchId === toolCallId);
              const running = group.filter((e) => e.status !== "completed").length;
              const total = params.tasks.length;
              const latest = summarizeLatestAction(history) ?? truncateToWidth(taskPreview(task.task), 40);
              onUpdate?.({
                content: [
                  { type: "text" as const, text: `subagents · ${running}/${total} running · latest: ${latest}` },
                ],
                details: undefined as never,
              });
            } catch {
              // swallowed — onUpdate is diagnostic only (mirrors the singular tool)
            }
          },
        };
        let result: SpawnSubagentResult;
        try {
          // Gate the actual provider dispatch under the shared per-provider cap
          // (outer bound). The per-batch `concurrency` worker pool above stays
          // the inner bound; this is the cross-tool shared budget. Pass-through
          // when no rateLimits cap is configured for the provider.
          const dispatch = () => spawn(childSpawnOpts);
          result = globalRateLimiter ? await globalRateLimiter.run(dispatch) : await dispatch();
        } finally {
          // Mark completed (kept in the registry for k/N + frozen trace); the whole
          // batch is evicted on return via endBatch(toolCallId). Runs on throw too, so
          // a failed child does not block its siblings — it just won't persist below.
          options.inFlight?.markCompleted(childRunId);
        }
        dispatched++;
        // Accumulate usage for the batch-wide budget check (guard for undefined usage).
        if (result.usage) {
          acc.tokens.total += result.usage.total;
          acc.cost += result.usage.cost;
        }
        // Per-child abort detection (Frontier A): a USER abort fires childAc only
        // (parent signal intact); a whole-turn Esc fans the parent signal INTO
        // childAc (signal.aborted distinguishes); a timeout aborts spawn's internal
        // controller, not childAc (falls through to timedout unchanged).
        const userAborted = childAc.signal.aborted && !signal?.aborted;
        // Map the slot — preserve per-child hard-budget routing (Task 3) alongside
        // failed->null and the normal done/timedout path, + the user-aborted path.
        const status = userAborted ? "aborted" : deriveSubagentStatus(result);
        if (userAborted) {
          slots[index] = {
            output: "",
            status: "aborted",
            id: task.id,
            index,
            task: preview,
            model: childModel,
            elapsedMs: Date.now() - childT0,
          };
        } else if (status === "failed") {
          slots[index] = null;
        } else if (result.budget) {
          slots[index] = {
            status: "budget",
            exhaustion: result.budget,
            source: "child",
            id: task.id,
            index,
            task: preview,
            model: childModel,
            elapsedMs: Date.now() - childT0,
          };
        } else {
          slots[index] = {
            output: result.output,
            status: status === "timedout" ? "timedout" : "done",
            id: task.id,
            index,
            usage: result.usage,
            task: preview,
            model: childModel,
            elapsedMs: Date.now() - childT0,
          };
        }
        // Durable record for completed runs only. Failed children (status "failed")
        // and gate-skipped children (early-returned above, never reached spawn) are
        // NOT real completed runs, so they are not persisted — matching the singular
        // tool. Budget-aborted children (status "budget") ARE persisted with their
        // `budget` field set, also matching the singular tool.
        if (status !== "failed") {
          options.persistence?.save({
            id: generateSubagentRunId(),
            toolCallId,
            task: task.task,
            model: childModel,
            tier: task.tier,
            cwd: childOpts.cwd ?? defaultCwd,
            status,
            exitCode: result.exitCode,
            timedOut: userAborted ? false : result.timedOut,
            stderr: result.stderr || undefined,
            startedAt: new Date(childT0).toISOString(),
            elapsedMs: Date.now() - childT0,
            usage: result.usage,
            budget: result.budget,
            output: userAborted ? "Subagent aborted by user." : result.output,
          });
        }
        // Check the batch budget BETWEEN dispatches (never aborts the child that just finished).
        if (hasBatchBudget && !gateTripped) {
          const ex = checkBudgetExhaustion(acc, batchBudget);
          if (ex) {
            gateTripped = true;
            budgetExhaustion = ex;
          }
        }
      };
      try {
        await runWithConcurrency(tasks, concurrency, dispatchChild);
      } finally {
        // Evict the whole batch on return (success OR a mid-batch throw) so the
        // registry is clean when execute() returns. Children stayed past their own
        // completion (markCompleted above) for k/N progress + frozen-trace follow.
        options.inFlight?.endBatch(toolCallId);
      }

      // `skipped` counts every budget-status slot — both batch-gate skips
      // (source "batch": never dispatched) and per-child hard-budget aborts
      // (source "child": ran, then hit its own ceiling). The per-slot `source`
      // distinguishes them in results + rendering; the aggregate intentionally
      // lumps both as "not ok, not failed".
      const skipped = slots.filter((s) => s != null && (s as { status: string }).status === "budget").length;
      const details: SubagentsToolDetails = {
        results: slots as BatchResultSlot[],
        dispatched,
        skipped,
        elapsedMs: Date.now() - t0,
        ...(budgetExhaustion ? { budgetExhaustion } : {}),
      };
      return { content: [{ type: "text" as const, text: renderBatchResult(details) }], details };
    },
  });
}

/** Render the batch result as a readable summary for the model. */
export function renderBatchResult(details: SubagentsToolDetails): string {
  const done = details.results.filter(
    (s) => s && (s as { status: string }).status !== "budget" && (s as { status: string }).status !== "aborted",
  ).length;
  const aborted = details.results.filter((s) => s && (s as { status: string }).status === "aborted").length;
  const failed = details.results.filter((s) => s === null).length;
  const skipped = details.skipped;
  // The aborted segment is only rendered when present, so a batch with no
  // user-aborts stays byte-identical to the pre-abort header.
  const header = `## subagents batch (${done} ok${aborted ? ` · ${aborted} aborted` : ""} · ${failed} failed · ${skipped} skipped) — ${(
    details.elapsedMs / 1000
  ).toFixed(1)}s`;
  const body = details.results
    .map((slot, i) => {
      if (slot === null)
        return `### [${i}] failed\n_(null — child failed; re-run via the singular \`subagent\` tool to see the error)_`;
      if (slot.status === "budget") {
        const label = slot.source === "child" ? "child budget" : "batch budget";
        return `### [${i}]${slot.id ? ` (${slot.id})` : ""} skipped — ${label}: ${slot.exhaustion.kind} ${slot.exhaustion.actual} > ${slot.exhaustion.limit}`;
      }
      if (slot.status === "aborted") {
        return `### [${i}]${slot.id ? ` (${slot.id})` : ""} aborted\n_(user-aborted mid-flight)_`;
      }
      return `### [${i}]${slot.id ? ` (${slot.id})` : ""} ${slot.status}\n${slot.output || "_(empty output)_"}`;
    })
    .join("\n\n");
  return `${header}\n\n${body}`;
}
