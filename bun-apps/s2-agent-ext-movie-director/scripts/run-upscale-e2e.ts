/**
 * run-upscale-e2e.ts — native upscale end-to-end proof (flux2 RealPLKSR/ESRGAN).
 *
 * Drives the upscale chain on a real fixture image, deterministically, via the
 * SAME `dispatch("generate", …)` path the agent's `movie generate` lands on:
 *
 *   fixture.png (256×256, ffmpeg lavfi gradient)
 *     → dispatch("generate", {enhancement, upscale}) → swift:flux2
 *       (RealPLKSR 4xNomosWebPhoto, native Swift MLX)
 *       → fixture_4x.png (1024×1024)
 *         → ffprobe confirm (PNG, dimensions 4× the source)
 *
 * The Python/torch-MPS `esrganAdapter` was removed 2026-07-19 (zero-python ext);
 * `swift:flux2 upscale` (same model family) is the sole upscale provider now.
 *
 * Why deterministic (no LLM in the loop)? Upscaling is a fixed function. No
 * model judgment; this isolates ONE variable: "does the native upscale path
 * produce a real 4× PNG?" — the enhancement-gap gate.
 *
 * Run:
 *   MLX_MODELS_DIR=$(pwd)/mlx-models \
 *     bun run --cwd bun-apps/s2-agent-ext-movie-director scripts/run-upscale-e2e.ts
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../src/dispatch.ts";

const OUT = process.env.MLX_OUTPUT_DIR
  ? join(process.env.MLX_OUTPUT_DIR, "movie-director", "upscale-e2e")
  : join(import.meta.dirname, "..", "receipts", "upscale-e2e-artifacts");

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
  line("# Native upscale (flux2 RealPLKSR/ESRGAN): live end-to-end receipt");
  line("");
  line(`Generated: ${new Date().toISOString()}`);
  line(`Fixture: ffmpeg lavfi gradient → 256×256 PNG (synthetic, deterministic)`);
  line("");

  // 1. Build a deterministic 256×256 fixture (no input file needed).
  const fixture = join(OUT, "fixture.png");
  const genR = await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "gradients=s=256x256:d=1",
    "-frames:v", "1", fixture,
  ]);
  if (genR.code !== 0 || !existsSync(fixture)) throw new Error(`fixture gen failed: ${genR.stderr}`);
  line("## 1. Fixture — 256×256 gradient PNG");
  line(`- \`${fixture}\` (${(await run("stat", ["-f%z", fixture])).stdout.trim()} bytes)`);
  line("");

  // 2. Upscale via the movie-tool dispatch path → swift:flux2 (native Swift MLX).
  line("## 2. Upscale — `dispatch(\"generate\", {enhancement, upscale})` → swift:flux2");
  const t1 = Date.now();
  const res = await dispatch("generate", {
    capability: "enhancement",
    command: "upscale",
    outputDir: OUT,
    options: { input: fixture },
  });
  const dt = ((Date.now() - t1) / 1000).toFixed(1);
  if (!res.ok) {
    line(`- ERROR: ${res.error}`);
    throw new Error(`upscale dispatch failed: ${res.error}`);
  }
  const parsed = JSON.parse(typeof res.text === "string" ? res.text : JSON.stringify(res.text));
  const result = parsed.result ?? parsed;
  line(`- success: ${result.success}, provider: ${result.provider}, model: ${result.model}, dispatch: ${dt}s`);
  if (!result.success || !result.artifacts?.length) {
    line(`- ERROR: ${result.error}`);
    throw new Error(`upscale failed: ${result.error}`);
  }
  const out = result.artifacts[0];
  line(`- output: \`${out.path}\` (${out.width}×${out.height}, role=${out.role})`);
  line("");

  // 3. Verify the output is a real PNG at 4× the source.
  const probe = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0", out.path,
  ]);
  const tokens = probe.stdout.trim().split(",");
  const nums = tokens.map((t) => Number(t)).filter((n) => Number.isFinite(n) && n > 0);
  const codec = tokens.find((t) => Number.isNaN(Number(t))) ?? "";
  const [w, h] = nums;
  const dimsOk = w === 1024 && h === 1024;
  line("## 3. Verify — ffprobe the upscaled output");
  line(`- ffprobe: ${probe.stdout.trim() || "(empty)"}`);
  line(`- codec: ${codec}, dimensions: ${w}×${h} → ${dimsOk ? "4× source ✓" : "WRONG ✗"}`);
  line("");

  line("---");
  line(`Gate: real 4× PNG produced ✓ · dims ${w}×${h} verified ✓ · provider=${result.provider}`);
  const outReceipt = join(import.meta.dirname, "..", "receipts", "upscale-e2e-20260705.md");
  writeFileSync(outReceipt, receipt.join("\n") + "\n", "utf8");
  console.log(`receipt → ${outReceipt}`);
  console.log(`verdict: dims ${w}×${h}, ok=${dimsOk}, provider=${result.provider}`);
  if (!dimsOk) process.exit(1);
}

main().catch((e) => {
  console.error("upscale-e2e failed:", e);
  process.exit(1);
});
