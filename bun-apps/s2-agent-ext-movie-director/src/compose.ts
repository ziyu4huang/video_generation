/**
 * compose.ts — the compose stage foundation (movie-director iteration 4).
 *
 * Turns an `edit_decisions` artifact into a real .mp4 by trimming each cut to
 * its [in_seconds, out_seconds] window and concatenating them in order — the
 * foundation that any composer (Remotion, AVFoundation, ffmpeg) builds on. This
 * iteration uses ffmpeg directly (no transitions/overlays/animations — those are
 * the templated-composer tier; this is the straight-cut concat that's already
 * useful for animatics and rough cuts).
 *
 * final_review runs the 6 delivery checks on the rendered mp4 (ffprobe container
 * validity, duration>0, video stream present, audio stream present, volumedetect
 * mean/peak, mid-point frame extractable). A `fail` verdict means the render is
 * not shippable.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { burnCaptions, planBurn, type CaptionOutcome } from "./captions.ts";
import { probeMedia, type ProbeResult } from "./ffprobe.ts";
import { runSpawn, type SpawnImpl } from "./spawn.ts";

// ─── edit_decisions / render_report shapes (subset of the JSON schemas) ──────

export interface EditCut {
  id: string;
  source: string; // file path (this foundation) or asset-manifest id
  in_seconds: number;
  out_seconds: number;
  speed?: number;
}

export interface EditDecisions {
  version: string;
  cuts: EditCut[];
  render_runtime?: string;
}

export interface RenderOutput {
  path: string;
  format: string;
  codec?: string;
  audio_codec?: string;
  resolution?: string;
  fps?: number;
  duration_seconds: number;
  file_size_bytes?: number;
}

export interface RenderReport {
  version: string;
  outputs: RenderOutput[];
  render_time_seconds?: number;
  warnings: string[];
  verification_notes: string[];
  render_grammar?: string;
}

export interface ComposeDeps {
  /** Inject a spawn impl (tests mock ffmpeg). Defaults to real child_process.spawn. */
  spawnImpl?: SpawnImpl;
}

/**
 * Build a RenderOutput from a rendered file's ffprobe result. Shared by all
 * three compose tiers (compose.ts / compose_motion.ts / remotion.ts) — each
 * previously hand-rolled this identical block at the end of its render
 * function (tool-design audit, output/next-goal-20260712_142905.md, Item 2).
 */
export function buildRenderOutput(path: string, probe: ProbeResult): RenderOutput {
  return {
    path: resolve(path),
    format: probe.format || "mp4",
    codec: probe.videoCodec,
    audio_codec: probe.audioCodec,
    resolution: probe.resolution,
    fps: probe.fps,
    duration_seconds: probe.duration,
    file_size_bytes: existsSync(path) ? statSync(path).size : undefined,
  };
}

/** ffmpeg availability (cached). */
let ffmpegCached: boolean | undefined;
export function ffmpegAvailable(): boolean {
  if (ffmpegCached == null) {
    try {
      const p = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
      ffmpegCached = p.pid != null;
    } catch {
      ffmpegCached = false;
    }
  }
  return ffmpegCached;
}
export function _setFfmpegAvailableForTest(v: boolean | undefined): void {
  ffmpegCached = v;
}

// The captions filter probes + burn ladder live in `captions.ts` (shared with
// compose_motion.ts). Re-exported here so existing compose.test.ts imports
// (`_setSubtitlesFilterForTest`) keep resolving, and so callers that knew
// compose.ts as the captions owner still see the API surface.
export {
  subtitlesFilterAvailable,
  _setSubtitlesFilterForTest,
  drawtextFilterAvailable,
  _setDrawtextFilterForTest,
  resolveCaptionFont,
  _setCaptionFontForTest,
  parseSrt,
} from "./captions.ts";

// ─── compose ─────────────────────────────────────────────────────────────────

export interface ComposeOptions {
  /** Working dir for intermediate trimmed clips + the final output. */
  workDir: string;
  /** Output mp4 path (absolute). Defaults to <workDir>/compose_<ts>.mp4. */
  output?: string;
  /** Target resolution WxH (all clips scaled to fit). Default: no re-scale. */
  resolution?: string;
  /** Target fps. Default: inherit. */
  fps?: number;
  /** Optional captions sourced from the whisper transcript (subtitle_gen SRT). */
  captions?: CaptionsOptions;
}

export interface CaptionsOptions {
  /** Path to an SRT (or VTT) file. */
  srtPath: string;
  /**
   * true  → hard-burn the subtitles into the video (re-encode, always visible).
   * false → embed as a soft subtitle stream (mov_text; viewer-toggleable).
   * Default: true (the animated-explainer captions primitive).
   */
  burn?: boolean;
  /**
   * Video frame width (px). Used only by the drawtext tier to word-wrap long cues
   * so they don't overflow frame width. Default 1920. (libass wraps itself; the
   * sidecar tier is unaffected.)
   */
  width?: number;
  /** drawtext font size (px). Default 48 (matches the burn ladder's fixed size). */
  fontsize?: number;
}

/**
 * Compose an mp4 from edit_decisions: trim each cut → concat. Returns a
 * render_report (validated against data/schemas/artifacts/render_report.schema.json
 * by the caller's validate-artifact command). This is the straight-cut foundation;
 * transitions/overlays/ken-burns are the templated-composer tier (not here).
 */
export async function composeVideo(edit: EditDecisions, opts: ComposeOptions, deps: ComposeDeps = {}): Promise<RenderReport> {
  const warnings: string[] = [];
  const notes: string[] = [];
  if (!edit.cuts || edit.cuts.length === 0) {
    return { version: "1.0", outputs: [], warnings: ["edit_decisions has no cuts"], verification_notes: ["compose skipped: empty cut list"] };
  }
  if (!ffmpegAvailable()) {
    return { version: "1.0", outputs: [], warnings: ["ffmpeg not found on PATH"], verification_notes: ["compose failed: ffmpeg unavailable"] };
  }
  const run = deps.spawnImpl ?? runSpawn;
  const t0 = Date.now();

  // Resolve sources; warn (don't crash) on missing files — drop them from the cut list.
  const valid = edit.cuts.filter((c) => {
    if (existsSync(c.source)) return true;
    warnings.push(`cut "${c.id}" source missing: ${c.source}`);
    return false;
  });
  if (valid.length === 0) {
    return { version: "1.0", outputs: [], warnings, verification_notes: ["compose failed: no cut sources existed"] };
  }

  // 1. Trim each cut to its own normalized mp4 (re-encode for safe concat — streams
  //    from different sources rarely share codec/timestamps, so the concat filter
  //    is more robust than the demuxer here).
  const trimmed: string[] = [];
  for (const c of valid) {
    const seg = join(opts.workDir, `cut_${c.id}.mp4`);
    const duration = Math.max(0, c.out_seconds - c.in_seconds);
    const argv = ["-y", "-ss", String(c.in_seconds), "-i", c.source, "-t", String(duration)];
    const vf: string[] = [];
    if (opts.resolution) vf.push(`scale=${opts.resolution}:force_original_aspect_ratio=decrease`, "pad=ceil(iw/2)*2:ceil(ih/2)*2");
    if (opts.fps) vf.push(`fps=${opts.fps}`);
    if (vf.length) argv.push("-vf", vf.join(","));
    argv.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-r", String(opts.fps ?? 30), seg);
    const r = await run("ffmpeg", argv);
    if (r.code !== 0 || !existsSync(seg)) {
      warnings.push(`cut "${c.id}" trim failed (exit ${r.code})`);
    } else {
      trimmed.push(seg);
    }
  }
  if (trimmed.length === 0) {
    return { version: "1.0", outputs: [], warnings, verification_notes: ["compose failed: every cut trim failed"] };
  }

  // 2. Concat the trimmed segments.
  const output = opts.output ?? join(opts.workDir, `compose_${Math.floor(Date.now() / 1000)}.mp4`);
  const filter = trimmed.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("") + `concat=n=${trimmed.length}:v=1:a=1[v][a]`;
  const argv = ["-y"];
  for (const seg of trimmed) argv.push("-i", seg);
  argv.push("-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", output);
  const r = await run("ffmpeg", argv);
  if (r.code !== 0 || !existsSync(output)) {
    return { version: "1.0", outputs: [], warnings: [...warnings, `concat failed (exit ${r.code})`], verification_notes: [`compose failed: ${r.stderr.slice(-400)}`] };
  }

  // 2b. Optional captions pass: burn or sidecar the SRT onto the concat output
  //     via the shared libass → drawtext → sidecar ladder (src/captions.ts). The
  //     SRT typically comes from subtitle_gen consuming the whisper adapter's
  //     word timestamps. On macOS stock ffmpeg (no libass) the ladder reaches
  //     drawtext, which hard-burns plain text WITHOUT libass — the fix for the
  //     "captions always soft on macOS" defect.
  let finalOutput = output;
  if (opts.captions) {
    const wantBurn = opts.captions.burn !== false;
    const srtExists = existsSync(opts.captions.srtPath);
    const plan = planBurn(wantBurn, srtExists);
    if (plan.outcome === "skip") {
      warnings.push(`captions srt not found: ${opts.captions.srtPath}`);
    } else {
      if (plan.warning) warnings.push(plan.warning);
      const captioned = join(opts.workDir, `captioned_${Math.floor(Date.now() / 1000)}.mp4`);
      const burn = await burnCaptions(output, opts.captions.srtPath, captioned, wantBurn, { spawnImpl: run, width: opts.captions.width, fontsize: opts.captions.fontsize });
      if (burn.ok && existsSync(captioned)) {
        finalOutput = captioned;
        notes.push(captionNote(burn.outcome, opts.captions.srtPath));
      } else {
        warnings.push(`captions pass failed (${burn.detail}); output has no captions`);
      }
    }
  }

  // 3. ffprobe the output for the render_report fields.
  const probe = await probeMedia(finalOutput, run);
  notes.push(`composed ${valid.length} cuts → ${trimmed.length} segments`);
  return {
    version: "1.0",
    outputs: [buildRenderOutput(finalOutput, probe)],
    render_time_seconds: (Date.now() - t0) / 1000,
    warnings,
    verification_notes: notes,
  };
}

/** Human-readable note for which burn tier ran (mirrors the prior vocabulary). */
function captionNote(outcome: CaptionOutcome, srtPath: string): string {
  switch (outcome) {
    case "libass":
      return `captions burned (libass subtitles) from ${srtPath}`;
    case "drawtext":
      return `captions burned (drawtext) from ${srtPath}`;
    case "sidecar":
      return `captions sidecar (mov_text) from ${srtPath}`;
  }
}

// ─── final_review (6 checks) ─────────────────────────────────────────────────

export interface ReviewCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface FinalReview {
  verdict: "pass" | "fail";
  checks: ReviewCheck[];
  duration_seconds: number;
  mean_volume_db?: number;
  /** The surfaced transcript text when a transcriptPath was supplied (Item I). */
  transcript?: string;
}

export interface FinalReviewOptions {
  /**
   * Optional transcript artifact path (the whisper adapter's transcript.txt).
   * When supplied + readable, an advisory `transcript` check is appended
   * (NON-blocking — never flips the verdict) carrying the word count + a
   * preview. This is the v1 surfacing of spoken content for final_review.
   */
  transcriptPath?: string;
  /**
   * The story's declared narration intent (the script artifact's top-level
   * `narration` field: "voiced" | "none"). When "none" (ambient-only /
   * intentionally silent), a near-silent track is EXPECTED, not a defect —
   * the audio_level check downgrades from "fail" to "warn" so a correctly
   * silent track never flips the verdict to "fail". Omit/undefined preserves
   * the prior behavior (near-silence always fails).
   */
  narration?: "voiced" | "none";
}

/**
 * Run the 6 delivery checks on a rendered mp4. A `fail` verdict blocks publish.
 * 1. container valid (ffprobe parses), 2. duration>0, 3. video stream present,
 * 4. audio stream present, 5. volumedetect (not silent, not clipping),
 * 6. mid-point frame extractable (file not corrupt mid-stream).
 * Optional transcriptPath adds a 7th advisory (non-blocking) check (Item I).
 */
export async function finalReview(mp4Path: string, deps: ComposeDeps = {}, opts: FinalReviewOptions = {}): Promise<FinalReview> {
  const run = deps.spawnImpl ?? runSpawn;
  const checks: ReviewCheck[] = [];
  const t0 = Date.now();

  if (!existsSync(mp4Path)) {
    return { verdict: "fail", checks: [{ name: "file_exists", status: "fail", detail: `not found: ${mp4Path}` }], duration_seconds: (Date.now() - t0) / 1000 };
  }

  // 1-4: ffprobe
  const probe = await probeMedia(mp4Path, run);
  checks.push({ name: "container_valid", status: probe.format || probe.videoCodec ? "pass" : "fail", detail: probe.format ? `format=${probe.format}` : "ffprobe could not parse" });
  checks.push({ name: "duration_positive", status: probe.duration > 0 ? "pass" : "fail", detail: `duration=${probe.duration.toFixed(2)}s` });
  checks.push({ name: "has_video_stream", status: probe.videoCodec ? "pass" : "fail", detail: probe.videoCodec ? `codec=${probe.videoCodec} ${probe.resolution ?? ""}`.trim() : "no video stream" });
  checks.push({ name: "has_audio_stream", status: probe.audioCodec ? "pass" : "warn", detail: probe.audioCodec ? `codec=${probe.audioCodec}` : "no audio stream" });

  // 5: volumedetect (mean + peak). Run on the whole file; parse the stderr lines.
  let meanDb: number | undefined;
  const vol = await run("ffmpeg", ["-hide_banner", "-i", mp4Path, "-af", "volumedetect", "-f", "null", "-"]);
  const meanMatch = vol.stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  const peakMatch = vol.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  if (meanMatch) meanDb = parseFloat(meanMatch[1]!);
  if (meanDb == null) {
    checks.push({ name: "audio_level", status: "warn", detail: "volumedetect did not report (no audio?)" });
  } else if (meanDb < -45) {
    const ambientOnly = opts.narration === "none";
    checks.push({
      name: "audio_level",
      status: ambientOnly ? "warn" : "fail",
      detail: ambientOnly
        ? `mean=${meanDb}dB (near-silent; expected — script declares narration:"none")`
        : `mean=${meanDb}dB (near-silent)`,
    });
  } else {
    const peak = peakMatch ? parseFloat(peakMatch[1]!) : 0;
    checks.push({ name: "audio_level", status: peak > -0.5 ? "warn" : "pass", detail: `mean=${meanDb}dB peak=${peak}dB` });
  }

  // 6: mid-point frame extractable.
  const mid = probe.duration > 0 ? probe.duration / 2 : 0;
  const frame = await run("ffmpeg", ["-hide_banner", "-y", "-ss", String(mid), "-i", mp4Path, "-frames:v", "1", "-f", "image2", "-"]);
  checks.push({ name: "midpoint_frame", status: frame.code === 0 ? "pass" : "fail", detail: frame.code === 0 ? "frame extracted at 50%" : `extract exit ${frame.code}` });

  // 7 (advisory, Item I): transcript surfaced from the whisper adapter.
  let transcript: string | undefined;
  if (opts.transcriptPath) {
    try {
      const text = readFileSync(opts.transcriptPath, "utf8");
      if (text) {
        transcript = text;
        const words = text.trim().split(/\s+/).filter(Boolean).length;
        const preview = text.length > 80 ? `${text.slice(0, 80).trim()}…` : text.trim();
        // Advisory only — `warn` (never `fail`) so v1 keeps final_review non-blocking.
        checks.push({ name: "transcript", status: "warn", detail: `${words} words captured; preview: "${preview}"` });
      } else {
        checks.push({ name: "transcript", status: "warn", detail: "transcript file empty" });
      }
    } catch {
      checks.push({ name: "transcript", status: "warn", detail: `transcript not readable: ${opts.transcriptPath}` });
    }
  }

  const verdict: "pass" | "fail" = checks.some((c) => c.status === "fail") ? "fail" : "pass";
  return { verdict, checks, duration_seconds: (Date.now() - t0) / 1000, mean_volume_db: meanDb, transcript };
}
