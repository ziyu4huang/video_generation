/**
 * compose_motion.ts — the ffmpeg motion-composition runtime (Item J, movie-director).
 *
 * Whereas `compose.ts` is the straight-cut foundation (trim + concat, NO motion)
 * and `remotion.ts` is the React/Chromium templated composer, this module is the
 * LIGHTWEIGHT motion composer: it bakes a per-cut ken-burns/zoom/pan animation
 * into each segment via ffmpeg's `zoompan` filter, then joins them with `xfade`
 * crossfade transitions — no React, no browser, no swift build. Just ffmpeg
 * (which is already on PATH), so it is callable anywhere compose_ffmpeg is.
 *
 * This is the runtime that retires the composition "new director" gap on
 * machines where browser-based composers (Remotion/HyperFrames/Motion Canvas)
 * don't resolve. It reuses `RemotionEditDecisions` (the same edit shape the
 * Remotion runtime consumes) so an agent can drive EITHER runtime from one edit
 * and diff the outputs.
 *
 * `composeMotion()` returns the SAME `RenderReport` shape as compose.ts/remotion.ts
 * so `movie compose-motion` is a uniform drop-in. The spawn is injectable
 * (`deps.spawnImpl`) so tests verify the argv + report assembly without a real
 * ffmpeg render; the real-silicon smoke is opt-in via `MOTION_SMOKE=1` or the
 * e2e script (`scripts/run-compose-motion-e2e.ts`).
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RenderReport, CaptionsOptions } from "./compose.ts";
import { buildRenderOutput } from "./compose.ts";
import { burnCaptions, planBurn, buildDrawtextFilter, drawtextFilterAvailable, resolveCaptionFont, type CaptionOutcome } from "./captions.ts";
import type { Animation, RemotionEditDecisions, RemotionCut } from "./remotion.ts";
import { probeMedia, probeDuration } from "./ffprobe.ts";
import { runSpawn, type SpawnImpl, type SpawnResult } from "./spawn.ts";

export type { SpawnImpl, SpawnResult } from "./spawn.ts";

export interface MotionDeps {
  spawnImpl?: SpawnImpl;
}

export interface MotionComposeOptions {
  /** Working dir for the per-cut segments + the rendered output. */
  workDir: string;
  /** Output mp4 path (absolute). Defaults to <workDir>/compose_motion_<ts>.mp4. */
  output?: string;
  /** Target width. Default 1920. */
  width?: number;
  /** Target height. Default 1080. */
  height?: number;
  /** Target fps. Default 30. */
  fps?: number;
  /** Crossfade duration in seconds (used when edit.transition === "crossfade"). Default 0.5. */
  transitionSeconds?: number;
  /**
   * Optional captions sourced from an SRT (typically the whisper transcript →
   * subtitle_gen output). Mirrors ComposeOptions.captions: burns via the shared
   * libass → drawtext → sidecar ladder so the motion tier is caption-honest on
   * the same macOS stock-ffmpeg platform that lacks libass.
   */
  captions?: CaptionsOptions;
}

// ─── zoompan expression builder ───────────────────────────────────────────────

/**
 * Build the `zoompan=` filter string for a cut's animation. `totalFrames` is the
 * segment's output frame count (ceil(duration_s * fps)); we bake it in so the
 * `on` (output frame index) variable drives a smooth, monotonic motion across
 * the whole clip. Output size `s=WxH` (the WORKING size — rendered at 2x target,
 * see composeMotion) and `fps=F`; `d=1` keeps one output frame per input frame
 * (no slow-mo / frame duplication). Returns null for "static" (no motion filter
 * — the caller just scales).
 *
 * x,y are the top-left of the zoom window in INPUT pixels, in range
 * [0, iw - iw/zoom]. We center by default; pan animations move that window.
 */
function zoompanFilter(anim: Animation, totalFrames: number, width: number, height: number, fps: number): string | null {
  const T = Math.max(1, totalFrames);
  const s = `${width}x${height}`;
  // Zoom range: 1.0 → 1.4 over the clip (gentle; avoids blocky upscale artifacts).
  const zIn = `min(1.0+0.4*on/${T},1.5)`;
  const zOut = `max(1.5-0.4*on/${T},1.0)`;
  const zFixed12 = `1.2`;
  // Centered top-left for a given zoom (input coords).
  const cx = `(iw-iw/zoom)/2`;
  const cy = `(ih-ih/zoom)/2`;
  switch (anim) {
    case "zoom-in":
      return `zoompan=z='${zIn}':d=1:s=${s}:fps=${fps}:x='${cx}':y='${cy}'`;
    case "zoom-out":
      return `zoompan=z='${zOut}':d=1:s=${s}:fps=${fps}:x='${cx}':y='${cy}'`;
    case "ken-burns":
      // Slow zoom-in + a slight horizontal drift for the parallax feel.
      return `zoompan=z='${zIn}':d=1:s=${s}:fps=${fps}:x='${cx}+((iw-iw/zoom)*0.25*on/${T})':y='${cy}'`;
    case "pan-left":
      // Window starts at the right edge, slides left over the clip.
      return `zoompan=z='${zFixed12}':d=1:s=${s}:fps=${fps}:x='(iw-iw/zoom)*(1-on/${T})':y='${cy}'`;
    case "pan-right":
      return `zoompan=z='${zFixed12}':d=1:s=${s}:fps=${fps}:x='(iw-iw/zoom)*(on/${T})':y='${cy}'`;
    case "static":
    default:
      return null;
  }
}

// ─── compose ──────────────────────────────────────────────────────────────────

/**
 * Render an edit through the ffmpeg motion compositor. Each media cut is trimmed
 * to its [in_seconds, out_seconds] window, pre-scaled to 2x target (so zoom/pan
 * has pixels to draw on), baked with its `zoompan` animation, and encoded as a
 * normalized segment. Segments are then joined — `xfade` crossfade when
 * `edit.transition === "crossfade"` (with a silent audio bed, since xfade is
 * video-only and motion composition is a visual tier), else a plain v+a concat.
 *
 * Returns a render_report. Never throws: missing sources / failed renders surface
 * as warnings + an empty outputs[] (mirrors compose.ts / remotion.ts).
 */
export async function composeMotion(
  edit: RemotionEditDecisions,
  opts: MotionComposeOptions,
  deps: MotionDeps = {},
): Promise<RenderReport> {
  const warnings: string[] = [];
  const notes: string[] = [];
  const run = deps.spawnImpl ?? runSpawn;
  const t0 = Date.now();

  if (!edit.cuts || edit.cuts.length === 0) {
    return { version: "1.0", outputs: [], warnings: ["edit_decisions has no cuts"], verification_notes: ["compose-motion skipped: empty cut list"] };
  }

  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const fps = opts.fps ?? 30;
  const td = opts.transitionSeconds ?? edit.transitionSeconds ?? 0.5;
  const crossfade = (edit.transition ?? "crossfade") === "crossfade" && edit.cuts.length > 1;

  mkdirSync(opts.workDir, { recursive: true });

  // Partition text cuts from media cuts. Media cuts motionize normally; text
  // cuts (title cards / section dividers) render as a solid-color + centered
  // drawtext segment via the SAME drawtext primitive the captions ladder uses —
  // closing the prior "text cuts dropped, use compose-remotion" gap without a
  // browser runtime. Segments are emitted in original cut order.
  const canRenderText = drawtextFilterAvailable() && resolveCaptionFont() != null;

  // 1. Per-cut: media → trim + pre-scale 2x + zoompan; text → color + drawtext.
  //    Both produce a normalized segment mp4 so the join strategies are agnostic.
  const segments: string[] = [];
  for (const c of edit.cuts) {
    if (c.type === "text") {
      if (!c.text) {
        warnings.push(`cut "${c.id}" is a text cut with no text — dropped`);
        continue;
      }
      if (!canRenderText) {
        warnings.push(`cut "${c.id}" is a text cut but ffmpeg lacks drawtext or no font resolved — dropped (install ffmpeg-full OR use compose-remotion for text overlays)`);
        continue;
      }
      const seg = join(opts.workDir, `motion_${c.id}.mp4`);
      const ok = await renderTextCut(c, width, height, fps, seg, run);
      if (ok) {
        segments.push(seg);
        notes.push(`cut "${c.id}" text card ("${c.text.slice(0, 32)}")`);
      } else {
        warnings.push(`cut "${c.id}" text-card render failed`);
      }
      continue;
    }
    // media cut: resolve source (warn + skip on missing).
    if (!c.source || !existsSync(c.source)) {
      warnings.push(`cut "${c.id}" source missing: ${c.source ?? "(none)"}`);
      continue;
    }
    const seg = join(opts.workDir, `motion_${c.id}.mp4`);
    const duration = Math.max(0.1, (c.out_seconds - c.in_seconds));
    const totalFrames = Math.ceil(duration * fps);
    const anim: Animation = c.animation ?? "static";
    const vf: string[] = [];
    // Sharp ken-burns path (Item B). Pre-scale to 2x target (cover) with lanczos
    // so zoompan has working pixels; bake the animation at the 2x WORKING size
    // (zoompan's internal resample then maps a zoom window within a 2x frame to a
    // 2x output — more pixels per output, less per-pixel blur); finally a lanczos
    // DOWNSCALE to the target. The measured lift (scripts/probe-zoompan-lanczos.ts,
    // laplacian-variance on a 1080p testsrc2 frame): old 2x-bilinear 124 vs this
    // 2x-zoompan + final-lanczos 174 (+40%). Lanczos downscaling rarely rings
    // (ringing is an upscale artifact), so the gain is genuine sharpness.
    // The final downscale runs for BOTH animated and static cuts, which also keeps
    // every segment at a uniform target resolution (a prior static-cut path left
    // static segments at 2x — mismatching animated segments and breaking the join).
    vf.push(`scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase:flags=lanczos`);
    vf.push(`crop=${width * 2}:${height * 2}`);
    const z = zoompanFilter(anim, totalFrames, width * 2, height * 2, fps);
    if (z) vf.push(z);
    vf.push(`scale=${width}:${height}:flags=lanczos`);
    vf.push(`fps=${fps}`);
    // Image vs video input shape the input flags. A still image (PNG/JPG/WebP) is
    // a SINGLE frame — without `-loop 1` ffmpeg exhausts it after one frame and the
    // segment renders as ~1 frame regardless of `-t`, so the downstream xfade
    // offset math sees a near-zero duration and the join fails. `-loop 1` loops the
    // image as a continuous input so zoompan has `totalFrames` frames to animate
    // across the full `-t` window (ken-burns on a still is this runtime's main case).
    // A video source keeps the seek-then-trim shape (`-ss` before `-i`).
    const isImage = !/\.(mp4|mov|webm|avi|mkv|m4v)$/i.test(c.source!);
    // Defensive duration check (video sources only): `in_seconds`/`out_seconds`
    // on a video-source cut are ABSOLUTE offsets into that source file — a
    // caller that copies the still-image convention (relative offsets from an
    // implicit 0) will pass an `in_seconds` at or past the source's own probed
    // duration, silently collapsing the trimmed segment toward zero length
    // (ffmpeg -ss past EOF just yields ~nothing). This bit us once already
    // (a composed video shrinking from 20s to ~10s with no error) before the
    // ffprobe-diff that found it; catch it here instead of after the fact.
    if (!isImage) {
      const sourceDuration = await probeDuration(c.source!, run);
      if (sourceDuration > 0 && (c.in_seconds ?? 0) >= sourceDuration - 0.1) {
        warnings.push(
          `cut "${c.id}" in_seconds=${c.in_seconds} is at or past source "${c.source}"'s probed duration (${sourceDuration.toFixed(2)}s) — ` +
          `this trims to ~0s; if the source is itself a per-cut clip, in_seconds should likely be 0`,
        );
      }
    }
    const argv: string[] = ["-y"];
    if (isImage) {
      argv.push("-loop", "1");
    } else {
      argv.push("-ss", String(c.in_seconds ?? 0));
    }
    argv.push("-i", c.source!, "-t", String(duration), "-vf", vf.join(","),
      "-sws_flags", "lanczos+accurate_rnd",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-an", // drop audio at the segment stage; the final mux adds a unified bed
      seg,
    );
    const r = await run("ffmpeg", argv);
    if (r.code !== 0 || !existsSync(seg)) {
      warnings.push(`cut "${c.id}" motion render failed (exit ${r.code})`);
    } else {
      segments.push(seg);
      notes.push(`cut "${c.id}" animation=${anim} (${totalFrames}f)`);
    }
  }
  if (segments.length === 0) {
    return { version: "1.0", outputs: [], warnings, verification_notes: ["compose-motion failed: every cut render failed (or dropped)"] };
  }

  // A caller-supplied `opts.output` names the file THEY expect the final
  // deliverable at. Downstream stages (audio mix, captions) each write their
  // result to a NEW timestamped path rather than in place, so without the
  // reconciliation below `opts.output` would keep pointing at the pre-mix
  // (silent) join file — a real "reviews/publishes the wrong file" footgun a
  // caller has no way to detect short of diffing report.outputs[0].path
  // against the path it asked for.
  const requestedOutput = opts.output;
  const output = requestedOutput ?? join(opts.workDir, `compose_motion_${Math.floor(Date.now() / 1000)}.mp4`);

  // 2. Join segments. Probe each segment's real duration first (xfade offsets are
  //    cumulative and overlap-sensitive, so we trust ffmpeg's reported durations).
  const durations = await Promise.all(segments.map((s) => probeDuration(s, run)));

  let ok: boolean;
  if (crossfade && segments.length >= 2) {
    ok = await renderXfade(segments, durations, output, td, fps, run);
    if (ok) notes.push(`crossfade transitions (xfade, ${td}s) across ${segments.length} segments`);
    else warnings.push("xfade chain failed; falling back to plain concat");
    if (!ok) ok = await renderConcat(segments, output, run); // best-effort fallback
  } else {
    ok = await renderConcat(segments, output, run);
    notes.push(`plain concat (${segments.length} segments)`);
  }
  if (!ok || !existsSync(output)) {
    return { version: "1.0", outputs: [], warnings: [...warnings, `final join failed`], verification_notes: [`compose-motion failed: join did not produce output`] };
  }

  // 2b. Optional audio mix pass. The join output has a SILENT audio bed (visual
  //     motion tier); when edit.audio supplies narration/music, mix it over the
  //     bed so the deliverable is shippable (passes final_review's audio_level).
  //     Narration: trimmed/looped to the video duration + volume. Music: same,
  //     optional loop + fade. Both: amix. A missing audio file → warn + keep bed.
  let finalOutput = output;
  const audio = edit.audio;
  const narrationSrc = audio?.narration?.src;
  const musicSrc = audio?.music?.src;
  const narrationPresent = narrationSrc && existsSync(narrationSrc);
  const musicPresent = musicSrc && existsSync(musicSrc);
  // Warn on any declared-but-missing audio source (independent of whether the
  // mix runs — a missing-only narration still deserves a warning, not silence).
  if (narrationSrc && !narrationPresent) warnings.push(`narration missing: ${narrationSrc}`);
  if (musicSrc && !musicPresent) warnings.push(`music missing: ${musicSrc}`);
  if (narrationPresent || musicPresent) {
    const mixed = join(opts.workDir, `motion_audio_${Math.floor(Date.now() / 1000)}.mp4`);
    const r = await mixAudioOnto(output, narrationPresent ? narrationSrc : null, musicPresent ? musicSrc : null, audio, mixed, run);
    if (r.ok && existsSync(mixed)) {
      finalOutput = mixed;
      notes.push(`audio mixed: ${[narrationPresent ? "narration" : null, musicPresent ? "music" : null].filter(Boolean).join(" + ") || "silent"}`);
    } else {
      warnings.push(`audio mix failed (${r.detail}); output keeps the silent bed`);
    }
  }

  // 2c. Optional captions sub-pass (mirrors compose.ts): burn or sidecar the
  //     SRT onto the joined+mixed output via the shared libass → drawtext →
  //     sidecar ladder. On macOS stock ffmpeg this reaches drawtext (hard-burn
  //     plain text without libass) — the same fix compose.ts got.
  if (opts.captions) {
    const wantBurn = opts.captions.burn !== false;
    const srtExists = existsSync(opts.captions.srtPath);
    const plan = planBurn(wantBurn, srtExists);
    if (plan.outcome === "skip") {
      warnings.push(`captions srt not found: ${opts.captions.srtPath}`);
    } else {
      if (plan.warning) warnings.push(plan.warning);
      const captioned = join(opts.workDir, `motion_captioned_${Math.floor(Date.now() / 1000)}.mp4`);
      const burn = await burnCaptions(finalOutput, opts.captions.srtPath, captioned, wantBurn, { spawnImpl: run, width: opts.captions.width ?? width, fontsize: opts.captions.fontsize });
      if (burn.ok && existsSync(captioned)) {
        finalOutput = captioned;
        notes.push(motionCaptionNote(burn.outcome, opts.captions.srtPath));
      } else {
        warnings.push(`captions pass failed (${burn.detail}); output has no captions`);
      }
    }
  }

  // 2d. Reconcile onto the caller-requested path (if any): whatever stage ran
  //     last (join / audio-mix / captions) wrote its result to its OWN
  //     timestamped path, not `requestedOutput`. Copy it back so a caller that
  //     trusts the `output` it passed in gets the actual final deliverable,
  //     not the earlier (possibly silent, possibly caption-less) intermediate
  //     that happens to still be sitting at that path.
  if (requestedOutput && finalOutput !== requestedOutput) {
    copyFileSync(finalOutput, requestedOutput);
    finalOutput = requestedOutput;
  }

  // 3. ffprobe → RenderReport.
  const probe = await probeMedia(finalOutput, run);
  notes.push(`rendered via ffmpeg zoompan+xfade (${segments.length} cuts)`);
  return {
    version: "1.0",
    outputs: [buildRenderOutput(finalOutput, probe)],
    render_time_seconds: (Date.now() - t0) / 1000,
    warnings,
    verification_notes: notes,
    render_grammar: "motion",
  };
}

/** Human-readable note for which caption burn tier the motion tier ran. */
function motionCaptionNote(outcome: CaptionOutcome, srtPath: string): string {
  switch (outcome) {
    case "libass":
      return `captions burned (libass subtitles) from ${srtPath}`;
    case "drawtext":
      return `captions burned (drawtext) from ${srtPath}`;
    case "sidecar":
      return `captions sidecar (mov_text) from ${srtPath}`;
  }
}

// ─── audio mix pass ───────────────────────────────────────────────────────────

/**
 * Mix narration (and/or music) onto the join output's silent bed. The video
 * stream is copied (no re-encode); the audio inputs are trimmed/looped to the
 * output duration and amix'd. Volume/fade come from RemotionAudio. Falls back to
 * the silent bed on any ffmpeg error (returns ok:false — caller keeps the bed).
 */
async function mixAudioOnto(
  video: string,
  narration: string | null,
  music: string | null,
  audio: RemotionEditDecisions["audio"],
  output: string,
  run: SpawnImpl,
): Promise<{ ok: boolean; detail: string }> {
  // Probe the video duration so we can fit the audio to it.
  const dur = await probeDuration(video, run);
  const durSec = dur > 0 ? dur : 5;

  const argv: string[] = ["-y", "-i", video];
  // Inputs: narration first (idx 1), then music (idx 2). Short audio loops to
  // fill the duration; we then atrim to the exact video length.
  if (narration) argv.push("-stream_loop", "-1", "-i", narration);
  if (music) argv.push("-stream_loop", "-1", "-i", music);

  const filter: string[] = [];
  let aLabel: string;
  if (narration && music) {
    filter.push(`[1:a]atrim=duration=${durSec.toFixed(3)},volume=${audio?.narration?.volume ?? 1}[narr]`);
    filter.push(`[2:a]atrim=duration=${durSec.toFixed(3)},volume=${audio?.music?.volume ?? 0.4}[mus]`);
    filter.push("[narr][mus]amix=inputs=2:duration=first[aout]");
    aLabel = "aout";
  } else if (narration) {
    filter.push(`[1:a]atrim=duration=${durSec.toFixed(3)},volume=${audio?.narration?.volume ?? 1}[aout]`);
    aLabel = "aout";
  } else {
    // music only
    filter.push(`[1:a]atrim=duration=${durSec.toFixed(3)},volume=${audio?.music?.volume ?? 0.4}[aout]`);
    aLabel = "aout";
  }
  argv.push("-filter_complex", filter.join(";"));
  argv.push("-map", "0:v", "-map", `[${aLabel}]`);
  argv.push("-c:v", "copy", "-c:a", "aac", "-shortest", output);

  const r = await run("ffmpeg", argv);
  return { ok: r.code === 0 && existsSync(output), detail: `exit ${r.code}` };
}

/**
 * Render a text cut as a solid-color + centered-drawtext segment (a title card).
 * Uses the SAME drawtext primitive as the captions ladder, so a text cut is now
 * first-class on compose_motion WITHOUT a browser runtime (the prior gap). The
 * color lavfi source fixes the segment's duration + size; drawtext paints the
 * text centered with a readable outline. Returns true on a produced segment.
 */
async function renderTextCut(
  cut: RemotionCut,
  width: number,
  height: number,
  fps: number,
  output: string,
  run: SpawnImpl,
): Promise<boolean> {
  const duration = Math.max(0.1, cut.out_seconds - cut.in_seconds);
  const totalFrames = Math.ceil(duration * fps);
  const fontfile = resolveCaptionFont()!;
  // Normalize a CSS-style hex (#RRGGBB) → ffmpeg's 0xRRGGBB; names pass through.
  const bg = normalizeColor(cut.backgroundColor) ?? "black";
  const vf = buildDrawtextFilter(cut.text!, {
    fontfile,
    fontsize: Math.round(Math.min(width, height) / 12), // scales with target size
  });
  const argv = [
    "-y",
    "-f", "lavfi", "-i", `color=c=${bg}:s=${width}x${height}:d=${duration.toFixed(3)}:r=${fps}`,
    "-vf", vf,
    "-frames:v", String(totalFrames),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-an",
    output,
  ];
  const r = await run("ffmpeg", argv);
  return r.code === 0 && existsSync(output);
}

/** "#1a2b3c" | "0x1a2b3c" | "red" → ffmpeg color spec (0x1a2b3c | red). */
function normalizeColor(c?: string): string | undefined {
  if (!c) return undefined;
  if (c.startsWith("#")) return `0x${c.slice(1)}`;
  return c;
}

// ─── join strategies ──────────────────────────────────────────────────────────

/** Plain v+a concat (segments are video-only here, so v-only concat). */
async function renderConcat(segments: string[], output: string, run: SpawnImpl): Promise<boolean> {
  const filter = segments.map((_, i) => `[${i}:v:0]`).join("") + `concat=n=${segments.length}:v=1:a=0[v]`;
  const argv = ["-y"];
  for (const seg of segments) argv.push("-i", seg);
  argv.push("-filter_complex", filter, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", output);
  const r = await run("ffmpeg", argv);
  return r.code === 0 && existsSync(output);
}

/**
 * xfade crossfade chain across N video segments. Each xfade overlaps two streams
 * by `td` seconds; the offset for the k-th xfade is the cumulative duration of
 * the chained output so far minus td. A silent `anullsrc` audio bed of the final
 * duration is muxed in so the deliverable has an audio stream (xfade is
 * video-only; the visual motion tier intentionally does not mix source audio).
 */
async function renderXfade(
  segments: string[],
  durations: number[],
  output: string,
  td: number,
  fps: number,
  run: SpawnImpl,
): Promise<boolean> {
  // Clamp transition duration to the shortest segment (xfade breaks if td >= a seg).
  const minDur = Math.min(...durations);
  const t = Math.max(0.1, Math.min(td, minDur * 0.5));

  // Build the xfade video filtergraph chain.
  const filters: string[] = [];
  let prevLabel = "0:v";
  let acc = durations[0]!;
  for (let i = 1; i < segments.length; i++) {
    const offset = Math.max(0, acc - t);
    const outLabel = i < segments.length - 1 ? `[v${i}]` : "[vout]";
    filters.push(`[${prevLabel}][${i}:v]xfade=transition=fade:duration=${t.toFixed(3)}:offset=${offset.toFixed(3)}${outLabel}`);
    prevLabel = `v${i}`;
    acc += durations[i]! - t;
  }
  // Single segment would not reach here (caller guards >=2), but guard anyway.
  if (segments.length === 1) prevLabel = "0:v";

  const videoDuration = acc; // the chained video's total duration

  // Assemble argv: inputs = each segment + one silent audio source.
  const argv = ["-y"];
  for (const seg of segments) argv.push("-i", seg);
  argv.push("-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`);
  // filter_complex: xfade chain + trim the silent bed to the video duration.
  const fc = [...filters];
  fc.push(`[${segments.length}:a]atrim=duration=${videoDuration.toFixed(3)}[aout]`);
  argv.push("-filter_complex", fc.join(";"));
  argv.push("-map", segments.length > 1 ? "[vout]" : "[0:v]", "-map", "[aout]");
  argv.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(fps), "-c:a", "aac", "-shortest", output);

  const r = await run("ffmpeg", argv);
  return r.code === 0 && existsSync(output);
}

// ─── ffprobe helpers ──────────────────────────────────────────────────────────

// probeDuration + probeOutput (now probeMedia) live in the shared ./ffprobe.ts
// module — the three compose tiers (compose / compose_motion / remotion) all
// share one parser. Re-exported here only if a caller imported it from this
// module; the canonical import is ./ffprobe.ts.
