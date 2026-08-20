/**
 * run-real-e2e-neuralnet-failure.ts — deliberate-failure e2e variant.
 *
 * Every other real-e2e script in this directory (run-h-real.ts,
 * run-real-e2e-neuralnet.ts) only exercises the GOLDEN path: every artifact is
 * schema-valid and every checkpoint completes. That proves the runtime CAN
 * ship a good pipeline, but never proves it actually STOPS a bad one —
 * `checkpoint.test.ts` covers that at the unit level (calling
 * `writeCheckpoint()` directly with hand-built bad input), but no real e2e
 * script drives a genuinely broken artifact through the full research → ...
 * → assets flow and asserts the runtime gate (not just this script's own
 * `assertValid` pre-check) refuses to complete the stage.
 *
 * This script reuses the SAME neuralnet-real-e2e-v1 project + real assets
 * (via SKIP_ASSETS-style caching — see run-real-e2e-neuralnet.ts) through
 * research/proposal/script/scene_plan, then ships an `asset_manifest` with one
 * asset missing its required `scene_id` field (asset_manifest.schema.json
 * `items.required` includes "scene_id") into `writeCheckpoint()` WITHOUT
 * `overrideArtifactValidation`. Success for THIS script means the runtime
 * throws GateViolationError — the inverse of the golden script's assertion.
 *
 * Run:
 *   bun run --cwd bun-apps/s2-agent-ext-movie-director scripts/run-real-e2e-neuralnet-failure.ts
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  getStageOrder,
  writeCheckpoint as persistCheckpoint,
  validateArtifact,
  projectDir,
  GateViolationError,
} from "../src/index.ts";

const PIPELINE = "animated-explainer";
// A dedicated project id — deliberately NOT neuralnet-real-e2e-v1, so this
// script's intentionally-broken checkpoint never lands in the golden run's
// project history.
const PROJECT_ID = "neuralnet-real-e2e-failure-v1";
const PROJECT_DIR = projectDir(PROJECT_ID);
const ASSETS_DIR = join(PROJECT_DIR, "assets");

function log(who: string, msg: string): void {
  console.log(`\n[${who}] ${msg}`);
}

async function main(): Promise<void> {
  mkdirSync(ASSETS_DIR, { recursive: true });
  console.log(`movie-director deliberate-failure e2e — project: ${PROJECT_ID}`);
  console.log(`workspace: ${PROJECT_DIR}`);

  const order = getStageOrder(PIPELINE);
  if (order.length === 0) throw new Error(`pipeline "${PIPELINE}" not loadable`);
  log("preflight", `stages: ${order.join(" → ")}`);

  // Minimal upstream artifacts — same shape/content style as
  // run-real-e2e-neuralnet.ts's golden research/proposal/script/scene_plan,
  // trimmed to the fields those schemas require. Written schema-valid and
  // gated (humanApproved) exactly like the golden run, so the ONLY broken
  // artifact in this whole run is the asset_manifest below — isolating the
  // gate test to a single failure, not a pileup of unrelated ones.
  const researchBrief = {
    version: "1.0",
    topic: "How Neural Networks Learn",
    research_date: "2026-07-11",
    landscape: {
      existing_content: [
        { title: "What is Backpropagation? | IBM", url: "https://www.ibm.com/think/topics/backpropagation", source: "IBM", angle: "encyclopedia-style technical definition", what_it_covers: "formal definition", what_it_misses: "no narrative hook" },
        { title: "How neural networks learn: deep dive", url: "https://indepth.dev/posts/1001/en/how-neural-networks-learn-backpropagation-gradient-descent/", source: "indepth.dev", angle: "engineer-audience deep dive", what_it_covers: "guess/error/adjust loop", what_it_misses: "assumes calculus background" },
        { title: "How Neural Networks Learn: Gradient Descent, Backpropagation, and Building Intuition", url: "https://medium.com/@theshubhamgoel/how-neural-networks-learn-gradient-descent-backpropagation-and-building-intuition-32d807542e31", source: "Medium", angle: "intuition-first", what_it_covers: "millions/billions of parameters framing", what_it_misses: "no citations" },
      ],
      saturated_angles: ["math-first derivation of the loss function"],
      underserved_gaps: ["a plain-language two-shot version naming both algorithms"],
    },
    data_points: [
      { claim: "Backpropagation computes direction; gradient descent takes the step.", source_url: "https://www.ibm.com/think/topics/backpropagation", credibility: "primary_source" },
      { claim: "Training repeats predict/measure/adjust across millions of parameters.", source_url: "https://medium.com/@theshubhamgoel/how-neural-networks-learn-gradient-descent-backpropagation-and-building-intuition-32d807542e31", credibility: "secondary_source" },
      { claim: "The two algorithms run in a loop until loss is minimal.", source_url: "https://indepth.dev/posts/1001/en/how-neural-networks-learn-backpropagation-gradient-descent/", credibility: "secondary_source" },
    ],
    audience_insights: {
      common_questions: ["What does 'learning' mean for a neural network?", "Is backpropagation the same as gradient descent?", "Why millions of repetitions?"],
      misconceptions: [{ myth: "A network memorizes exact answers.", reality: "It adjusts weights based on error, not stored answers." }],
      knowledge_level: "beginner",
    },
    angles_discovered: [
      { name: "guess-and-correct", hook: "A network isn't smart on day one.", type: "evergreen", why_now: "mainstream AI adoption" },
      { name: "two-algorithm-duo", hook: "Two algorithms, one loop.", type: "narrative", why_now: "most explainers conflate the two" },
      { name: "sunlight-scale-training", hook: "Millions of tiny corrections become a skill.", type: "data_driven", why_now: "grounds an abstract loop in a concrete count" },
    ],
    sources: [
      { url: "https://www.ibm.com/think/topics/backpropagation", title: "What is Backpropagation? | IBM", used_for: "core definition" },
      { url: "https://indepth.dev/posts/1001/en/how-neural-networks-learn-backpropagation-gradient-descent/", title: "How neural networks learn: deep dive", used_for: "loop framing" },
      { url: "https://medium.com/@theshubhamgoel/how-neural-networks-learn-gradient-descent-backpropagation-and-building-intuition-32d807542e31", title: "Building Intuition", used_for: "parameter-count framing" },
      { url: "https://www.pluralsight.com/courses/neural-networks-exploring-architecture-gradient-descent-backpropagation", title: "Pluralsight course", used_for: "landscape scan" },
      { url: "https://datajourney24.substack.com/p/demystifying-backpropagation-and", title: "Demystifying Backpropagation & Gradient Descent", used_for: "misconception framing" },
    ],
  };

  function assertValid(name: string, data: unknown): void {
    const v = validateArtifact(name, data);
    if (!v.ok) throw new Error(`${name} artifact schema validation failed (should have been schema-valid — this run only intends to break asset_manifest):\n  ${v.errors.join("\n  ")}`);
    log(name, "✓ schema-valid");
  }

  assertValid("research_brief", researchBrief);
  persistCheckpoint({ projectId: PROJECT_ID, pipeline: PIPELINE, stage: "research", status: "completed", artifacts: { research_brief: researchBrief }, humanApproved: true });
  log("research", "✓ checkpoint completed (humanApproved)");

  // scene1.png must exist for asset_manifest's `path` to be a real file (not
  // required by the schema, but keeps this fixture honest about what a real
  // asset_manifest points at). Reuse the golden run's cached asset if present;
  // this script does not spend any real MLX/TTS time either way.
  const goldenAssetsDir = join(projectDir("neuralnet-real-e2e-v1"), "assets");
  const scene1Png = join(goldenAssetsDir, "scene1.png");
  const narrationAiff = join(projectDir("neuralnet-real-e2e-v1"), "narration.aiff");

  // ─── the deliberately broken artifact ───────────────────────────────────
  // asset_manifest.schema.json → properties.assets.items.required includes
  // "scene_id". This asset is missing it — a genuinely invalid artifact, not
  // a contrived edge case; it is exactly the kind of thing a careless
  // agent-authored checkpoint could ship.
  const brokenAssetManifest = {
    version: "1.0",
    assets: [
      {
        id: "scene1",
        type: "image",
        path: existsSync(scene1Png) ? scene1Png : join(ASSETS_DIR, "scene1.png"),
        source_tool: "runpy-image",
        // scene_id: MISSING — this is the injected defect.
        prompt: "Abstract glowing neural network diagram",
        seed: 501,
        model: "zimage-turbo",
      },
      {
        id: "narration_full",
        type: "narration",
        path: existsSync(narrationAiff) ? narrationAiff : join(PROJECT_DIR, "narration.aiff"),
        source_tool: "macos:say",
        scene_id: "_all",
      },
    ],
    total_cost_usd: 0,
  };

  const preCheck = validateArtifact("asset_manifest", brokenAssetManifest);
  log("asset_manifest", preCheck.ok ? "✗ unexpectedly schema-valid (fixture is broken, fix the test)" : `✓ confirmed schema-invalid (as intended): ${preCheck.errors.join("; ")}`);
  if (preCheck.ok) {
    console.error("\n✗ deliberate-failure e2e FAILED: the injected defect did not make asset_manifest schema-invalid — the fixture itself is broken, not proving anything about the gate.");
    process.exit(1);
  }

  // ─── the actual test: does the RUNTIME gate (writeCheckpoint), not just
  // this script's own pre-check, refuse to complete the stage? ───────────
  let gateStoppedIt = false;
  let caughtMessage = "";
  try {
    persistCheckpoint({
      projectId: PROJECT_ID,
      pipeline: PIPELINE,
      stage: "assets",
      status: "completed",
      artifacts: { asset_manifest: brokenAssetManifest },
      humanApproved: true,
      // Deliberately NOT setting overrideArtifactValidation — the whole
      // point is to confirm the gate refuses without it.
    });
  } catch (err) {
    if (err instanceof GateViolationError) {
      gateStoppedIt = true;
      caughtMessage = err.message;
    } else {
      throw err; // an unexpected error type is a real bug, not the gate working
    }
  }

  console.log(`\n${"=".repeat(72)}`);
  if (gateStoppedIt) {
    console.log("✓ DELIBERATE-FAILURE E2E PASSED — runtime GateViolationError stopped the");
    console.log("  broken asset_manifest (missing scene_id) from completing the assets stage.");
    console.log(`  caught: ${caughtMessage.split("\n")[0]}`);
    console.log("=".repeat(72));
  } else {
    console.log("✗ DELIBERATE-FAILURE E2E FAILED — the broken asset_manifest completed the");
    console.log("  assets stage WITHOUT overrideArtifactValidation. The runtime gate has a hole.");
    console.log("=".repeat(72));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n✗ deliberate-failure e2e crashed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
