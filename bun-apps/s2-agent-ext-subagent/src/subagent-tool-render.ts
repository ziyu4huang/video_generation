/**
 * Pure render/parse helpers for the `subagent` tool — stateless string/Theme
 * transforms (args in, string out). Extracted from subagent-tool.ts
 * (behavior-preserving split — no logic change).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BudgetWarning } from "@repo/s2-agent-core-runtime";
import {
  capTraceTail,
  capWidth,
  ellipsizeToWidth,
  fmtCost,
  fmtDurationHuman,
  fmtTokens,
  isSddReportActionable,
  type SpawnSubagentResult,
  STREAMING_EXPANDED_TAIL,
  shortModel,
} from "@repo/s2-agent-core-runtime";
import type { SubagentToolDetails } from "./subagent-tool-schema.js";

// The history/trace display helpers MOVED to core-runtime's
// agent-trace-display.ts (they are history-shaped, and s2-agent-ext-task
// consumed four of them across an ext→ext edge). Re-exported here so this
// file's own consumers — and the package barrel — are unchanged.
export {
  capTraceTail,
  formatHistoryLine,
  formatSubagentLive,
  formatSubagentProgress,
  formatSubagentTrace,
  latestMessageLine,
  STREAMING_EXPANDED_TAIL,
} from "@repo/s2-agent-core-runtime";

/** Collapse a task prompt to a single-line preview within `n` columns
 *  (width-aware, ticket 01): the cap is min(n, `width`) via the shared helper,
 *  so CJK counts double-width and a cut always ends in one `…` inside budget.
 *  Render-layer safe (2026-08-16 crash fix): tolerates a missing task —
 *  composer render paths may see partial/unparsed tool-call args and must
 *  never throw (an uncaught render exception kills the whole TUI). */
export function taskPreview(task: string | undefined, n = 80, width?: number): string {
  const oneLine = (task ?? "").replace(/\s+/g, " ").trim();
  return ellipsizeToWidth(oneLine, capWidth(n, width));
}

/** Display-only helper: strip a leading cwd/repo preamble line from the task
 *  and return the first non-empty remaining line, truncated to `n` chars.
 *  The orchestrator's task prompt convention opens with a line like
 *  `Working dir: /path/to/repo` — this surfaces the actual work intent instead.
 *  Falls back to the first non-empty line (same as {@link taskPreview}) when
 *  there is no preamble. Does NOT mutate the raw task string. Width-aware
 *  (ticket 01): effective cap min(n, `width`), CJK double-width counted.
 *  Render-layer safe (2026-08-16 crash fix): `task.split` on a partial args
 *  object crashed pi via uncaughtException — now tolerates undefined → "". */
export function workIntentPreview(task: string | undefined, n = 60, width?: number): string {
  const lines = (task ?? "").split("\n");
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

/** Theme the call line shown WHILE the subagent runs (pi's spinner conveys activity). */
export function renderSubagentCall(
  args: {
    agent?: string;
    model?: string;
    capability?: string;
    tier?: string;
    task?: string;
    /** Fallback-aware model segment from RunView.modelSeg (e.g. "claude-opus-4-1 → glm-5.2"). */
    modelSeg?: string;
  },
  theme: Theme,
  width?: number,
): string {
  // Render-layer safe (2026-08-16 crash fix #2): tolerate nullish/partial args —
  // a composer must never throw per frame (uncaught render exception kills pi).
  if (!args) return "";
  // CC-parity head (tui-cc-parity ticket 01): `Task(agent): intent` — agent
  // FIRST, the work intent right after, exactly the shape Claude-Code's live
  // Task line reads as. No agent param → bare `Task: intent`.
  const head = theme.bold(theme.fg("toolTitle", "Task"));
  const intent = workIntentPreview(args.task ?? "", 60, width);
  const named = args.agent ? `${head}${theme.fg("accent", `(${args.agent})`)}` : head;
  const parts: string[] = [`${named}${theme.fg("dim", `: ${intent}`)}`];
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
  // The pi tool name trails as a dim segment: greppable in the terminal, but
  // no longer the head — CC's line leads with the AGENT, not the tool.
  parts.push(theme.fg("dim", "spawn_subagent"));
  return parts.join(" ▸ ");
}

/**
 * Width-capped first non-empty line of the report — the settled headline the
 * CC-parity row leads with (ticket 01). Measured on the PLAIN text (style
 * applied by the caller), cap min(60, width) columns, CJK double-width aware.
 */
function settledHeadline(text: string, width?: number): string {
  const raw =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l) ?? "";
  // The report body is Markdown; the headline segment renders PLAIN — strip
  // the common leading markers so `## Findings` headlines as `Findings`, not
  // a raw `##` (CC's completion summary is plain text).
  const plain = raw.replace(/^#{1,6}\s*/, "").replace(/^\*\*(.+)\*\*$/, "$1");
  return plain ? ellipsizeToWidth(plain, capWidth(60, width)) : "";
}

/**
 * Settled header row, CC-parity order (tui-cc-parity ticket 01):
 * `badge ↳ headline · 34,283 tokens · 2m 13s · model · tags…` — the result
 * summary leads (Claude-Code's `↳ summary · N tokens · duration` shape),
 * tokens carry thousands separators with the unit spelled, duration is human
 * (m+s). s2's extra axes (SDD / commit-scope / budget death+warn / turns)
 * stay as trailing warning-tinted segments — they are load-bearing for this
 * repo's dispatch protocol (effort map D1) and are NEVER removed for parity.
 * Cost renders only when non-zero (cost ≡ 0 on this local stack; CC omits
 * it too). One home for both settle surfaces — the collapsed one-liner IS
 * this row, and the ticket-03 expanded CONTAINER (subagent-tool.ts
 * renderResult) renders it as the header Text above the Markdown body — so
 * the row's content can never drift between them.
 */
function settledHeaderRow(
  d: SubagentToolDetails,
  theme: Theme,
  opts?: { modelSeg?: string; headline?: string },
): string {
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
                : d.status === "running"
                  ? theme.fg("muted", "⌛ running") // background:true immediate return — live, the parent turn moved on
                  : theme.fg("error", "✗ failed");
  // CC-shaped meta head: headline (if any) → tokens → duration → cost → model.
  const tokensSeg = d.usage && d.usage.total > 0 ? ` · ${fmtTokens(d.usage.total)} tokens` : "";
  const costSeg = d.usage && d.usage.cost > 0 ? ` · $${fmtCost(d.usage.cost)}` : "";
  // Settled result meta (ticket 04, findings 3 + 5): the live call line shows
  // the fallback `→ actual` mid-run, but on settle that segment vanished and
  // the meta collapsed to the bare actual model — a surprising fallback became
  // invisible. modelSeg comes in fallback-aware from the RunView-carrying caller
  // ("requested → actual", shortModel-ed, single home in core-runtime); when no
  // view is available (registry entry torn down after end()) degrade to the
  // bare actual model.
  const modelSeg = opts?.modelSeg ?? shortModel(d.model) ?? "default";
  const headline = opts?.headline ? theme.fg("dim", ` ↳ ${opts.headline}`) : "";
  const metaHead = theme.fg(
    "muted",
    `${headline}${tokensSeg} · ${fmtDurationHuman(d.elapsedMs)}${costSeg} · ${modelSeg}`,
  );
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
  return `${badge} ${metaHead}${sddTag}${scopeTag}${budgetExhaustionTag}${turnsExhaustionTag}${budgetWarnTag}`;
}

/**
 * Header segment for the settled expanded container (ticket 03): the same
 * badge + meta row the string branch emits, exposed so the component-level
 * composition in subagent-tool.ts (Container → Text header + Markdown body)
 * can reuse it without re-parsing themed strings. Empty when the result
 * carries no details (the fallback then renders just the Markdown child).
 */
export function renderSubagentResultHeader(
  result: { content?: Array<{ type: string; text?: string }>; details?: SubagentToolDetails } | undefined,
  theme: Theme,
  opts?: { modelSeg?: string; width?: number },
): string {
  const d = result?.details;
  // Headline derived from the SAME body text the collapsed one-liner reads, so
  // the two settle surfaces share one summary (ticket 01's no-drift rule).
  return d
    ? settledHeaderRow(d, theme, { ...opts, headline: settledHeadline(subagentResultText(result), opts?.width) })
    : "";
}

/**
 * Full, unthemed report text of a result — the Markdown body for the settled
 * expanded container (ticket 03). Uncapped by design: the Markdown component
 * owns wrapping via render(width), so terminal-width re-flow comes free from
 * the component contract.
 *
 * Render-layer safe: `content` is optional here for the same reason the call
 * renderers tolerate nullish args — these run inside a render pass, where a
 * throw is a whole-session crash rather than a bad line.
 */
export function subagentResultText(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
  return result?.content?.find((c) => c.type === "text")?.text ?? "";
}

/** Theme the result: collapsed = badge+meta+headline; expanded = full report. */
export function renderSubagentResult(
  result: { content?: Array<{ type: string; text?: string }>; details?: SubagentToolDetails } | undefined,
  options: { expanded?: boolean; isPartial?: boolean } | undefined,
  theme: Theme,
  opts?: { modelSeg?: string; width?: number },
): string {
  // Render-layer safe: total over nullish/partial input, matching
  // renderSubagentCall / renderSubagentsCall. GuardedComponent and
  // ComposerComponent are the barrier of last resort; degrading to a correct
  // empty render beats degrading to an error line.
  if (!options) return subagentResultText(result);
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
  const d = result?.details;
  if (!d) return text;
  // Both settle branches share the header row via settledHeaderRow (ticket 03;
  // ticket 01 moved the width-capped headline INSIDE the row so collapsed and
  // expanded cannot drift) — collapsed IS the row, expanded prepends it above
  // the report body.
  const header = settledHeaderRow(d, theme, { ...opts, headline: settledHeadline(text, opts?.width) });
  if (!options.expanded) {
    return header;
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
