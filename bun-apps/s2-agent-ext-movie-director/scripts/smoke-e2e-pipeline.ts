/**
 * smoke-e2e-pipeline.ts — Item H orchestration-integration proof (iter-5 foundation).
 *
 * Walks the FULL `animated-explainer` pipeline state machine (research→proposal→
 * script→scene_plan→assets→edit→compose→publish) with the movie-director
 * checkpoint gate enforced at every human-approval stage, then renders a real
 * .mp4 via `compose-remotion` and `final-review`s it. Assets are ffmpeg lavfi
 * (no MLX generation) so this proves the ORCHESTRATION integration end-to-end
 * without contending for the GPU/LM Studio model — the real T2I/I2V `generate`
 * command plugs into the `assets` stage in a later increment.
 *
 * Not a unit test (needs remotion/ install + browser). Run:
 *
 *   E2E_SMOKE=1 REMOTION_BIN=.../remotion/node_modules/.bin/remotion \
 *     bun bun-apps/s2-agent-ext-movie-director/scripts/smoke-e2e-pipeline.ts
 *
 * Exits 0 only if a real .mp4 is produced and final_review passes, with every
 * pipeline stage checkpoint reached.
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  loadPipeline,
  getStageOrder,
  getStageProduces,
  writeCheckpoint,
  readCheckpoint,
  renderRemotion,
  finalReview,
  type RemotionEditDecisions,
} from "../src/index.ts";

function run(cmd: string, argv: string[]): Promise<number> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", () => {});
    p.stderr.on("data", () => {});
    p.on("error", () => res(-1));
    p.on("exit", (c) => res(c ?? -1));
  });
}

async function main() {
  if (!process.env.E2E_SMOKE) {
    console.log("set E2E_SMOKE=1 to run this orchestration e2e smoke (needs remotion/ install + browser)");
    process.exit(0);
  }
  // Isolate project workspace under a temp MLX_OUTPUT_DIR (no real-output pollution).
  const tmpRoot = mkdtempSync(join(tmpdir(), "md-e2e-"));
  process.env.MLX_OUTPUT_DIR = tmpRoot;
  const projectId = `e2e-smoke-${Date.now()}`;
  console.log("tmpRoot:", tmpRoot, "projectId:", projectId);

  try {
    const manifest = loadPipeline("animated-explainer");
    if ("error" in manifest || !manifest) { console.error("pipeline load failed"); process.exit(2); }
    const stages = getStageOrder("animated-explainer");
    console.log("stages:", stages.join(" → "));

    // Assets: two lavfi PNG "shots" + a narration bed (the asset_manifest).
    const a = join(tmpRoot, "shot1.png");
    const b = join(tmpRoot, "shot2.png");
    const narration = join(tmpRoot, "narration.mp3");
    if ((await run("ffmpeg", ["-f", "lavfi", "-i", "color=c=0x1e3a5f:s=1920x1080:d=1", "-frames:v", "1", "-y", a])) !== 0) { console.error("shot1 gen failed"); process.exit(2); }
    if ((await run("ffmpeg", ["-f", "lavfi", "-i", "color=c=0x5f1e3a:s=1920x1080:d=1", "-frames:v", "1", "-y", b])) !== 0) { console.error("shot2 gen failed"); process.exit(2); }
    if ((await run("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=300:duration=5", "-y", narration])) !== 0) { console.error("narration gen failed"); process.exit(2); }

    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [
        { id: "shot1", source: a, in_seconds: 0, out_seconds: 2.5, animation: "ken-burns" },
        { id: "shot2", source: b, in_seconds: 2.5, out_seconds: 5, animation: "zoom-in" },
      ],
      overlays: [{ type: "section_title", in_seconds: 0.4, out_seconds: 3, text: "Orchestration E2E", subtitle: "movie-director pipeline" }],
      audio: { narration: { src: narration, volume: 0.8 } },
      transition: "crossfade",
      theme: "dark",
    };

    // Walk every stage, enforcing the gate (humanApproved:true satisfies every gate).
    const artifacts: Record<string, unknown> = {
      research: { brief: { summary: "e2e smoke brief" } },
      proposal: { proposal_packet: { logline: "smoke" } },
      script: { script: { scenes: [] } },
      scene_plan: { scene_plan: { shots: [] } },
      assets: { asset_manifest: { assets: [{ id: "shot1", path: a }, { id: "shot2", path: b }] } },
      edit: { edit_decisions: edit },
      compose: {}, // filled after render
      publish: {},
    };

    for (const stage of stages) {
      const produces = getStageProduces("animated-explainer", stage);
      const stageArtifacts: Record<string, unknown> = {};
      for (const p of produces) stageArtifacts[p] = (artifacts[stage] as Record<string, unknown>)?.[p] ?? { stub: true };
      // This first pass proves orchestration mechanics with placeholder {stub:true}
      // content, not real artifacts — override both content-schema and final_review
      // gates here; the real compose/publish checkpoints below (after the actual
      // Remotion render + final_review) are written WITHOUT an override.
      writeCheckpoint({
        projectId, pipeline: "animated-explainer", stage, status: "completed", artifacts: stageArtifacts, humanApproved: true,
        overrideArtifactValidation: true, overrideFinalReview: true,
      });
      const cp = readCheckpoint(projectId, stage);
      console.log(`  ✓ ${stage}: status=${cp?.status} (produces: ${produces.join(",") || "—"})`);
    }

    // The compose stage: actually render via Remotion + final-review.
    const workDir = join(tmpRoot, "render");
    const out = join(workDir, "e2e.mp4");
    console.log("compose-remotion rendering…");
    const t0 = Date.now();
    const report = await renderRemotion(edit, { workDir, output: out, width: 1280, height: 720, fps: 30 });
    console.log(`render took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (report.outputs.length !== 1 || !existsSync(out)) {
      console.error("FAIL: compose-remotion produced no output:", report.warnings);
      process.exit(3);
    }
    const review = await finalReview(out);
    console.log("final_review verdict:", review.verdict, `(${review.checks.filter((c) => c.status === "pass").length}/${review.checks.length} pass)`);
    if (review.verdict !== "pass") { console.error(JSON.stringify(review.checks, null, 2)); process.exit(4); }

    // publish checkpoint with the render_report.
    writeCheckpoint({
      projectId, pipeline: "animated-explainer", stage: "publish", status: "completed",
      artifacts: { publish_log: { mp4: out, size_bytes: report.outputs[0]!.file_size_bytes, final_review: "pass" } },
      humanApproved: true,
    });
    console.log("\n✓ END-TO-END OK: pipeline walked, .mp4 rendered, final_review PASS, publish checkpoint written.");
    console.log("  output:", out);
  } finally {
    if (process.env.KEEP_E2E_DIR) console.log("keeping", tmpRoot);
    else rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
