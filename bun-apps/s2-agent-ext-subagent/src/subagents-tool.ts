/**
 * `subagents` tool — agent-callable PARALLEL read-only fan-out. Dispatches N
 * isolated subagents (via spawnSubagent) with bounded concurrency, returning a
 * positional array of results. Read-only is ENFORCED: edit/write/bash are
 * always excluded (non-overridable) so children sharing the parent's working
 * tree can never race on writes. See .planning/done/2026-08-01-what-s-next-for-subagent-develop-map/.
 */
import { defineTool, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  AgentDefinition,
  AgentRegistry,
  AgentUsage,
  BudgetExhaustion,
  RunView,
  SpawnSubagentOptions,
  SpawnSubagentResult,
  SubagentInFlightRegistry,
  TurnExhaustion,
} from "@repo/s2-agent-core-runtime";
import {
  checkBudgetExhaustion,
  DEFAULT_BATCH_CONCURRENCY,
  deriveTaskLabel,
  fmtElapsed,
  generateSubagentRunId,
  getGlobalRateLimiter,
  isTerminalStatus,
  listAgentTypes,
  loadAgentRegistry,
  MAX_BATCH_TASKS,
  MAX_CONCURRENCY,
  providerFromModelSpec,
  resolveAgentType,
  roleAwareDefaults,
  type SubagentRunPersistence,
  shortModel,
  spawnSubagent,
  summarizeLatestAction,
  tierDefaultToken,
} from "@repo/s2-agent-core-runtime";
import { Type } from "typebox";
import { dispatchChild } from "./child-dispatch.js";
import { ComposerComponent } from "./composer-component.js";
import { type GitSnapshotOps, realGitOps, realGitSnapshotOps } from "./git-scope.js";
import { missingRequiredTools } from "./impossible-tools.js";
import {
  buildSiblingRoster,
  buildStartupContextBlock,
  DEFAULT_BATCH_STARTUP_CAP_CHARS,
  type StartupContextMode,
} from "./startup-context.js";
import { taskPreview, workIntentPreview } from "./subagent-tool-render.js";
import {
  abortSafetyFooter,
  augmentOutputWithScopeViolation,
  extractSalvage,
  resolveDisplayModel,
} from "./subagent-tool-run.js";
import { DEFAULT_TIMEOUT_MS } from "./subagent-tool-schema.js";

/** Tree-mutating tools a read-only child may NEVER carry (non-overridable). */
export const READ_ONLY_EXCLUDED = ["edit", "write", "bash"] as const;

/** One task in a batch. Same shape as the singular tool, minus the mutating
 *  hooks (no worktree isolation, no watchdog) that a read-only child cannot
 *  use. `agentType` IS supported (ticket 07): resolved via `resolveAgentType`
 *  exactly as the singular path — but worktree-isolating definitions are
 *  rejected up-front (the batch loop allocates no per-child worktrees). */
export interface BatchTask {
  task: string;
  id?: string;
  /** Named agentType (.pi/agents/*.md); binds tools/model/tier/prompt per the
   *  definition. Explicit per-task `tools`/`model`/`tier` still win. */
  agentType?: string;
  model?: string;
  tier?: string;
  capability?: string;
  cwd?: string;
  tools?: string[];
  excludeTools?: string[];
  requiredTools?: string[];
  commitScope?: string[];
  timeoutMs?: number;
  tokenBudget?: number;
  spendBudget?: number;
  /** Per-child turn cap (integer ≥ 1, hard — timeout-like abort). No default. */
  maxTurns?: number;
  retryOnTransient?: boolean;
}

/** A positional result slot (input order). `null` = the child failed. */
export type BatchResultSlot =
  | {
      output: string;
      status: "done" | "timedout" | "aborted" | "detached";
      id?: string;
      index: number;
      usage?: AgentUsage;
      /** Task preview (Completed-section display). */
      task: string;
      /** Resolved child model (never a hardcoded id). */
      model: string;
      /** The originally-requested model spec, when the resolution fell back to a
       *  different model (ticket 04, finding 2 — #1103's actual-model capture
       *  never reached the batch tool). Full spec for the audit trace; the
       *  DISPLAY shortens it via shortModel(). Absent on normal resolution. */
      requestedModel?: string;
      /** True when the model resolution fell back. Absent on normal resolution. */
      fellBack?: boolean;
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
      /** See the done/timedout/aborted variant (ticket 04, finding 2). */
      requestedModel?: string;
      /** See the done/timedout/aborted variant (ticket 04, finding 2). */
      fellBack?: boolean;
      /** 0 for gate-skipped (never ran); real for per-child budget aborts. */
      elapsedMs: number;
    }
  | {
      status: "turns";
      turns: TurnExhaustion;
      id?: string;
      index: number;
      /** Task preview (Completed-section display). */
      task: string;
      /** Resolved child model (never a hardcoded id). */
      model: string;
      /** See the done/timedout/aborted variant (ticket 04, finding 2). */
      requestedModel?: string;
      /** See the done/timedout/aborted variant (ticket 04, finding 2). */
      fellBack?: boolean;
      /** Real per-child elapsed (the child ran before the cap fired). */
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
  /** Parent session's model scope; see SubagentToolOptions.getScopedModels. */
  getScopedModels?: () => readonly string[] | undefined;
  /**
   * Parent session's CURRENT active tool-name set (the gated set). When a child
   * task omits an explicit `tools` allowlist, it defaults to THIS set instead of
   * re-inheriting the full ~55-tool definition universe (optimization #1,
   * `.planning/2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task/` ticket 01).
   * An explicit per-task `tools` always overrides.
   */
  getActiveTools?: () => string[] | undefined;
  /** Injectable spawn for tests (defaults to the real spawnSubagent). */
  spawn?: (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
  /** Injectable agent-type registry for tests (defaults to loadAgentRegistry(cwd)). */
  agentRegistry?: AgentRegistry;
  inFlight?: SubagentInFlightRegistry;
  persistence?: SubagentRunPersistence;
  /** Injectable spawn-time git snapshot ops for the shared startup-context
   *  block (ticket 04). Defaults to realGitSnapshotOps (best-effort). */
  gitSnapshotOps?: GitSnapshotOps;
}

export const subagentsToolSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      task: Type.String({
        description: "Full self-contained prompt — the child has NO access to this session's history.",
      }),
      id: Type.Optional(Type.String({ description: "Optional caller tag echoed in the result for correlation." })),
      agentType: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Named agentType (.pi/agents/*.md) whose tools/model/tier/prompt bind to this child. Built-in read-only types 'explore'/'plan' need no setup; user files shadow them. Worktree-isolating types are rejected (batch children share the parent tree). Empty string is invalid.",
        }),
      ),
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
      requiredTools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Tools this task NEEDS. Before spawn, the child is skipped (null slot) if any is absent from its allowlist or denied by excludeTools.",
        }),
      ),
      commitScope: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Opt-in commit-path allowlist for this child. When set, flags any committed path outside it as a ⚠ (detection only). Default-off on the plural tool (read-only children + concurrent shared-tree access).",
        }),
      ),
      timeoutMs: Type.Optional(Type.Integer({ description: "Per-child wall-clock cap (ms). Defaults to 15 min." })),
      tokenBudget: Type.Optional(Type.Integer({ description: "Per-child token cap (hard — aborts that one child)." })),
      spendBudget: Type.Optional(Type.Number({ description: "Per-child cost cap in $ (hard)." })),
      maxTurns: Type.Optional(
        Type.Integer({
          description: "Per-child turn cap (integer >= 1, hard — timeout-like abort). No default.",
        }),
      ),
      retryOnTransient: Type.Optional(
        Type.Boolean({
          description:
            "Retry this child once on a transient failure (timeout/network/rate-limit/schema). Default true — same as the singular `subagent` tool.",
        }),
      ),
    }),
    { description: "Read-only fan-out: each task runs as an isolated subagent with edit/write/bash always excluded." },
  ),
  concurrency: Type.Optional(Type.Integer({ description: "Max parallel children. Clamped to [1,16]; default 4." })),
  context: Type.Optional(
    Type.Union([Type.Literal("full"), Type.Literal("minimal"), Type.Literal("none")], {
      description:
        "Startup-context block prefixed to every child's spawned task (CLAUDE.md hierarchy is inherited regardless). Batch default 'minimal' = git branch + HEAD only (one SHARED snapshot for the whole batch, tightly capped); 'full' adds the porcelain status body + sibling roster; 'none' omits the block.",
    }),
  ),
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

/** Build the per-child spawn opts, folding in the non-overridable read-only exclusion.
 *  `ctx.activeTools` is the parent's gated active set — used as the per-task `tools`
 *  default when the task omits an explicit allowlist (optimization #1).
 *  `ctx.agentDef` (ticket 07) binds the resolved agentType exactly as the singular
 *  path's buildSpawnOptions: explicit per-task `tools`/`excludeTools`/`model`/`tier`
 *  win, the definition supplies the next fallback, and the definition's prompt
 *  rides the spawn's `instructions` (the persisted task stays raw). The
 *  read-only exclusion is applied LAST — a definition (or task) allowlisting
 *  edit/write/bash is still denied (non-overridable). */
export function mergeReadOnlyExclusion(
  task: BatchTask,
  ctx: {
    defaultCwd: string;
    mainModel?: string;
    scopedModels?: readonly string[];
    extensionTools?: ToolDefinition[];
    activeTools?: string[];
    /** Run token for the abort-safety footer's log path (`<toolCallId>:<index>`). */
    logToken?: string;
    /** Resolved agentType definition (ticket 07), when the task names one. */
    agentDef?: AgentDefinition;
    /** Rendered startup-context block (ticket 04), shared verbatim across the
     *  batch — the snapshot is captured ONCE per list_subagents call, so every
     *  child sees the identical spawn-time state. Prefixed to the spawned task
     *  only; task.task (persisted) stays raw. */
    startupBlock?: string;
  },
): SpawnSubagentOptions {
  const excludeTools = Array.from(
    new Set([...(task.excludeTools ?? ctx.agentDef?.disallowedTools ?? []), ...READ_ONLY_EXCLUDED]),
  );
  // Ticket 07 singular-parity folds: task field > agentType definition > ctx default.
  const model = task.model ?? ctx.agentDef?.model;
  const tier = task.tier ?? ctx.agentDef?.tier;
  // H4: a batch child is read-only BY CONSTRUCTION (edit/write/bash always
  // denied below), so the write-tool footer gate is always false here — the
  // footer rides only on an explicit long turn cap (maxTurns > 10). The
  // startup-context block (ticket 04) PREFIXES the spawned task; the footer
  // is APPENDED after it. Both compose onto the SPAWNED task only; task.task
  // (persisted) stays raw.
  const taskWithBlock = ctx.startupBlock ? `${ctx.startupBlock}\n\n${task.task}` : task.task;
  const task0 =
    (task.maxTurns ?? 0) > 10
      ? `${taskWithBlock}${abortSafetyFooter(`/tmp/subagent-runs/${ctx.logToken ?? "batch-child"}.md`)}`
      : taskWithBlock;
  const opts: SpawnSubagentOptions = {
    task: task0,
    // H1: real per-task label (was a hardcoded "zk-spawn").
    label: deriveTaskLabel(task.task),
    cwd: task.cwd ?? ctx.defaultCwd,
    // Default to the parent's gated active set (not the full definition universe)
    // so a spawned child doesn't re-pay the ~18k tok/req schema baseline the
    // parent gated down to ~10k. An explicit per-task `tools` always overrides
    // (ticket 07: a definition's `tools` sits between — task > agentType > active set).
    // See .planning/2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task/ ticket 01.
    tools: task.tools ?? ctx.agentDef?.tools ?? ctx.activeTools,
    excludeTools,
    timeoutMs: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tokenBudget: task.tokenBudget ?? tierDefaultToken(tier, model ?? ctx.mainModel),
    spendBudget: task.spendBudget,
    maxTurns: task.maxTurns,
    // Batch children retried once on a transient failure all along (spawnSubagent
    // defaults it on), but the batch surface exposed no way to say otherwise
    // while the singular tool did. Forwarding it makes the policy one the caller
    // can see and set on both tools, instead of one they can only read the source
    // to discover.
    retryOnTransient: task.retryOnTransient,
    ...(ctx.agentDef?.prompt ? { instructions: ctx.agentDef.prompt } : {}),
  };
  if (model) opts.model = model;
  if (tier) opts.tier = tier;
  if (task.capability) opts.capability = task.capability;
  if (ctx.mainModel) opts.mainModel = ctx.mainModel;
  if (ctx.scopedModels?.length) opts.scopedModels = ctx.scopedModels;
  if (ctx.extensionTools?.length) opts.extensionTools = ctx.extensionTools;
  return opts;
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order.
 *  Workers are drained via `Promise.allSettled` so in-flight siblings always
 *  settle (never orphaned) even if one `fn` rejects; the first rejection is
 *  rethrown afterwards so callers still observe the error. */
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
      const item = items[index];
      if (item === undefined) continue; // invariant: index < items.length (while guard)
      results[index] = await fn(item, index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const firstRejection = settled.find((s) => s.status === "rejected");
  if (firstRejection) {
    throw (firstRejection as PromiseRejectedResult).reason;
  }
  return results;
}

export function createSubagentsTool(
  options: SubagentsToolOptions = {},
): ToolDefinition<typeof subagentsToolSchema, SubagentsToolDetails> {
  const spawn = options.spawn ?? spawnSubagent;
  const defaultCwd = options.cwd ?? process.cwd();

  return defineTool<typeof subagentsToolSchema, SubagentsToolDetails>({
    // Renamed 2026-08-20 (tool-name verb_object effort): legacy name `subagents`
    // — see docs/agents/extension-naming.md for the rename history.
    name: "list_subagents",
    label: "Subagents",
    description:
      "Dispatch N isolated read-only subagents in parallel (bounded) and return a positional array of results.",
    gating: { gate: "workflow" }, // reference form (ticket 01) — family declared in GATE_DEFS["workflow"] (workflow ext)
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
      // Ticket 07: per-task agentType, resolved via the SAME resolveAgentType as
      // the singular path. Two batch-specific guardrails, both whole-batch
      // failEarly BEFORE any dispatch: (a) an unknown type rejects the batch —
      // a positional null slot cannot carry the "available types" hint the
      // caller needs to fix the call; (b) a worktree-isolating type rejects the
      // batch — the batch loop allocates no per-child worktrees, so honoring
      // the definition would silently downgrade isolation. Errors list the
      // offending task indexes so one bad task is findable in a large batch.
      // The registry loads LAZILY — a batch with no typed task keeps the pre-07
      // path free of the .pi/agents disk scan.
      // Ticket 07: `!== undefined` (not truthiness) on BOTH the registry-load
      // gate and the loop — an empty-string agentType loads the registry and
      // rejects the batch as a bad type name, instead of silently dispatching
      // untyped.
      const agentRegistry = tasks.some((t) => t?.agentType !== undefined)
        ? (options.agentRegistry ?? loadAgentRegistry(defaultCwd))
        : (options.agentRegistry ?? new Map<string, AgentDefinition>());
      const agentDefs = new Map<number, AgentDefinition>();
      const typeErrors: string[] = [];
      for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index];
        if (task?.agentType === undefined) continue;
        const def = resolveAgentType(task.agentType, agentRegistry);
        if (!def) {
          typeErrors.push(`[${index}] unknown agentType "${task.agentType}"`);
          continue;
        }
        if (def.isolation === "worktree") {
          typeErrors.push(
            `[${index}] agentType "${task.agentType}" uses worktree isolation — unsupported in batch (use the singular spawn_subagent tool)`,
          );
          continue;
        }
        agentDefs.set(index, def);
      }
      if (typeErrors.length > 0) {
        const known = listAgentTypes(agentRegistry).map((t) => t.name);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Batch rejected before dispatch — agentType errors:\n${typeErrors.join("\n")}` +
                (known.length
                  ? `\nAvailable agentTypes: ${known.join(", ")}.`
                  : "\nNo agentType definitions found (.pi/agents/*.md or ~/.pi/agents/*.md)."),
            },
          ],
          details: { results: [], dispatched: 0, skipped: 0, elapsedMs: Date.now() - t0 } as SubagentsToolDetails,
        };
      }
      const concurrency = clampConcurrency(params.concurrency);
      // Startup-context block (ticket 04): ONE git snapshot for the whole
      // batch, captured before any child dispatches — a 10-task batch pays one
      // pair of git subprocesses, and every child sees the IDENTICAL
      // spawn-time state (map D5). Default 'minimal' (branch + HEAD, no
      // porcelain body, no roster): read-only researchers need to know WHERE
      // they stand; the dirty-tree inventory and sibling roster are the
      // singular 'full' mode's job. Best-effort — a non-repo cwd yields no
      // block and never fails the batch.
      const contextMode: StartupContextMode = params.context ?? "minimal";
      let startupBlock: string | undefined;
      if (contextMode !== "none") {
        const snapshotOps = options.gitSnapshotOps ?? realGitSnapshotOps;
        const gitStatus = await snapshotOps.snapshot(defaultCwd).catch(() => undefined);
        startupBlock = buildStartupContextBlock({
          spawnCwd: defaultCwd,
          gitStatus,
          roster: contextMode === "full" ? buildSiblingRoster(undefined, options.inFlight) : undefined,
          mode: contextMode,
          capChars: DEFAULT_BATCH_STARTUP_CAP_CHARS,
        });
      }
      const mainModel = options.getMainModel?.();
      const scopedModels = options.getScopedModels?.();
      const extensionTools = options.getExtensionTools?.();
      // Parent's gated active set — the per-task `tools` default (optimization #1).
      const activeTools = options.getActiveTools?.();
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
      const acc = { tokens: { total: 0, input: 0, output: 0 }, cost: 0 };
      // Per-child final usage, captured via the additive onUsage callback
      // (fires once at each child's completion). Feeds the running (live)
      // header's Σtok/$Σ. NOTE: onUsage is completion-triggered, so the Σ is
      // "sum over children completed so far" — not a per-token live ticker.
      const runningUsage = new Map<string, AgentUsage>();
      const batchBudget = {
        ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
        ...(params.spendBudget !== undefined ? { spendBudget: params.spendBudget } : {}),
      };
      const hasBatchBudget = params.tokenBudget !== undefined || params.spendBudget !== undefined;

      const runTask = async (task: BatchTask, index: number): Promise<void> => {
        // Ticket 07: this task's resolved agentType definition (undefined when
        // the task names none — the pre-07 path, byte-identical).
        const agentDef = agentDefs.get(index);
        // Effective model string + task preview — computed up front so BOTH the
        // soft-gate skip branch and the normal dispatch branch can enrich the
        // result slot (deficit 4b: Completed-section display needs task/model).
        // Ticket 07 (cc-parity): precedence unified with the singular path —
        // ONE shared resolveDisplayModel (model > capability > tier >
        // mainModel) with the prefixed display strings (`tier:big`,
        // `capability:vision`), replacing the batch-local raw chain that
        // ordered tier above capability and dropped the prefixes. The
        // definition's model/tier fold into the task fields first (singular
        // parity); definitions carry no capability.
        const childModel = resolveDisplayModel(
          task.model ?? agentDef?.model,
          task.capability,
          task.tier ?? agentDef?.tier,
          mainModel,
        );
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
        // H3: role-aware bounds for an all-omitted batch child. A batch child
        // is read-only by construction (edit/write/bash always denied), so the
        // role is always recon. Applied to the task BEFORE
        // mergeReadOnlyExclusion so the spawn sees one coherent envelope; the
        // notice lands in the durable record's output (grep-able) — batch
        // slots stay compact.
        const reconBounds = roleAwareDefaults(
          { tokenBudget: task.tokenBudget, maxTurns: task.maxTurns, timeoutMs: task.timeoutMs },
          "recon",
          tierDefaultToken(task.tier ?? agentDef?.tier, task.model ?? agentDef?.model ?? mainModel),
        );
        const effTask: BatchTask = reconBounds.applied
          ? {
              ...task,
              tokenBudget: reconBounds.tokenBudget,
              maxTurns: reconBounds.maxTurns,
              timeoutMs: reconBounds.timeoutMs,
            }
          : task;
        const childOpts = mergeReadOnlyExclusion(effTask, {
          defaultCwd,
          mainModel,
          scopedModels,
          extensionTools,
          activeTools,
          logToken: `${toolCallId}:${index}`,
          agentDef,
          startupBlock,
        });
        // #03 plural mirror: impossible-tool preflight. A child missing a
        // required tool is skipped (null slot) and warned — never dispatched.
        const missingChild = missingRequiredTools(task.requiredTools, childOpts.tools, childOpts.excludeTools);
        if (missingChild) {
          console.warn(
            `[subagents] task[${index}] requires tools not in the child allowlist: ${missingChild.join(", ")} — skipped.`,
          );
          slots[index] = null;
          return;
        }
        // Abort-flag bail (P1): if a sibling already failed the batch, do NOT
        // register a new child (it would immediately become a zombie orphaned
        // by endBatch); null the slot and stop.
        if (batchAborted) {
          slots[index] = null;
          return;
        }
        const childRunId = `${toolCallId}:${index}`;
        const childT0 = Date.now();
        // The whole per-child pipeline — abort fan-in, in-flight lifecycle,
        // resolved-model capture, the commit-scope audit, user-abort detection
        // and status derivation — is owned by dispatchChild, shared with the
        // singular tool. It used to be a hand-maintained copy here, which is how
        // the actual-model capture (ticket 04, finding 2) and the default-on
        // scope audit ("#02 B1") each reached only one of the two tools.
        let outcome: Awaited<ReturnType<typeof dispatchChild>>;
        outcome = await dispatchChild(
          {
            id: childRunId,
            startedAt: childT0,
            spawn: childOpts,
            entry: {
              model: childModel,
              taskPreview: preview,
              // Work-intent strip from the RAW task, so the docked context box
              // can surface it (ticket 04, finding 1).
              workIntent: workIntentPreview(task.task),
              batchId: toolCallId,
            },
            // Audit only when a scope is declared — deliberately NOT the
            // singular tool's default-on policy, and stated here rather than
            // left to diverge silently. The singular tool's child holds raw
            // `bash`, so an undeclared scope must still flag a `git add -A`
            // sweep. A batch child has edit/write/bash excluded and so cannot
            // reach git at all, making an unconditional audit two git
            // subprocesses per child to detect something it cannot do.
            scope: task.commitScope
              ? { declared: task.commitScope, runCwd: defaultCwd, spawnCwd: childOpts.cwd ?? defaultCwd }
              : undefined,
            parentSignal: signal,
          },
          {
            spawn,
            inFlight: options.inFlight,
            gitOps: realGitOps,
            // Keep the entry after completion for k/N progress + a frozen
            // trace; the whole batch is evicted on return via endBatch.
            release: "markCompleted",
            // Gate the provider dispatch under the shared per-provider cap
            // (outer bound); the `concurrency` worker pool is the inner bound.
            // Pass-through when no cap is configured for the provider.
            gate: globalRateLimiter ? (fn) => globalRateLimiter.run(fn) : undefined,
            onUsage: (u) => {
              runningUsage.set(childRunId, u);
            },
            onHistory: () => {
              // Single-line batch progress feed — kills the blind spinner on
              // the batch's own call line. dispatchChild already swallows a
              // throw here, so a broken feed can never fail a child.
              const group = (options.inFlight?.views() ?? []).filter((v) => v.batchId === toolCallId);
              const running = group.filter((v) => !isTerminalStatus(v.status)).length;
              const total = params.tasks.length;
              const agg = sumUsage(runningUsage.values());
              const aggStr = agg.total > 0 ? ` · ${agg.total} tok · $${agg.cost.toFixed(3)}` : "";
              const header = `subagents · ${running}/${total} running${aggStr}`;
              const table = buildLiveTable(group);
              const text = table ? `${header}\n${table}` : header;
              onUpdate?.({ content: [{ type: "text" as const, text }], details: undefined as never });
            },
          },
        );
        const result = outcome.result;
        const elapsedMs = outcome.elapsedMs;
        dispatched++;
        // Accumulate usage for the batch-wide budget check (guard for undefined usage).
        // Full breakdown: the batch gate rides the billable (real-token)
        // metric — cache excluded (ADR-subagent-0009).
        if (result.usage) {
          acc.tokens.total += result.usage.total;
          acc.tokens.input += result.usage.input ?? 0;
          acc.tokens.output += result.usage.output ?? 0;
          acc.cost += result.usage.cost;
        }
        const userAborted = outcome.userAborted;
        const status = outcome.status;
        const slotModel = outcome.model;
        const slotRequestedModel = outcome.requestedModel;
        const slotFellBack = outcome.fellBack || undefined;
        // t02: an aborted child is an ABORTED slot regardless of WHICH lever
        // fired (viewer x = userAborted; whole-turn Esc fans into childAc and
        // arrives here as status "aborted" with userAborted false). Either way
        // the user interrupted it — never badge it done/timedout.
        if (userAborted || status === "aborted") {
          slots[index] = {
            output: "",
            status: "aborted",
            id: task.id,
            index,
            task: preview,
            model: slotModel,
            requestedModel: slotRequestedModel,
            fellBack: slotFellBack,
            elapsedMs,
          };
        } else if (status === "failed") {
          slots[index] = null;
        } else if (result.failure?.kind === "budget") {
          slots[index] = {
            status: "budget",
            exhaustion: result.failure.budget,
            source: "child",
            id: task.id,
            index,
            task: preview,
            model: slotModel,
            requestedModel: slotRequestedModel,
            fellBack: slotFellBack,
            elapsedMs,
          };
        } else if (result.failure?.kind === "turns") {
          // Per-child turn-cap abort — mirrors the per-child budget slot (Task 3b):
          // the child ran, hit its maxTurns ceiling, and was aborted with
          // timeout-like semantics. No output → counted as skipped, never "done".
          slots[index] = {
            status: "turns",
            turns: result.failure.turns,
            id: task.id,
            index,
            task: preview,
            model: slotModel,
            requestedModel: slotRequestedModel,
            fellBack: slotFellBack,
            elapsedMs: Date.now() - childT0,
          };
        } else {
          slots[index] = {
            // Task 05: a detached child was handed off to its detached OS
            // subprocess — the run stays live in the subagents section; the
            // slot records the hand-off, not a completion.
            output:
              status === "detached"
                ? `Detached → background (run ${toolCallId}:${index}; still live in the status section / /subagents)`
                : result.output,
            status: status === "timedout" ? "timedout" : status === "detached" ? "detached" : "done",
            id: task.id,
            index,
            usage: result.usage,
            task: preview,
            model: slotModel,
            requestedModel: slotRequestedModel,
            fellBack: slotFellBack,
            elapsedMs,
          };
        }
        // Durable record for completed runs only. Failed children (status "failed")
        // and gate-skipped children (early-returned above, never reached spawn) are
        // NOT real completed runs, so they are not persisted — matching the singular
        // tool. Budget-aborted children (status "budget") ARE persisted with their
        // `budget` field set, also matching the singular tool. A DETACHED child
        // (Task 05) persists nothing here either — the detached subprocess owns
        // the run and its eventual completed-record write (persistence owns
        // recovery via the detach manifest).
        if (status !== "failed" && status !== "detached") {
          options.persistence?.save({
            id: generateSubagentRunId(),
            toolCallId,
            task: task.task,
            // Persist the ACTUAL model + audit fields when it fell back (mirrors
            // the singular tool — ticket 04, finding 2). Tier persists the FOLDED
            // value (task.tier ?? agentDef.tier) like the singular path — the
            // effective budget derives from it, so raw-undefined here would
            // misattribute retrospective budget analysis (review finding 1).
            model: slotModel,
            requestedModel: slotRequestedModel,
            fellBack: slotFellBack,
            tier: task.tier ?? agentDef?.tier,
            cwd: childOpts.cwd ?? defaultCwd,
            status,
            error: result.failure?.message,
            startedAt: new Date(childT0).toISOString(),
            elapsedMs,
            usage: result.usage,
            budget: result.failure?.kind === "budget" ? result.failure.budget : undefined,
            turns: result.failure?.kind === "turns" ? result.failure.turns : undefined,
            // H2: record-only salvage for an aborted batch child (the slot
            // output stays compact; subagent_runs get renders the section).
            salvage:
              userAborted ||
              result.failure?.kind === "budget" ||
              result.failure?.kind === "turns" ||
              result.failure?.kind === "timedout"
                ? extractSalvage(outcome.history)
                : undefined,
            output: userAborted
              ? "Subagent aborted by user."
              : reconBounds.applied && reconBounds.notice
                ? `${result.output}\n${reconBounds.notice}`
                : result.output,
          });
        }
        // Commit-scope violation surfaced into the child's output. Only slots
        // carrying an `output` (done/timedout/aborted) can be augmented; failed
        // (null) and budget (no output) slots are skipped. Detection only.
        if (
          outcome.scopeCheck &&
          outcome.scopeCheck.outOfScope.length > 0 &&
          slots[index] &&
          (slots[index] as { output?: string }).output !== undefined
        ) {
          const slot = slots[index] as { output: string };
          slot.output = augmentOutputWithScopeViolation(slot.output, outcome.scopeCheck);
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
      // Mid-batch-throw containment (P1): a per-child error must never (a)
      // reject a worker promise (it would short-circuit Promise.all and orphan
      // in-flight siblings), (b) leak the child's registry entry, or (c) spawn
      // zombie children after the failure. The wrapper nulls the slot, sets
      // `batchAborted` (checked by every worker before dispatching the NEXT
      // child and by dispatchChild just before inFlight.start), and records the
      // first error; runWithConcurrency drains all workers via allSettled, then
      // the recorded error is rethrown so execute() still fails loudly.
      let batchAborted = false;
      let firstError: Error | undefined;
      const worker = async (task: BatchTask, index: number): Promise<void> => {
        if (batchAborted) return; // stop dispatching new children after a failure
        try {
          await runTask(task, index);
        } catch (err) {
          batchAborted = true;
          slots[index] = null;
          if (firstError === undefined) firstError = err instanceof Error ? err : new Error(String(err));
        }
      };
      try {
        await runWithConcurrency(tasks, concurrency, worker);
        if (firstError !== undefined) throw firstError;
      } catch (err) {
        // Outer error path: abort remaining dispatches BEFORE the finally's
        // endBatch runs, so no new child registers between failure and eviction.
        batchAborted = true;
        throw err;
      } finally {
        // Launder the `slots` holes (P1): every index must end as either a
        // result or an explicit `null` before the `as BatchResultSlot[]` cast —
        // gate-skipped children without a budget record, aborted dispatches,
        // and worker-wrap failures all leave `undefined` holes otherwise.
        for (let i = 0; i < slots.length; i++) {
          if (slots[i] === undefined) slots[i] = null;
        }
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
      const skipped = slots.filter(
        (s) =>
          s != null && ((s as { status: string }).status === "budget" || (s as { status: string }).status === "turns"),
      ).length;
      const details: SubagentsToolDetails = {
        results: slots as BatchResultSlot[],
        dispatched,
        skipped,
        elapsedMs: Date.now() - t0,
        ...(budgetExhaustion ? { budgetExhaustion } : {}),
      };
      return { content: [{ type: "text" as const, text: renderBatchResult(details) }], details };
    },
    renderCall(args, theme, _context) {
      // Compose-in-render (ticket 02): the batch header (incl. the first-task
      // preview) is composed inside render(width) at the real terminal width.
      const component =
        _context.lastComponent instanceof ComposerComponent ? _context.lastComponent : new ComposerComponent(() => "");
      component.setComposer((width) => renderSubagentsCall(args, theme, width));
      return component;
    },
    renderResult(result, options, theme, _context) {
      // Same deferred mounting; renderSubagentsResult's row shapes stay
      // width-constant today (per-slot caps), Text's wrap is the backstop.
      const component =
        _context.lastComponent instanceof ComposerComponent ? _context.lastComponent : new ComposerComponent(() => "");
      component.setComposer(() => renderSubagentsResult(result, options, theme));
      return component;
    },
  });
}

/** Render the batch result as a readable summary for the model. */
export function renderBatchResult(details: SubagentsToolDetails): string {
  const done = details.results.filter(
    (s) =>
      s &&
      (s as { status: string }).status !== "budget" &&
      (s as { status: string }).status !== "turns" &&
      (s as { status: string }).status !== "aborted",
  ).length;
  const aborted = details.results.filter((s) => s && (s as { status: string }).status === "aborted").length;
  const failed = details.results.filter((s) => s === null).length;
  const skipped = details.skipped;
  // The aborted segment is only rendered when present, so a batch with no
  // user-aborts stays byte-identical to the pre-abort header.
  const header = `## subagents batch (${done} ok${aborted ? ` · ${aborted} aborted` : ""} · ${failed} failed · ${skipped} skipped) — ${fmtElapsed(details.elapsedMs)}`;
  const body = details.results
    .map((slot, i) => {
      if (slot === null)
        return `### [${i}] failed\n_(null — child failed; re-run via the singular \`subagent\` tool to see the error)_`;
      if (slot.status === "budget") {
        const label = slot.source === "child" ? "child budget" : "batch budget";
        return `### [${i}]${slot.id ? ` (${slot.id})` : ""} skipped — ${label}: ${slot.exhaustion.kind} ${slot.exhaustion.actual} > ${slot.exhaustion.limit}`;
      }
      if (slot.status === "turns") {
        return `### [${i}]${slot.id ? ` (${slot.id})` : ""} skipped — max turns exceeded: ${slot.turns.turnsUsed}/${slot.turns.maxTurns} turns (timeout-like abort; re-run with a higher maxTurns)`;
      }
      if (slot.status === "aborted") {
        return `### [${i}]${slot.id ? ` (${slot.id})` : ""} aborted\n_(user-aborted mid-flight)_`;
      }
      return `### [${i}]${slot.id ? ` (${slot.id})` : ""} ${slot.status}\n${slot.output || "_(empty output)_"}`;
    })
    .join("\n\n");
  return `${header}\n\n${body}`;
}

/** Theme the call line shown WHILE the batch runs. */
export function renderSubagentsCall(
  args: { tasks?: Array<{ task: string }>; concurrency?: number } | undefined,
  theme: Theme,
  width?: number,
): string {
  // Render-layer safe (2026-08-16 crash fix #2): this composer captures RAW
  // tool-call args and executes every frame — args can be nullish while the
  // call's arguments are still streaming/absent. Total: degenerate input
  // renders an empty line instead of throwing (an uncaught render kills pi).
  if (!args) return "";
  const parts: string[] = [theme.bold(theme.fg("toolTitle", "subagents"))];
  const taskCount = args.tasks?.length ?? 0;
  parts.push(theme.fg("muted", `${taskCount} tasks`));
  if (args.concurrency !== undefined) parts.push(theme.fg("muted", `concurrency ${args.concurrency}`));
  if (args.tasks && args.tasks.length > 0) {
    const head = args.tasks[0];
    if (head) {
      // Width-aware first-task preview (ticket 02): the render-time width
      // reaches taskPreview via the component mounting; 60 stays the upper
      // bound so wide terminals render byte-identically to the old cap.
      const first = taskPreview(head.task, 60, width);
      parts.push(theme.fg("dim", `"${first}"`));
    }
  }
  return parts.join(" ▸ ");
}

/** Fixed-width status badges for the collapsed batch per-slot line (ticket 05,
 *  finding 6). The badge text width varies by terminal status
 *  (`✓ done` / `⏱ timedout` / `⛔ budget` / `⊘ aborted` / `✗ failed`); padding
 *  each badge to the widest keeps the following `model · elapsed · task`
 *  columns aligned across rows so a quick vertical scan of an N-children batch
 *  stays aligned. Fixed-width pad only — no terminal-width dependency. */
const BATCH_STATUS_BADGES = {
  done: { text: "✓ done", tone: "success" as const },
  timedout: { text: "⏱ timedout", tone: "warning" as const },
  budget: { text: "⛔ budget", tone: "warning" as const },
  turns: { text: "⏹ turns", tone: "warning" as const },
  aborted: { text: "⊘ aborted", tone: "dim" as const },
  failed: { text: "✗ failed", tone: "error" as const },
};
const BATCH_BADGE_WIDTH = Math.max(...Object.values(BATCH_STATUS_BADGES).map((b) => b.text.length));

/** Render a fixed-width status badge for the collapsed batch per-slot line so
 *  the following `model · elapsed · task` columns line up across rows
 *  (ticket 05, finding 6). Pads the badge text to {@link BATCH_BADGE_WIDTH} so a
 *  short `✓ done` (6) matches a wide `⏱ timedout` (10) before the columns
 *  follow. Unknown statuses fall back to the `failed` badge. */
function batchStatusBadge(status: string, theme: Theme): string {
  const b =
    status in BATCH_STATUS_BADGES
      ? BATCH_STATUS_BADGES[status as keyof typeof BATCH_STATUS_BADGES]
      : BATCH_STATUS_BADGES.failed;
  return theme.fg(b.tone, b.text.padEnd(BATCH_BADGE_WIDTH));
}

/** Usage segment mirroring the single `subagent` card's meta: ` · $X.XXX · Ntok`
 *  when usage is present and non-zero, else `""` (defensive — degrades to empty).
 *  Load-bearing: render fixtures omit `usage`, so `""` keeps rendered lines
 *  byte-compatible (no phantom spaces/tokens). */
export function formatUsage(u: AgentUsage | undefined): string {
  return u && u.total > 0 ? ` · $${u.cost.toFixed(3)} · ${u.total} tok` : "";
}

/** Themed `model · elapsed · usage` line for a done/timedout/aborted/budget slot.
 *  Shared by the done-collapsed per-slot line and the done-expanded meta line
 *  (DRY). The model segment is RunView-sourced (`modelSeg`) when the caller
 *  holds a view; settled slots that have no view degrade to
 *  `shortModel(slot.model) ?? "default"`. `usage` optional → degrades to
 *  `model · elapsed`. */
export function formatSlotMeta(
  slot: { modelSeg?: string; model?: string; elapsedMs: number; usage?: AgentUsage },
  theme: Theme,
): string {
  const seg = slot.modelSeg ?? shortModel(slot.model ?? "") ?? "default";
  return theme.fg("muted", `${seg} · ${fmtElapsed(slot.elapsedMs)}${formatUsage(slot.usage)}`);
}

/** Extract the trailing `:N` dispatch index from a batch child runId
 *  (`${batchId}:${index}`). NaN for ids without a numeric suffix (sorts last). */
export function childDispatchIndex(id: string): number {
  const idx = Number(id.slice(id.lastIndexOf(":") + 1));
  return Number.isFinite(idx) ? idx : NaN;
}

/** Pure live-table builder for the running (isPartial) batch view. One row per
 *  in-flight child, sorted ascending by dispatch index:
 *    `[i] slot ⏱/✓ elapsed · currentAction`
 *  - `slot` via RunView.modelSeg (fallback-aware; built once in core-runtime).
 *  - glyph ⏱ while live, ✓ once terminal (kept in the registry until endBatch
 *    so a finished child still shows its final elapsed).
 *  - `elapsed` via fmtElapsed(RunView.elapsedMs) — buildRunView already FREEZES
 *    elapsed at endedAt for terminal rows, so a finished child's elapsed stops
 *    growing while it lingers in the registry pre-endBatch (the freeze policy
 *    has exactly one home: core-runtime).
 *  - `currentAction` from {@link summarizeLatestAction}(history), falling back to
 *    latestAction (truncated to 40) when there is no history yet.
 *  PLAIN text (no theme — `execute()` has no Theme; rendered dim by the isPartial
 *  branch of `renderSubagentsResult`). Empty input → "" (header-only). */
export function buildLiveTable(views: RunView[]): string {
  const sorted = [...views].sort((a, b) => {
    const ia = childDispatchIndex(a.id);
    const ib = childDispatchIndex(b.id);
    return (Number.isNaN(ia) ? Infinity : ia) - (Number.isNaN(ib) ? Infinity : ib);
  });
  return sorted
    .map((v) => {
      const idx = childDispatchIndex(v.id);
      const idxLabel = Number.isNaN(idx) ? "?" : String(idx);
      const glyph = v.elapsedFrozen ? "✓" : "⏱";
      const action = summarizeLatestAction(v.history) ?? truncateToWidth(v.latestAction ?? "", 40);
      return `[${idxLabel}] ${v.modelSeg} ${glyph} ${fmtElapsed(v.elapsedMs)} · ${action}`;
    })
    .join("\n");
}

/** Sum total + cost across any iterable of AgentUsage (slots' usage for the done
 *  header; the runningUsage map's values for the live header). Empty → zeros. */
export function sumUsage(values: Iterable<AgentUsage>): { total: number; cost: number } {
  let total = 0;
  let cost = 0;
  for (const v of values) {
    total += v.total;
    cost += v.cost;
  }
  return { total, cost };
}

/** Default live-feed CHILD-row budget for a COLLAPSED partial `subagents`
 *  render — line 0 (the header) is always shown and EXEMPT; the first N child
 *  rows of the batch progress feed stay visible while the tool-call is
 *  collapsed (see renderLiveFeedDim, used by BOTH the details-less streaming
 *  path and the isPartial branch of renderSubagentsResult). */
const DEFAULT_LIVE_LINES = 5;

/** How many live-feed lines a collapsed partial `subagents` render shows.
 *  Env knob `SUBAGENT_LIVE_LINES` (positive int) overrides the default 5;
 *  unset/non-integer/<1 values fall back to the default. Read fresh per call
 *  (budget-defaults.ts style) so tests can set/restore it. */
export function liveProgressLineBudget(): number {
  const n = parseInt(process.env.SUBAGENT_LIVE_LINES ?? "", 10);
  return !Number.isFinite(n) || n < 1 ? DEFAULT_LIVE_LINES : n;
}

/** Dim-render a live-feed text under the live-line budget. Collapsed partial
 *  render → line 0 (the `subagents · k/N running · …` header) is ALWAYS shown
 *  and does NOT count against the budget; the budget (default 5 = 5 CHILD
 *  rows; env knob `SUBAGENT_LIVE_LINES`, positive int) applies only to the
 *  remaining child rows, with a dim "… +K more" indicator appended as the
 *  last line ONLY when child rows were actually cut (K = cut child rows only);
 *  everything else (expanded, or non-partial) → the full text. Shared by the
 *  details-less streaming path (the live feed onHistory/onUpdate emits has
 *  `details: undefined`, so it always takes the `!d` early return) and the
 *  details-carrying isPartial branch — one budget, both paths. */
export function renderLiveFeedDim(
  text: string,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): string {
  if (options.expanded || !options.isPartial) return theme.fg("dim", text);
  const [header, ...rows] = text.split("\n");
  const budget = liveProgressLineBudget();
  const shownRows = rows.slice(0, budget);
  const extra = rows.length - shownRows.length;
  const shown = [header, ...shownRows].join("\n");
  return theme.fg("dim", extra > 0 ? `${shown}\n… +${extra} more` : shown);
}

/** Theme the batch result: collapsed = header + per-child one-liners; expanded = full themed output. */
export function renderSubagentsResult(
  result: { content: Array<{ type: string; text?: string }>; details?: SubagentsToolDetails },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): string {
  const d = result.details;
  if (!d) {
    // Live streaming feed (details: undefined) — same budget as below.
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    return renderLiveFeedDim(text, options, theme);
  }

  // Streaming: compact progress block.
  if (options.isPartial) {
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    return renderLiveFeedDim(text, options, theme);
  }

  // Build the batch header.
  const done = d.results.filter(
    (s) =>
      s &&
      (s as { status: string }).status !== "budget" &&
      (s as { status: string }).status !== "turns" &&
      (s as { status: string }).status !== "aborted",
  ).length;
  const aborted = d.results.filter((s) => s && (s as { status: string }).status === "aborted").length;
  const failed = d.results.filter((s) => s === null).length;
  // Aggregate usage across non-null slots that carry usage → header Σtok/$Σ
  // (mirrors the single card's `$cost · Ntok`, appended after elapsed).
  const slotUsages: AgentUsage[] = [];
  for (const s of d.results) {
    if (s && (s as { usage?: AgentUsage }).usage) slotUsages.push((s as { usage: AgentUsage }).usage);
  }
  const agg = sumUsage(slotUsages);
  const aggStr = agg.total > 0 ? ` · $${agg.cost.toFixed(3)} · ${agg.total} tok` : "";
  const header =
    `subagents batch (${done} ok` +
    (aborted ? ` · ${aborted} aborted` : "") +
    ` · ${failed} failed` +
    ` · ${d.skipped} skipped) — ${fmtElapsed(d.elapsedMs)}${aggStr}`;

  if (!options.expanded) {
    // Collapsed: header + one line per slot with status badge.
    const lines: string[] = [theme.bold(header)];
    for (let i = 0; i < d.results.length; i++) {
      const slot = d.results[i];
      if (slot === null) {
        lines.push(theme.fg("dim", `  [${i}] ${batchStatusBadge("failed", theme)}  ·  (child failed)`));
        continue;
      }
      if (!slot) continue; // invariant: i < d.results.length (loop bound)
      const slotStatus = (slot as { status: string }).status;
      // Fixed-width badge (ticket 05, finding 6): pad to the widest badge text so
      // the `model · elapsed · task` columns line up across rows regardless of
      // status (`✓ done`=6 vs `⏱ timedout`=10, etc.).
      const badge = batchStatusBadge(slotStatus, theme);
      // Model segment: on a fallback show `requested → actual` (both shortened
      // via shortModel so the collapsed line stays within terminal width —
      // ticket 04, findings 2 + 5). The audit field stays the full spec; only
      // the DISPLAY is shortened.
      const meta = formatSlotMeta(slot as { model?: string; elapsedMs: number; usage?: AgentUsage }, theme);
      const taskPreview60 = truncateToWidth((slot as { task: string }).task ?? "", 60);
      const idTag = slot.id ? `${theme.fg("dim", `(${slot.id})`)} ` : "";
      lines.push(`  ${theme.fg("dim", `[${i}]`)} ${idTag}${badge}  ${meta} · ${theme.fg("dim", `"${taskPreview60}"`)}`);
    }
    lines.push(theme.fg("dim", "Ctrl-O to expand · /subagents for detail"));
    return lines.join("\n");
  }

  // Expanded: header + per-child full themed output (mirrors renderBatchResult structure).
  const body = d.results
    .map((slot, i) => {
      if (slot === null)
        return `${theme.bold(`### [${i}] failed`)}
${theme.fg("dim", "_(null — child failed; re-run via the singular `subagent` tool to see the error)_")}`;
      // Meta line shared by every variant that carries model + elapsedMs
      // (done/timedout/aborted/budget). usage optional → formatSlotMeta degrades.
      const metaLine = formatSlotMeta(slot as { model?: string; elapsedMs: number; usage?: AgentUsage }, theme);
      if (slot.status === "budget") {
        const label = slot.source === "child" ? "child budget" : "batch budget";
        return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} skipped`)} — ${theme.fg("warning", `${label}: ${slot.exhaustion.kind} ${slot.exhaustion.actual} > ${slot.exhaustion.limit}`)}
${metaLine}`;
      }
      if (slot.status === "turns") {
        return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} skipped`)} — ${theme.fg("warning", `max turns exceeded: ${slot.turns.turnsUsed}/${slot.turns.maxTurns} turns`)}
${metaLine}`;
      }
      if (slot.status === "aborted") {
        return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} aborted`)}
${metaLine}
${theme.fg("dim", "_(user-aborted mid-flight)_")}`;
      }
      const output = slot.output || "_(empty output)_";
      return `${theme.bold(`### [${i}]${slot.id ? ` (${slot.id})` : ""} ${slot.status}`)}
${metaLine}
${theme.fg("toolOutput", output)}`;
    })
    .join("\n\n");
  return `${theme.bold(header)}\n\n${body}`;
}
