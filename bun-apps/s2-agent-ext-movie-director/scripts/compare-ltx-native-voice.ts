/**
 * compare-ltx-native-voice.ts — A/B comparison: LTX-2.3's own joint
 * audio-video generation (dev-audio transplant, auto-on for dasiwa) speaking
 * the narration text as an in-prompt instruction, vs. the edge-tts narration
 * track from run-real-e2e-neuralnet-v4-motion.ts.
 *
 * v4-motion already runs LTX I2V with --dev-audio active (dasiwa default),
 * but compose_motion.ts's segment stage always does `-an` (drop native audio,
 * mix a separate narration bed instead) — so the model's own generated audio
 * has never actually been listened to. This script:
 *
 *   1. Re-generates each scene's I2V motion clip, this time with the
 *      narration text folded into the motion prompt as spoken dialogue (LTX's
 *      audio branch is prompt-conditioned like the visual branch — there is
 *      no separate "text-to-speech-script" input, so the only way to ask for
 *      speech is to describe it in the prompt).
 *   2. Concatenates the two clips directly via ffmpeg concat, re-encoding
 *      video+audio so mismatched per-clip encode params don't break `-c copy`
 *      concat — and, critically, KEEPS each clip's own generated audio track
 *      instead of stripping it (unlike compose_motion.ts's pipeline path).
 *
 * Standalone / outside the checkpoint-gated pipeline on purpose: this is an
 * A/B probe, not a shippable-artifact run.
 *
 * Cost: 2 fresh LTX I2V generations (prompt changed → no SKIP_ASSETS reuse
 * possible), ~5-6 min each, ~10-12 min total.
 *
 * Run:
 *   bun run --cwd bun-apps/s2-agent-ext-movie-director scripts/compare-ltx-native-voice.ts
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPyVideo } from "@repo/s2-agent-ext-ltx";
import { projectDir } from "../src/index.ts";
import { spawn } from "node:child_process";

const V4_PROJECT_DIR = projectDir("neuralnet-real-e2e-v4-motion");
const V4_ASSETS_DIR = join(V4_PROJECT_DIR, "assets");
const OUT_PROJECT_DIR = projectDir("neuralnet-ltx-native-voice-compare");
const OUT_ASSETS_DIR = join(OUT_PROJECT_DIR, "assets");
const FPS = 24;

const SHOTS = [
  {
    id: "scene1",
    seed: 501,
    stillPath: join(V4_ASSETS_DIR, "scene1.png"),
    durationSeconds: 10,
    motionPrompt:
      "Abstract glowing neural network diagram, nodes and connections pulsing " +
      "with soft blue light, one connection highlighted in warm orange, camera " +
      "slowly pushing in, subtle parallax drift, the orange highlight gently " +
      "spreading along adjacent connections as if the network is adjusting itself. " +
      'A calm English-speaking narrator\'s voice is heard saying: ' +
      '"A neural network is not smart on day one. It makes a guess, checks how ' +
      'wrong it was, and quietly adjusts itself to do better next time."',
  },
  {
    id: "scene2",
    seed: 502,
    stillPath: join(V4_ASSETS_DIR, "scene2.png"),
    durationSeconds: 10,
    motionPrompt:
      "Extreme macro close-up of a glowing synapse-like connection node, warm " +
      "orange light flowing steadily along the connection line toward a bright " +
      "convergence point, slow camera drift revealing more of the branching " +
      "structure, gentle pulsing glow. " +
      'A calm English-speaking narrator\'s voice is heard saying: ' +
      '"Two algorithms do the work: backpropagation figures out which direction ' +
      'to nudge each connection, and gradient descent takes that step. Repeat ' +
      'millions of times, and the guess becomes a skill."',
  },
] as const;

function log(who: string, msg: string): void {
  console.log(`\n[${who}] ${msg}`);
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`))));
    p.on("error", reject);
  });
}

async function generateVoicedMotion(shot: (typeof SHOTS)[number]): Promise<string> {
  const cachedMp4 = join(OUT_ASSETS_DIR, `${shot.id}_native_voice.mp4`);
  if (!existsSync(shot.stillPath)) throw new Error(`missing v4 still: ${shot.stillPath} (run v4-motion first)`);

  const frames = Math.round(shot.durationSeconds * FPS) + 1; // 241 for 10s@24fps
  log("gen", `ltx i2v (native-voice prompt) → ${shot.id} (${frames} frames @ ${FPS}fps, seed ${shot.seed})`);
  console.log(`  [gen] slow stage — measured ~5-6min per 10s/241-frame clip on this hardware`);
  const t0 = Date.now();
  const out = await runPyVideo({
    options: {
      fromImage: shot.stillPath,
      prompt: shot.motionPrompt,
      seed: shot.seed,
      frames,
      fps: FPS,
    },
  });
  const elapsed = (Date.now() - t0) / 1000;
  if (!out.details.ok || !out.details.output) {
    throw new Error(`scene ${shot.id} native-voice I2V generation failed: ${out.stderrTail}`);
  }
  if (!existsSync(out.details.output)) throw new Error(`scene ${shot.id}: reported mp4 missing at ${out.details.output}`);
  copyFileSync(out.details.output, cachedMp4);
  log("gen", `✓ ${shot.id} → ${cachedMp4} (${elapsed.toFixed(1)}s real LTX I2V, model=${out.details.model ?? "ltx-2.3"})`);
  return cachedMp4;
}

async function main(): Promise<void> {
  mkdirSync(OUT_ASSETS_DIR, { recursive: true });
  console.log(`LTX native-voice A/B probe — workspace: ${OUT_PROJECT_DIR}`);

  const clips: string[] = [];
  for (const shot of SHOTS) {
    clips.push(await generateVoicedMotion(shot));
  }

  const listFile = join(OUT_ASSETS_DIR, "concat_list.txt");
  writeFileSync(listFile, clips.map((c) => `file '${c}'`).join("\n") + "\n");

  const finalMp4 = join(OUT_PROJECT_DIR, "neuralnet_ltx_native_voice.mp4");
  log("concat", `re-encoding + concatenating ${clips.length} clips (native LTX audio kept) → ${finalMp4}`);
  await run("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listFile,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    finalMp4,
  ]);

  log("done", `✓ ${finalMp4}`);
  console.log(`\ncompare against the edge-tts version:\n  ${join(V4_PROJECT_DIR, "neuralnet_motion_20s.mp4")}`);
}

main().catch((err) => {
  console.error(`\n✗ native-voice compare failed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
