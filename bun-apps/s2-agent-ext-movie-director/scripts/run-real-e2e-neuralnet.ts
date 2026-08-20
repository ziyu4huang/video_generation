/**
 * run-real-e2e-neuralnet.ts — second REAL end-to-end movie-director video,
 * a NEW story disjoint from the H-real (solar panel, flux2) and the agent-driven
 * skyblue (why the sky is blue) runs.
 *
 * Story: "How Neural Networks Learn" — from OpenMontage's Quick Start prompt
 * class ("Make a 45-second animated explainer about ...", zero-key path).
 * Research is grounded in real, cited sources (IBM, indepth.dev, Medium — see
 * research_brief.sources below), not invented facts.
 *
 * Unlike run-h-real.ts (flux2 + overrideArtifactValidation for proposal/script)
 * this script writes EVERY checkpoint schema-VALID against the canonical
 * artifact schemas — zero overrideArtifactValidation calls — proving the
 * CONCEPT-stage gate (closed 2026-07-10) composes cleanly with a full real
 * pipeline run when the artifact content is authored against the schema's
 * actual required/enum fields (all discovered from
 * data/schemas/artifacts/*.schema.json, not guessed).
 *
 * Mirrors the assets-stage tooling actually used by the real skyblue e2e:
 * runpy-image (local MLX Z-Image T2I) for visuals, macOS `say` for narration,
 * compose-motion (ffmpeg zoompan + xfade) for render — no Remotion/browser
 * dependency, no cloud spend.
 *
 * Run:
 *   bun run --cwd bun-apps/s2-agent-ext-movie-director scripts/run-real-e2e-neuralnet.ts
 *
 * Fast schema-iteration loop: `SKIP_ASSETS=1 bun run ... scripts/run-real-e2e-neuralnet.ts`
 * reuses this project's already-generated narration.aiff / <scene>.png (copied to
 * a deterministic path after the first real run) instead of re-running MLX T2I /
 * `say`, so a checkpoint-JSON-only fix costs ~1s instead of ~40s+ per re-run. Falls
 * back to a real generation automatically if the cached file is missing.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  getStageOrder,
  getStageCheckpointRequired,
  getCompletedStages,
  writeCheckpoint as persistCheckpoint,
  validateArtifact,
  preComposeGate,
  composeMotion,
  finalReview,
  estimate as costEstimate,
  reserve as costReserve,
  reconcile as costReconcile,
  costSnapshot,
  projectDir,
  runPyImage,
  GateViolationError,
  type RemotionEditDecisions,
} from "../src/index.ts";

// ─── config ──────────────────────────────────────────────────────────────────

const PIPELINE = "animated-explainer";
const PROJECT_ID = "neuralnet-real-e2e-v1";
const PROJECT_DIR = projectDir(PROJECT_ID);
const ASSETS_DIR = join(PROJECT_DIR, "assets");
const WIDTH = 1024;
const HEIGHT = 576;
const FPS = 24;
const T2I = { steps: 9, width: WIDTH, height: HEIGHT } as const;
const SKIP_ASSETS = process.env.SKIP_ASSETS === "1";

const SHOTS = [
  {
    id: "scene1",
    start: 0,
    end: 10,
    animation: "ken-burns" as const,
    seed: 501,
    prompt:
      "Abstract glowing neural network diagram, nodes and connections pulsing " +
      "with soft blue light on a dark background, one connection highlighted in " +
      "warm orange as if being adjusted, minimalist data-visualization aesthetic, " +
      "high detail, dark cinematic background",
    narration:
      "A neural network isn't smart on day one. It makes a guess, checks how wrong " +
      "it was, and quietly adjusts itself to do better next time.",
  },
  {
    id: "scene2",
    start: 10,
    end: 20,
    animation: "zoom-in" as const,
    seed: 502,
    prompt:
      "Extreme macro close-up of a single glowing synapse-like connection node, " +
      "warm orange light flowing along the connection line toward a bright " +
      "convergence point, clean modern data-visualization aesthetic, dark " +
      "background, cinematic lighting",
    narration:
      "Two algorithms do the work: backpropagation figures out which direction to " +
      "nudge each connection, and gradient descent takes that step. Repeat millions " +
      "of times, and the guess becomes a skill.",
  },
] as const;

const NARRATION_TEXT = SHOTS.map((s) => s.narration).join(" ");

// ─── helpers ─────────────────────────────────────────────────────────────────

function log(who: string, msg: string): void {
  console.log(`\n[${who}] ${msg}`);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", (err) => rejectP(new Error(`${cmd} failed to spawn: ${err.message}`)));
    p.on("exit", (code) => (code === 0 ? resolveP(`${cmd} ok`) : rejectP(new Error(`${cmd} exited ${code}`))));
  });
}

/** Generate ONE scene image via runpy-image (real local MLX Z-Image T2I). */
async function generateScene(shot: (typeof SHOTS)[number]): Promise<{ path: string; seed: number }> {
  const cachedPng = join(ASSETS_DIR, `${shot.id}.png`);
  if (SKIP_ASSETS && existsSync(cachedPng)) {
    log("assets", `SKIP_ASSETS=1 → reusing cached ${shot.id} → ${cachedPng}`);
    return { path: cachedPng, seed: shot.seed };
  }
  log("assets", `runpy-image t2i → ${shot.id} (seed ${shot.seed}, ${T2I.width}x${T2I.height}, ${T2I.steps} steps)`);
  const entryId = costEstimate(PROJECT_ID, "runpy-image", `image_generation:t2i:${shot.id}`, 0);
  costReserve(PROJECT_ID, entryId);
  const out = await runPyImage({
    options: { action: "t2i", prompt: shot.prompt, seed: shot.seed, steps: T2I.steps, width: T2I.width, height: T2I.height },
    outputDir: ASSETS_DIR,
  });
  costReconcile(PROJECT_ID, entryId, 0, out.details.ok);
  if (!out.details.ok || out.details.outputs.length === 0) {
    throw new Error(`scene ${shot.id} generation failed: ${out.stderrTail}`);
  }
  const png = out.details.outputs[0]!;
  if (!existsSync(png.path)) throw new Error(`scene ${shot.id}: reported PNG missing at ${png.path}`);
  copyFileSync(png.path, cachedPng);
  log("assets", `✓ ${shot.id} → ${png.path} (model=${out.details.model}, ${out.details.elapsedSeconds?.toFixed(1) ?? "?"}s, cached → ${cachedPng})`);
  return { path: png.path, seed: png.seed ?? shot.seed };
}

async function generateNarration(): Promise<string> {
  const aiff = join(PROJECT_DIR, "narration.aiff");
  if (SKIP_ASSETS && existsSync(aiff)) {
    log("assets", `SKIP_ASSETS=1 → reusing cached narration → ${aiff}`);
    return aiff;
  }
  log("assets", "narration → macOS say (local TTS)");
  await run("say", ["-v", "Samantha", "-r", "175", "-o", aiff, NARRATION_TEXT]);
  if (!existsSync(aiff)) throw new Error("say produced no narration file");
  log("assets", `✓ narration → ${aiff}`);
  return aiff;
}

function writeCheckpointGated(stage: string, artifacts: Record<string, unknown>): void {
  writeCheckpointStage(stage, artifacts, true);
}
function writeCheckpoint(stage: string, artifacts: Record<string, unknown>): void {
  writeCheckpointStage(stage, artifacts, false);
}
function writeCheckpointStage(stage: string, artifacts: Record<string, unknown>, humanApproved: boolean): void {
  try {
    // No overrideArtifactValidation anywhere in this script — every artifact
    // below is authored against its canonical schema's required/enum fields.
    persistCheckpoint({ projectId: PROJECT_ID, pipeline: PIPELINE, stage, status: "completed", artifacts, humanApproved });
    log(stage, `✓ checkpoint completed${humanApproved ? " (humanApproved)" : ""}`);
  } catch (err) {
    if (err instanceof GateViolationError) throw new Error(`GATE at ${stage}: ${err.message}`);
    throw err;
  }
}
function assertValid(name: string, data: unknown): void {
  const v = validateArtifact(name, data);
  if (!v.ok) throw new Error(`${name} artifact schema validation failed:\n  ${v.errors.join("\n  ")}`);
  log(name, "✓ schema-valid");
}

// ─── the pipeline ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(ASSETS_DIR, { recursive: true });
  console.log(`movie-director real e2e #2 — project: ${PROJECT_ID}`);
  console.log(`workspace: ${PROJECT_DIR}`);

  const order = getStageOrder(PIPELINE);
  if (order.length === 0) throw new Error(`pipeline "${PIPELINE}" not loadable`);
  log("preflight", `stages: ${order.join(" → ")}`);

  // 1. research (gated) — grounded in real, cited sources (web search 2026-07-11).
  const researchBrief = {
    version: "1.0",
    topic: "How Neural Networks Learn",
    research_date: "2026-07-11",
    landscape: {
      existing_content: [
        {
          title: "What is Backpropagation? | IBM",
          url: "https://www.ibm.com/think/topics/backpropagation",
          source: "IBM",
          angle: "encyclopedia-style technical definition",
          what_it_covers: "formal definition of backpropagation and its relationship to gradient descent",
          what_it_misses: "no plain-language narrative hook, no visual metaphor",
        },
        {
          title: "How Neural Networks Learn: Exploring Architecture, Gradient Descent, and Backpropagation",
          url: "https://www.pluralsight.com/courses/neural-networks-exploring-architecture-gradient-descent-backpropagation",
          source: "Pluralsight",
          angle: "full-course, architecture-first walkthrough",
          what_it_covers: "network architecture plus the training loop end to end",
          what_it_misses: "paid course length (hours), not a short-form hook",
        },
        {
          title: "How neural networks learn: deep dive into backpropagation and gradient descent",
          url: "https://indepth.dev/posts/1001/en/how-neural-networks-learn-backpropagation-gradient-descent/",
          source: "indepth.dev",
          angle: "engineer-audience technical deep dive",
          what_it_covers: "the guess → error → adjust loop, with derivations",
          what_it_misses: "assumes calculus background, not beginner-accessible",
        },
      ],
      saturated_angles: [
        "math-first derivation of the loss function with equations on screen",
        "generic 'a neural network is like a brain' analogy",
      ],
      underserved_gaps: [
        "a plain-language two-shot version that names backpropagation and gradient descent as a duo, without deriving either",
      ],
    },
    data_points: [
      {
        claim: "Backpropagation computes which direction to adjust each weight; gradient descent takes the step in that direction.",
        source_url: "https://www.ibm.com/think/topics/backpropagation",
        credibility: "primary_source",
      },
      {
        claim: "Training a neural network means finding the right values for millions or billions of parameters by repeatedly predicting, measuring error, and adjusting.",
        source_url: "https://medium.com/@theshubhamgoel/how-neural-networks-learn-gradient-descent-backpropagation-and-building-intuition-32d807542e31",
        credibility: "secondary_source",
      },
      {
        claim: "The two algorithms run in a loop: backpropagation finds the direction, gradient descent applies the step, repeated until the loss is minimal.",
        source_url: "https://indepth.dev/posts/1001/en/how-neural-networks-learn-backpropagation-gradient-descent/",
        credibility: "secondary_source",
      },
    ],
    audience_insights: {
      common_questions: [
        "What does 'learning' actually mean for a neural network?",
        "Is backpropagation the same thing as gradient descent?",
        "Why does it take millions of repetitions instead of getting it right immediately?",
      ],
      misconceptions: [
        {
          myth: "A neural network learns by memorizing exact answers.",
          reality: "It adjusts internal connection weights based on how wrong its guess was, not by storing answers.",
        },
      ],
      knowledge_level: "beginner",
    },
    angles_discovered: [
      {
        name: "guess-and-correct",
        hook: "A network isn't smart on day one — it learns by being wrong, on purpose, over and over.",
        type: "evergreen",
        why_now: "generative AI adoption made 'how does it learn' a mainstream question, not just a CS-class one",
      },
      {
        name: "two-algorithm-duo",
        hook: "Two algorithms, one loop: backpropagation finds the direction, gradient descent takes the step.",
        type: "narrative",
        why_now: "most explainers conflate the two; naming them separately is the underserved gap",
      },
      {
        name: "sunlight-scale-training",
        hook: "It takes millions of tiny corrections for a guess to become a skill — the same 'small repeated steps' story as compound interest.",
        type: "data_driven",
        why_now: "grounds an abstract training loop in a concrete repetition count instead of hand-waving 'lots of training'",
      },
    ],
    sources: [
      { url: "https://www.ibm.com/think/topics/backpropagation", title: "What is Backpropagation? | IBM", used_for: "core definition of backpropagation + gradient descent relationship" },
      { url: "https://indepth.dev/posts/1001/en/how-neural-networks-learn-backpropagation-gradient-descent/", title: "How neural networks learn: deep dive into backpropagation and gradient descent", used_for: "the guess → error → adjust loop framing" },
      { url: "https://medium.com/@theshubhamgoel/how-neural-networks-learn-gradient-descent-backpropagation-and-building-intuition-32d807542e31", title: "How Neural Networks Learn: Gradient Descent, Backpropagation, and Building Intuition", used_for: "millions/billions of parameters framing" },
      { url: "https://www.pluralsight.com/courses/neural-networks-exploring-architecture-gradient-descent-backpropagation", title: "How Neural Networks Learn: Exploring Architecture, Gradient Descent, and Backpropagation", used_for: "landscape scan of existing course-style coverage" },
      { url: "https://datajourney24.substack.com/p/demystifying-backpropagation-and", title: "Demystifying Backpropagation & Gradient Descent", used_for: "confirming the beginner-misconception framing is a recurring pain point across sources" },
    ],
  };
  assertValid("research_brief", researchBrief);
  writeCheckpointGated("research", { research_brief: researchBrief });

  // 2. proposal (gated).
  const proposalPacket = {
    version: "1.0",
    concept_options: [
      {
        id: "c1",
        title: "Guess, Check, Correct",
        hook: "A network isn't smart on day one — it learns by being wrong, on purpose.",
        narrative_structure: "problem_solution",
        visual_approach: "abstract glowing network diagram → macro close-up on a single connection adjusting",
        target_duration_seconds: 20,
        why_this_works: "translates two named algorithms into one visual beat, no equations, resolves the underserved 'guess and correct' gap",
      },
      {
        id: "c2",
        title: "A Day in the Life of a Weight",
        hook: "first-person: one parameter's journey through a single training step",
        narrative_structure: "story",
        visual_approach: "macro shot of a glowing synapse-like connection, POV framing",
        target_duration_seconds: 20,
        why_this_works: "personifies an abstract concept but risks being cute over clear",
      },
      {
        id: "c3",
        title: "The Two-Algorithm Duo",
        hook: "data-forward: name backpropagation and gradient descent as a pair",
        narrative_structure: "comparison",
        visual_approach: "split-screen diagram contrasting the two algorithms",
        target_duration_seconds: 20,
        why_this_works: "directly resolves the misconception that they're the same algorithm",
      },
    ],
    selected_concept: {
      concept_id: "c1",
      rationale: "clearest visual translation of the 'guess and correct' gap identified in research; avoids the saturated math-first angle",
    },
    production_plan: {
      pipeline: PIPELINE,
      stages: order.map((s) => ({ stage: s, tools: [], approach: "local MLX + macOS say + ffmpeg compose-motion" })),
      renderer_family: "explainer-data",
      render_runtime: "ffmpeg",
      composition_mode: "templated",
    },
    cost_estimate: {
      total_estimated_usd: 0,
      line_items: [
        { tool: "runpy-image:t2i", operation: "2x native local MLX T2I", estimated_usd: 0 },
        { tool: "macos:say", operation: "local TTS narration", estimated_usd: 0 },
      ],
      budget_verdict: "within_budget",
    },
    approval: { status: "approved" },
  };
  assertValid("proposal_packet", proposalPacket);
  writeCheckpointGated("proposal", { proposal_packet: proposalPacket, decision_log: { selected: "c1" } });

  // 3. script (gated).
  const script = {
    version: "1.0",
    title: "How Neural Networks Learn",
    total_duration_seconds: 20,
    sections: SHOTS.map((s) => ({ id: s.id, text: s.narration, start_seconds: s.start, end_seconds: s.end })),
  };
  assertValid("script", script);
  writeCheckpointGated("script", { script });

  // 4. scene_plan (gated).
  const scenePlan = {
    version: "1.0",
    style_playbook: "clean-professional",
    scenes: SHOTS.map((s) => ({
      id: s.id,
      type: "generated",
      description: s.prompt,
      start_seconds: s.start,
      end_seconds: s.end,
      script_section_id: s.id,
      shot_intent: s.id === "scene1" ? "establish the guess-and-correct idea" : "reveal the two-algorithm mechanism",
      narrative_role: s.id === "scene1" ? "establish_context" : "deliver_payload",
      shot_language: {
        shot_size: s.id === "scene1" ? "establishing" : "extreme_close_up",
        camera_movement: "zoom_in",
        lighting_key: "low_key",
        depth_of_field: "medium",
        color_temperature: "cool",
      },
      required_assets: [{ type: "image", description: s.prompt, source: "generate" }],
    })),
  };
  assertValid("scene_plan", scenePlan);
  writeCheckpointGated("scene_plan", { scene_plan: scenePlan });

  // 5. assets (gated) — REAL generation, one scene at a time.
  const narrationAiff = await generateNarration();
  const sceneResults: Array<{ shot: (typeof SHOTS)[number]; png: string; seed: number }> = [];
  for (const shot of SHOTS) {
    const r = await generateScene(shot);
    sceneResults.push({ shot, png: r.path, seed: r.seed });
  }
  const assetManifest = {
    version: "1.0",
    assets: [
      {
        id: "narration_full",
        type: "narration",
        path: narrationAiff,
        source_tool: "macos:say",
        scene_id: "_all",
        duration_seconds: 20,
        generation_summary: "Local macOS `say` (Samantha voice), no cloud TTS.",
      },
      ...sceneResults.map(({ shot, png, seed }) => ({
        id: shot.id,
        type: "image" as const,
        path: png,
        source_tool: "runpy-image",
        scene_id: shot.id,
        prompt: shot.prompt,
        seed,
        model: "zimage-turbo",
        provider: "runpy-image",
        resolution: `${T2I.width}x${T2I.height}`,
        format: "png",
        subtype: "generated",
        generation_summary: `Local MLX Z-Image T2I via python run.py, ${T2I.steps} steps.`,
      })),
    ],
    total_cost_usd: 0,
  };
  assertValid("asset_manifest", assetManifest);
  writeCheckpointGated("assets", { asset_manifest: assetManifest });

  // 6. edit (not gated).
  const editDecisions = {
    version: "1.0",
    render_runtime: "ffmpeg",
    renderer_family: "explainer-data",
    composition_mode: "templated",
    cuts: SHOTS.map((s, i) => ({
      id: s.id,
      source: sceneResults[i]!.png,
      in_seconds: 0,
      out_seconds: s.end - s.start,
      transform: { animation: s.animation },
      transition_in: i === 0 ? "fade" : "dissolve",
      transition_duration: 0.5,
      reason: `${s.animation} motion over ${s.id}`,
    })),
    audio: { narration: { segments: SHOTS.map((s) => ({ asset_id: "narration_full", start_seconds: s.start, end_seconds: s.end })) } },
  };
  assertValid("edit_decisions", editDecisions);
  writeCheckpoint("edit", { edit_decisions: editDecisions });

  // 7. compose — pre-compose gate, then compose-motion (ffmpeg zoompan+xfade).
  const motionEdit: RemotionEditDecisions = {
    version: "1.0",
    cuts: SHOTS.map((s, i) => ({
      id: s.id,
      source: sceneResults[i]!.png,
      in_seconds: s.start,
      out_seconds: s.end,
      type: "media" as const,
      animation: s.animation,
    })),
    audio: { narration: { src: narrationAiff, volume: 1 } },
    transition: "crossfade",
    transitionSeconds: 0.5,
    theme: "dark",
  };
  const gate = await preComposeGate(motionEdit);
  log("compose", `pre-compose gate: ${gate.verdict} — ${gate.checks.map((c) => `${c.name}=${c.status}`).join(", ")}`);
  if (gate.verdict === "fail") throw new Error(`pre-compose gate FAILED — refusing to render: ${JSON.stringify(gate.checks)}`);

  const mp4 = join(PROJECT_DIR, "neuralnet_explainer_20s.mp4");
  log("compose", `compose-motion → ${mp4} (${WIDTH}x${HEIGHT}@${FPS})`);
  const report = await composeMotion(motionEdit, { workDir: PROJECT_DIR, output: mp4, width: WIDTH, height: HEIGHT, fps: FPS });
  if (report.outputs.length === 0) {
    throw new Error(`compose-motion produced no output. warnings=${JSON.stringify(report.warnings)} notes=${JSON.stringify(report.verification_notes)}`);
  }
  const out = report.outputs[0]!;
  log("compose", `✓ rendered ${out.resolution} ${out.codec} / audio ${out.audio_codec ?? "?"}, ${out.duration_seconds?.toFixed(2)}s, ${out.file_size_bytes ?? "?"} bytes`);
  // composeMotion now reconciles the audio-mixed/captioned result back onto
  // opts.output (fixed 2026-07-11 — see next-goal.md's compose-motion
  // output-path finding), so out.path === mp4 here; kept as out.path since
  // that's always correct regardless of which internal stage ran last.
  const finalMp4 = out.path;

  // 8. final_review.
  const review = await finalReview(finalMp4);
  log("final-review", `verdict=${review.verdict}`);
  for (const c of review.checks) console.log(`    ${c.status.padEnd(4)} ${c.name}: ${c.detail}`);
  if (review.verdict !== "pass") throw new Error(`final_review verdict=${review.verdict} — not shippable`);
  writeCheckpoint("compose", { render_report: report, final_review: review });

  // 9. publish (gated).
  const publishLog = {
    version: "1.0",
    entries: [
      {
        platform: "local_export",
        status: "exported",
        timestamp: "2026-07-11T00:00:00Z",
        export_path: finalMp4,
      },
    ],
  };
  assertValid("publish_log", publishLog);
  writeCheckpointGated("publish", { publish_log: publishLog });

  // 10. cost snapshot + gate summary.
  const snap = costSnapshot(PROJECT_ID);
  log("cost", `spent=$${snap.total_spent_usd} reserved=$${snap.total_reserved_usd} remaining=$${snap.budget_remaining_usd}`);

  const completed = getCompletedStages(PROJECT_ID, PIPELINE);
  const checkpointed = order.filter((s) => getStageCheckpointRequired(PIPELINE, s));
  console.log(`\n${"=".repeat(72)}`);
  console.log(`completed checkpointed stages: ${completed.join(", ")}`);
  const missing = checkpointed.filter((s) => !completed.includes(s));
  const allGreen = missing.length === 0 && review.verdict === "pass";
  console.log(`final_review: ${review.verdict} (${review.checks.filter((c) => c.status === "pass").length}/${review.checks.length} pass)`);
  console.log(`mp4: ${finalMp4}`);
  console.log(`project: ${PROJECT_DIR}`);
  console.log(allGreen ? "✓ REAL E2E #2 GATE PASSED — schema-valid checkpoints throughout, real mp4." : `✗ gate NOT met; missing stages: ${missing.join(", ")}`);
  console.log("=".repeat(72));
  if (!allGreen) process.exit(1);
}

main().catch((err) => {
  console.error(`\n✗ real e2e #2 failed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
