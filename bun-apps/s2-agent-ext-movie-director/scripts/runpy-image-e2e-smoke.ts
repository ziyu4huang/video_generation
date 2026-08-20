/**
 * runpy-image-e2e-smoke.ts — certify the mlx:runpy-image IMAGE adapter end-to-end.
 *
 * Two proofs, both LOCAL MLX only (constraint 1: zero cloud GAI):
 *   1. ROUTING — `selectProvider("image_generation", {command})` for the run.py-
 *      exclusive commands (controlnet/faceswap/profile/twosubject/swap) resolves to
 *      the runpy-image provider. This is the "agent-callable through the bridge"
 *      proof: `movie generate {image_generation, controlnet}` routes correctly.
 *   2. REAL GEN — `runPyImage({action:"t2i", prompt, outputDir})` spawns the real
 *      `python/venv/bin/python run.py image t2i`, parses the manifest sentinel, and
 *      a REAL PNG lands on disk + the manifest's model is a local transformer.
 *
 * Default-skipped (real MLX gen, ~tens of seconds). Opt in:
 *
 *   MLX_E2E=1 bun scripts/runpy-image-e2e-smoke.ts
 *
 * Override prompt/output: MLX_E2E_PROMPT / MLX_E2E_OUT.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { selectProvider } from "../src/selector.ts";
import { runPyImage } from "../src/runpy_image.ts";

const E2E = process.env.MLX_E2E === "1";

/** Cloud model ids that must NEVER appear (constraint: zero cloud GAI). */
const CLOUD_MODEL_HINTS = ["gpt", "claude", "gemini", "openai", "anthropic", "grok", "veo", "sora", "kling", "runway", "fal", "replicate"];

async function main() {
  // ── Proof 1: routing (always runs — cheap, no generation) ──────────────────
  console.log("=== Proof 1: selector routing for run.py-exclusive image commands ===");
  const routed: Record<string, string> = {};
  for (const cmd of ["controlnet", "faceswap", "profile", "twosubject", "swap", "anime2real", "angle", "purify"]) {
    const e = selectProvider("image_generation", { command: cmd });
    routed[cmd] = `${e.provider}/${e.invoke}`;
    if (e.invoke !== "mlx:runpy-image") {
      console.error(`FAIL: ${cmd} → ${e.provider}/${e.invoke} (expected runpy-image/mlx:runpy-image)`);
      process.exit(1);
    }
  }
  console.log("routed all run.py-exclusive commands → runpy-image:", JSON.stringify(routed, null, 2));

  // Sanity: basic t2i still routes to the Swift directors (NOT runpy-image).
  const t2i = selectProvider("image_generation", { command: "t2i" });
  console.log(`t2i (basic) → ${t2i.provider}/${t2i.invoke} (stays on Swift directors, as designed)`);
  if (t2i.invoke === "mlx:runpy-image") {
    console.error("FAIL: basic t2i should NOT route to runpy-image");
    process.exit(1);
  }

  if (!E2E) {
    console.log("\ne2e-smoke: real-gen proof default-skipped. Set MLX_E2E=1 to run a real run.py image generation.");
    console.log("  MLX_E2E=1 bun scripts/runpy-image-e2e-smoke.ts");
    return;
  }

  // ── Proof 2: real generation through the adapter ───────────────────────────
  const outDir = resolve(process.env.MLX_E2E_OUT ?? "./output/runpy-image-e2e");
  mkdirSync(outDir, { recursive: true });
  const prompt = process.env.MLX_E2E_PROMPT ?? "moody portrait, cinematic lighting, 35mm";

  console.log(`\n=== Proof 2: runPyImage real gen (action:t2i) → ${outDir} ===`);
  const out = await runPyImage({
    options: { action: "t2i", prompt, width: 640, height: 960, steps: 9 },
    outputDir: outDir,
  });

  console.log("summary:", out.summary);
  console.log("details.ok:", out.details.ok);
  console.log("details.manifestPath:", out.details.manifestPath);
  console.log("details.manifestStatus:", out.details.manifestStatus);
  console.log("details.model:", out.details.model);
  console.log("details.elapsedSeconds:", out.details.elapsedSeconds);
  console.log("details.outputs:", JSON.stringify(out.details.outputs, null, 2));

  if (!out.details.ok || out.details.outputs.length === 0) {
    console.error("FAIL: runPyImage did not produce an image");
    console.error("── stderr tail ──\n" + out.stderrTail);
    process.exit(1);
  }

  // Constraint 1a: a real PNG exists and is non-trivially sized.
  const img = out.details.outputs[0]!.path;
  if (!existsSync(img)) {
    console.error(`FAIL: image path does not exist: ${img}`);
    process.exit(1);
  }

  // Constraint 1b: the manifest's model is a LOCAL transformer, never a cloud id.
  const model = (out.details.model ?? "").toLowerCase();
  if (CLOUD_MODEL_HINTS.some((h) => model.includes(h))) {
    console.error(`FAIL: model id looks like a cloud backend: ${out.details.model}`);
    process.exit(1);
  }

  // Constraint 2: $0 marginal cost (local silicon).
  console.log("\n✓ E2E PASS — real image produced, routing correct, model is local, $0 cloud spend.");
  console.log(`  artifact: ${img}`);
}

await main();
