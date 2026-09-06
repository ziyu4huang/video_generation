/**
 * agent-trace-display — pure render/parse helpers over `AgentHistoryEntry`:
 * the collapsed live line, the streaming progress snapshot, and the expanded
 * trace with its viewport-safe tail cap.
 *
 * MOVED here from s2-agent-ext-subagent/src/subagent-tool-render.ts. These are
 * history-shaped, not subagent-tool-shaped — nothing below mentions
 * `SubagentToolDetails`, and `s2-agent-ext-task`'s subagents status section
 * consumed four of them across an ext→ext import edge. History display is
 * runtime vocabulary (this package already owns agent-row-display, run-view,
 * render-width, tool-action-label), so it lives here and the subagent
 * extension stays removable. See tests/extension-isolation-contract.test.ts
 * invariant (1).
 *
 * The subagent-tool-specific renderers (`taskPreview`, `renderSubagentCall`,
 * `renderSubagentResult`, …) stay in that file, which re-exports everything
 * here so its own call sites are unchanged.
 */
import type { AgentHistoryEntry } from "./agent-history.js";
import { fmtElapsed } from "./agent-row-display.js";
import { capWidth, ellipsizeToWidth } from "./render-width.js";
import { formatToolAction, matchedCallArgsFor } from "./tool-action-label.js";

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
      return formatToolAction(last, { width });
    case "toolResult":
      return formatToolAction(last, { matchedCallArgs: ctx?.matchedCallArgs, width });
    case "error":
      // Errors are the moment progress streaming matters most — `formatToolAction`
      // already conveys failure (`Failed to …` / `⚠ …`), so no extra marker here.
      return formatToolAction(last, { width });
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
      return `→ ${formatToolAction(e, { width })}`;
    case "toolResult":
      // Results carry no args; ctx.matchedCallArgs (from the matching preceding
      // toolCall) recovers the target → `✓ Read a.ts`. Orphan → verb-only `✓ Read`.
      return `✓ ${formatToolAction(e, { matchedCallArgs: ctx?.matchedCallArgs, width })}`;
    case "error": {
      // `formatToolAction` already emits `⚠ <line>` for whole-turn assistant
      // errors — pass it through unchanged so we never double up `✗ ⚠`. Tool
      // errors (`Failed to …`) get the `✗` marker. Pass matchedCallArgs so a
      // tool error recovers the target it acted on (e.g. `✗ Failed to edit
      // src/parser.ts: …`) — consistent with the toolResult branch above.
      const phrase = formatToolAction(e, { matchedCallArgs: ctx?.matchedCallArgs, width });
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
 * Viewport-aware replacement for the fixed {@link STREAMING_EXPANDED_TAIL} cap
 * (tui-cc-parity-2 ticket 01): the expanded live trace may grow with the real
 * terminal height — CC's ctrl+o fills the viewport — while still honoring the
 * #1104 constraint that the whole box must fit, which is a FUNCTION of rows,
 * not a constant. `rows` is the terminal's current row count; anything
 * non-finite/absent (headless, print mode, unit tests) falls back to the fixed
 * 16 so behavior stays deterministic without a terminal.
 *
 * Budget: `rows - reserved` trace lines, clamped [8, 28]. `reserved` covers the
 * chrome that shares the viewport with the trace (2-line progress header +
 * `…` ellipsis + hint/footer + composer + status bar ≈ 14 rows) — measured on
 * the pi composer layout, deliberately generous so the box never pushes its
 * first line above the viewport top (that is the fullRender flicker trigger).
 *
 * Height-stability rule (#1104, map D3): the cap varies only when the terminal
 * is RESIZED — callers read rows once per render pass and the value is stable
 * between resizes — never per tick.
 */
export function viewportTraceTail(
  rows: number | undefined,
  opts?: { min?: number; max?: number; reserved?: number },
): number {
  if (rows === undefined || !Number.isFinite(rows) || rows <= 0) return STREAMING_EXPANDED_TAIL;
  const min = opts?.min ?? 8;
  const max = opts?.max ?? 28;
  const reserved = opts?.reserved ?? 14;
  return Math.max(min, Math.min(max, rows - reserved));
}

/**
 * Best-effort current terminal row count for render seams that only receive
 * `width` (pi-tui's Component contract has no height). Returns undefined in a
 * headless/non-TTY context (piped output, tests, print mode) so callers fall
 * back to {@link viewportTraceTail}'s default. Never throws — render seams
 * must not.
 */
export function currentTerminalRows(): number | undefined {
  try {
    const rows = (process.stdout as unknown as { rows?: number } | undefined)?.rows;
    return typeof rows === "number" && rows > 0 ? rows : undefined;
  } catch {
    return undefined;
  }
}

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
