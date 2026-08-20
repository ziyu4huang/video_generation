/**
 * result.ts — turn a flux2 run into structured, agent-consumable `details`.
 *
 * For image-producing commands we parse the newest `.manifest.json` sidecar in
 * the output dir (snake_case keys — see Manifest.swift) and additionally run
 * `flux2 gate --json` on the primary output so every generation returns its
 * quality verdict first-class. For gate/models we parse the native JSON/text.
 *
 * The text content is a one-line summary with the output path first-class, so
 * the agent can chain scene → gate → upscale by reusing the returned path.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { invokeFlux2, type InvokeResult } from "./invoke.ts";
import type { ScenePipelineResult } from "./scenePipeline.ts";

export interface OutputFile {
  path: string;
  seed: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

export interface PerfInfo {
  steps: number | null;
  totalSeconds: number | null;
  avgItPerSec: number | null;
  peakMemoryMB: number | null;
}

export interface GateEntry {
  path: string;
  status: "PASS" | "WARN" | "FAIL" | string;
  reason?: string;
}

export interface Flux2Details {
  ok: boolean;
  command: string;
  exitCode: number;
  aborted: boolean;
  /** Primary output path (first-class, for chaining). null for non-image commands. */
  output: string | null;
  outputs: OutputFile[];
  seed: number | null;
  width: number | null;
  height: number | null;
  gate: "PASS" | "WARN" | "FAIL" | null;
  perf: PerfInfo;
  manifestPath: string | null;
  runJsonPath: string | null;
  /** Gate results when the command is `gate` (array) or post-run gate (primary only). */
  gateResults?: GateEntry[];
  /** Raw stdout for read-only commands (models). */
  stdout?: string;
  /** Present when `scene` was run with a multi-seed pipeline (see scenePipeline.ts). */
  scenePipeline?: ScenePipelineResult;
}

// ─── Manifest parsing ────────────────────────────────────────────────────────

interface RawManifest {
  status?: string;
  output_files?: Array<{ path: string; seed: number; size_bytes: number; width: number; height: number }>;
  perf?: {
    steps?: number;
    total_seconds?: number;
    avg_it_per_sec?: number;
    peak_memory_mb?: number;
  };
  // generation commands record wall time under timings.generation (no `perf`
  // block); elapsed_seconds is only the manifest-write overhead (~0). Prefer
  // the longest timing entry as the run's total when perf is absent.
  timings?: Record<string, number>;
  elapsed_seconds?: number;
  memory_peak_mb?: number;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Resolve the output dir from args (--output-dir or --output) or fall back. */
function outputDirFromArgs(args: string[], fallback: string): string {
  const odIdx = args.indexOf("--output-dir");
  const odVal = args[odIdx + 1];
  if (odIdx >= 0 && odVal) return resolve(odVal);
  const outIdx = args.indexOf("--output");
  const outVal = args[outIdx + 1];
  if (outIdx >= 0 && outVal) return dirname(resolve(outVal));
  return fallback;
}

/** Run `flux2 gate --json <img>` to get a verdict for a generated image. */
async function gateImage(bin: string, img: string): Promise<GateEntry | null> {
  // flux2 gate needs a path it can open; run from the image's own dir.
  const cwd = existsSync(img) ? dirname(img) : process.cwd();
  const res = await invokeFlux2({ bin, args: ["gate", "--json", img], cwd });
  if (!res.stdout.trim()) return null;
  try {
    const arr = JSON.parse(res.stdout) as GateEntry[];
    return arr[0] ?? null;
  } catch {
    return null;
  }
}

/** flux2 writes output_files[].path as a bare basename; resolve it to absolute. */
function resolveOutput(base: string, outputDir: string): string {
  return base.startsWith("/") ? base : resolve(outputDir, base);
}

/**
 * Every single-image flux2 command prints the absolute output path on its own
 * line (right after the `✅ <verb> <name>.png` line):
 *     ✅ upscaled ups_out.png
 *        /abs/.../ups_out.png
 * This is the ONLY reliable source of the output path — upscale writes no
 * .manifest.json, and matching "newest manifest" collides with prior runs.
 * Returns the LAST absolute image path found on its own line.
 */
function parseOutputPathFromStdout(stdout: string): string | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(/^\s*(\/[^\s]+\.(?:png|jpg|jpeg|webp))\s*$/i);
    if (m) return m[1] ?? null;
  }
  return null;
}

interface RawRunJson {
  width?: number;
  height?: number;
  seed?: number;
}

// ─── Builders ────────────────────────────────────────────────────────────────

/** Build details for an image-producing command from stdout + manifest/run.json. */
export async function buildImageDetails(
  command: string,
  res: InvokeResult,
  bin: string,
  args: string[],
  outputDirFallback: string,
): Promise<Flux2Details> {
  const ok = res.exitCode === 0 && !res.aborted;
  const dir = outputDirFromArgs(args, outputDirFallback);

  // PRIMARY truth: the absolute output path flux2 prints. Works for every
  // single-image command (t2i/scene/edit/style/angle/swap/expand/upscale).
  const primary = ok ? parseOutputPathFromStdout(res.stdout) : null;

  // Match sidecars by the output's basename (NOT "newest in dir", which can
  // collide with a prior run's manifest). upscale has no manifest → null.
  let manifestPath: string | null = null;
  let runJsonPath: string | null = null;
  if (primary) {
    const base = basename(primary).replace(/\.[^.]+$/, "");
    const mp = join(dir, `${base}.manifest.json`);
    const rp = join(dir, `${base}.run.json`);
    if (existsSync(mp)) manifestPath = mp;
    if (existsSync(rp)) runJsonPath = rp;
  }
  const manifest = manifestPath ? readJson<RawManifest>(manifestPath) : null;
  const runJson = runJsonPath ? readJson<RawRunJson>(runJsonPath) : null;

  // Build outputs[]: prefer manifest's parsed list (resolved to absolute); else
  // synthesize a single entry from the stdout path + run.json dims.
  let outputs: OutputFile[];
  if (manifest?.output_files?.length) {
    outputs = manifest.output_files.map((o) => ({
      path: resolveOutput(o.path, dir),
      seed: o.seed,
      width: o.width,
      height: o.height,
      sizeBytes: o.size_bytes,
    }));
  } else if (primary) {
    outputs = [
      {
        path: primary,
        seed: runJson?.seed ?? null,
        width: runJson?.width ?? null,
        height: runJson?.height ?? null,
        sizeBytes: existsSync(primary) ? statSync(primary).size : null,
      },
    ];
  } else {
    outputs = [];
  }

  let gate: "PASS" | "WARN" | "FAIL" | null = null;
  let gateResults: GateEntry[] | undefined;
  if (ok && primary && existsSync(primary)) {
    const g = await gateImage(bin, primary);
    if (g) {
      gateResults = [g];
      const s = g.status.toUpperCase();
      if (s === "PASS" || s === "WARN" || s === "FAIL") gate = s;
    }
  }

  // Total time: prefer the explicit generation timing, then the longest timing
  // entry, then perf.total_seconds. elapsed_seconds is manifest-write overhead
  // (~0) and must NOT be used as the run time.
  const timings = manifest?.timings ?? {};
  const maxTiming = Object.values(timings).reduce((m, v) => (typeof v === "number" && v > m ? v : m), 0);
  const totalSeconds =
    timings.generation ?? (maxTiming > 0 ? maxTiming : null) ?? manifest?.perf?.total_seconds ?? null;

  // Dims: manifest output_files first (most accurate), then run.json (upscale).
  const w = outputs[0]?.width ?? runJson?.width ?? null;
  const h = outputs[0]?.height ?? runJson?.height ?? null;

  return {
    ok,
    command,
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: primary,
    outputs,
    seed: outputs[0]?.seed ?? runJson?.seed ?? null,
    width: w,
    height: h,
    gate,
    perf: {
      steps: manifest?.perf?.steps ?? null,
      totalSeconds,
      avgItPerSec: manifest?.perf?.avg_it_per_sec ?? null,
      peakMemoryMB: manifest?.perf?.peak_memory_mb ?? manifest?.memory_peak_mb ?? null,
    },
    manifestPath,
    runJsonPath,
    gateResults,
  };
}

/** Build details for the `gate` command (parse its JSON stdout). */
export function buildGateDetails(res: InvokeResult): Flux2Details {
  let entries: GateEntry[] = [];
  try {
    const parsed = JSON.parse(res.stdout) as GateEntry[];
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    /* non-JSON (e.g. --json not set) — leave empty */
  }
  const worst = entries.reduce<"PASS" | "WARN" | "FAIL" | null>((acc, e) => {
    const s = e.status.toUpperCase();
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
    outputs: [],
    seed: null,
    width: null,
    height: null,
    gate: worst,
    perf: { steps: null, totalSeconds: null, avgItPerSec: null, peakMemoryMB: null },
    manifestPath: null,
    runJsonPath: null,
    gateResults: entries,
    stdout: res.stdout,
  };
}

/** Build details for read-only text commands (models, verify-*). */
export function buildTextDetails(command: string, res: InvokeResult): Flux2Details {
  return {
    ok: res.exitCode === 0 && !res.aborted,
    command,
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: null,
    outputs: [],
    seed: null,
    width: null,
    height: null,
    gate: null,
    perf: { steps: null, totalSeconds: null, avgItPerSec: null, peakMemoryMB: null },
    manifestPath: null,
    runJsonPath: null,
    stdout: res.stdout + (res.stderr ? `\n${res.stderr}` : ""),
  };
}

/**
 * Build details for a multi-seed scene pipeline result. Extracted as a pure
 * function (no I/O) specifically so this fallback logic is directly unit
 * testable — the `gate` field's fallback previously lived inline in index.ts
 * and had a real bug (checked `handRepair` object truthiness instead of its
 * `.output`) that shipped for two runs before a fresh review caught it.
 */
export function buildScenePipelineDetails(command: string, pipeline: ScenePipelineResult): Flux2Details {
  const finalOutput = pipeline.handRepair?.output ?? pipeline.winnerOutput;
  return {
    ok: pipeline.winnerOutput != null,
    command,
    exitCode: pipeline.winnerOutput != null ? 0 : 1,
    aborted: false,
    output: finalOutput,
    outputs: finalOutput
      ? [{ path: finalOutput, seed: pipeline.winnerSeed, width: null, height: null, sizeBytes: null }]
      : [],
    seed: pipeline.winnerSeed,
    width: null,
    height: null,
    // `gate` MUST describe whichever image `finalOutput` actually points at.
    // Checking `pipeline.handRepair` truthiness (rather than its `.output`)
    // is wrong: a hand-repair that throws sets handRepair = {output:null,
    // gate:null} — a truthy object — so `finalOutput` correctly falls back to
    // the pre-repair winner image, but a naive truthiness check on
    // `handRepair` itself would leave `gate` forced to null instead of also
    // falling back to that winner's known gate.
    gate: pipeline.handRepair?.output != null ? pipeline.handRepair.gate : pipeline.winnerGate,
    perf: { steps: null, totalSeconds: null, avgItPerSec: null, peakMemoryMB: null },
    manifestPath: null,
    runJsonPath: null,
    scenePipeline: pipeline,
  };
}

/** One-line human summary for the text content field. */
export function summarize(d: Flux2Details): string {
  if (d.aborted) return `${d.command} aborted (exit ${d.exitCode}).`;
  if (!d.ok) {
    const tail = (d.stdout ?? "").trim().split("\n").slice(-6).join("\n");
    return `${d.command} FAILED (exit ${d.exitCode}).\n${tail}`;
  }
  if (d.command === "gate") {
    const lines = (d.gateResults ?? []).map(
      (g) => `${g.status}  ${g.path}${g.reason ? `  — ${g.reason}` : ""}`,
    );
    return lines.length ? lines.join("\n") : "gate ok (no results).";
  }
  if (d.command === "models" || d.stdout != null) {
    const head = (d.stdout ?? "").trim().split("\n").slice(0, 30).join("\n");
    return `${d.command} ok:\n${head}`;
  }
  if (d.scenePipeline) {
    const p = d.scenePipeline;
    const lines = p.candidates.map(
      (c) =>
        `  seed ${c.seed}: ${c.ok ? (c.gate ?? "?") : "RUN-FAILED"}` +
        (c.vlmReply ? ` — ${c.matched ? "MATCH" : "no-match"}: ${c.vlmReply.slice(0, 80)}` : "") +
        (c.seed === p.winnerSeed ? "  ← winner" : ""),
    );
    const winnerLine = p.winnerOutput
      ? `winner: seed ${p.winnerSeed} (${p.winnerReason}) → ${p.handRepair?.output ?? p.winnerOutput}`
      : "winner: none (every candidate failed)";
    return `scene pipeline (${p.candidates.length} seeds):\n${lines.join("\n")}\n${winnerLine}`;
  }
  const dims = d.width && d.height ? `${d.width}×${d.height}` : "";
  const gateStr = d.gate ? ` gate ${d.gate}` : "";
  const perfStr = d.perf.totalSeconds ? ` ${d.perf.totalSeconds.toFixed(1)}s` : "";
  const seedStr = d.seed != null ? ` seed ${d.seed}` : "";
  return `${d.command} ok → ${d.output ?? "(no output)"}  ${dims}${seedStr}${gateStr}${perfStr}`.replace(/  +/g, "  ").trim();
}

/** Summarize a non-ok run's stderr tail for the error-content fallback. */
export function stderrTail(res: InvokeResult, n = 12): string {
  const src = (res.stderr || res.output || "").trim();
  return src.split("\n").slice(-n).join("\n");
}

// Keep `basename` referenced for potential path-shortening in summaries.
void basename;
