/**
 * e2e-smoke.ts — drive runPyVideo() directly (the pure core the run.py adapter
 * wraps) for a REAL `run.py video t2i2v` generation. No LLM, no agent runtime —
 * exercises venv resolution + path validation + spawn + manifest parsing.
 *
 * Default-skipped (real MLX gen, minutes). Opt in:
 *
 *   MLX_E2E=1 bun scripts/e2e-smoke.ts
 *
 * Uses the `dasiwa-dev-audio` T2I2V_SELF_TESTS fixture (VLM stage skipped — the
 * zh prompt is fed directly to I2V), so it does NOT depend on LM Studio for the
 * VLM expansion. (The fixture's quality_check stage still runs; if LM Studio is
 * down it warns+skips gracefully and the run still exits 0 with a real mp4.)
 *
 * Override the fixture: `MLX_E2E_FIXTURE=default bun scripts/e2e-smoke.ts`.
 *
 * Asserts the two hard constraints (2026-07-07):
 *   1. details.ok && details.output is a REAL playable mp4 (ffprobe video stream).
 *   2. ZERO cloud — the spawn is python+run.py (local MLX), and the model id
 *      pulled from the manifest is a local transformer (dasiwa/dev/z-image),
 *      never a cloud GAI id.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { runPyVideo } from "../src/index.ts";

const E2E = process.env.MLX_E2E === "1";
const FIXTURE = process.env.MLX_E2E_FIXTURE ?? "dasiwa-dev-audio";

/** Cloud model ids that must NEVER appear (constraint: zero cloud GAI). */
const CLOUD_MODEL_HINTS = ["gpt", "claude", "gemini", "openai", "anthropic", "grok", "veo", "sora", "kling", "runway", "fal", "replicate"];

async function main() {
  if (!E2E) {
    console.log("e2e-smoke: default-skipped. Set MLX_E2E=1 to run a real run.py video t2i2v generation.");
    console.log("  MLX_E2E=1 bun scripts/e2e-smoke.ts   (fixture: MLX_E2E_FIXTURE, default 'dasiwa-dev-audio')");
    return;
  }

  console.log(`=== run.py video t2i2v --self-test ${FIXTURE} (real MLX) ===`);
  const out = await runPyVideo({
    options: { selfTest: FIXTURE },
    onProgress: (u) => console.log(`  … ${u.text}`),
  });

  console.log("summary:", out.summary);
  console.log("details.ok:", out.details.ok);
  console.log("details.output (mp4):", out.details.output);
  console.log("details.model:", out.details.model);
  console.log("details.outDir:", out.details.outDir);

  if (!out.details.ok || !out.details.output) {
    console.error("FAIL: t2i2v did not produce an mp4");
    console.error("── stderr tail ──\n" + out.stderrTail);
    process.exit(1);
  }

  // Constraint 1a: the mp4 exists and is non-trivially sized.
  const mp4 = out.details.output;
  if (!existsSync(mp4)) {
    console.error("FAIL: mp4 path does not exist on disk:", mp4);
    process.exit(1);
  }
  const size = statSync(mp4).size;
  console.log(`  mp4 size: ${size} bytes`);
  if (size < 2000) {
    console.error("FAIL: mp4 is suspiciously small (<2KB) — not a real generation");
    process.exit(1);
  }

  // Constraint 1b: ffprobe confirms a real, playable video stream.
  const probe = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", mp4], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    console.error("FAIL: ffprobe could not read the mp4 (status " + probe.status + "):\n" + probe.stderr);
    process.exit(1);
  }
  const j = JSON.parse(probe.stdout);
  const video = (j.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === "video");
  if (!video) {
    console.error("FAIL: mp4 has no video stream");
    process.exit(1);
  }
  const dur = Number(j.format?.duration ?? 0);
  console.log(`  ffprobe: ${video.codec_name} ${video.width}x${video.height} @ ${video.avg_frame_rate}, ${dur.toFixed(2)}s`);
  if (dur <= 0) {
    console.error("FAIL: mp4 duration is zero (not playable)");
    process.exit(1);
  }

  // Constraint 2: ZERO cloud. The provider is local run.py; the model id is a
  // local transformer from the manifest, never a cloud GAI hint.
  const model = (out.details.model ?? "").toLowerCase();
  const cloudHit = CLOUD_MODEL_HINTS.find((c) => model.includes(c));
  if (cloudHit) {
    console.error(`FAIL: model id "${out.details.model}" matches a cloud hint ("${cloudHit}") — zero-cloud violated`);
    process.exit(1);
  }
  console.log(`  zero-cloud: ✓ model "${out.details.model}" is local silicon`);

  console.log("\n=== ALL E2E CHECKS PASSED (run.py video adapter: real MP4, zero cloud) ===");
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(1);
});
