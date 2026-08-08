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
import { shortModel } from "./agent-row-display.js";
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
import { formatToolAction, matchedCallArgsFor } from "./tool-action-label.js";
import { computeBaseline, type RepoBaseline } from "./watchdog/repo-diff.js";
import { normalizeWatchdogParam, type WatchdogResult } from "./watchdog/types.js";
import { runWatchdog } from "./watchdog/watchdog.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

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
function isSchemaShaped(value: unknown): value is TSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value;
}

/** Collapse a task prompt to a single-line preview of at most `n` chars. */
export function taskPreview(task: string, n = 80): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

/** Display-only helper: strip a leading cwd/repo preamble line from the task
 *  and return the first non-empty remaining line, truncated to `n` chars.
 *  The orchestrator's task prompt convention opens with a line like
 *  `Working dir: /path/to/repo` — this surfaces the actual work intent instead.
 *  Falls back to the first non-empty line (same as {@link taskPreview}) when
 *  there is no preamble. Does NOT mutate the raw task string. */
export function workIntentPreview(task: string, n = 60): string {
  const lines = task.split("\n");
  // Strip a leading cwd/repo preamble line (case-insensitive).
  const startIdx = lines.length > 0 && /^(working dir|cwd|repo)\s*:\s*\S+/i.test(lines[0]?.trim() ?? "") ? 1 : 0;
  // Take the first non-empty line after the optional preamble.
  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = lines[i]?.trim();
    if (trimmed && trimmed.length > 0) {
      return trimmed.length > n ? `${trimmed.slice(0, n - 1)}…` : trimmed;
    }
  }
  // All lines were empty or preamble-only — fall back to single-line.
  return taskPreview(task, n);
}

/** Describe the most recent history entry as a short one-line activity string.
 *  Delegates the PHRASE to {@link formatToolAction} and adds NO glyph prefix —
 *  callers (`formatSubagentProgress`) prepend their own `↳`. */
function describeLastActivity(
  last: AgentHistoryEntry | undefined,
  ctx?: { matchedCallArgs?: Record<string, unknown> },
): string {
  if (!last) return "…";
  switch (last.kind) {
    case "toolCall":
      return formatToolAction(last);
    case "toolResult":
      return formatToolAction(last, { matchedCallArgs: ctx?.matchedCallArgs });
    case "error":
      // Errors are the moment progress streaming matters most — `formatToolAction`
      // already conveys failure (`Failed to …` / `⚠ …`), so no extra marker here.
      return formatToolAction(last);
    case "text":
      return (last.text.split("\n")[0] ?? "").slice(0, 60);
    default:
      return last.text.slice(0, 60);
  }
}

/** First non-empty (trimmed) line of a multi-line string; "" if every line is blank. */
function firstNonEmptyLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line) return line;
  }
  return "";
}

/** Truncate `s` to `max` chars with a trailing ellipsis when it exceeds. */
function truncateEnd(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Collapsed-box live line — the latest history entry as a single `↳ …` line.
 *  - assistant prose (role "assistant", kind "text", non-empty body) → QUOTED
 *    first non-empty line (`↳ "…"`, ≤80 chars). The quotes are the visual signal
 *    that distinguishes "the child is thinking/typing this" from "the child is
 *    running this tool".
 *  - anything else → verb-led activity via {@link describeLastActivity}
 *    (`↳ Reading src/x.ts`). Returns null only for empty history (the caller
 *    then omits the line entirely).
 *
 * Pure render helper — no data-model / compaction change.
 */
export function latestMessageLine(history: AgentHistoryEntry[]): string | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  if (last.role === "assistant" && last.kind === "text" && last.text.trim()) {
    return `↳ "${truncateEnd(firstNonEmptyLine(last.text), 80)}"`;
  }
  // Pass matchedCallArgs so a toolResult last recovers its target (mirrors
  // formatSubagentProgress). describeLastActivity's error branch ignores ctx,
  // so an error stays verb-led `Failed to …` here (the expanded trace via
  // formatHistoryLine recovers the target — see formatSubagentTrace tests).
  return `↳ ${describeLastActivity(last, { matchedCallArgs: matchedCallArgsFor(history, history.length - 1) })}`;
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
  const activity = describeLastActivity(last, { matchedCallArgs: matchedCallArgsFor(history, history.length - 1) });
  const elapsedS = (elapsedMs / 1000).toFixed(1);
  return `↳ ${activity}\n  ↳ ${elapsedS}s elapsed · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
}

/** Render one history entry as a single readable trace line (live-output buffer).
 *  Owns only the surface MARKER (`→`/`✓`/`✗`); the PHRASE comes from
 *  {@link formatToolAction}. The optional `ctx.matchedCallArgs` lets a toolResult
 *  line recover the target it acted on (obtain via `matchedCallArgsFor`). */
export function formatHistoryLine(e: AgentHistoryEntry, ctx?: { matchedCallArgs?: Record<string, unknown> }): string {
  switch (e.kind) {
    case "toolCall":
      // `text` holds the JSON-stringified arguments (compactAgentHistory);
      // formatToolAction parses them into a verb-led phrase (e.g. `Reading a.ts`).
      return `→ ${formatToolAction(e)}`;
    case "toolResult":
      // Results carry no args; ctx.matchedCallArgs (from the matching preceding
      // toolCall) recovers the target → `✓ Read a.ts`. Orphan → verb-only `✓ Read`.
      return `✓ ${formatToolAction(e, { matchedCallArgs: ctx?.matchedCallArgs })}`;
    case "error": {
      // `formatToolAction` already emits `⚠ <line>` for whole-turn assistant
      // errors — pass it through unchanged so we never double up `✗ ⚠`. Tool
      // errors (`Failed to …`) get the `✗` marker. Pass matchedCallArgs so a
      // tool error recovers the target it acted on (e.g. `✗ Failed to edit
      // src/parser.ts: …`) — consistent with the toolResult branch above.
      const phrase = formatToolAction(e, { matchedCallArgs: ctx?.matchedCallArgs });
      return phrase.startsWith("⚠") ? phrase : `✗ ${phrase}`;
    }
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
  // matchedCallArgsFor scans the trace window (not the full history) — for runs
  // under the cap this is identical; a result whose call fell outside the recent
  // window degrades gracefully to verb-only.
  const window = history.slice(-maxTraceLines);
  const trace = window.map((e, i) => formatHistoryLine(e, { matchedCallArgs: matchedCallArgsFor(window, i) }));
  return trace.length ? `${header}\n${trace.join("\n")}` : header;
}

/**
 * Expanded-box live trace — pairs each toolCall with its IMMEDIATELY-following
 * toolResult into ONE past-tense `✓ <phrase>` line (consuming BOTH entries),
 * marks a trailing un-paired toolCall as in-flight (`→ <phrase> …`), and
 * appends COMPACT progress (`<elapsed>s · <N> calls`) to the in-flight line —
 * or a trailing line when no call is in flight. Interspersed `text` (assistant
 * prose) and `error` entries render inline via {@link formatHistoryLine}.
 *
 * Kept a SEPARATE function from {@link formatSubagentLive}: the INLINE tool
 * surface (renderSubagentResult's isPartial branch) relies on formatSubagentLive
 * starting with a 2-line progress header so its COLLAPSED view (`slice(0, 2)`)
 * stays a clean elapsed/count summary. This pairing pass is the CONTEXT-BOX
 * expanded trace only — restructured without touching the inline surface's
 * contract. (`formatHistoryLine` itself stays unchanged so the /subagents
 * viewer — a separate consumer — is unaffected.)
 *
 * Pure render layer — no data-model / compaction change.
 */
export function formatSubagentTrace(history: AgentHistoryEntry[], elapsedMs: number, minToolCalls = 0): string {
  if (history.length === 0) return "";
  const lines: string[] = [];
  // Index into `lines` of the in-flight `→ …` entry, if any. In a normal
  // sequential agent loop there is at most one (the latest un-paired call);
  // progress attaches there. If several un-paired calls appear (a truncated
  // mid-stream window), the latest wins as "the" in-flight call.
  let inFlightIdx = -1;
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    if (e.kind === "toolCall") {
      const next = history[i + 1];
      if (next && next.kind === "toolResult") {
        // Paired call+result → collapse to ONE past-tense line; consume both.
        lines.push(`✓ ${formatToolAction(next, { matchedCallArgs: matchedCallArgsFor(history, i + 1) })}`);
        i++;
      } else {
        // Trailing un-paired call → in-flight (present-tense + ellipsis).
        lines.push(`→ ${formatToolAction(e)} …`);
        inFlightIdx = lines.length - 1;
      }
    } else {
      // Orphan toolResult (no preceding call in the window), error, or text →
      // inline via formatHistoryLine (matchedCallArgsFor recovers a target for
      // an orphan result/error, else verb-only).
      lines.push(formatHistoryLine(e, { matchedCallArgs: matchedCallArgsFor(history, i) }));
    }
  }
  const toolCalls = Math.max(history.filter((h) => h.kind === "toolCall").length, minToolCalls);
  const progress = `${(elapsedMs / 1000).toFixed(1)}s · ${toolCalls} call${toolCalls === 1 ? "" : "s"}`;
  if (inFlightIdx >= 0) {
    lines[inFlightIdx] = `${lines[inFlightIdx]}   ${progress}`;
  } else {
    lines.push(progress);
  }
  return lines.join("\n");
}

/** Theme the call line shown WHILE the subagent runs (pi's spinner conveys activity). */
export function renderSubagentCall(
  args: {
    agent?: string;
    model?: string;
    capability?: string;
    tier?: string;
    task: string;
    resolvedModel?: string;
    /** True when the model resolution fell back (actual model differs from requested). */
    fellBack?: boolean;
  },
  theme: Theme,
): string {
  const parts: string[] = [theme.bold(theme.fg("toolTitle", "subagent"))];
  if (args.agent) parts.push(theme.fg("accent", args.agent));
  // Requested-model slot: explicit model, else capability, else tier, else "default".
  // shortModel() drops the provider prefix on a real model id (ticket 04, finding 5 —
  // a full `anthropic/claude-opus-4-1` overflows the one-line glance). `tier:`/`capability:`/
  // `default` carry no `/` so shortModel() leaves them untouched.
  const slot = shortModel(
    args.model ?? (args.capability ? `capability:${args.capability}` : args.tier ? `tier:${args.tier}` : "default"),
  )!;
  parts.push(theme.fg("muted", slot));
  // Concrete model resolved mid-run (onModelResolved). Separate segment so the
  // requested tier/model stays visible. Skipped when it matches the slot (e.g.
  // an explicit model that resolved to itself) to avoid duplication.
  const resolvedShort = args.resolvedModel ? shortModel(args.resolvedModel) : undefined;
  if (resolvedShort && resolvedShort !== slot) {
    // When the resolution fell back, prefix with a fallback indicator (`→`)
    // so the display reads e.g. "claude-opus-4-1 ▸ → glm-5.2". shortModel keeps
    // the segment narrow so the collapsed line stays within terminal width
    // (ticket 04, finding 5). Normal resolution (no fallback) is unchanged.
    const label = args.fellBack ? `→ ${resolvedShort}` : resolvedShort;
    parts.push(theme.fg("muted", label));
  }
  parts.push(theme.fg("dim", `"${workIntentPreview(args.task, 60)}"`));
  return parts.join(" ▸ ");
}

/**
 * Max trace lines shown in the streaming-expanded (ctrl+o) live view. Keeps
 * the box ≈2 (header) + 1 (ellipsis) + this-many (tail) rows so it fits a
 * normal terminal viewport — preventing the per-frame fullRender that causes
 * the whole-TUI flicker (see {@link renderSubagentResult}'s isPartial branch).
 * Only the STREAMING view is capped; the settled expanded report renders in
 * full (no repeated clears → no flicker).
 *
 * Exported + shared with the context-box expanded trace (decision: ticket 05,
 * finding 4) — `extensions/subagent.ts` wires Ctrl-O with `{ consume: false }`
 * so Ctrl-O expands BOTH surfaces together; the cap must hold on both to keep
 * the #1104 flicker fix intact on the surface #1104 didn't touch.
 */
export const STREAMING_EXPANDED_TAIL = 16;

/**
 * Cap a trace's tail to at most `tail` lines, prefixing a `…` (ellipsis) line
 * when the trace exceeds the cap. Shared cap policy between the INLINE
 * streaming-expanded view ({@link renderSubagentResult}'s isPartial+expanded
 * branch) and the context-box expanded trace
 * ({@link SubagentContextWidget} `renderRun`'s expanded branch) — both surfaces
 * must hold the #1104 viewport-safe tail so a tall box never re-trips the
 * whole-TUI fullRender flicker. Pure render helper; no data-model change.
 */
export function capTraceTail(lines: string[], tail: number): string[] {
  return lines.length <= tail ? lines : ["…", ...lines.slice(-tail)];
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
    // header. Expanded (ctrl+o / app.tools.expand) shows the trace so a
    // long-running subagent's recent work is inspectable without aborting —
    // BUT capped to a viewport-safe tail (see STREAMING_EXPANDED_TAIL): the
    // full ≤102-row box is taller than the terminal viewport, so its first
    // line sits above the bottom-anchored viewport top and trips the TUI's
    // per-frame fullRender (full-screen clear+rewrite) at ~4Hz → whole-TUI
    // flicker. Keeping the streaming-expanded box small + height-stable keeps
    // the first changed line inside the viewport → differential render → no
    // fullRender. The settled (non-partial) expanded report is unaffected.
    const lines = text.split("\n");
    // Keep the first 2 (progress header) then cap the trace tail via the SHARED
    // helper so this surface and the context-box expanded trace hold the SAME
    // viewport-safe cap (ticket 05, finding 4). Byte-identical to the prior
    // inline ternary: capTraceTail checks `trace.length <= tail`, which is
    // `lines.length - 2 <= tail` ⟺ `lines.length <= 2 + tail`.
    const shown = options.expanded
      ? [...lines.slice(0, 2), ...capTraceTail(lines.slice(2), STREAMING_EXPANDED_TAIL)]
      : lines.slice(0, 2);
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
          : d.status === "aborted"
            ? theme.fg("dim", "⊘ aborted")
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
  // Settled result meta (ticket 04, findings 3 + 5): the live call line shows
  // the fallback `→ actual` mid-run, but on settle that segment vanished and
  // the meta collapsed to the bare actual model — a surprising fallback became
  // invisible. Persist a dim `requested → actual` segment when `d.fellBack` so
  // the discrepancy survives settle. shortModel() keeps it narrow on the
  // one-line collapsed result; `d.requestedModel` (the audit field) stays the
  // FULL spec, only the DISPLAY is shortened.
  const modelSeg =
    d.fellBack && d.requestedModel
      ? `${shortModel(d.requestedModel)} → ${shortModel(d.model) ?? "default"}`
      : shortModel(d.model) ?? "default";
  const meta =
    theme.fg("muted", `${modelSeg} · ${(d.elapsedMs / 1000).toFixed(1)}s${usageStr}`) +
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
    // Owner-declared gating — migrated from tool-gate's hardcoded GATES (was the
    // {names:["workflow","workflow_help","subagent","workflow_control"]} combined
    // gate; tickets 10 + 11 rolled out TOGETHER as one atomic unit because they
    // SHARE that single combined gate). Per the semantics-preserving rule, the
    // SAME gating (keywords only, no `requires`) is mirrored IDENTICALLY on all
    // 4 tools so they activate together and reconstructOwnerDeclaredGates
    // collapses them back into one 4-name gate (names[0] === "workflow") —
    // preserving the original co-fire behavior. Mirrors the original GATES entry
    // verbatim (keywords were unambiguous workflow/orchestration intents that
    // never false-fired the way image/video nouns do, so no requires is needed).
    gating: {
      keywords: ["workflow", "pipeline", "orchestrate", "fan-out", "fan out", "parallel agent", "multi-step"],
    },
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
      // True when the model resolution fell back (onModelFallback fired).
      let fellBack = false;

      // Per-child AbortController (Frontier A): the user can abort ONE running
      // child via registry.abort(toolCallId) → this controller fires. We FAN IN
      // the parent tool-call `signal` so a whole-turn Esc still aborts the child.
      // spawn's own timeoutMs gate stays independent — it aborts spawn's internal
      // controller (not this one), so a timeout is detectable separately.
      const childAc = new AbortController();
      if (signal?.aborted) childAc.abort();
      else signal?.addEventListener("abort", () => childAc.abort(), { once: true });
      options.inFlight?.start({
        id: toolCallId,
        agent: params.agent,
        model: displayModelBeforeResolve,
        taskPreview: taskPreview(params.task),
        // Precompute the work-intent strip from the RAW task so the docked
        // context box can surface it (ticket 04, finding 1 — taskPreview is
        // already single-lined, so workIntentPreview can't strip its preamble).
        workIntent: workIntentPreview(params.task),
        startedAt: t0,
        abort: () => childAc.abort(),
        // Rendered inline in the CURRENT turn by this tool's own call/result line
        // (Surface A) — mark foreground so the above-editor context box EXCLUDES
        // it (no duplication). Background runs (foreground:false) are the box's
        // domain. See subagent-context-widget.ts.
        foreground: true,
      });
      try {
        const instructions =
          [params.agent ? `You are the ${params.agent} for this task.` : undefined, agentDef?.prompt]
            .filter((s): s is string => Boolean(s))
            .join("\n\n") || undefined;

        // Default to the parent's gated active set (not the full definition universe)
        // so a spawned subagent doesn't re-pay the ~18k tok/req schema baseline the
        // parent gated down to ~10k. Precedence: explicit per-call `tools` > agentType
        // `tools` binding > parent's gated active set (the fallback when neither
        // restricts). See .planning/2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task/
        // ticket 01 (optimization #1). Caller's explicit `tools` still overrides.
        const defaultActiveTools = options.getActiveTools?.();
        const result = await spawn({
          task: params.task,
          tools: params.tools ?? agentDef?.tools ?? defaultActiveTools,
          excludeTools: params.excludeTools ?? agentDef?.disallowedTools,
          model: requestedModel,
          tier,
          capability,
          mainModel,
          cwd: spawnCwd,
          instructions,
          extensionTools: options.getExtensionTools?.(),
          externalSignal: childAc.signal,
          timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          tokenBudget: params.tokenBudget,
          spendBudget: params.spendBudget,
          retryOnTransient: params.retryOnTransient,
          schema: params.schema as TSchema | undefined,
          schemaRepairAttempts: params.schemaRepairAttempts,
          onModelResolved: (id) => {
            resolvedModel = id;
            options.inFlight?.updateModel(toolCallId, id);
          },
          onModelFallback: (requestedSpec) => {
            fellBack = true;
            options.inFlight?.markFallback(toolCallId, requestedSpec);
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
        // Per-child abort detection (Frontier A): a USER abort fires childAc
        // only (parent signal intact); a whole-turn Esc fans the parent signal
        // INTO childAc (so signal.aborted distinguishes); a timeout aborts
        // spawn's internal controller, not childAc (so childAc.signal stays
        // un-aborted → falls through to the timedout path unchanged).
        if (childAc.signal.aborted && !signal?.aborted) {
          // Partial work is discarded (worktree) or left in-tree (real-tree);
          // scope/watchdog review of a half-finished diff would be noise.
          const model = resolvedModel ?? displayModelBeforeResolve;
          options.persistence?.save({
            id: generateSubagentRunId(),
            toolCallId,
            agent: params.agent,
            task: params.task,
            model,
            requestedModel: fellBack ? (requestedModel ?? undefined) : undefined,
            fellBack: fellBack || undefined,
            tier,
            cwd: runCwd,
            status: "aborted",
            exitCode: result.exitCode,
            timedOut: false,
            startedAt: new Date(t0).toISOString(),
            elapsedMs,
            usage: result.usage,
            output: "Subagent aborted by user.",
          });
          return {
            content: [{ type: "text" as const, text: "Subagent aborted by user." }],
            details: {
              exitCode: result.exitCode,
              timedOut: false,
              agent: params.agent,
              model,
              taskPreview: taskPreview(params.task),
              elapsedMs,
              startedAt: t0,
              status: "aborted" as const,
              usage: result.usage,
            },
          };
        }
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
          requestedModel: fellBack ? (requestedModel ?? undefined) : undefined,
          fellBack: fellBack || undefined,
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
          requestedModel: fellBack ? (requestedModel ?? undefined) : undefined,
          fellBack: fellBack || undefined,
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
      const entry = options.inFlight?.get(context.toolCallId);
      const resolvedModel = entry?.resolvedModel;
      const fellBack = entry?.fellBack;
      options.inFlight?.bindInvalidate(context.toolCallId, context.invalidate);
      text.setText(renderSubagentCall({ ...args, resolvedModel, fellBack }, theme));
      return text;
    },
    renderResult(result, options, theme, _context) {
      const text = (_context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderSubagentResult(result, options, theme));
      return text;
    },
  });
}
