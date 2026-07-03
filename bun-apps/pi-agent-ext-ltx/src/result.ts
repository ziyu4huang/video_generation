/**
 * result.ts — turn an ltx-video run into structured, agent-consumable
 * `details`. Unlike pi-agent-ext-flux2 (which parses a `.manifest.json`
 * sidecar), ltx-video writes NO sidecar files — every command's real output
 * lives only in its stdout, in a fixed-but-per-command format (see each
 * <Cmd>Command.swift's print() calls). This module regex-parses those known
 * formats. `gate --json` / `verify --json` are the two commands with real
 * structured output; everything else is parsed from human-readable prints.
 */
import { existsSync, statSync } from "node:fs";
import type { InvokeResult } from "./invoke.ts";

export interface GateEntry {
  path: string;
  status: "PASS" | "WARN" | "FAIL" | string;
  reasons?: string[];
  [key: string]: unknown;
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
  /** Raw stdout, always present, truncated in `summarize()` but kept whole here. */
  stdout: string;
}

/** Path on the LAST stdout line matching `re` (walks from the end). */
function lastMatch(stdout: string, re: RegExp): string | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(re);
    if (m) return m[1];
  }
  return null;
}

/** Path on the FIRST stdout line matching `re`. */
function firstMatchLine(stdout: string, re: RegExp): string | null {
  for (const line of stdout.split("\n")) {
    const m = line.match(re);
    if (m) return m[1];
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
    .map((m) => m[1]);
}

function parseWallSeconds(stdout: string): number | null {
  // "✅ wall time: 587.7s" (native-i2v/native-upscale) or "wall time: 587.7s" (i2v).
  // No line-start anchor: the ✅ prefix is not whitespace.
  const m = firstMatch(stdout, /wall time:\s*([\d.]+)s/);
  return m ? Number(m[1]) : null;
}

function parseDims(stdout: string): { width: number | null; height: number | null } {
  // Prefer an explicit "AxB -> CxD" transition (native-upscale/native-i2v's
  // upscale section) — the OUTPUT (post-arrow) dims are what matters. Falls
  // back to the first standalone "WxH" occurrence (native-i2v's initial
  // "9 frames @ 24.0fps, 640x960" line, no arrow).
  const arrow = firstMatch(stdout, /\d+x\d+\s*->\s*(\d+)x(\d+)/);
  if (arrow) return { width: Number(arrow[1]), height: Number(arrow[2]) };
  const m = firstMatch(stdout, /(\d+)x(\d+)(?:\s*$|,|\))/);
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
  const dims = parseDims(stdout);
  return {
    ok,
    command: "native-i2v",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: upscaledFramesDir ?? framesDir,
    extraOutputs: {
      ...(sourceImage ? { sourceImage } : {}),
      ...(framesDir ? { frames: framesDir } : {}),
      ...(audio ? { audio } : {}),
      ...(upscaledFramesDir ? { upscaledFrames: upscaledFramesDir } : {}),
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
  const dims = parseDims(stdout);
  return {
    ok,
    command: "native-upscale",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: framesDir,
    extraOutputs: framesDir ? { frames: framesDir } : {},
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
  const output = m ? m[1] : null;
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
    gateResults: gateMatch ? [{ path: video ?? "", status: gateMatch[1], reasons: [gateMatch[2]] }] : undefined,
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
    gateResults: gateMatch && output ? [{ path: output, status: gateMatch[1], reasons: [gateMatch[2]] }] : undefined,
    stdout,
  };
}

/** `gate --json`: array of {path, status, reasons, ...}. Falls back to text parsing if --json wasn't set. */
function buildGateDetails(res: InvokeResult): LtxDetails {
  let entries: GateEntry[] = [];
  try {
    const parsed = JSON.parse(res.stdout) as GateEntry[];
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    /* non-JSON text output — leave empty, stdout still carries the human-readable verdicts */
  }
  const worst = entries.reduce<"PASS" | "WARN" | "FAIL" | null>((acc, e) => {
    const s = String(e.status).toUpperCase();
    if (s === "FAIL") return "FAIL";
    if (s === "WARN" && acc !== "FAIL") return "WARN";
    if (s === "PASS" && acc === null) return "PASS";
    return acc;
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

/** `audio-decode` / `video-decode`: "Wrote ... to <path> — 100% native Swift/MLX...". */
function buildDecodeDetails(command: "audio-decode" | "video-decode", res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const m = firstMatch(stdout, /Wrote .* to (\S+) —/);
  const output = m ? m[1] : null;
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

/** Dispatch to the right per-command parser. */
export function buildDetails(command: string, res: InvokeResult): LtxDetails {
  switch (command) {
    case "native-i2v":
      return buildNativeI2VDetails(res);
    case "native-upscale":
      return buildNativeUpscaleDetails(res);
    case "t2i":
      return buildT2IDetails(res);
    case "i2v":
      return buildI2VDetails(res);
    case "upscale":
      return buildUpscaleDetails(res);
    case "gate":
      return buildGateDetails(res);
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
  if (!d.ok) {
    const tail = d.stdout.trim().split("\n").slice(-8).join("\n");
    return `${d.command} FAILED (exit ${d.exitCode}).\n${tail}`;
  }
  if (d.command === "gate") {
    const lines = (d.gateResults ?? []).map(
      (g) => `${g.status}  ${g.path}${g.reasons?.length ? `  — ${g.reasons.join("; ")}` : ""}`,
    );
    return lines.length ? lines.join("\n") : d.stdout.trim().split("\n").slice(0, 30).join("\n");
  }
  if (d.command === "verify" && d.verify) {
    return `verify: mean=${d.verify.meanOverall.toFixed(1)} worst=${d.verify.worstOverall.toFixed(1)} ${d.verify.pass ? "PASS" : "FAIL"}`;
  }
  if (d.command === "models") {
    return `models ok:\n${d.stdout.trim().split("\n").slice(0, 30).join("\n")}`;
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

// Kept referenced for future output-size enrichment (mirrors flux2's outputs[].sizeBytes).
export function fileSizeOrNull(path: string | null): number | null {
  if (!path || !existsSync(path)) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
