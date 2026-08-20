/**
 * captions.ts — the SRT → burned-in-text ladder (movie-director Item J-sibling).
 *
 * The composition stack's captions pass historically tried ONE hard-burn path
 * (libass `subtitles`) and on absence silently fell back to a soft `mov_text`
 * sidecar (viewer-toggleable, NOT burned-in). On the macOS dev platform that is
 * every machine running Homebrew's stock `ffmpeg` formula — it ships WITHOUT
 * libass, so captions were ALWAYS soft there, breaking the animated-explainer
 * pitch ("captions always visible"). See the `ffmpeg-full` vs `ffmpeg` split:
 * the stock formula omits `--enable-libass/--enable-libfreetype/--enable-fontconfig`.
 *
 * This module inserts a MIDDLE tier: when libass is absent but the `drawtext`
 * filter (fontconfig/freetype-based, no libass dep) resolves, parse the SRT into
 * `{text, start, end}` cues and burn them with a `drawtext` filter chain (one
 * node per cue, gated by `enable='between(t,start,end)'`). Only if drawtext is
 * ALSO absent does the ladder legitimately end at the sidecar.
 *
 * Shared by `compose.ts` (straight-cut) and `compose_motion.ts` (motion tier)
 * so both runtimes honor the same ladder without duplication.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { runSpawn, type SpawnImpl } from "./spawn.ts";

// ─── SRT parsing ─────────────────────────────────────────────────────────────

export interface CaptionCue {
  /** Cue text (single line; multi-line cues joined with \n by the renderer). */
  text: string;
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
}

/**
 * Parse an SRT (or VTT) file into caption cues. Tolerant: skips the index lines,
 * the `-->` arrow delimits start/end, and timestamps may be `HH:MM:SS,mmm`
 * (SRT) or `HH:MM:SS.mmm` (VTT). Malformed blocks are dropped (not fatal).
 */
export function parseSrt(content: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  // Normalize CRLF + split on blank-line block boundaries.
  const blocks = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    // Drop a leading numeric index line ("1", "2", ...).
    let i = 0;
    if (/^\d+$/.test(lines[0]!)) i = 1;
    const timeLine = lines[i];
    if (!timeLine || !timeLine.includes("-->")) continue;
    const m = timeLine.match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    const start = parseTimestamp(m[1]!);
    const end = parseTimestamp(m[2]!);
    if (start == null || end == null) continue;
    const text = lines
      .slice(i + 1)
      .join("\n")
      .trim();
    if (text) cues.push({ text: stripSrtMarkup(text), start, end });
  }
  return cues;
}

/** "HH:MM:SS,mmm" | "MM:SS.mmm" | "SS" → seconds. Returns undefined on miss. */
function parseTimestamp(ts: string): number | undefined {
  // Strip SRT's comma millisecond separator → dot.
  const clean = ts.replace(",", ".");
  const parts = clean.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 1) return parts[0]!;
  return undefined;
}

/**
 * Strip SRT/ASS/HTML inline markup drawtext would otherwise burn as raw text.
 * Handles `<i>`/`<b>`/`<u>`/`<font ...>` (HTML-style SRT markup) and `{\an8}` /
 * `{\...}` (ASS override blocks). Whitespace inside `<font>` tags is tolerated.
 * drawtext cannot honor italics/bold/positioning, so these are removed (not
 * interpreted) — the cue's plain text is what burns.
 */
export function stripSrtMarkup(s: string): string {
  return s
    .replace(/<\/?(i|b|u|s|font|small|sub|sup)\b[^>]*>/gi, "") // <i></i><b></b><u></u><font ...></font>
    .replace(/\{[^}]*\}/g, "") // ASS override blocks {\an8}{\b1}
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Word-wrap a cue for the drawtext tier so a long line doesn't overflow frame
 * width. `maxCharsPerLine` is derived from fontsize + frame width by the caller
 * (≈ 0.5 × fontsize average glyph advance). Existing `\n` (explicit cue breaks)
 * are preserved; each segment is then wrapped by word to the per-line budget.
 */
export function wrapCueText(text: string, maxCharsPerLine: number): string {
  const budget = Math.max(8, maxCharsPerLine);
  return text
    .split("\n")
    .map((seg) => {
      const words = seg.split(/\s+/).filter(Boolean);
      if (words.length === 0) return "";
      const lines: string[] = [];
      let cur = "";
      for (const w of words) {
        if (!cur) {
          cur = w;
        } else if ((cur + " " + w).length <= budget) {
          cur += " " + w;
        } else {
          lines.push(cur);
          cur = w;
        }
      }
      if (cur) lines.push(cur);
      return lines.join("\n");
    })
    .join("\n");
}

// ─── filter availability probes (cached per process) ─────────────────────────

/** Whether this ffmpeg build has the `subtitles` (libass) filter. */
let subtitlesCached: boolean | undefined;
export function subtitlesFilterAvailable(): boolean {
  if (subtitlesCached != null) return subtitlesCached;
  try {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
    // Match the name as a whole token so "ass " doesn't false-match "bandpass".
    subtitlesCached = /(?:^|\s).{0,3}subtitles\s+V->V/.test(r.stdout ?? "");
  } catch {
    subtitlesCached = false;
  }
  return subtitlesCached;
}
export function _setSubtitlesFilterForTest(v: boolean | undefined): void {
  subtitlesCached = v;
}

/** Whether this ffmpeg build has the `drawtext` (freetype + fontconfig) filter. */
let drawtextCached: boolean | undefined;
export function drawtextFilterAvailable(): boolean {
  if (drawtextCached != null) return drawtextCached;
  try {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
    drawtextCached = /(?:^|\s).{0,3}drawtext\s+V->V/.test(r.stdout ?? "");
  } catch {
    drawtextCached = false;
  }
  return drawtextCached;
}
export function _setDrawtextFilterForTest(v: boolean | undefined): void {
  drawtextCached = v;
}

/**
 * Resolve a fontfile for drawtext. Honors `MD_CAPTION_FONT` (a path OR a
 * fontconfig family name resolved via `fc-match`); falls back to a macOS-safe
 * system default. Returns null if no file resolves (caller then falls to sidecar).
 */
let fontfileCached: string | null | undefined;
export function resolveCaptionFont(): string | null {
  // `undefined` = not yet probed; `null` = probed and NO font resolved (a valid
  // result the caller falls back from). Guard on undefined, not null.
  if (fontfileCached !== undefined) return fontfileCached;
  const env = process.env.MD_CAPTION_FONT;
  // 1. Explicit path that exists on disk → use verbatim.
  if (env && existsSync(env)) {
    fontfileCached = env;
    return fontfileCached;
  }
  // 2. Explicit family name → resolve via fontconfig's fc-match.
  if (env) {
    const hit = fcMatchFont(env);
    if (hit) {
      fontfileCached = hit;
      return fontfileCached;
    }
  }
  // 3. macOS system default (Arial). Present on every macOS install.
  const defaultMac = "/System/Library/Fonts/Supplemental/Arial.ttf";
  if (existsSync(defaultMac)) {
    fontfileCached = defaultMac;
    return fontfileCached;
  }
  // 4. Last resort: resolve "Arial" via fontconfig (Linux/other).
  const fallback = fcMatchFont("Arial");
  fontfileCached = fallback;
  return fontfileCached;
}
export function _setCaptionFontForTest(v: string | null | undefined): void {
  fontfileCached = v;
}

/** Run `fc-match -f '%{file}' "<family>"` to resolve a fontfile path. */
function fcMatchFont(family: string): string | null {
  try {
    const r = spawnSync("fc-match", ["-f", "%{file}", family], { encoding: "utf8" });
    const file = (r.stdout ?? "").trim();
    if (file && existsSync(file)) return file;
  } catch {
    // fc-match absent (non-fontconfig ffmpeg build) → caller falls to sidecar.
  }
  return null;
}

// ─── the burn ladder ─────────────────────────────────────────────────────────

/** What the captions pass actually did (mirrors the prior note vocabulary). */
export type CaptionOutcome = "libass" | "drawtext" | "sidecar";

export interface BurnResult {
  ok: boolean;
  outcome: CaptionOutcome;
  /** Path to the captioned output (only meaningful when ok). */
  output: string;
  detail: string;
}

export interface BurnDeps {
  spawnImpl?: SpawnImpl;
  /** Frame width (px) for drawtext word-wrap (default 1920). libass/sidecar ignore it. */
  width?: number;
  /** drawtext font size (px), default 48. */
  fontsize?: number;
}

/**
 * Decide the burn tier WITHOUT running it (compose.ts uses this to surface a
 * warning BEFORE re-encoding, matching the prior UX). The actual burn happens in
 * `burnCaptions`. `wantBurn` is the caller's intent (captions.burn !== false).
 */
export function planBurn(wantBurn: boolean, srtExists: boolean): {
  outcome: CaptionOutcome | "skip";
  warning?: string;
} {
  if (!srtExists) return { outcome: "skip", warning: undefined };
  if (!wantBurn) return { outcome: "sidecar" };
  if (subtitlesFilterAvailable()) return { outcome: "libass" };
  if (drawtextFilterAvailable()) {
    if (resolveCaptionFont()) return { outcome: "drawtext" };
    return {
      outcome: "sidecar",
      warning: "ffmpeg has `drawtext` but no caption font resolved (MD_CAPTION_FONT unset + no system Arial); falling back to soft mov_text sidecar",
    };
  }
  return {
    outcome: "sidecar",
    warning: "ffmpeg lacks both `subtitles` (libass) and `drawtext` filters; falling back to soft mov_text sidecar",
  };
}

/**
 * Burn captions onto `video` per the ladder: libass → drawtext → sidecar.
 * Writes a new mp4 at `output`. Never throws — a failed burn returns ok:false so
 * the caller keeps the uncaptioned video (mirrors compose.ts's soft-fail UX).
 */
export async function burnCaptions(
  video: string,
  srtPath: string,
  output: string,
  wantBurn: boolean,
  deps: BurnDeps = {},
): Promise<BurnResult> {
  const run = deps.spawnImpl ?? runSpawn;
  const plan = planBurn(wantBurn, existsSync(srtPath));
  if (plan.outcome === "skip") {
    return { ok: false, outcome: "sidecar", output, detail: `captions srt not found: ${srtPath}` };
  }

  let argv: string[];
  if (plan.outcome === "libass") {
    argv = ["-y", "-i", video, "-vf", `subtitles=${srtPath}`, "-c:a", "copy", output];
  } else if (plan.outcome === "drawtext") {
    argv = await buildDrawtextArgv(video, srtPath, output, { width: deps.width, fontsize: deps.fontsize });
  } else {
    // sidecar (soft mov_text)
    argv = ["-y", "-i", video, "-i", srtPath, "-c", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", output];
  }

  const r = await run("ffmpeg", argv);
  const ok = r.code === 0 && existsSync(output);
  return { ok, outcome: plan.outcome, output, detail: ok ? plan.outcome : `exit ${r.code}` };
}

/**
 * Build the drawtext filtergraph: one `drawtext` node per cue, gated by
 * `enable='between(t,start,end)'`. The text is escaped per ffmpeg's drawtext
 * rules (backslash the special chars `:` `\` `'` `%` `{}`). Fontfile is resolved
 * once (resolveCaptionFont); box + bordercolor give a readable outline over any
 * background. Position: bottom-center (~72px from bottom).
 */
async function buildDrawtextArgv(
  video: string,
  srtPath: string,
  output: string,
  wrap: { width?: number; fontsize?: number } = {},
): Promise<string[]> {
  const fontfile = resolveCaptionFont() ?? "";
  const cues = parseSrt(readFileText(srtPath));
  // Per-line char budget from fontsize + frame width (~0.5 × fontsize advance,
  // capped to 80% of the frame). Long cues word-wrap so they stack with
  // line_spacing instead of overflowing frame width.
  const fontsize = wrap.fontsize ?? 48;
  const frameW = wrap.width ?? 1920;
  const maxChars = Math.max(8, Math.floor((frameW * 0.8) / (fontsize * 0.5)));
  const vf = cues.length
    ? cues.map((c) => drawtextNode({ ...c, text: wrapCueText(c.text, maxChars) }, fontfile, fontsize)).join(",")
    // No parseable cues → still emit a no-op filter so the encode is valid.
    : "null";
  return ["-y", "-i", video, "-vf", vf, "-c:a", "copy", output];
}

function readFileText(path: string): string {
  try {
    // Lazy require to keep this module import-side-effect-free for tests.
    const { readFileSync } = require("node:fs");
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * One drawtext node for a cue. Escapes the text + fontfile per ffmpeg's rules.
 * `enable='between(t,start,end)'` makes the node active only during the cue.
 * The cue text may contain `\n` (explicit or word-wrap) → drawtext renders each
 * as a stacked line; `y=h-text_h-72` anchors the whole block by its total height.
 */
function drawtextNode(cue: CaptionCue, fontfile: string, fontsize = 48): string {
  const text = escapeDrawtextText(cue.text);
  const f = escapeDrawtextPath(fontfile);
  // ffmpeg filter syntax: `filtername=key=val:key=val`. The first separator
  // after `drawtext` is `=`; subsequent option pairs are `:`-delimited.
  const opts = [
    `fontfile='${f}'`,
    `text='${text}'`,
    `enable='between(t,${cue.start.toFixed(3)},${cue.end.toFixed(3)})'`,
    `fontsize=${fontsize}`,
    "fontcolor=white",
    "borderw=3",
    "bordercolor=black",
    "x=(w-text_w)/2",
    "y=h-text_h-72",
    "line_spacing=8",
  ];
  return `drawtext=${opts.join(":")}`;
}

/**
 * Escape text for drawtext's `text='...'` option. ffmpeg drawtext treats `\`,
 * `'`, `:`, `%`, `{`, `}` as special; backslash-escape each. Newlines (\n in
 * the cue text) become a literal `\` + `n` so drawtext renders a line break.
 */
function escapeDrawtextText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\n/g, "\\n");
}

/** Escape a filesystem path for drawtext's `fontfile='...'` (colon + quote). */
function escapeDrawtextPath(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

// ─── standalone drawtext (text cuts / title cards) ───────────────────────────

export interface DrawtextStyle {
  /** Resolved font file path (from resolveCaptionFont). */
  fontfile: string;
  fontsize?: number;
  fontcolor?: string;
  borderw?: number;
  bordercolor?: string;
  /** drawtext x expression. Default centers horizontally. */
  x?: string;
  /** drawtext y expression. Default centers vertically. */
  y?: string;
}

/**
 * Build a single always-on `drawtext=` filter string for a static text overlay
 * (a text cut / title card). Reuses the same escaping + option vocabulary as the
 * per-cue burn ladder but omits `enable=between` (the text is visible for the
 * whole segment it's applied to). Used by compose_motion to render text cuts
 * WITHOUT a browser runtime (the gap compose-remotion filled via React layers).
 */
export function buildDrawtextFilter(text: string, style: DrawtextStyle): string {
  const opts = [
    `fontfile='${escapeDrawtextPath(style.fontfile)}'`,
    `text='${escapeDrawtextText(text)}'`,
    `fontsize=${style.fontsize ?? 72}`,
    `fontcolor=${style.fontcolor ?? "white"}`,
    `borderw=${style.borderw ?? 4}`,
    `bordercolor=${style.bordercolor ?? "black"}`,
    `x=${style.x ?? "(w-text_w)/2"}`,
    `y=${style.y ?? "(h-text_h)/2"}`,
    "line_spacing=12",
  ];
  return `drawtext=${opts.join(":")}`;
}

