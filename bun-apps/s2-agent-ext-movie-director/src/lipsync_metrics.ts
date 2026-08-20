/**
 * lipsync_metrics.ts — the `ltx-video lipsync-metrics` adapter (mouth-motion
 * vs. audio-loudness correlation for a talking-head video).
 *
 * Pure Swift (Vision + AVFoundation), no Python — see
 * swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift and
 * .planning/specs/2026-07-25-swift-lipsync-metrics-design.md. This
 * module replaces the prior `python -m app.lipsync_metrics` adapter
 * (formerly runpy_lipsync.ts) — same interface, different binary.
 *
 * Unlike runpy_tts's best-effort posture (which protects an already-succeeded
 * generation), evaluation IS the point here — callers get a real {ok, error}
 * on any failure, nothing is swallowed at this layer.
 *
 * This module returns a flat `{ok, metrics, error, stderrTail}` instead of the
 * sibling `{details, summary, stderrTail}` shape because there's no multi-field
 * "details" worth summarizing — `metrics` IS the whole payload, and `error`
 * already carries the exit code inline for the (rare) transport-failure case.
 */
import { ensureBinary } from "@repo/s2-agent-ext-ltx";

export interface LipsyncMetrics {
  verdict: string;
  pearson_r?: number | null;
  mouth_ratio_std?: number | null;
  caveat?: string;
  /** Human-readable reason, present on no_face/no_audio verdicts (and sometimes others). */
  note?: string;
}

export interface RunPyLipsyncInput {
  videoPath: string;
  signal?: AbortSignal;
  /**
   * Test seam: inject a canned spawn result so unit tests can drive
   * runPyLipsync without a built ltx-video binary. The real path resolves
   * (building if needed) the ltx-video Swift binary and spawns
   * `ltx-video lipsync-metrics <videoPath> --json`.
   */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface RunPyLipsyncOutput {
  ok: boolean;
  metrics: LipsyncMetrics | null;
  error: string | null;
  stderrTail: string;
}

/** Build the argv for `ltx-video lipsync-metrics <videoPath> --json`. */
export function buildLipsyncArgs(videoPath: string): string[] {
  return ["lipsync-metrics", videoPath, "--json"];
}

async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bin = await ensureBinary();
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Run `ltx-video lipsync-metrics <videoPath> --json` and parse its JSON stdout. */
export async function runPyLipsync(input: RunPyLipsyncInput): Promise<RunPyLipsyncOutput> {
  const args = buildLipsyncArgs(input.videoPath);
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, metrics: null, error: `lipsync-metrics spawn failed: ${msg}`, stderrTail: "" };
  }

  const stderrTail = res.stderr.slice(-2000);
  if (res.exitCode !== 0) {
    return { ok: false, metrics: null, error: `lipsync-metrics exited ${res.exitCode}`, stderrTail };
  }

  try {
    const metrics = JSON.parse(res.stdout) as LipsyncMetrics;
    return { ok: true, metrics, error: null, stderrTail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, metrics: null, error: `lipsync-metrics produced non-JSON stdout: ${msg}`, stderrTail };
  }
}
