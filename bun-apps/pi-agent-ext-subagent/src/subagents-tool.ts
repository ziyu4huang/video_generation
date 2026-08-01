/**
 * `subagents` tool — agent-callable PARALLEL read-only fan-out. Dispatches N
 * isolated subagents (via spawnSubagent) with bounded concurrency, returning a
 * positional array of results. Read-only is ENFORCED: edit/write/bash are
 * always excluded (non-overridable) so children sharing the parent's working
 * tree can never race on writes. See .planning/2026-08-01-what-s-next-for-subagent-develop-map/.
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentUsage, BudgetExhaustion } from "./agent.js";
import { checkBudgetExhaustion } from "./agent.js";
import { DEFAULT_BATCH_CONCURRENCY, MAX_CONCURRENCY } from "./config.js";
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
  | { output: string; status: "done" | "timedout"; id?: string; index: number; usage?: AgentUsage }
  | { status: "budget"; exhaustion: BudgetExhaustion; id?: string; index: number }
  | null;

export interface SubagentsToolDetails {
  results: BatchResultSlot[];
  /** Present when the batch-wide soft gate tripped. */
  budgetExhaustion?: BudgetExhaustion;
  /** Aggregate usage across children that reported usage. */
  usage?: AgentUsage;
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

export function createSubagentsTool(_options: SubagentsToolOptions = {}): ToolDefinition {
  return defineTool({
    name: "subagents",
    label: "Subagents",
    description:
      "Dispatch N isolated read-only subagents in parallel (bounded) and return a positional array of results.",
    promptSnippet:
      "Fan out read-only research/review subagents in parallel. Each child has edit/write/bash excluded. Returns one result per task in input order (null for a failed child).",
    executionMode: "sequential",
    parameters: subagentsToolSchema,
    async execute() {
      throw new Error("subagents execute not implemented until Task 3");
    },
  });
}
