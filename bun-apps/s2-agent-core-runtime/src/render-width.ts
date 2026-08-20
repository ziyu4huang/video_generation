/**
 * Shared width-aware truncation helpers (effort 2026-08-15-subagent-tui-display,
 * ticket 01 prefactor; ported home to core-runtime 2026-08-19 so every package
 * renders through ONE surface — subagent keeps no local copy).
 *
 * ONE surface for every pure render site that clips a line: terminal-COLUMN
 * aware (East-Asian double-width counted via pi-tui's `visibleWidth`), one
 * ellipsis INSIDE the column budget whenever content is cut, an upper-bound
 * `min(constant, width)` combinator, and a graceful floor so degenerate widths
 * degrade to a clean short line — never empty, never a crash.
 *
 * Why this wraps `visibleWidth` instead of calling pi-tui `truncateToWidth`
 * directly: the library's truncation emits ANSI-reset-wrapped `"..."` (three
 * ASCII dots inside escape sequences), which breaks the unified single-`…`
 * trailing-ellipsis contract and the existing pinned outputs (e.g.
 * `taskPreview` ending in exactly one `…`). `sliceByColumn` is also unsafe as
 * a clipper: a wide char straddling the boundary can overshoot the requested
 * width. So this module owns the clip loop and delegates only MEASUREMENT to
 * the library — every adopter gets identical ellipsis/floor/CJK semantics.
 *
 * Input contract: plain (unstyled) text. Measure-then-style at the call site
 * (`theme.fg(...)` AFTER clipping), never feed styled text in.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Clip `s` to at most `budget` terminal columns WITHOUT adding an ellipsis.
 * Walks code points (surrogate pairs stay whole); stops before the first char
 * that would overflow the budget — so a trailing double-width char is dropped
 * rather than overshooting. Zero-width chars (combining marks, ZWJ) attach
 * freely and never cause a cut.
 */
function clipColumns(s: string, budget: number): string {
  if (budget <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of s) {
    const w = visibleWidth(ch);
    if (w === 0) {
      out += ch;
      continue;
    }
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out;
}

/** Clip from the END of `s` to at most `budget` columns (mid-ellipsis tail half). */
function clipColumnsEnd(s: string, budget: number): string {
  if (budget <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of [...s].reverse()) {
    const w = visibleWidth(ch);
    if (w === 0) {
      out = ch + out;
      continue;
    }
    if (used + w > budget) break;
    out = ch + out;
    used += w;
  }
  return out;
}

/**
 * Truncate `s` to at most `width` terminal columns with ONE trailing `…`
 * (visible width 1) inside the budget whenever content is cut — the unified
 * ellipsis semantics for every converted render site.
 *
 * Graceful floor: content that already fits is returned verbatim (empty stays
 * empty); when content must be cut, a width of ≤1 degrades to the bare `…`
 * (the smallest clean signal that a cut happened) instead of an empty render.
 */
export function ellipsizeToWidth(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  if (width <= 1) return "…";
  return `${clipColumns(s, width - 1)}…`;
}

/**
 * Mid-ellipsis counterpart of {@link ellipsizeToWidth}: keep the head and tail,
 * replace the cut middle with ONE `…` inside the budget. Column split mirrors
 * the legacy char-based semantics — head gets the ceil half, tail the floor —
 * so ASCII outputs are byte-identical to the old `truncateMid`; wide chars are
 * dropped when they would straddle either half's column budget.
 */
export function ellipsizeMidToWidth(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  if (width <= 1) return "…";
  const content = width - 1;
  const head = Math.ceil(content / 2);
  const tail = Math.floor(content / 2);
  return `${clipColumns(s, head)}…${clipColumnsEnd(s, tail)}`;
}

/**
 * Upper-bound combinator: the effective cap is `min(constant, width)` — the
 * historical fixed cap survives as a ceiling, and a caller-supplied width only
 * ever NARROWS it. `undefined`/non-finite width (no width source available)
 * keeps today's constant exactly, so defaulted callers stay byte-identical.
 */
export function capWidth(constant: number, width?: number): number {
  if (width === undefined || !Number.isFinite(width)) return constant;
  return Math.min(constant, Math.floor(width));
}
