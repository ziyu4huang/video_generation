/**
 * story.ts — the "story with voice" pipeline: flux2 keyframe panels → grid
 * stitch (ffmpeg) → `ltx-video native-storyboard` (hard-cut relay).
 *
 * LTX-2.3 generates SYNCHRONIZED AUDIO with every clip (joint audio-video
 * transformer) — scene prompts carry voice cues (dialogue, meows, wind,
 * rain) so each segment ships with its own soundtrack; segments concatenate
 * into one mp4 (H.264+AAC via AVAssetWriter, no ffmpeg on the ltx side).
 *
 * Panels are keyframed with flux2 (same style prefix + seed family) so the
 * character/look stays consistent across shots; the grid image pins each
 * panel at its segment's frame 0 (gridStrength 0.525 = hard-cut tuning).
 *
 * AUTO mode (agentic) adds the two bracketing steps: a local LLM brain
 * (LM Studio) writes the storyboard from a one-line idea up front, and each
 * scene's narration line is spoken by Kokoro TTS and mixed over its
 * segment's LTX soundtrack at the end — idea in, voiced film out, one job.
 */
import path from "path";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync, readFileSync } from "fs";

import { invokeFlux2 } from "@repo/s2-agent-ext-flux2/src/invoke.ts";
import { ensureBinary } from "@repo/s2-agent-ext-ltx/src/binary.ts";

import { FLUX2_BIN, OUTPUT_DIR, REPO_DIR, flux2MetallibExists } from "./paths";
import type { PipelineHandle } from "./jobs";
import { writeStoryboard } from "./brain";
import { buildVoiceMixArgs, concatListBody, ensureKokoro, synthesizeNarration, wavDurationSec } from "./voice";

/** Voice cues make LTX-2.3's joint audio branch produce an actual soundtrack. */
export const STORY_STYLE_PREFIX =
  "Cinematic story still, warm film grade, shallow depth of field. ";

/** Auto-mode extras: the one-line idea + which Kokoro voice speaks it. */
export interface AutoStoryOptions {
  idea: string;
  /** "" = language-aware default (af_heart / zf_xiaobei). */
  voice: string;
}

export interface StoryParams {
  /** One prompt per scene/segment (1..4). In auto mode: brain-written visuals. */
  scenes: string[];
  /** Duration PER segment in seconds (integer; LTX snaps to 8k+1 frames @ 24fps). */
  seconds: number;
  width: number;
  height: number;
  seed: string;
  stylePrefix?: string;
  /** Present = agentic mode: brain writes scenes + Kokoro speaks narration. */
  auto?: AutoStoryOptions;
}

/** The decided default story — "Miko in the Lighthouse" (4 voiced scenes). */
export const DEFAULT_STORY: StoryParams & { title: string } = {
  title: "Miko in the Lighthouse",
  scenes: [
    "Miko, a small ginger cat with white paws, sits on the windowsill of a stone lighthouse keeper's cottage at dusk as the first rain arrives, warm lamplight glowing. Distant thunder rumbles softly and rain patters on the glass.",
    "Miko the ginger cat climbs the spiral staircase inside the lighthouse tower, shadows sweeping with the turning lamp above. The wind howls faintly and Miko lets out one small meow.",
    "Miko the ginger cat presses a paw against the lantern room glass at night while the great lamp sweeps light over stormy black waves below. Wind howls, waves crash, thunder rolls.",
    "Dawn fills the lantern room with golden light; Miko the ginger cat curls up asleep on a warm blanket beside the lamp, a teacup steaming nearby. A gentle breeze and seabirds calling far away.",
  ],
  seconds: 2,
  width: 960,
  height: 544,
  seed: "42",
  stylePrefix: STORY_STYLE_PREFIX,
};

/** Validate + coerce a story request (manual or auto). Returns [params, error]. */
export function validateStory(body: {
  scenes?: unknown;
  sceneCount?: unknown;
  seconds?: unknown;
  width?: unknown;
  height?: unknown;
  seed?: unknown;
  auto?: unknown;
}): [StoryParams | null, string | null] {
  // Shared timing/size/seed bounds, independent of author mode.
  const seconds = typeof body.seconds === "number" ? body.seconds : 2;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 8) {
    return [null, "seconds must be an integer 1..8 per scene"];
  }
  const width = typeof body.width === "number" ? body.width : 960;
  const height = typeof body.height === "number" ? body.height : 544;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return [null, "width/height must be integers"];
  if (width < 256 || width > 1280 || height < 256 || height > 1280) return [null, "width/height must be within 256..1280"];
  const seed = body.seed !== undefined && body.seed !== "" ? String(body.seed) : "42";
  if (!/^\d+$/.test(seed)) return [null, "seed must be a non-negative integer"];
  if (BigInt(seed) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return [null, `seed must be < ${Number.MAX_SAFE_INTEGER} (the storyboard config carries it as a JSON number)`];
  }

  const auto = body.auto;
  if (auto !== undefined && auto !== null && auto !== false) {
    if (typeof auto !== "object") return [null, "auto must be an object"];
    const { idea, voice } = auto as { idea?: unknown; voice?: unknown };
    const ideaStr = typeof idea === "string" ? idea.trim() : "";
    if (ideaStr.length < 3) return [null, "auto mode needs an idea (at least 3 characters)"];
    if (ideaStr.length > 600) return [null, "idea too long (max 600 characters)"];
    const voiceStr = typeof voice === "string" ? voice.trim() : "";
    if (voiceStr !== "" && !/^[a-z]{2}_[a-z0-9_]+$/.test(voiceStr)) {
      return [null, "voice must be a Kokoro id like af_heart, or empty for auto"];
    }
    const sceneCount = typeof body.sceneCount === "number" ? body.sceneCount : 4;
    if (!Number.isInteger(sceneCount) || sceneCount < 1 || sceneCount > 4) {
      return [null, "sceneCount must be an integer 1..4"];
    }
    return [{ scenes: Array.from({ length: sceneCount }, () => ""), seconds, width, height, seed, auto: { idea: ideaStr, voice: voiceStr } }, null];
  }

  const raw = Array.isArray(body.scenes) ? body.scenes : [];
  const scenes = raw.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (scenes.length < 1) return [null, "at least one scene prompt is required"];
  if (scenes.length > 4) return [null, "at most 4 scenes per story"];
  return [{ scenes, seconds, width, height, seed }, null];
}

/** Spawn a generic CLI (bin/args), streaming lines into the job. Never rejects. */
function runCli(
  bin: string,
  args: string[],
  handle: PipelineHandle,
): Promise<{ exitCode: number; aborted: boolean; output: string }> {
  return invokeFlux2({
    bin,
    args,
    cwd: REPO_DIR,
    signal: handle.signal,
    onProgress: ({ text }) => handle.log(text),
  }).then((r) => ({ exitCode: r.exitCode, aborted: r.aborted, output: r.output }));
}

/** Stitch N same-size panels into a 1xN grid row via ffmpeg hstack. */
export async function stitchGrid(
  panels: string[],
  outGrid: string,
  run: (bin: string, args: string[]) => Promise<{ exitCode: number }>,
): Promise<void> {
  // A 1x1 "grid" is just the panel — ffmpeg's hstack needs >= 2 inputs
  // (`hstack=inputs=1` exits 222), and FrameLoad splits a 1x1 grid as the
  // whole image anyway.
  if (panels.length === 1) {
    copyFileSync(panels[0]!, outGrid);
    return;
  }
  const inputs = panels.map((p) => ["-i", p]).flat();
  const labels = panels.map((_, i) => `[${i}:v]`).join("");
  const args = ["-y", ...inputs, "-filter_complex", `${labels}hstack=inputs=${panels.length}`, outGrid];
  const { exitCode } = await run("ffmpeg", args);
  if (exitCode !== 0) throw new Error(`ffmpeg grid stitch failed (exit ${exitCode})`);
}

/** Extract the final concatenated mp4 from native-storyboard output lines. */
export function finalVideoForLine(line: string): string | null {
  const m = line.match(/^\s*final:\s*(\S.+\.mp4)$/);
  return m ? m[1]!.trim() : null;
}

/** Extract one relay segment mp4 ("   segment 2: /path/seg.mp4"). */
export function segmentVideoForLine(line: string): string | null {
  const m = line.match(/^\s*segment\s+\d+:\s*(\S.+\.mp4)$/);
  return m ? m[1]!.trim() : null;
}

export interface StoryPaths {
  dir: string;
  configPath: string;
  gridPath: string;
  outDir: string;
}

export function makeStoryPaths(seed: string): StoryPaths {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = path.join(OUTPUT_DIR, "story", `${stamp}_s${seed}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    configPath: path.join(dir, "storyboard.json"),
    gridPath: path.join(dir, "grid.png"),
    outDir: path.join(dir, "out"),
  };
}

/** Build the StoryboardConfig JSON consumed by `ltx-video native-storyboard`. */
export function buildStoryboardConfig(params: StoryParams, paths: StoryPaths) {
  const style = params.stylePrefix ?? STORY_STYLE_PREFIX;
  return {
    version: 1,
    transitionMode: "hard-cut",
    width: params.width,
    height: params.height,
    fps: 24,
    seed: Number(params.seed),
    seconds: params.seconds,
    t2iTransformer: "moody-pro-mix",
    grid: { image: paths.gridPath, columns: params.scenes.length, rows: 1 },
    segments: params.scenes.map((prompt, i) => ({
      panel: i,
      prompt: style + prompt,
      strength: 0.525,
    })),
    output: paths.outDir,
  };
}

/** Segment paths in order — parsed from relay log lines, else a dir scan. */
function segmentPaths(output: string, outDir: string, count: number): string[] {
  const fromLog = output
    .split("\n")
    .map(segmentVideoForLine)
    .filter((p): p is string => p !== null);
  if (fromLog.length >= count) return fromLog.slice(0, count);
  if (!existsSync(outDir)) return [];
  const mp4s = readdirSync(outDir)
    .filter((f) => f.endsWith(".mp4") && !f.startsWith("voiced_"))
    .sort();
  return mp4s.map((f) => path.join(outDir, f));
}

/**
 * Mix each segment's Kokoro narration over its LTX soundtrack, then concat.
 * Segments without narration still get a uniform aac-192k re-encode so the
 * final `-c copy` concat sees identical streams. Returns the final mp4 path.
 */
async function mixVoiceOver(
  segments: string[],
  voiceWavs: Array<string | null>,
  storyDir: string,
  handle: PipelineHandle,
): Promise<string | null> {
  const mixed: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const out = path.join(storyDir, `voiced_${i}.mp4`);
    const wav = voiceWavs[i] ?? null;
    const dur = wav ? wavDurationSec(wav) : null;
    if (wav && dur !== null) {
      handle.log(`[story] mixing scene ${i + 1}: narration ${dur.toFixed(1)}s over LTX audio`);
      const { exitCode } = await runCli("ffmpeg", buildVoiceMixArgs(segments[i]!, wav, out), handle);
      if (exitCode !== 0) throw new Error(`ffmpeg voice mix failed for scene ${i + 1} (exit ${exitCode})`);
    } else {
      handle.log(`[story] scene ${i + 1}: no narration — passthrough re-encode`);
      const { exitCode } = await runCli(
        "ffmpeg",
        ["-y", "-i", segments[i]!, "-map", "0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", out],
        handle,
      );
      if (exitCode !== 0) throw new Error(`ffmpeg audio passthrough failed for scene ${i + 1} (exit ${exitCode})`);
    }
    mixed.push(out);
  }
  if (mixed.length === 1) return mixed[0]!;
  const finalVoiced = path.join(storyDir, "voiced_final.mp4");
  writeFileSync(path.join(storyDir, "concat.txt"), concatListBody(mixed));
  const { exitCode } = await runCli(
    "ffmpeg",
    ["-y", "-f", "concat", "-safe", "0", "-i", path.join(storyDir, "concat.txt"), "-c", "copy", finalVoiced],
    handle,
  );
  if (exitCode !== 0) throw new Error(`ffmpeg concat of voiced segments failed (exit ${exitCode})`);
  return finalVoiced;
}

/**
 * Run the whole story pipeline inside a job. Manual: keyframes → grid →
 * storyboard. Auto: brain → keyframes → grid → voice → storyboard → mix.
 * Throws on the first failed step; the job layer turns that into job.error.
 */
export async function runStory(paramsIn: StoryParams, handle: PipelineHandle): Promise<string> {
  if (!flux2MetallibExists()) {
    throw new Error(
      "mlx.metallib missing for flux2 — run: bash swift/flux2-image-director/scripts/build-metallib.sh",
    );
  }
  let params = paramsIn;
  const paths = makeStoryPaths(params.seed);
  handle.setOutput(paths.configPath);

  // 0. Auto mode: the brain turns the idea into titled scenes + narration.
  let title: string | null = null;
  let brainModel: string | null = null;
  let narrations: string[] | null = null;
  if (params.auto) {
    handle.stage("writing");
    handle.log(`[story] 🧠 writing ${params.scenes.length} scenes for: ${params.auto.idea.slice(0, 100)}`);
    const board = await writeStoryboard(params.auto.idea, params.scenes.length, params.seconds, {
      signal: handle.signal,
      onLog: (line) => handle.log(line),
    });
    title = board.title;
    brainModel = board.model;
    params = { ...params, scenes: board.scenes.map((s) => s.visual) };
    narrations = board.scenes.map((s) => s.narration);
    handle.log(`[story] ✍️ "${title}" — ${board.model}`);
    board.scenes.forEach((s, i) =>
      handle.log(`   scene ${i + 1}: ${s.visual}${s.narration ? `\n            🎙 ${s.narration}` : ""}`),
    );
  }

  // 1. Keyframe panels — one flux2 t2i per scene, seed family seed+i.
  handle.stage("keyframes");
  const panels: string[] = [];
  for (let i = 0; i < params.scenes.length; i++) {
    const panel = path.join(paths.dir, `panel_${i}.png`);
    handle.log(`[story] keyframe ${i + 1}/${params.scenes.length}: ${params.scenes[i]!.slice(0, 72)}…`);
    const { exitCode, aborted } = await runCli(
      FLUX2_BIN,
      [
        "t2i",
        "--prompt", (params.stylePrefix ?? STORY_STYLE_PREFIX) + params.scenes[i]!,
        "--width", String(params.width),
        "--height", String(params.height),
        "--steps", "6",
        "--seed", String(BigInt(params.seed) + BigInt(i)),
        "--output", panel,
        "--no-artifacts",
      ],
      handle,
    );
    if (aborted) throw new Error("cancelled");
    if (exitCode !== 0) throw new Error(`flux2 t2i keyframe ${i + 1} failed (exit ${exitCode})`);
    if (!existsSync(panel)) throw new Error(`flux2 t2i wrote no panel at ${panel}`);
    panels.push(panel);
  }

  // 2. Stitch the shared grid image (identity pinning across segments).
  handle.stage("grid");
  handle.log("[story] stitching grid via ffmpeg");
  await stitchGrid(panels, paths.gridPath, (bin, args) => runCli(bin, args, handle));

  // 3. Auto mode: speak each scene's line with Kokoro (local TTS).
  const voiceWavs: Array<string | null> = [];
  let voiceErrors: string[] = [];
  if (params.auto && narrations) {
    handle.stage("voice");
    await ensureKokoro(handle);
    for (let i = 0; i < narrations.length; i++) {
      const wav = path.join(paths.dir, `narration_${i}.wav`);
      const [out, err] = await synthesizeNarration(narrations[i]!, params.auto.voice, wav, handle);
      voiceWavs.push(out);
      if (err) {
        voiceErrors.push(`scene ${i + 1}: ${err}`);
        handle.log(`[story] ⚠️ scene ${i + 1} narration failed: ${err}`);
      }
    }
  }

  // 4. Render: ltx-video native-storyboard (hard-cut relay, joint audio).
  handle.stage("rendering");
  const config = buildStoryboardConfig(params, paths);
  writeFileSync(paths.configPath, JSON.stringify(config, null, 2));
  handle.log(`[story] storyboard config: ${paths.configPath}`);

  const ltxBin = await ensureBinary((u) => handle.log(u.text));
  const { exitCode, aborted, output } = await runCli(
    ltxBin,
    ["native-storyboard", "--config", paths.configPath],
    handle,
  );
  if (aborted) throw new Error("cancelled");
  if (exitCode !== 0) throw new Error(`ltx-video native-storyboard failed (exit ${exitCode})`);

  const segments = segmentPaths(output, paths.outDir, params.scenes.length);
  const finalFromLog = output
    .split("\n")
    .map(finalVideoForLine)
    .find((p): p is string => p !== null) ?? null;
  const ltxFinal =
    finalFromLog ??
    (() => {
      const outDir = paths.outDir;
      if (!existsSync(outDir)) return null;
      const mp4s = readdirSync(outDir).filter((f) => f.endsWith(".mp4"));
      if (mp4s.length === 0) return null;
      return path.join(
        outDir,
        mp4s.sort((a, b) => statSync(path.join(outDir, b)).mtimeMs - statSync(path.join(outDir, a)).mtimeMs)[0]!,
      );
    })();
  if (!ltxFinal) throw new Error("native-storyboard produced no final mp4");

  // 5. Auto mode: mix narration over the LTX soundtrack, segment-aligned.
  let finalMp4 = ltxFinal;
  let voiced = false;
  if (params.auto && voiceWavs.some((w) => w !== null) && segments.length > 0) {
    handle.stage("mixing");
    const mixed = await mixVoiceOver(segments, voiceWavs, paths.dir, handle);
    if (mixed) {
      finalMp4 = mixed;
      voiced = true;
    }
  }
  if (!voiced && voiceErrors.length > 0) {
    handle.log(`[story] ⚠️ delivering without narration — ${voiceErrors.length} scene(s) failed`);
  }

  handle.setOutput(finalMp4);
  writeFileSync(
    path.join(paths.dir, "story.json"),
    JSON.stringify(
      {
        title,
        idea: params.auto?.idea ?? undefined,
        scenes: params.scenes,
        narrations: narrations ?? undefined,
        voice: params.auto
          ? { model: voiceWavs.some((w) => w !== null) ? "kokoro-82m" : null, id: params.auto.voice || "auto", errors: voiceErrors.length ? voiceErrors : undefined }
          : undefined,
        brainModel,
        panels,
        voiced,
        seconds: params.seconds,
        width: params.width,
        height: params.height,
        seed: params.seed,
        finalVideo: finalMp4,
        config: paths.configPath,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return finalMp4;
}

// List past story runs (OUTPUT_DIR/story/<stamp>/story.json), newest first.
export function listStories(): Array<Record<string, unknown>> {
  const root = path.join(OUTPUT_DIR, "story");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => path.join(root, name, "story.json"))
    .filter((f) => existsSync(f))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((s): s is Record<string, unknown> => s !== null)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
