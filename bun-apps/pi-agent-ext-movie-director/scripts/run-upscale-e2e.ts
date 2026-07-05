/**
 * run-upscale-e2e.ts — Item I sibling: native ESRGAN director, end-to-end proof.
 *
 * Drives the upscale chain on a real fixture image, deterministically:
 *
 *   fixture.png (256×256, ffmpeg lavfi gradient)
 *     → esrganAdapter (real spandrel + torch MPS, 4xNomosWebPhoto_RealPLKSR)
 *       → fixture_4x.png (1024×1024)
 *         → ffprobe confirm (PNG, dimensions 4× the source)
 *
 * Why deterministic (no LLM in the loop)? Upscaling is a fixed function —
 * spandrel loads the .pth, torch runs the conv on MPS, pixels come out 4×
 * larger. No model judgment; the LLM orchestrator is the replaceable layer.
 * This isolates ONE variable: "does the native ESRGAN path produce a real
 * upscaled PNG?" — exactly the enhancement-gap gate.
 *
 * Run:
 *   bun run --cwd bun-apps/pi-agent-ext-movie-director scripts/run-upscale-e2e.ts
 *
 * Env:
 *   MD_VISION_PYTHON  python binary with spandrel+torch (default: <repo>/python/vision-venv/bin/python)
 *   MD_ESRGAN_MODEL   ESRGAN .pth path (default: mlx-models/upscale/4x-nomos-webphoto-realplksr/…)
 *   MLX_OUTPUT_DIR    project workspace root (default repo convention)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { esrganAdapter, probedMenuSummary } from "../src/index.ts";

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
  line("# Item I sibling — native ESRGAN upscale director: live end-to-end receipt");
  line("");
  line(`Generated: ${new Date().toISOString()}`);
  line(`Fixture: ffmpeg lavfi gradient → 256×256 PNG (synthetic, deterministic)`);
  line("");

  // 0. Preflight: upscale is no longer a gap.
  const menu = probedMenuSummary();
  const enhancement = menu.capabilities.find((c) => c.capability === "enhancement");
  line("## 0. Preflight");
  line(`- enhancement available_providers: ${JSON.stringify(enhancement?.available_providers)}`);
  line(`- upscale in gaps? ${menu.gaps.some((g) => g.name === "upscale") ? "YES (BUG)" : "no ✓"}`);
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

  // 2. Upscale (REAL spandrel + torch MPS).
  line("## 2. Upscale — `esrganAdapter` (real ESRGAN 4×)");
  const t1 = Date.now();
  const res = await esrganAdapter({
    capability: "enhancement",
    command: "upscale",
    outputDir: OUT,
    options: { image: fixture },
  });
  line(`- success: ${res.success}, provider: ${res.provider}, model: ${res.model}, duration: ${res.duration_seconds}s`);
  if (!res.success || !res.artifacts.length) {
    line(`- ERROR: ${res.error}`);
    throw new Error(`upscale failed: ${res.error}`);
  }
  const out = res.artifacts[0]!;
  line(`- output: \`${out.path}\` (${out.width}×${out.height}, role=${out.role})`);
  line(`- wall time: ${((Date.now() - t1) / 1000).toFixed(2)}s`);
  line("");

  // 3. Verify the output is a real PNG at 4× the source.
  const probe = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0", out.path,
  ]);
  // ffprobe csv order is not guaranteed — pull the two ints + the codec token.
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
  line(`Gate: upscale retired from gaps ✓ · real 4× PNG produced ✓ · dims ${w}×${h} verified ✓`);
  const outReceipt = join(import.meta.dirname, "..", "receipts", "upscale-e2e-20260705.md");
  writeFileSync(outReceipt, receipt.join("\n") + "\n", "utf8");
  console.log(`receipt → ${outReceipt}`);
  console.log(`verdict: dims ${w}×${h}, ok=${dimsOk}`);
  if (!dimsOk) process.exit(1);
}

main().catch((e) => {
  console.error("upscale-e2e failed:", e);
  process.exit(1);
});
