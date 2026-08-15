/**
 * Pure render/parse helpers for the `subagent` tool — stateless string/Theme
 * transforms (args in, string out). Extracted from subagent-tool.ts
 * (behavior-preserving split — no logic change).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentHistoryEntry, BudgetWarning } from "@repo/pi-agent-ext-core-runtime";
import {
  fmtCost,
  fmtElapsed,
  formatToolAction,
  isSddReportActionable,
  matchedCallArgsFor,
  shortModel,
} from "@repo/pi-agent-ext-core-runtime";
import { capWidth, ellipsizeToWidth } from "./render-width.js";
import type { SpawnSubagentResult } from "./spawn-subagent.js";
import type { SubagentToolDetails } from "./subagent-tool-schema.js";

/** Collapse a task prompt to a single-line preview within `n` columns
 *  (width-aware, ticket 01): the cap is min(n, `width`) via the shared helper,
 *  so CJK counts double-width and a cut always ends in one `…` inside budget. */
export function taskPreview(task: string, n = 80, width?: number): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return ellipsizeToWidth(oneLine, capWidth(n, width));
}

/** Display-only helper: strip a leading cwd/repo preamble line from the task
 *  and return the first non-empty remaining line, truncated to `n` chars.
 *  The orchestrator's task prompt convention opens with a line like
 *  `Working dir: /path/to/repo` — this surfaces the actual work intent instead.
 *  Falls back to the first non-empty line (same as {@link taskPreview}) when
 *  there is no preamble. Does NOT mutate the raw task string. Width-aware
 *  (ticket 01): effective cap min(n, `width`), CJK double-width counted. */
export function workIntentPreview(task: string, n = 60, width?: number): string {
  const lines = task.split("\n");
  // Strip a leading cwd/repo preamble line (case-insensitive).
  const startIdx = lines.length > 0 && /^(working dir|cwd|repo)\s*:\s*\S+/i.test(lines[0]?.trim() ?? "") ? 1 : 0;
  // Take the first non-empty line after the optional preamble.
  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = lines[i]?.trim();
    if (trimmed && trimmed.length > 0) {
      return ellipsizeToWidth(trimmed, capWidth(n, width));
    }
  }
  // All lines were empty or preamble-only — fall back to single-line.
  return taskPreview(task, n, width);
}

/** Describe the most recent history entry as a short one-line activity string.
 *  Delegates the PHRASE to {@link formatToolAction} and adds NO glyph prefix —
 *  callers (`formatSubagentProgress`) prepend their own `↳`. Width-aware
 *  (ticket 01): the text/default branches ellipsize within min(60, `width`)
 *  — the previously BARE slices now end in one visible `…` when cut. */
function describeLastActivity(
  last: AgentHistoryEntry | undefined,
  ctx?: { matchedCallArgs?: Record<string, unknown> },
  width?: number,
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
      return ellipsizeToWidth(last.text.split("\n")[0] ?? "", capWidth(60, width));
    default:
      return ellipsizeToWidth(last.text, capWidth(60, width));
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
 * Pure render helper — no data-model / compaction change. Width-aware
 *  (ticket 01): the quoted-prose cap is min(80, `width`) columns (the `width`
 *  budgets the truncatable inner text — quotes/`↳` prefix are the caller's).
 */
export function latestMessageLine(history: readonly AgentHistoryEntry[], width?: number): string | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  if (!last) return null; // invariant: history is non-empty (length guarded above)
  if (last.role === "assistant" && last.kind === "text" && last.text.trim()) {
    return `↳ "${ellipsizeToWidth(firstNonEmptyLine(last.text), capWidth(80, width))}"`;
  }
  // Pass matchedCallArgs so a toolResult last recovers its target (mirrors
  // formatSubagentProgress). describeLastActivity's error branch ignores ctx,
  // so an error stays verb-led `Failed to …` here (the expanded trace via
  // formatHistoryLine recovers the target — see formatSubagentTrace tests).
  return `↳ ${describeLastActivity(last, { matchedCallArgs: matchedCallArgsFor(history, history.length - 1) }, width)}`;
}

/**
 * Render the latest compact history snapshot as a one/two-line progress update.
 *
 * `minToolCalls` floors the displayed count (default 0, i.e. no floor). Callers
 * that stream across a `retryOnTransient` retry pass their own running max here:
 * a retry gets a fresh (shorter) history array from a brand-new child session
 * (see spawnSubagent/tryOnce), and without the floor the displayed count would
 * visibly jump backward — read by the user as "did it lose progress?".
 *
 * `width` (ticket 01) flows to the activity snippet only — min(60, width)
 * columns on the truncatable text; the `↳` markers and count line are fixed.
 */
export function formatSubagentProgress(
  history: AgentHistoryEntry[],
  elapsedMs: number,
  minToolCalls = 0,
  width?: number,
): string {
  const last = history[history.length - 1];
  const toolCalls = Math.max(history.filter((h) => h.kind === "toolCall").length, minToolCalls);
  const activity = describeLastActivity(
    last,
    { matchedCallArgs: matchedCallArgsFor(history, history.length - 1) },
    width,
  );
  // fmtElapsed already carries the trailing "s"
  return `↳ ${activity}\n  ↳ ${fmtElapsed(elapsedMs)} elapsed · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
}

/** Render one history entry as a single readable trace line (live-output buffer).
 *  Owns only the surface MARKER (`→`/`✓`/`✗`); the PHRASE comes from
 *  {@link formatToolAction}. The optional `ctx.matchedCallArgs` lets a toolResult
 *  line recover the target it acted on (obtain via `matchedCallArgsFor`).
 *  Width-aware (ticket 01): the text/default branches ellipsize within
 *  min(200, `width`) columns — the previously BARE slices now end in one
 *  visible `…` when cut. */
export function formatHistoryLine(
  e: AgentHistoryEntry,
  ctx?: { matchedCallArgs?: Record<string, unknown> },
  width?: number,
): string {
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
      return ellipsizeToWidth(e.text.split("\n")[0] ?? "", capWidth(200, width));
    default:
      return ellipsizeToWidth(e.text, capWidth(200, width));
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
  width?: number,
): string {
  const header = formatSubagentProgress(history, elapsedMs, minToolCalls, width);
  // matchedCallArgsFor scans the trace window (not the full history) — for runs
  // under the cap this is identical; a result whose call fell outside the recent
  // window degrades gracefully to verb-only.
  const window = history.slice(-maxTraceLines);
  const trace = window.map((e, i) => formatHistoryLine(e, { matchedCallArgs: matchedCallArgsFor(window, i) }, width));
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
export function formatSubagentTrace(
  history: readonly AgentHistoryEntry[],
  elapsedMs: number,
  minToolCalls = 0,
  width?: number,
): string {
  if (history.length === 0) return "";
  const lines: string[] = [];
  // Result indices already rendered inline with their paired call — skipped on
  // the orphan-result pass so a paired result is never ALSO emitted standalone.
  // (Batching: one turn emits N calls then N results; a call must pair with its
  // OWN result by toolCallId, not the immediately-following entry.)
  const consumedResults = new Set<number>();
  // Index into `lines` of the in-flight `→ …` entry, if any. In a normal
  // sequential agent loop there is at most one (the latest un-paired call);
  // progress attaches there. If several un-paired calls appear (a truncated
  // mid-stream window), the latest wins as "the" in-flight call.
  let inFlightIdx = -1;
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    if (!e) continue; // invariant: i < history.length (loop bound)
    if (e.kind === "toolCall") {
      // Pair this call with its OWN result: when the call carries a toolCallId,
      // scan forward for the result whose toolCallId matches (handles batching,
      // where results follow all calls). Fall back to the IMMEDIATELY-following
      // result when ids are absent (legacy/sequential interleaving) — preserving
      // prior behavior for id-less transcripts.
      let pairIdx = -1;
      if (e.toolCallId) {
        for (let j = i + 1; j < history.length; j++) {
          if (history[j]?.kind === "toolResult" && history[j]?.toolCallId === e.toolCallId) {
            pairIdx = j;
            break;
          }
        }
      }
      if (pairIdx < 0) {
        const next = history[i + 1];
        if (next && next.kind === "toolResult") pairIdx = i + 1;
      }
      if (pairIdx >= 0) {
        // invariant: pairIdx is a valid history index (set from an in-range j
        // above, or from i+1 after a defined-result check) → history[pairIdx] defined.
        consumedResults.add(pairIdx);
        lines.push(
          `✓ ${formatToolAction(
            // biome-ignore lint/style/noNonNullAssertion: pairIdx proven in-range by the loop invariant above
            history[pairIdx]!,
            { matchedCallArgs: matchedCallArgsFor(history, pairIdx) },
          )}`,
        );
      } else {
        // Trailing un-paired call → in-flight (present-tense + ellipsis).
        lines.push(`→ ${formatToolAction(e)} …`);
        inFlightIdx = lines.length - 1;
      }
    } else if (!(e.kind === "toolResult" && consumedResults.has(i))) {
      // Orphan toolResult (no preceding call / not already consumed), error, or
      // text → inline via formatHistoryLine (matchedCallArgsFor recovers a target
      // for an orphan result/error, else verb-only). A result already rendered
      // inline with its paired call is skipped (consumedResults).
      lines.push(formatHistoryLine(e, { matchedCallArgs: matchedCallArgsFor(history, i) }, width));
    }
  }
  const toolCalls = Math.max(history.filter((h) => h.kind === "toolCall").length, minToolCalls);
  const progress = `${fmtElapsed(elapsedMs)} · ${toolCalls} call${toolCalls === 1 ? "" : "s"}`;
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
    /** Fallback-aware model segment from RunView.modelSeg (e.g. "claude-opus-4-1 → glm-5.2"). */
    modelSeg?: string;
  },
  theme: Theme,
  width?: number,
): string {
  const parts: string[] = [theme.bold(theme.fg("toolTitle", "subagent"))];
  if (args.agent) parts.push(theme.fg("accent", args.agent));
  // Requested-model slot: explicit model, else capability, else tier, else "default".
  // shortModel() drops the provider prefix on a real model id (ticket 04, finding 5 —
  // a full `anthropic/claude-opus-4-1` overflows the one-line glance). `tier:`/`capability:`/
  // `default` carry no `/` so shortModel() leaves them untouched.
  // biome-ignore lint/style/noNonNullAssertion: argument is always defined; shortModel returns defined for these inputs
  const slot = shortModel(
    args.model ?? (args.capability ? `capability:${args.capability}` : args.tier ? `tier:${args.tier}` : "default"),
  )!;
  parts.push(theme.fg("muted", slot));
  // Concrete model resolved mid-run (onModelResolved), as projected by RunView
  // (registry.view). Separate segment so the requested tier/model stays visible.
  // Skipped when it matches the slot (e.g. an explicit model that resolved to
  // itself) to avoid duplication. modelSeg is already shortened + fallback-aware
  // (it carries its own `→` marker when the resolution fell back), so it is
  // rendered verbatim.
  if (args.modelSeg && args.modelSeg !== slot) {
    parts.push(theme.fg("muted", args.modelSeg));
  }
  parts.push(theme.fg("dim", `"${workIntentPreview(args.task, 60, width)}"`));
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

/**
 * Settled header row: status badge + fallback-aware meta (usage / SDD /
 * commit-scope / budget / turns tags). One home for both settle surfaces —
 * the collapsed one-liner appends the width-capped headline, and the
 * ticket-03 expanded CONTAINER (subagent-tool.ts renderResult) renders it as
 * the header Text above the Markdown body — so the row's content can never
 * drift between them. Content-identical to the pre-ticket-03 inline block.
 */
function settledHeaderRow(d: SubagentToolDetails, theme: Theme, opts?: { modelSeg?: string }): string {
  const badge =
    d.status === "done"
      ? theme.fg("success", "✓ done")
      : d.status === "timedout"
        ? theme.fg("warning", "⏱ timedout")
        : d.status === "budget"
          ? theme.fg("warning", "⛔ budget")
          : d.status === "turns"
            ? theme.fg("warning", "⏹ turns")
            : d.status === "aborted"
              ? theme.fg("dim", "⊘ aborted")
              : d.status === "detached"
                ? theme.fg("dim", "→ background") // Task 05: run handed off to a detached subprocess
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
  // Death tag (abort path): the ⛔-badged run's exceeded budget. Guarded on
  // `kind` because `budget` may carry ONLY a warning (completed run).
  const budgetExhaustionTag =
    d.budget?.kind !== undefined ? theme.fg("warning", ` · ${d.budget.kind}:${d.budget.actual}/${d.budget.limit}`) : "";
  // Turn-cap death tag (abort path): the ⏹-badged run's exceeded turn count
  // (turnsUsed == maxTurns when the abort fired). Mirrors the budget death tag.
  const turnsExhaustionTag = d.turns ? theme.fg("warning", ` · turns:${d.turns.turnsUsed}/${d.turns.maxTurns}`) : "";
  // Warn tag (completed path): informational 80% notice — ⚠ glyph + explicit
  // "budget 80%" wording, visually distinct from the death tag above.
  const budgetWarnTag = d.budget?.warning
    ? theme.fg(
        "warning",
        ` · ⚠ budget 80% ${d.budget.warning.kind}:${d.budget.warning.actual}/${d.budget.warning.limit}`,
      )
    : "";
  // Settled result meta (ticket 04, findings 3 + 5): the live call line shows
  // the fallback `→ actual` mid-run, but on settle that segment vanished and
  // the meta collapsed to the bare actual model — a surprising fallback became
  // invisible. modelSeg comes in fallback-aware from the RunView-carrying caller
  // ("requested → actual", shortModel-ed, single home in core-runtime); when no
  // view is available (registry entry torn down after end()) degrade to the
  // bare actual model.
  const modelSeg = opts?.modelSeg ?? shortModel(d.model) ?? "default";
  const meta =
    theme.fg("muted", `${modelSeg} · ${fmtElapsed(d.elapsedMs)}${usageStr}`) +
    sddTag +
    scopeTag +
    budgetExhaustionTag +
    turnsExhaustionTag +
    budgetWarnTag;
  return `${badge} ${meta}`;
}

/**
 * Header segment for the settled expanded container (ticket 03): the same
 * badge + meta row the string branch emits, exposed so the component-level
 * composition in subagent-tool.ts (Container → Text header + Markdown body)
 * can reuse it without re-parsing themed strings. Empty when the result
 * carries no details (the fallback then renders just the Markdown child).
 */
export function renderSubagentResultHeader(
  result: { content: Array<{ type: string; text?: string }>; details?: SubagentToolDetails },
  theme: Theme,
  opts?: { modelSeg?: string },
): string {
  const d = result.details;
  return d ? settledHeaderRow(d, theme, opts) : "";
}

/**
 * Full, unthemed report text of a result — the Markdown body for the settled
 * expanded container (ticket 03). Uncapped by design: the Markdown component
 * owns wrapping via render(width), so terminal-width re-flow comes free from
 * the component contract.
 */
export function subagentResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

/** Theme the result: collapsed = badge+meta+headline; expanded = full report. */
export function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: SubagentToolDetails },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
  opts?: { modelSeg?: string; width?: number },
): string {
  const text = subagentResultText(result);
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
  // Both settle branches share the header row via settledHeaderRow (ticket 03)
  // — collapsed appends the width-capped headline, expanded prepends it above
  // the report body.
  const header = settledHeaderRow(d, theme, opts);
  if (!options.expanded) {
    const firstLine =
      text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l) ?? "";
    // Settled-collapsed headline (ticket 01): width-aware via the shared
    // helper — cap min(60, width) columns, CJK double-width counted, one
    // trailing `…` inside budget when cut. Measured BEFORE theming (plain
    // text in, style out — render-width input contract).
    return `${header} ${theme.fg("dim", ellipsizeToWidth(firstLine, capWidth(60, opts?.width)))}`;
  }
  return `${header}\n${theme.fg("toolOutput", text)}`;
}

// `deriveSubagentStatus(r)` used to live here, holding a four-branch precedence
// chain (budget > turns > timedout > failed) that mirrored `classifyError`'s
// branch order in spawn-subagent.ts. With the failure union that chain has one
// home, and the helper degenerated to `r.failure?.kind ?? "done"` — so its three
// call sites now write that directly rather than import an alias for it.

/** One-line informational notice for the parent agent's result text (never on the abort path). */
function budgetWarningLine(w: BudgetWarning): string {
  const unit = w.kind === "tokens" ? `${w.actual} tokens` : `$${fmtCost(w.actual)}`;
  return `[budget warning] ${w.kind} usage at ${unit} ≥ 80% of limit ${w.limit} (informational — run completed).`;
}

/** Format the subagent result into the text the parent agent reads. */
export function formatSubagentResult(result: SpawnSubagentResult): string {
  const { failure } = result;
  if (!failure) {
    // Informational 80% warning on a COMPLETED run — appended as its own line so
    // the parent agent (and the user reading the tool result) sees the near-miss
    // without it reading as a failure (distinct from the abort messages below).
    return `${result.output}${result.budgetWarning ? `\n${budgetWarningLine(result.budgetWarning)}` : ""}`;
  }
  if (failure.kind === "budget") {
    const b = failure.budget;
    const unit = b.kind === "tokens" ? `${b.actual} tokens` : `$${fmtCost(b.actual)}`;
    return `Subagent aborted: ${b.kind} budget exhausted (${unit} > limit ${b.limit}).`;
  }
  // Turn-cap abort — same "Subagent aborted:" shape as the budget line, with
  // the parenthesized count matching core-runtime's own message
  // ("max turns exceeded (N)") so the parent sees the same number the child
  // surfaced. Distinct from the timeout fate line below.
  if (failure.kind === "turns") {
    return `Subagent aborted: max turns exceeded (${failure.turns.maxTurns}).`;
  }
  // No exit code in the head line any more: there was never a process, and the
  // number it used to print (1, or 124 for a timeout) carried nothing the fate
  // word does not already say.
  const head = `Subagent ${failure.kind === "timedout" ? "timed out" : "failed"}.`;
  const err = failure.message ? `\n${failure.message}` : "";
  const tail = result.output ? `\n\n--- subagent output ---\n${result.output}` : "";
  return `${head}${err}${tail}`;
}
