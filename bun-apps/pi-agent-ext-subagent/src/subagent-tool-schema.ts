/**
 * Schema, result-details type, and options for the `subagent` tool.
 * Extracted from subagent-tool.ts (behavior-preserving split — no logic change).
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentRegistry,
  AgentUsage,
  BudgetExhaustion,
  createWorktree,
  removeWorktree,
  SddReport,
  SubagentInFlightRegistry,
} from "@repo/pi-agent-ext-core-runtime";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import type { GitScopeOps, SubagentScopeCheck } from "./git-scope.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "./spawn-subagent.js";
import type { SubagentRunPersistence } from "./subagent-run-persistence.js";
import type { WatchdogResult } from "./watchdog/types.js";

export interface SubagentToolDetails {
  exitCode: number;
  timedOut: boolean;
  /** Role label (params.agent), if provided. */
  agent?: string;
  /** The ACTUAL model that ran (provider/id), or the requested display string when unresolvable. */
  model?: string;
  /** The originally-requested model spec (params.model or agentDef.model), when
   *  the resolution fell back to a different actual model. Absent when the
   *  requested model resolved normally. Old records without this field stay valid. */
  requestedModel?: string;
  /** True when the model resolution fell back to a different model than requested. */
  fellBack?: boolean;
  /** First ~80 chars of params.task, single-lined. */
  taskPreview: string;
  /** Wall-clock of the run, ms. */
  elapsedMs: number;
  /** Wall-clock dispatch start, epoch ms — for /subagents timestamp display. */
  startedAt?: number;
  status: "done" | "failed" | "timedout" | "budget" | "aborted";
  /** Real token/cost usage from the child session, when reported. */
  usage?: AgentUsage;
  /**
   * Set when the run was aborted for exceeding `tokenBudget`/`spendBudget`
   * (status "budget"). Carries which budget, the limit, and the actual usage
   * at abort — distinct from a timeout (wall-clock) or a generic failure.
   */
  budget?: BudgetExhaustion;
  /**
   * Parsed SDD report block (ticket 04), when the subagent's output carries the
   * `**Status:**` marker. Absent for plain (non-SDD) dispatches, schema results,
   * and failures. `report.status` is reliable; the rest are best-effort hints.
   */
  report?: SddReport;
  /**
   * Opt-in commit-scope check (`commitScope` param). Present when the caller set
   * `commitScope` AND the run operated on the real tree (not worktree-isolated).
   * `outOfScope` lists the committed paths that fell outside the declared scope —
   * the recurring `git add -A` sweep signal. Absent otherwise (no scope /
   * worktree-isolated / not a repo). Detection only; never auto-reverts.
   */
  scopeCheck?: SubagentScopeCheck;
  /**
   * Opt-in two-layer watchdog review (`watchdog` param, ticket 02). Present only
   * when the caller set `watchdog` AND a repo baseline could be captured pre-spawn
   * AND runWatchdog returned (edit-gated results are included — they still carry a
   * summary). Absent when watchdog is off. A throw inside the watchdog path never
   * fails the run; in that case `details.watchdog` stays undefined and the result
   * text carries a `watchdog-error:` line instead. Soft gate: never auto-fails.
   */
  watchdog?: WatchdogResult;
}

/**
 * Default wall-clock timeout (ms) applied when a dispatch omits `timeoutMs`.
 * Generous safety net (15 min): legit in-process runs rarely exceed ~10 min
 * (research 1-3, implementer 3-10, reviewer 2-5), so this almost never fires on
 * real work — it exists to unblock the parent turn when a child deadlocks / hangs
 * on a network call / loops without burning tokens (tokenBudget can't catch that).
 * In-process children are synchronous to the parent turn, so a stuck child blocks
 * the whole interactive session until the timeout fires. Override per-dispatch
 * via `timeoutMs`. (cf. pi-subagents 0.37.1's 30-min default — theirs is
 * detached/async so a long run doesn't block the user; ours is not, hence shorter.)
 */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export const subagentToolSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: "Role label (e.g. 'reviewer'); forwarded as an instructions prefix, doesn't change tool selection.",
    }),
  ),
  agentType: Type.Optional(
    Type.String({
      description:
        "Named agent def (.pi/agents/<name>.md) binding tools/model/prompt/worktree-isolation. Explicit model/tools/excludeTools here override the binding.",
    }),
  ),
  task: Type.String({
    description:
      "Full self-contained prompt — the child has NO access to this session's history (include goal, context, constraints, return format).",
  }),
  model: Type.Optional(
    Type.String({
      description:
        "Model override `provider/model-id`. Prefer omitting (uses the session's current model) or set `tier`; an unauthed id warns and falls back — only pass a model you know is configured.",
    }),
  ),
  tier: Type.Optional(
    Type.String({
      description:
        "Model tier: 'small'|'medium'|'big'. Omit to inherit the session model; explicit `model` takes priority.",
    }),
  ),
  capability: Type.Optional(
    Type.String({
      description:
        "Model capability for the child (e.g. 'vision'), resolved from the capabilities map in the model-tiers config. Omit to inherit the session's current model. Precedence: model > capability > tier.",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Child working directory (defaults to parent session cwd)." })),
  watchdog: Type.Optional(
    Type.Union(
      [
        Type.Boolean({
          description: "Enable watchdog review (L1 LSP on, L2 off). true = {l1:true,l2:false}.",
        }),
        Type.Object({
          l1: Type.Optional(Type.Boolean({ description: "L1 LSP diagnostics. Default true when watchdog enabled." })),
          l2: Type.Optional(Type.Boolean({ description: "L2 model review (opt-in). Default false." })),
        }),
      ],
      { description: "Opt-in two-layer review of the implementer's final diff. Off by default." },
    ),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Tool allowlist, e.g. ['read','grep','find','ls'] for read-only. Omit for the default coding toolset.",
    }),
  ),
  excludeTools: Type.Optional(
    Type.Array(Type.String(), { description: "Tools to deny after the allowlist, e.g. ['edit','write']." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Abort after this many ms (wall-clock). Omit for a 15-minute default (DEFAULT_TIMEOUT_MS).",
    }),
  ),
  tokenBudget: Type.Optional(
    Type.Number({
      description:
        "Abort once cumulative token usage exceeds this (bounds a looping child timeoutMs can't catch; per-turn check, may overshoot one turn; non-recoverable).",
    }),
  ),
  spendBudget: Type.Optional(
    Type.Number({
      description: "Abort once cumulative cost ($) exceeds this (pairs with tokenBudget; same per-turn check).",
    }),
  ),
  retryOnTransient: Type.Optional(
    Type.Boolean({
      description: "Retry once on transient failure (timeout/network/rate-limit/schema). Default true.",
    }),
  ),
  commitScope: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Commit-path allowlist (prefix-matched). After the run, flags any committed path outside this scope as a ⚠ violation (detection only, never auto-reverts; best-effort). Use [] to flag any commit. Ignored for worktree-isolated runs.",
    }),
  ),
  schema: Type.Optional(
    Type.Unknown({
      description:
        "JSON Schema for the child's final answer; when set, the child returns via structured_output and the result is the JSON-serialized object.",
    }),
  ),
  schemaRepairAttempts: Type.Optional(
    Type.Number({
      description:
        "Max repair re-prompts when the child returns prose instead of structured_output (default 2). Bump for models that emit structured output unreliably.",
    }),
  ),
});

export interface SubagentToolOptions {
  cwd?: string;
  /** Parent-session tools to bridge into the child. Updated by session_start. */
  getExtensionTools?: () => ToolDefinition[] | undefined;
  /** Parent session's current model (provider/id), captured at session_start. Lets an untagged dispatch default to the live session model. */
  getMainModel?: () => string | undefined;
  /**
   * Parent session's CURRENT active tool-name set (the gated set, ~24 names).
   * Read lazily at spawn time so it reflects the freshest gating. When the
   * caller omits an explicit `tools` allowlist (and no agentType binds one),
   * the child defaults to THIS set instead of re-inheriting the full ~55-tool
   * definition universe. See `.planning/2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task/`
   * ticket 01 (optimization #1). The caller's explicit `tools` always overrides.
   */
  getActiveTools?: () => string[] | undefined;
  /** Injectable spawn for tests (defaults to the real spawnSubagent). */
  spawn?: (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
  /** Injectable agentType registry for tests (defaults to loadAgentRegistry(cwd) per call). */
  agentRegistry?: AgentRegistry;
  /** Injectable worktree creation for tests (defaults to the real createWorktree). */
  createWorktree?: typeof createWorktree;
  /** Injectable worktree teardown for tests (defaults to the real removeWorktree). */
  removeWorktree?: typeof removeWorktree;
  /** Live registry of in-flight runs; when set, the tool registers/updates/deregisters so /subagents can show running subagents. */
  inFlight?: SubagentInFlightRegistry;
  /**
   * Durable run persistence (ticket 08). When set, each completed run is written
   * once to ~/.pi/subagents/runs/<id>.json (best-effort) for post-session
   * replay/inspection by `/subagents`. Never affects the run's result.
   */
  persistence?: SubagentRunPersistence;
  /** Injectable git-scope ops for tests (defaults to realGitOps). */
  gitOps?: GitScopeOps;
}

/** Minimal pre-flight check: a JSON-Schema-shaped object needs at least a `type` field. */
export function isSchemaShaped(value: unknown): value is TSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value;
}
