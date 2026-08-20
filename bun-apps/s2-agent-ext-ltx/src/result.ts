/**
 * result.ts — turn an ltx-video run into structured, agent-consumable
 * `details`. Unlike s2-agent-ext-flux2 (which parses a `.manifest.json`
 * sidecar), ltx-video writes NO sidecar files — every command's real output
 * lives only in its stdout, in a fixed-but-per-command format (see each
 * <Cmd>Command.swift's print() calls). This module regex-parses those known
 * formats. `gate --json` / `verify --json` are the two commands with real
 * structured output; everything else is parsed from human-readable prints.
 */
import { existsSync, statSync } from "node:fs";
import type { InvokeResult } from "./invoke.ts";

export interface AsrGateVerdict {
  status: "PASS" | "WARN" | "FAIL" | string;
  reasons: string[];
  detectedLang: string;
  transcript: string;
  [key: string]: unknown;
}

export interface GateEntry {
  path: string;
  status: "PASS" | "WARN" | "FAIL" | string;
  reasons?: string[];
  /** Present only when `asrPrompt` was given — the separate voice-content sub-check. */
  asr?: AsrGateVerdict;
  [key: string]: unknown;
}

export interface SceneEntry {
  sceneNum: number;
  startFrame: number;
  endFrame: number;
  frames: number;
  durationSec: number;
}

export interface LtxDetails {
  ok: boolean;
  command: string;
  exitCode: number;
  aborted: boolean;
  /** Primary output path/dir (first-class, for chaining). null for non-generation commands. */
  output: string | null;
  /** Named secondary outputs a command may also produce (e.g. native-i2v's audio.wav, upscaled/). */
  extraOutputs: Record<string, string>;
  width: number | null;
  height: number | null;
  wallSeconds: number | null;
  gate: "PASS" | "WARN" | "FAIL" | null;
  gateResults?: GateEntry[];
  verify?: { meanOverall: number; worstOverall: number; pass: boolean };
  /** `segment`: detected scene cuts, in order. */
  scenes?: SceneEntry[];
  /** Raw stdout, always present, truncated in `summarize()` but kept whole here. */
  stdout: string;
}

/** Path on the LAST stdout line matching `re` (walks from the end). */
function lastMatch(stdout: string, re: RegExp): string | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(re);
    if (m) return m[1]!;
  }
  return null;
}

/** Path on the FIRST stdout line matching `re`. */
function firstMatchLine(stdout: string, re: RegExp): string | null {
  for (const line of stdout.split("\n")) {
    const m = line.match(re);
    if (m) return m[1]!;
  }
  return null;
}

function firstMatch(stdout: string, re: RegExp): RegExpMatchArray | null {
  for (const line of stdout.split("\n")) {
    const m = line.match(re);
    if (m) return m;
  }
  return null;
}

/** All matches of `re` across stdout, one per matching line, in order. */
function allMatches(stdout: string, re: RegExp): string[] {
  return stdout
    .split("\n")
    .map((l) => l.match(re))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => m[1]!);
}

function parseWallSeconds(stdout: string): number | null {
  // "✅ wall time: 587.7s" (native-i2v/native-upscale) or "wall time: 587.7s" (i2v).
  // No line-start anchor: the ✅ prefix is not whitespace. A command that runs
  // multiple stages (e.g. native-i2v's auto-upscale, or native-upscale's hd
  // mode) prints ONE "wall time:" line per stage — sum them all rather than
  // taking just the first, which used to silently under-report total wall
  // time by however long the later stage(s) took (found by
  // s2-agent-ext-ltx-self-improve's review lane, 2026-07-04).
  const times = allMatches(stdout, /wall time:\s*([\d.]+)s/);
  if (!times.length) return null;
  return times.reduce((sum, t) => sum + Number(t), 0);
}

function parseDims(stdout: string): { width: number | null; height: number | null } {
  // Prefer an explicit "AxB -> CxD" transition (native-upscale/native-i2v's
  // upscale section) — the OUTPUT (post-arrow) dims are what matters. Falls
  // back to the first standalone "WxH" occurrence (native-i2v's initial
  // "9 frames @ 24.0fps, 640x960" line, no arrow).
  const arrow = firstMatch(stdout, /\d+x\d+\s*->\s*(\d+)x(\d+)/);
  if (arrow) return { width: Number(arrow[1]), height: Number(arrow[2]) };
  // native-restyle's dims line has a trailing annotation ("504x504 (unchanged
  // — restyle, not upscale)") — a bare space after the digits also ends the
  // match, not just end-of-line/comma/close-paren.
  const m = firstMatch(stdout, /(\d+)x(\d+)(?:\s|$|,|\))/);
  if (!m) return { width: null, height: null };
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** `native-i2v`: source image / frames dir / audio.wav / optional upscaled frames dir. */
function buildNativeI2VDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const sourceImage = firstMatchLine(stdout, /source image:\s*(\S+)/);
  // The base-generation "N frames: <dir>" line always comes first; the
  // upscale section (if it ran) emits its OWN "N frames: <dir>" line after
  // it — take the first occurrence for the base dir, last for the upscaled one.
  const framesHits = allMatches(stdout, /\d+ frames:\s*(\S+)/);
  const framesDir = framesHits[0] ?? null;
  const upscaledFramesDir = framesHits.length > 1 ? framesHits[framesHits.length - 1] : null;
  const audio = firstMatchLine(stdout, /audio:\s*(\S+)/);
  const mp4 = firstMatchLine(stdout, /\[mp4\] muxed:\s*(\S+)/);
  const dims = parseDims(stdout);
  return {
    ok,
    command: "native-i2v",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: mp4 ?? upscaledFramesDir ?? framesDir,
    extraOutputs: {
      ...(sourceImage ? { sourceImage } : {}),
      ...(framesDir ? { frames: framesDir } : {}),
      ...(audio ? { audio } : {}),
      ...(upscaledFramesDir ? { upscaledFrames: upscaledFramesDir } : {}),
      ...(mp4 ? { mp4 } : {}),
    },
    width: dims.width,
    height: dims.height,
    wallSeconds: parseWallSeconds(stdout),
    gate: null,
    stdout,
  };
}

/** `native-upscale`: upscaled frames dir. */
function buildNativeUpscaleDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const framesDir = lastMatch(stdout, /\d+ frames:\s*(\S+)/);
  const restoredFrames = firstMatchLine(stdout, /\[restoration\]\s*\d+ frames:\s*(\S+)/);
  const mp4 = firstMatchLine(stdout, /\[mp4\] muxed:\s*(\S+)/);
  const dims = parseDims(stdout);
  return {
    ok,
    command: "native-upscale",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: mp4 ?? framesDir,
    extraOutputs: {
      ...(framesDir ? { frames: framesDir } : {}),
      ...(restoredFrames ? { restoredFrames } : {}),
      ...(mp4 ? { mp4 } : {}),
    },
    width: dims.width,
    height: dims.height,
    wallSeconds: parseWallSeconds(stdout),
    gate: null,
    stdout,
  };
}

/** `t2i`: "Wrote <output> — 100% native Swift/MLX, zero run.py calls." */
function buildT2IDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const m = firstMatch(stdout, /^Wrote (\S+) —/);
  const output = m ? m[1]! : null;
  return {
    ok,
    command: "t2i",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output,
    extraOutputs: {},
    width: null,
    height: null,
    wallSeconds: null,
    gate: null,
    stdout,
  };
}

/** `i2v`: production pipeline — output dir + video path + optional gate line. */
function buildI2VDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const outputDir = lastMatch(stdout, /output dir:\s*(\S+)/);
  const video = lastMatch(stdout, /video:\s*(\S+)/);
  const gateMatch = firstMatch(stdout, /gate:\s*(PASS|WARN|FAIL)\s*—\s*(.*)$/);
  return {
    ok,
    command: "i2v",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: video ?? outputDir,
    extraOutputs: outputDir ? { outputDir } : {},
    width: null,
    height: null,
    wallSeconds: parseWallSeconds(stdout),
    gate: gateMatch ? (gateMatch[1] as "PASS" | "WARN" | "FAIL") : null,
    gateResults: gateMatch ? [{ path: video ?? "", status: gateMatch[1]!, reasons: [gateMatch[2]!] }] : undefined,
    stdout,
  };
}

/** `upscale`: "✅ upscaled: <path>" + optional gate line. */
function buildUpscaleDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const output = lastMatch(stdout, /upscaled:\s*(\S+)/);
  const gateMatch = firstMatch(stdout, /gate:\s*(PASS|WARN|FAIL)\s*—\s*(.*)$/);
  return {
    ok,
    command: "upscale",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output,
    extraOutputs: {},
    width: null,
    height: null,
    wallSeconds: null,
    gate: gateMatch ? (gateMatch[1] as "PASS" | "WARN" | "FAIL") : null,
    gateResults: gateMatch && output ? [{ path: output, status: gateMatch[1]!, reasons: [gateMatch[2]!] }] : undefined,
    stdout,
  };
}

/** Worse of two PASS/WARN/FAIL strings (FAIL > WARN > PASS > unknown). */
function worseStatus(a: string | null, b: string | undefined): string | null {
  if (!b) return a;
  const rank = (s: string) => (s === "FAIL" ? 2 : s === "WARN" ? 1 : s === "PASS" ? 0 : -1);
  return a === null || rank(b.toUpperCase()) > rank(a) ? b.toUpperCase() : a;
}

/**
 * Regex-parse GateCommand.swift's human-readable text output (see that
 * file's print() calls) into the same GateEntry[] shape `gate --json` would
 * return. Per-video block:
 *   "✅/⚠️/❌ STATUS  <path>"
 *   "     <reasons joined by '; '>"
 *   "     [<width>x<height> @ ...]"                         (video-only, ignored here)
 *   "     ASR ✅/⚠️/❌ STATUS  <reasons>"                    (only when --asr-prompt given)
 *   "     transcript: <text>"                                (only when --asr-prompt given)
 */
function parseGateTextOutput(stdout: string): GateEntry[] {
  const lines = stdout.split("\n");
  const entries: GateEntry[] = [];
  const headerRe = /^(?:✅|⚠️|❌)\s*(PASS|WARN|FAIL)\s+(\S+)$/;
  const asrRe = /^\s*ASR\s*(?:✅|⚠️|❌)\s*(PASS|WARN|FAIL)\s+(.*)$/;
  const transcriptRe = /^\s*transcript:\s*(.*)$/;
  let current: GateEntry | null = null;
  for (const line of lines) {
    const header = line.match(headerRe);
    if (header) {
      current = { path: header[2]!, status: header[1] as "PASS" | "WARN" | "FAIL" };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const asrMatch = line.match(asrRe);
    if (asrMatch) {
      current.asr = {
        status: asrMatch[1] as "PASS" | "WARN" | "FAIL",
        reasons: asrMatch[2]!.split(";").map((s) => s.trim()).filter(Boolean),
        detectedLang: "",
        transcript: "",
      };
      continue;
    }
    const transcriptMatch = line.match(transcriptRe);
    if (transcriptMatch && current.asr) {
      current.asr.transcript = transcriptMatch[1]!;
      continue;
    }
    // First indented, non-bracketed, non-ASR/transcript line after a header
    // is the video-only reasons line (e.g. "     could not read/probe video"
    // or "     duration too short (0.38s)").
    if (!current.reasons && /^\s{5}\S/.test(line) && !line.trimStart().startsWith("[")) {
      current.reasons = line.trim().split(";").map((s) => s.trim()).filter(Boolean);
    }
  }
  return entries;
}

/** `gate --json`: array of {path, status, reasons, ...}. Falls back to text parsing if --json wasn't set. */
function buildGateDetails(res: InvokeResult, asrPrompt?: string): LtxDetails {
  let entries: GateEntry[] = [];
  try {
    const parsed = JSON.parse(res.stdout) as GateEntry[];
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // Non-JSON text output (caller didn't set json:true) — fall back to
    // regex-parsing the same human-readable verdicts buildI2VDetails/
    // buildUpscaleDetails already parse for their own embedded "gate:" line,
    // instead of silently leaving entries/gate empty on a genuine FAIL
    // (found by s2-agent-ext-ltx-self-improve's review lane, 2026-07-05).
    entries = parseGateTextOutput(res.stdout);
  }
  // If asrPrompt was given, Swift's `try? ASRGate.evaluate(...)` swallows any
  // bridge crash (e.g. mlx_whisper not installed) to `nil`, which just omits
  // the `asr` key entirely — indistinguishable from "asrPrompt not passed" to
  // anything reading only stdout. Since we DO know asrPrompt was requested
  // here, flag entries missing `asr` as a FAIL rather than silently reporting
  // whatever entries[i].status alone says (TODO.md item 15, gap 8/8,
  // 2026-07-04).
  if (asrPrompt) {
    for (const e of entries) {
      if (!e.asr) {
        e.reasons = [...(e.reasons ?? []), "ASR requested (asrPrompt) but no asr result was returned — likely a swallowed Python-bridge crash"];
        e.status = worseStatus(e.status, "FAIL") as "PASS" | "WARN" | "FAIL";
      }
    }
  }
  // Combine each entry's own status with its `asr` sub-check (present only
  // when asrPrompt was given) — the Swift CLI's own `failed`/`strict` logic
  // treats an ASR FAIL/WARN as equally fatal to the video-only verdict, so
  // reporting only entries[i].status here would silently under-report an
  // ASR-only failure as PASS (found by s2-agent-ext-ltx-self-improve's
  // review lane, 2026-07-04).
  const worst = entries.reduce<"PASS" | "WARN" | "FAIL" | null>((acc, e) => {
    const combined = worseStatus(worseStatus(acc, e.status), e.asr?.status);
    return combined as "PASS" | "WARN" | "FAIL" | null;
  }, null);
  return {
    ok: res.exitCode === 0 && !res.aborted,
    command: "gate",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: null,
    extraOutputs: {},
    width: null,
    height: null,
    wallSeconds: null,
    gate: worst,
    gateResults: entries,
    stdout: res.stdout,
  };
}

/** `verify --json`: {mean_overall, worst_overall, frames, pass}. */
function buildVerifyDetails(res: InvokeResult): LtxDetails {
  let parsed: { mean_overall?: number; worst_overall?: number; pass?: boolean } | null = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* text output — verify field left undefined, stdout still human-readable */
  }
  return {
    ok: res.exitCode === 0 && !res.aborted,
    command: "verify",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: null,
    extraOutputs: {},
    width: null,
    height: null,
    wallSeconds: null,
    gate: null,
    verify: parsed
      ? { meanOverall: parsed.mean_overall ?? 0, worstOverall: parsed.worst_overall ?? 0, pass: parsed.pass ?? false }
      : undefined,
    stdout: res.stdout,
  };
}

/** `native-t2a`: "audio: <path>" + wall time, no video at all. */
function buildNativeT2ADetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const audio = firstMatchLine(stdout, /audio:\s*(\S+)/);
  return {
    ok,
    command: "native-t2a",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: audio,
    extraOutputs: {},
    width: null,
    height: null,
    wallSeconds: parseWallSeconds(stdout),
    gate: null,
    stdout,
  };
}

/** `native-relay`: "final: <path>" (concatenated relay.mp4) + per-segment prints + wall time. */
function buildNativeRelayDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const final = firstMatchLine(stdout, /final:\s*(\S+)/);
  const segments = allMatches(stdout, /segment \d+:\s*(\S+)/);
  const dims = parseDims(stdout);
  const extraOutputs: Record<string, string> = {};
  segments.forEach((path, i) => {
    extraOutputs[`segment_${i + 1}`] = path;
  });
  return {
    ok,
    command: "native-relay",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: final,
    extraOutputs,
    width: dims.width,
    height: dims.height,
    wallSeconds: parseWallSeconds(stdout),
    gate: null,
    stdout,
  };
}

/** `native-ingredients`: single reference-image I2V — frames dir / audio.wav / optional mp4. */
function buildNativeIngredientsDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const framesDir = firstMatchLine(stdout, /\d+ frames:\s*(\S+)/);
  const audio = firstMatchLine(stdout, /audio:\s*(\S+)/);
  const mp4 = firstMatchLine(stdout, /\[mp4\] muxed:\s*(\S+)/);
  const dims = parseDims(stdout);
  return {
    ok,
    command: "native-ingredients",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: mp4 ?? framesDir,
    extraOutputs: {
      ...(framesDir ? { frames: framesDir } : {}),
      ...(audio ? { audio } : {}),
      ...(mp4 ? { mp4 } : {}),
    },
    width: dims.width,
    height: dims.height,
    wallSeconds: parseWallSeconds(stdout),
    gate: null,
    stdout,
  };
}

/** `native-restyle`: V2V restyle — frames dir (dims unchanged from input) / optional mp4, no audio. */
function buildNativeRestyleDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const framesDir = firstMatchLine(stdout, /\d+ frames:\s*(\S+)/);
  const mp4 = firstMatchLine(stdout, /\[mp4\] muxed:\s*(\S+)/);
  const dims = parseDims(stdout);
  return {
    ok,
    command: "native-restyle",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: mp4 ?? framesDir,
    extraOutputs: {
      ...(framesDir ? { frames: framesDir } : {}),
      ...(mp4 ? { mp4 } : {}),
    },
    width: dims.width,
    height: dims.height,
    wallSeconds: parseWallSeconds(stdout),
    gate: null,
    stdout,
  };
}

/** `segment`: scene-cut detection — no generation, output is the optional --json report path. */
function buildSegmentDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const dims = firstMatch(stdout, /\[segment\]\s*\d+ frames,\s*(\d+)[×x](\d+)/);
  const jsonReport = firstMatchLine(stdout, /\[segment\] JSON report:\s*(\S+)/);
  const scenes: SceneEntry[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/Scene (\d+): frames (\d+)-(\d+) \((\d+) frames, ([\d.]+)s\)/);
    if (m) {
      scenes.push({
        sceneNum: Number(m[1]),
        startFrame: Number(m[2]),
        endFrame: Number(m[3]),
        frames: Number(m[4]),
        durationSec: Number(m[5]),
      });
    }
  }
  return {
    ok,
    command: "segment",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: jsonReport,
    extraOutputs: {},
    width: dims ? Number(dims[1]) : null,
    height: dims ? Number(dims[2]) : null,
    wallSeconds: null,
    gate: null,
    scenes,
    stdout,
  };
}

/** `audio-decode` / `video-decode`: "Wrote ... to <path> — 100% native Swift/MLX...". */
function buildDecodeDetails(command: "audio-decode" | "video-decode", res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const m = firstMatch(stdout, /Wrote .* to (\S+) —/);
  const output = m ? m[1]! : null;
  return {
    ok,
    command,
    exitCode: res.exitCode,
    aborted: res.aborted,
    output,
    extraOutputs: {},
    width: null,
    height: null,
    wallSeconds: null,
    gate: null,
    stdout,
  };
}

/** `models` and any other read-only text command: just the stdout. */
function buildTextDetails(command: string, res: InvokeResult): LtxDetails {
  return {
    ok: res.exitCode === 0 && !res.aborted,
    command,
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: null,
    extraOutputs: {},
    width: null,
    height: null,
    wallSeconds: null,
    gate: null,
    stdout: res.stdout + (res.stderr ? `\n${res.stderr}` : ""),
  };
}

/** Dispatch to the right per-command parser. `options` is the original per-command input (only `gate` reads it, for `asrPrompt`). */
export function buildDetails(command: string, res: InvokeResult, options?: Record<string, unknown>): LtxDetails {
  switch (command) {
    case "native-i2v":
      return buildNativeI2VDetails(res);
    case "native-upscale":
      return buildNativeUpscaleDetails(res);
    case "native-t2a":
      return buildNativeT2ADetails(res);
    case "native-relay":
      return buildNativeRelayDetails(res);
    case "native-ingredients":
      return buildNativeIngredientsDetails(res);
    case "native-restyle":
      return buildNativeRestyleDetails(res);
    case "segment":
      return buildSegmentDetails(res);
    case "t2i":
      return buildT2IDetails(res);
    case "i2v":
      return buildI2VDetails(res);
    case "upscale":
      return buildUpscaleDetails(res);
    case "gate":
      return buildGateDetails(res, typeof options?.asrPrompt === "string" ? options.asrPrompt : undefined);
    case "verify":
      return buildVerifyDetails(res);
    case "audio-decode":
      return buildDecodeDetails("audio-decode", res);
    case "video-decode":
      return buildDecodeDetails("video-decode", res);
    default:
      return buildTextDetails(command, res);
  }
}

/** One-line human summary for the text content field. */
export function summarize(d: LtxDetails): string {
  if (d.aborted) return `${d.command} aborted (exit ${d.exitCode}).`;
  // `gate` (and `verify`) exit non-zero WHEN THEY FIND A REAL FAILURE — that's
  // the expected, informative case, not a crash — so their structured result
  // must be shown even when `!d.ok`, ahead of the generic failure fallback
  // below (which used to swallow gate's own ASR reasons behind a useless
  // "gate FAILED (exit 1)" + raw stdout tail; found by
  // s2-agent-ext-ltx-self-improve's review lane, 2026-07-04).
  if (d.command === "gate") {
    const lines = (d.gateResults ?? []).map((g) => {
      const base = `${g.status}  ${g.path}${g.reasons?.length ? `  — ${g.reasons.join("; ")}` : ""}`;
      const asr = (g as GateEntry).asr;
      return asr ? `${base}\n  ASR ${asr.status} (${asr.detectedLang})${asr.reasons?.length ? `  — ${asr.reasons.join("; ")}` : ""}` : base;
    });
    return lines.length ? lines.join("\n") : d.stdout.trim().split("\n").slice(0, 30).join("\n");
  }
  if (!d.ok) {
    const tail = d.stdout.trim().split("\n").slice(-8).join("\n");
    return `${d.command} FAILED (exit ${d.exitCode}).\n${tail}`;
  }
  if (d.command === "verify" && d.verify) {
    return `verify: mean=${d.verify.meanOverall.toFixed(1)} worst=${d.verify.worstOverall.toFixed(1)} ${d.verify.pass ? "PASS" : "FAIL"}`;
  }
  if (d.command === "models") {
    return `models ok:\n${d.stdout.trim().split("\n").slice(0, 30).join("\n")}`;
  }
  if (d.command === "segment" && d.scenes) {
    const list = d.scenes
      .map((s) => `  Scene ${s.sceneNum}: frames ${s.startFrame}-${s.endFrame} (${s.frames} frames, ${s.durationSec}s)`)
      .join("\n");
    return `segment: ${d.scenes.length} scene(s) detected${d.output ? ` (report: ${d.output})` : ""}\n${list}`;
  }
  const dims = d.width && d.height ? ` ${d.width}x${d.height}` : "";
  const gateStr = d.gate ? ` gate ${d.gate}` : "";
  const wallStr = d.wallSeconds ? ` ${d.wallSeconds.toFixed(1)}s` : "";
  const extras = Object.entries(d.extraOutputs)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `${d.command} ok -> ${d.output ?? "(no output)"}${dims}${gateStr}${wallStr}${extras ? `  [${extras}]` : ""}`
    .replace(/  +/g, " ")
    .trim();
}

/** Summarize a non-ok run's stderr tail for the error-content fallback. */
export function stderrTail(res: InvokeResult, n = 12): string {
  const src = (res.stderr || res.output || "").trim();
  return src.split("\n").slice(-n).join("\n");
}
