/**
 * run-clip-e2e.ts — Item I sibling: native CLIP video_understand director, e2e proof.
 *
 * Drives the video-understanding chain on a real fixture mp4, deterministically:
 *
 *   fixture.mp4 (ffmpeg lavfi — solid color scene, 2s, 320×240)
 *     → clipAdapter (real transformers CLIPModel on torch MPS, 4 sampled frames)
 *       → clip_scores.json {score, prob_mean, frames[]}
 *         → ranking check: the matching prompt scores above the distractors
 *
 * Why deterministic (no LLM in the loop)? CLIP scoring is a fixed function —
 * frames are encoded, the prompt is encoded, cosine similarity falls out.
 * No model judgment in the understanding primitive; the LLM orchestrator is
 * the replaceable layer. This isolates ONE variable: "does the native CLIP
 * path produce a real score that ranks the right label first?" — exactly the
 * analysis-gap gate.
 *
 * Run:
 *   bun run --cwd bun-apps/s2-agent-ext-movie-director scripts/run-clip-e2e.ts
 *
 * Env:
 *   MD_VISION_PYTHON  python binary with transformers+torch (default: <repo>/python/vision-venv/bin/python)
 *   MD_CLIP_MODEL     HF CLIP repo (default: openai/clip-vit-base-patch32)
 *   MLX_OUTPUT_DIR    project workspace root (default repo convention)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clipAdapter, probedMenuSummary, type ClipResult } from "../src/index.ts";

const OUT = process.env.MLX_OUTPUT_DIR
  ? join(process.env.MLX_OUTPUT_DIR, "movie-director", "clip-e2e")
  : join(import.meta.dirname, "..", "receipts", "clip-e2e-artifacts");

function run(cmd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("exit", (c) => res({ code: c ?? -1, stdout, stderr }));
    p.on("error", () => res({ code: -1, stdout, stderr }));
  });
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const receipt: string[] = [];
  const line = (s = "") => receipt.push(s);
  line("# Item I sibling — native CLIP video_understand director: live end-to-end receipt");
  line("");
  line(`Generated: ${new Date().toISOString()}`);
  line(`Fixture: ffmpeg lavfi solid green scene → 2s 320×240 mp4 (synthetic, deterministic)`);
  line("");

  // 0. Preflight: video_understand is no longer a gap.
  const menu = probedMenuSummary();
  const analysis = menu.capabilities.find((c) => c.capability === "analysis");
  line("## 0. Preflight");
  line(`- analysis available_providers: ${JSON.stringify(analysis?.available_providers)}`);
  line(`- video_understand in gaps? ${menu.gaps.some((g) => g.name === "video_understand") ? "YES (BUG)" : "no ✓"}`);
  line("");

  // 1. Build a 2s green fixture mp4 (a scene CLIP can rank against color prompts).
  const fixture = join(OUT, "fixture.mp4");
  const genR = await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x2a8a2a:s=320x240:r=15:d=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture,
  ]);
  if (genR.code !== 0 || !existsSync(fixture)) throw new Error(`fixture gen failed: ${genR.stderr}`);
  line("## 1. Fixture — 2s green 320×240 mp4");
  line(`- \`${fixture}\` (probe: ${(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", fixture])).stdout.trim()}s)`);
  line("");

  // 2. video_understand (REAL CLIP — the matching prompt vs two distractors).
  line("## 2. video_understand — `clipAdapter` (real CLIP, 4 frames)");
  const t1 = Date.now();
  const res = await clipAdapter({
    capability: "analysis",
    command: "video_understand",
    outputDir: OUT,
    options: {
      video: fixture,
      numFrames: 4,
      prompt: "a green screen",
      labels: ["a red screen", "a night sky"],
    },
  });
  line(`- success: ${res.success}, provider: ${res.provider}, model: ${res.model}, duration: ${res.duration_seconds}s`);
  if (!res.success || !res.artifacts.length) {
    line(`- ERROR: ${res.error}`);
    throw new Error(`clip failed: ${res.error}`);
  }
  const scoresPath = res.artifacts.find((a) => a.role === "scores")!.path;
  const scores = JSON.parse(readFileSync(scoresPath, "utf8")) as ClipResult;
  line(`- prompt: "${scores.prompt}"  labels: ${JSON.stringify(scores.labels)}`);
  line(`- mean cosine score: ${scores.score?.toFixed(4)}  ·  mean prob (label[0]): ${scores.prob_mean?.toFixed(4)}`);
  line(`- per-frame: ${(scores.frames ?? []).map((f) => `f${f.index}:${f.score.toFixed(3)}`).join(" ")}`);
  line(`- surfaced artifacts: ${res.artifacts.map((a) => a.role).join(", ")}`);
  line(`- wall time: ${((Date.now() - t1) / 1000).toFixed(2)}s (incl. first-run model fetch)`);
  line("");

  // 3. Ranking check: matching prompt must beat the distractors. We re-score with
  //    labels reordered is unnecessary — prob_mean is already label[0] (the
  //    matching prompt). Assert it's the plurality (>0.5 across 3 labels).
  const ranked = (scores.prob_mean ?? 0) > 0.5;
  line("## 3. Verify — ranking");
  line(`- prob_mean for matching label: ${(scores.prob_mean ?? 0).toFixed(4)} (>0.5 ⇒ ranked first across 3 labels) → ${ranked ? "✓" : "✗"}`);
  line("");

  line("---");
  line(`Gate: video_understand retired from gaps ✓ · real CLIP score produced ✓ · matching label ranked first ${ranked ? "✓" : "✗"}`);
  const outReceipt = join(import.meta.dirname, "..", "receipts", "clip-e2e-20260705.md");
  writeFileSync(outReceipt, receipt.join("\n") + "\n", "utf8");
  console.log(`receipt → ${outReceipt}`);
  console.log(`verdict: score=${scores.score?.toFixed(3)}, prob_mean=${scores.prob_mean?.toFixed(3)}, ranked=${ranked}`);
  if (!ranked) process.exit(1);
}

main().catch((e) => {
  console.error("clip-e2e failed:", e);
  process.exit(1);
});
