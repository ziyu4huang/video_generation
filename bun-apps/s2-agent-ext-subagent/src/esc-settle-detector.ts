/**
 * esc-settle-detector — the badge-glyph discriminator behind the Esc-repro
 * regression lane (2026-08-27 handoff: "the detector needs the badge glyph as
 * its discriminator").
 *
 * #2067's lesson: a naive live-line detector cannot tell a SETTLED subagent
 * row from a STREAMING partial, because both carry `↳` continuation lines —
 * the streaming partial's 2-line header is itself `↳ <activity>` +
 * `  ↳ <N>s elapsed · <N> tool calls` (formatSubagentProgress). The settled
 * row (settledHeaderRow in subagent-tool-render.ts — the single home for both
 * settle surfaces) is the ONLY surface whose line STARTS with a status badge:
 * `✓ done` / `⏱ timedout` / `⛔ budget` / `⏹ turns` / `⊘ aborted` /
 * `→ background` / `⌛ running` / `✗ failed`. That glyph is the discriminator.
 *
 * Pure string scanning over captured pane lines — no TUI, no session — so the
 * whole contract is unit-testable offline; the tmux driver
 * (scripts/esc-repro-lane.ts) only feeds it `tmux capture-pane -p` output.
 */

/** Terminal statuses that end a foreground run (badge → status). Kept in sync
 *  with settledHeaderRow's badge ladder in subagent-tool-render.ts — the
 *  drift-guard test pins that coupling by reading the render source. */
export const BADGE_BY_STATUS = {
  done: "✓ done",
  timedout: "⏱ timedout",
  budget: "⛔ budget",
  turns: "⏹ turns",
  aborted: "⊘ aborted",
  background: "→ background",
  running: "⌛ running",
  failed: "✗ failed",
} as const;

export type SettleStatus = keyof typeof BADGE_BY_STATUS;

/** One settled row found in a pane capture. */
export interface SettledRow {
  status: SettleStatus;
  /** The full matched line (ANSI-stripped), for receipts. */
  line: string;
  /** Index into the input lines — the newest row wins ordering disputes. */
  lineIndex: number;
}

/** ANSI SGR sequence matcher, built from a string so the ESC control char
 *  never appears in a regex literal (biome noControlCharactersInRegex). */
const ANSI_SGR = new RegExp("\u001b\\[[0-9;?]*[A-Za-z]", "g");

/** Strip ANSI escape sequences (SGR colors etc.) so a themed row scans the
 *  same as a plain one. tmux capture-pane emits plain text by default, but
 *  the detector must not care whether it was captured with -e. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR, "");
}

/** Build the badge matcher once: `^\s*<badge>(?=$|[ ·↳])` per status. The
 *  trailing anchor is load-bearing for the `→` badge — an in-flight trace
 *  line also starts with `→` (`→ Read src/foo.ts …`, formatHistoryLine), so
 *  `→ background` only matches when the word is the badge, not a phrase.
 *  The `✗ failed` badge is likewise case-guarded: trace error phrases render
 *  Capitalized (`✗ Failed to edit …`, formatToolAction) and never lowercase,
 *  so only the badge form matches. */
const BADGE_MATCHERS: Array<{ status: SettleStatus; re: RegExp }> = (
  Object.entries(BADGE_BY_STATUS) as Array<[SettleStatus, string]>
).map(([status, badge]) => ({
  status,
  re: new RegExp(`^\\s*${escapeRe(badge)}(?=$|[\\s·↳])`),
}));

/** Escape regex metacharacters so the badge table stays literal if a badge
 *  ever gains a metacharacter (none of today's glyphs are special). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the NEWEST settled subagent row in captured pane lines. Returns null
 * while the run is still streaming (partial headers and trace lines never
 * match — no badge glyph at line start) or when nothing has settled yet.
 * Scans bottom-up so the last settled row wins even when the pane still holds
 * an older run's row above.
 */
export function detectSettledRow(lines: readonly string[]): SettledRow | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = stripAnsi(lines[i] ?? "");
    for (const { status, re } of BADGE_MATCHERS) {
      if (re.test(line)) return { status, line: line.trim(), lineIndex: i };
    }
  }
  return null;
}

/**
 * Detect the STREAMING partial header — the `  ↳ <N>s elapsed · <N> tool
 * call(s)` progress line is its distinctive second line (a settled row's meta
 * head never carries the word `elapsed`). This is the lane's "the child is
 * mid-flight, Esc NOW" trigger: pressing Esc before the partial appears races
 * the dispatch itself and settles nothing.
 */
export function detectStreamingPartial(lines: readonly string[]): boolean {
  // fmtElapsed renders one-decimal seconds ("13.4s"), so the time part is
  // [\d.]+s — anchor on the `elapsed · N tool calls` tail, which no other
  // surface emits.
  return lines.some((l) => /^\s*↳.*elapsed · \d+ tool calls?$/.test(stripAnsi(l)));
}
