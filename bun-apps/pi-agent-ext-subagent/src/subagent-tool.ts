/**
 * `subagent` tool — agent-callable single-agent dispatch over `spawnSubagent()`.
 *
 * Closes the Layer-3 drift: superpowers' subagent-driven-development and
 * dispatching-parallel-agents speak in terms of "dispatch a subagent" via the
 * `Subagent (general-purpose):` template; on Pi that resolves to "use an
 * installed `subagent` tool if available". This tool IS that surface, backed by
 * the workflow extension's existing isolated-child runner (WorkflowAgent.run).
 *
 * Minimal v1: { agent?, task, model?, cwd?, tools?, excludeTools? } → child output.
 * No clarify-TUI / acceptance / turnBudget / toolBudget (deferred — see spec.md).
 */
import { defineTool, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import type { AgentUsage, BudgetExhaustion } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  type AgentDefinition,
  type AgentRegistry,
  listAgentTypes,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.js";
import { computeScopeCheck, type GitScopeOps, realGitOps, type SubagentScopeCheck } from "./git-scope.js";
import { isSddReportActionable, parseSddReport, type SddReport } from "./sdd-report.js";
import { type SpawnSubagentOptions, type SpawnSubagentResult, spawnSubagent } from "./spawn-subagent.js";
import type { SubagentInFlightRegistry } from "./subagent-in-flight.js";
import { generateSubagentRunId, type SubagentRunPersistence } from "./subagent-run-persistence.js";
import { computeBaseline, type RepoBaseline } from "./watchdog/repo-diff.js";
import { normalizeWatchdogParam, type WatchdogResult } from "./watchdog/types.js";
import { runWatchdog } from "./watchdog/watchdog.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

export interface SubagentToolDetails {
  exitCode: number;
  timedOut: boolean;
  /** Role label (params.agent), if provided. */
  agent?: string;
  /** params.model, or "default". */
  model?: string;
  /** First ~80 chars of params.task, single-lined. */
  taskPreview: string;
  /** Wall-clock of the run, ms. */
  elapsedMs: number;
  /** Wall-clock dispatch start, epoch ms — for /subagents timestamp display. */
  startedAt?: number;
  status: "done" | "failed" | "timedout" | "budget";
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
      description: "Abort after this many ms (wall-clock). Omit for no timeout.",
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
function isSchemaShaped(value: unknown): value is TSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value;
}

/** Collapse a task prompt to a single-line preview of at most `n` chars. */
export function taskPreview(task: string, n = 80): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

/** Describe the most recent history entry as a short one-line activity string. */
function describeLastActivity(last: AgentHistoryEntry | undefined): string {
  if (!last) return "…";
  switch (last.kind) {
    case "toolCall":
      return last.toolName ?? "tool";
    case "toolResult":
      return `${last.toolName ?? "tool"} → done`;
    case "error":
      // Errors are the moment progress streaming matters most — mark them
      // distinctly so they never read as routine chatter.
      return `⚠ ${last.text.slice(0, 60)}`;
    case "text":
      return (last.text.split("\n")[0] ?? "").slice(0, 60);
    default:
      return last.text.slice(0, 60);
  }
}

/**
 * Render the latest compact history snapshot as a one/two-line progress update.
 *
 * `minToolCalls` floors the displayed count (default 0, i.e. no floor). Callers
 * that stream across a `retryOnTransient` retry pass their own running max here:
 * a retry gets a fresh (shorter) history array from a brand-new child session
 * (see spawnSubagent/tryOnce), and without the floor the displayed count would
 * visibly jump backward — read by the user as "did it lose progress?".
 */
export function formatSubagentProgress(history: AgentHistoryEntry[], elapsedMs: number, minToolCalls = 0): string {
  const last = history[history.length - 1];
  const toolCalls = Math.max(history.filter((h) => h.kind === "toolCall").length, minToolCalls);
  const activity = describeLastActivity(last);
  const elapsedS = (elapsedMs / 1000).toFixed(1);
  return `↳ ${activity}\n  ↳ ${elapsedS}s elapsed · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
}

/**
 * Short inline preview of a tool call's arguments or a tool result's text,
 * for the expanded live-output trace. `compactAgentHistory` already captures
 * both into `AgentHistoryEntry.text` (args as a compact JSON string, results as
 * their text) — this surfaces a one-line slice so the trace reads as a real
 * transcript (what was called + what came back), not just call markers.
 * Returns "" for an empty payload or a bare `{}` (no useful args), so those
 * lines stay as clean `→ name` / `← name ✓` markers.
 */
function previewPayload(text: string | undefined, max = 100): string {
  if (!text) return "";
  const one = text.replace(/\s+/g, " ").trim();
  if (!one || one === "{}") return "";
  return ` ${truncateToWidth(one, max)}`;
}

/** Render one history entry as a single readable trace line (live-output buffer). */
export function formatHistoryLine(e: AgentHistoryEntry): string {
  switch (e.kind) {
    case "toolCall":
      // `text` holds the JSON-stringified arguments (compactAgentHistory).
      // Surface a short preview so the expanded trace shows WHAT the subagent
      // called, not just the tool name — the core debug-visibility gap.
      return `→ ${e.toolName ?? "tool"}${previewPayload(e.text)}`;
    case "toolResult":
      // `text` holds the tool's result text. Surface a short preview of it too,
      // so the expanded trace reads as a real transcript, not just call markers.
      return `← ${e.toolName ?? "tool"} ✓${previewPayload(e.text)}`;
    case "error":
      return `⚠ ${e.text.slice(0, 200)}`;
    case "text":
      return (e.text.split("\n")[0] ?? "").slice(0, 200);
    default:
      return e.text.slice(0, 200);
  }
}

/**
 * Live-output payload sent while the subagent runs. The first 2 lines are the
 * progress header (elapsed + tool-call count, via formatSubagentProgress); the
 * rest is the latest ≤`maxTraceLines` activity trace (one line per history
 * entry). `renderSubagentResult`'s isPartial branch shows just the 2-line
 * header when collapsed and the full trace when expanded (ctrl+o /
 * app.tools.expand), so a long-running subagent's recent work is inspectable
 * without aborting it (decision: Ctrl-O live output, default 100 lines).
 */
export function formatSubagentLive(
  history: AgentHistoryEntry[],
  elapsedMs: number,
  minToolCalls = 0,
  maxTraceLines = 100,
): string {
  const header = formatSubagentProgress(history, elapsedMs, minToolCalls);
  const trace = history.slice(-maxTraceLines).map(formatHistoryLine);
  return trace.length ? `${header}\n${trace.join("\n")}` : header;
}

/** Theme the call line shown WHILE the subagent runs (pi's spinner conveys activity). */
export function renderSubagentCall(
  args: { agent?: string; model?: string; capability?: string; tier?: string; task: string; resolvedModel?: string },
  theme: Theme,
): string {
  const parts: string[] = [theme.bold(theme.fg("toolTitle", "subagent"))];
  if (args.agent) parts.push(theme.fg("accent", args.agent));
  // Requested-model slot: explicit model, else capability, else tier, else "default".
  const slot =
    args.model ?? (args.capability ? `capability:${args.capability}` : args.tier ? `tier:${args.tier}` : "default");
  parts.push(theme.fg("muted", slot));
  // Concrete model resolved mid-run (onModelResolved). Separate segment so the
  // requested tier/model stays visible. Skipped when it matches the slot (e.g.
  // an explicit model that resolved to itself) to avoid duplication.
  if (args.resolvedModel && args.resolvedModel !== slot) {
    parts.push(theme.fg("muted", args.resolvedModel));
  }
  parts.push(theme.fg("dim", `"${taskPreview(args.task, 60)}"`));
  return parts.join(" ▸ ");
}

/** Theme the result: collapsed = badge+meta+headline; expanded = full report. */
export function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: SubagentToolDetails },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): string {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (options.isPartial) {
    // Streaming progress update. The payload (formatSubagentLive) is a 2-line
    // header + a ≤100-line activity trace. Collapsed (default) shows just the
    // header; expanded (ctrl+o / app.tools.expand) shows the trace so a
    // long-running subagent's recent work is inspectable without aborting.
    const lines = text.split("\n");
    const shown = options.expanded ? lines : lines.slice(0, 2);
    return shown.map((l) => theme.fg("dim", l)).join("\n");
  }
  const d = result.details;
  if (!d) return text;
  const badge =
    d.status === "done"
      ? theme.fg("success", "✓ done")
      : d.status === "timedout"
        ? theme.fg("warning", "⏱ timedout")
        : d.status === "budget"
          ? theme.fg("warning", "⛔ budget")
          : theme.fg("error", "✗ failed");
  const usageStr = d.usage && d.usage.total > 0 ? ` · $${d.usage.cost.toFixed(3)} · ${d.usage.total} tok` : "";
  // SDD self-report tag (ticket 04): separate axis from process status. A run
  // can be process-done yet self-report BLOCKED — tint the actionable ones so
  // they never read as routine success.
  const sddTag = d.report
    ? isSddReportActionable(d.report.status)
      ? theme.fg("warning", ` · SDD:${d.report.status}`)
      : theme.fg("success", ` · SDD:${d.report.status}`)
    : "";
  // commit-scope tag: a separate axis from process status and SDD self-report.
  // Out-of-scope committed paths warrant a warning tint — the recurring
  // `git add -A` sweep signal the controller must act on before merging.
  const scopeTag =
    d.scopeCheck && d.scopeCheck.outOfScope.length > 0
      ? theme.fg("warning", ` · ⚠ ${d.scopeCheck.outOfScope.length} out-of-scope`)
      : "";
  const budgetTag = d.budget ? theme.fg("warning", ` · ${d.budget.kind}:${d.budget.actual}/${d.budget.limit}`) : "";
  const meta =
    theme.fg("muted", `${d.model ?? "default"} · ${(d.elapsedMs / 1000).toFixed(1)}s${usageStr}`) +
    sddTag +
    scopeTag +
    budgetTag;
  if (!options.expanded) {
    const firstLine =
      text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l) ?? "";
    return `${badge} ${meta} ${theme.fg("dim", truncateToWidth(firstLine, 60))}`;
  }
  return `${badge} ${meta}\n${theme.fg("toolOutput", text)}`;
}

/** Derive a human status from the spawn result. */
export function deriveSubagentStatus(r: SpawnSubagentResult): SubagentToolDetails["status"] {
  if (r.budget) return "budget";
  if (r.exitCode === 0) return "done";
  return r.timedOut ? "timedout" : "failed";
}

/** Format the subagent result into the text the parent agent reads. */
export function formatSubagentResult(result: SpawnSubagentResult): string {
  if (result.budget) {
    const unit =
      result.budget.kind === "tokens" ? `${result.budget.actual} tokens` : `$${result.budget.actual.toFixed(4)}`;
    return `Subagent aborted: ${result.budget.kind} budget exhausted (${unit} > limit ${result.budget.limit}).`;
  }
  if (result.exitCode === 0) return result.output;
  const fate = result.timedOut ? "timed out" : "failed";
  const head = `Subagent ${fate} (exit ${result.exitCode}).`;
  const err = result.stderr ? `\n${result.stderr}` : "";
  const tail = result.output ? `\n\n--- subagent output ---\n${result.output}` : "";
  return `${head}${err}${tail}`;
}

export function createSubagentTool(
  options: SubagentToolOptions = {},
): ToolDefinition<typeof subagentToolSchema, SubagentToolDetails> {
  const defaultCwd = options.cwd ?? process.cwd();
  const spawn = options.spawn ?? spawnSubagent;
  const gitOps = options.gitOps ?? realGitOps;
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Dispatch a single subagent with an ISOLATED context to do a focused task and report back.",
      "The subagent does NOT inherit this session's history — pass a self-contained `task` prompt.",
      "Returns the subagent's output, plus an exit/timed-out status in `details`.",
    ].join(" "),
    promptSnippet:
      "Dispatch an isolated-context subagent for one focused task (implementer / reviewer / researcher). Pass a self-contained `task`; pick `model`/`tier` per role (omit to use the current model); restrict with `tools`/`excludeTools`.",
    // Sequential: serialize any turn whose tool-call batch contains a
    // subagent dispatch. Enforces the "parallel fan-out goes through the
    // `workflow` tool's parallel()" contract at the engine level — pi's rule
    // is "any sequential tool call in a turn ⇒ the whole batch runs serially"
    // (pi-agent-core agent-loop). The `workflow` tool's parallel()/agent()
    // dispatch via a SEPARATE createAgentSession() path, so this does NOT
    // throttle workflow fan-out. (ticket 10)
    executionMode: "sequential",
    parameters: subagentToolSchema,
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      const t0 = Date.now();
      // A retryOnTransient retry hands onHistory a fresh (shorter) history array
      // from a brand-new child session — track the running max across the whole
      // call so the displayed tool-call count never visibly regresses. See
      // formatSubagentProgress's `minToolCalls` param.
      let maxToolCallsSeen = 0;
      // Latest compact history snapshot, retained so the durable record (ticket
      // 08) can persist the transcript. Updated in the onHistory callback.
      let lastHistory: AgentHistoryEntry[] | undefined;
      const runCwd = params.cwd ?? defaultCwd;
      const makeWorktree = options.createWorktree ?? createWorktree;
      const teardownWorktree = options.removeWorktree ?? removeWorktree;

      const failEarly = (
        text: string,
      ): { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails } => ({
        content: [{ type: "text" as const, text }],
        details: {
          exitCode: 1,
          timedOut: false,
          agent: params.agent,
          model: params.model ?? "default",
          taskPreview: taskPreview(params.task),
          elapsedMs: Date.now() - t0,
          startedAt: t0,
          status: "failed",
        },
      });

      let agentDef: AgentDefinition | undefined;
      if (params.agentType) {
        const registry = options.agentRegistry ?? loadAgentRegistry(runCwd);
        agentDef = resolveAgentType(params.agentType, registry);
        if (!agentDef) {
          const known = listAgentTypes(registry).map((t) => t.name);
          return failEarly(
            `Unknown agentType "${params.agentType}".${
              known.length
                ? ` Available: ${known.join(", ")}.`
                : " No agentType definitions found (.pi/agents/*.md or ~/.pi/agents/*.md)."
            }`,
          );
        }
      }

      if (params.schema !== undefined && !isSchemaShaped(params.schema)) {
        return failEarly(`Invalid schema: expected a JSON-Schema-shaped object with a "type" field.`);
      }

      let worktree: Worktree | undefined;
      let spawnCwd = runCwd;
      if (agentDef?.isolation === "worktree") {
        // toolCallId (not runId+callIndex) is fine here: this tool has no resume/journal
        // semantics, unlike workflow.ts's agent() — see the determinism note on
        // createWorktree() in worktree.ts.
        worktree = await makeWorktree(runCwd, `subagent-${toolCallId}`);
        if (worktree.isolated) spawnCwd = worktree.cwd;
      }

      // Opt-in commit-scope guardrail (commitScope param): record the repo HEAD
      // before dispatch so the post-run check can diff base..HEAD for out-of-scope
      // committed paths. Only the real-tree case is checked — a worktree-isolated
      // run is discarded after teardown, so it can never pollute the parent tree.
      const scope = params.commitScope;
      let baseCommit: string | undefined;
      if (scope !== undefined && spawnCwd === runCwd) {
        try {
          baseCommit = await gitOps.headCommit(runCwd);
        } catch {
          baseCommit = undefined;
        }
      }

      // Opt-in two-layer watchdog (watchdog param): snapshot the repo state NOW so the
      // post-spawn compute can tell whether the child edited anything. Captured on
      // spawnCwd (the real tree or the worktree the child ran in). A throw / non-repo
      // → undefined, which gates the post-spawn run entirely (no review, no summary).
      const watchdogOpts = normalizeWatchdogParam(params.watchdog);
      let watchdogBaseline: RepoBaseline | undefined;
      if (watchdogOpts) {
        try {
          watchdogBaseline = computeBaseline(spawnCwd);
        } catch {
          watchdogBaseline = undefined;
        }
      }

      const requestedModel = params.model ?? agentDef?.model;
      const tier = params.tier ?? agentDef?.tier;
      const capability = params.capability;
      const mainModel = options.getMainModel?.();
      // Shown WHILE the subagent runs, before the resolved model is known: the
      // requested model, else the capability, else the tier, else the live session model, else "default".
      const displayModelBeforeResolve =
        requestedModel ?? (capability ? `capability:${capability}` : tier ? `tier:${tier}` : mainModel) ?? "default";
      // The concrete provider/id the child actually ran on, captured from
      // WorkflowAgent once resolved. Falls back to the requested display string.
      let resolvedModel: string | undefined;

      options.inFlight?.start({
        id: toolCallId,
        agent: params.agent,
        model: displayModelBeforeResolve,
        taskPreview: taskPreview(params.task),
        startedAt: t0,
      });
      try {
        const instructions =
          [params.agent ? `You are the ${params.agent} for this task.` : undefined, agentDef?.prompt]
            .filter((s): s is string => Boolean(s))
            .join("\n\n") || undefined;

        const result = await spawn({
          task: params.task,
          tools: params.tools ?? agentDef?.tools,
          excludeTools: params.excludeTools ?? agentDef?.disallowedTools,
          model: requestedModel,
          tier,
          capability,
          mainModel,
          cwd: spawnCwd,
          instructions,
          extensionTools: options.getExtensionTools?.(),
          externalSignal: signal,
          timeoutMs: params.timeoutMs,
          tokenBudget: params.tokenBudget,
          spendBudget: params.spendBudget,
          retryOnTransient: params.retryOnTransient,
          schema: params.schema as TSchema | undefined,
          schemaRepairAttempts: params.schemaRepairAttempts,
          onModelResolved: (id) => {
            resolvedModel = id;
            options.inFlight?.updateModel(toolCallId, id);
          },
          onHistory:
            onUpdate || options.inFlight || options.persistence
              ? (history: AgentHistoryEntry[]) => {
                  lastHistory = history;
                  // Progress streaming is diagnostic only — a throwing onUpdate
                  // (e.g. a TUI re-render failure) must never fail the subagent's
                  // actual task result.
                  try {
                    const toolCallsNow = history.filter((h) => h.kind === "toolCall").length;
                    maxToolCallsSeen = Math.max(maxToolCallsSeen, toolCallsNow);
                    options.inFlight?.update(toolCallId, history);
                    onUpdate?.({
                      content: [
                        { type: "text" as const, text: formatSubagentLive(history, Date.now() - t0, maxToolCallsSeen) },
                      ],
                      details: undefined as unknown as SubagentToolDetails,
                    });
                  } catch {
                    // swallowed — see comment above
                  }
                }
              : undefined,
        });
        const elapsedMs = Date.now() - t0;
        // Opt-in commit-scope check (commitScope param): detection only. A
        // throwing op is swallowed — the scope guard never fails the run.
        let scopeCheck: SubagentScopeCheck | undefined;
        if (scope !== undefined && spawnCwd === runCwd && baseCommit !== undefined) {
          try {
            scopeCheck = await computeScopeCheck(gitOps, runCwd, baseCommit, scope);
          } catch {
            scopeCheck = undefined;
          }
        }
        let output = formatSubagentResult(result);
        if (scopeCheck && scopeCheck.outOfScope.length > 0) {
          // Surface the violation to the parent agent in the result text (not
          // just the details badge) so the controller cannot miss it — the
          // recurring `git add -A` sweep lands stray files into squash-merges.
          const paths = scopeCheck.outOfScope.map((p) => `  - ${p}`).join("\n");
          output += `\n\n--- ⚠ commit-scope violation (${scopeCheck.outOfScope.length}) ---\nThe subagent committed path(s) OUTSIDE the declared commitScope:\n${paths}\nInspect before merging — this is the recurring \`git add -A\` sweep signal.`;
        }
        // Opt-in two-layer watchdog: run the review against the captured baseline.
        // Soft gate — appends a summary line only when runWatchdog actually ran OR
        // was edit-gated (no diff). A throw anywhere in the watchdog path is caught
        // here so it can NEVER fail the run; in that case a `watchdog-error:` line
        // is appended instead and watchdogResult stays undefined.
        let watchdogResult: WatchdogResult | undefined;
        if (watchdogOpts && watchdogBaseline) {
          try {
            watchdogResult = await runWatchdog({
              cwd: spawnCwd,
              before: watchdogBaseline,
              opts: watchdogOpts,
              taskLabel: taskPreview(params.task),
            });
            if (watchdogResult.ran || watchdogResult.editGated) {
              output += `\n\n--- 🔍 ${watchdogResult.summary} (soft gate — review findings; not a failure) ---`;
            }
          } catch (e) {
            output += `\n\n--- 🔍 watchdog-error: ${(e as Error).message} ---`;
          }
        }
        const model = resolvedModel ?? displayModelBeforeResolve;
        const details: SubagentToolDetails = {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          agent: params.agent,
          model,
          taskPreview: taskPreview(params.task),
          elapsedMs,
          startedAt: t0,
          status: deriveSubagentStatus(result),
          usage: result.usage,
          budget: result.budget,
          // SDD report (ticket 04): parse the implementer's `**Status:**` block when
          // present (non-SDD / schema / failure outputs have no marker → undefined).
          report: parseSddReport(result.output),
          scopeCheck,
          watchdog: watchdogResult,
        };
        // Durable record for post-session replay (ticket 08). Write-once at
        // completion; best-effort — save() swallows errors so this can never
        // fail the run. Covers done/failed/timedout (spawnSubagent returns a
        // result, never throws, on child failure); the pre-flight failEarly
        // paths above do not persist (they are not real runs).
        options.persistence?.save({
          id: generateSubagentRunId(),
          toolCallId,
          agent: params.agent,
          task: params.task,
          model,
          tier,
          cwd: runCwd,
          status: details.status,
          exitCode: details.exitCode,
          timedOut: details.timedOut,
          stderr: result.stderr || undefined,
          startedAt: new Date(t0).toISOString(),
          elapsedMs,
          usage: details.usage,
          budget: details.budget,
          output,
          history: lastHistory,
          report: details.report,
          scopeCheck: details.scopeCheck,
          watchdog: watchdogResult,
        });
        return { content: [{ type: "text" as const, text: output }], details };
      } finally {
        options.inFlight?.end(toolCallId);
        if (worktree) await teardownWorktree(worktree);
      }
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      // The concrete model is only known mid-run (onModelResolved). Read the
      // latest from the registry (keyed by toolCallId) so the call line updates
      // live, and bind invalidate so updateModel can force a redraw even before
      // the next partial/history tick.
      // Live-run only: the registry entry is torn down in execute's finally
      // (end()), so after completion this reads undefined and the segment
      // reverts — the model then lives on the result line (d.model). While
      // running, onModelResolved → updateModel keeps this fresh + re-renders.
      const resolvedModel = options.inFlight?.get(context.toolCallId)?.resolvedModel;
      options.inFlight?.bindInvalidate(context.toolCallId, context.invalidate);
      text.setText(renderSubagentCall({ ...args, resolvedModel }, theme));
      return text;
    },
    renderResult(result, options, theme, _context) {
      const text = (_context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderSubagentResult(result, options, theme));
      return text;
    },
  });
}
