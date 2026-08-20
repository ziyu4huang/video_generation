/**
 * run-real-e2e-neuralnet-v4-motion.ts — Phase 2 of the motion+voice improvement
 * plan (2026-07-11): the SAME "How Neural Networks Learn" story as
 * run-real-e2e-neuralnet.ts (v2), but with the two real quality gaps closed:
 *
 * 1. REAL motion, not fake zoompan. v2's `assets` stage only ever ran
 *    runpy-image T2I (a static PNG per scene); compose-motion's ffmpeg
 *    `zoompan` filter then faked a pan/zoom over that still. This script adds
 *    a Stage 2: each scene's T2I still is fed into `run.py video t2i2v
 *    --from-image` (LTX-2.3 I2V, via runPyVideo from @repo/s2-agent-ext-ltx —
 *    the SAME provider already registered as `ltx_video_runpy` in registry.ts,
 *    just never previously invoked by this pipeline's own scripts) to produce
 *    a genuinely animated clip. compose_motion.ts already auto-detects a video
 *    source by extension and skips zoompan for it — ZERO changes needed there;
 *    feeding it real .mp4 segments instead of .png stills is the entire fix.
 *
 * 2. Natural narration, not `say`. Uses the new `run.py tts` / runPyTts
 *    (Phase 1, 2026-07-11) edge-tts adapter instead of macOS `say`.
 *
 * MEASURED COST (Phase 0 validation, 2026-07-11): ~3 min of real LTX I2V
 * compute per 5-second/121-frame clip on this hardware (Apple Silicon MLX).
 * At 10s/scene (241 frames) that's roughly ~6 min/scene, ~12 min total for
 * both scenes — 15-20x the ~40s v2 cost. SKIP_ASSETS=1 caches BOTH the T2I
 * still AND the I2V motion clip to deterministic paths so a checkpoint-JSON-
 * only schema iteration still costs ~seconds, not ~12 minutes, on every rerun
 * after the first.
 *
 * Run (first time, real generation — budget ~12-15 minutes):
 *   bun run --cwd bun-apps/s2-agent-ext-movie-director scripts/run-real-e2e-neuralnet-v4-motion.ts
 * Re-run after the first (cached, ~seconds):
 *   SKIP_ASSETS=1 bun run --cwd bun-apps/s2-agent-ext-movie-director scripts/run-real-e2e-neuralnet-v4-motion.ts
 */
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { runPyVideo } from "@repo/s2-agent-ext-ltx";
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
  runPyTts,
  GateViolationError,
  type RemotionEditDecisions,
} from "../src/index.ts";

// ─── config ──────────────────────────────────────────────────────────────────

const PIPELINE = "animated-explainer";
const PROJECT_ID = "neuralnet-real-e2e-v4-motion";
const PROJECT_DIR = projectDir(PROJECT_ID);
const ASSETS_DIR = join(PROJECT_DIR, "assets");
const WIDTH = 768;
const HEIGHT = 448; // LTX auto-fit budget from the Phase 0 probe (1024x576 in -> 768x448 working res)
const FPS = 24;
const T2I = { steps: 9, width: 1024, height: 576 } as const;
const TTS_VOICE = "en-US-AriaNeural";
const SKIP_ASSETS = process.env.SKIP_ASSETS === "1";

const SHOTS = [
  {
    id: "scene1",
    start: 0,
    end: 10,
    seed: 501,
    prompt:
      "Abstract glowing neural network diagram, nodes and connections pulsing " +
      "with soft blue light on a dark background, one connection highlighted in " +
      "warm orange as if being adjusted, minimalist data-visualization aesthetic, " +
      "high detail, dark cinematic background",
    motionPrompt:
      "Abstract glowing neural network diagram, nodes and connections pulsing " +
      "with soft blue light, one connection highlighted in warm orange, camera " +
      "slowly pushing in, subtle parallax drift, the orange highlight gently " +
      "spreading along adjacent connections as if the network is adjusting itself",
    narration:
      "A neural network isn't smart on day one. It makes a guess, checks how wrong " +
      "it was, and quietly adjusts itself to do better next time.",
  },
  {
    id: "scene2",
    start: 10,
    end: 20,
    seed: 502,
    prompt:
      "Extreme macro close-up of a single glowing synapse-like connection node, " +
      "warm orange light flowing along the connection line toward a bright " +
      "convergence point, clean modern data-visualization aesthetic, dark " +
      "background, cinematic lighting",
    motionPrompt:
      "Extreme macro close-up of a glowing synapse-like connection node, warm " +
      "orange light flowing steadily along the connection line toward a bright " +
      "convergence point, slow camera drift revealing more of the branching " +
      "structure, gentle pulsing glow",
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

/** Stage 1: T2I still for a scene (cached independently of the motion clip). */
async function generateStill(shot: (typeof SHOTS)[number]): Promise<{ path: string; seed: number }> {
  const cachedPng = join(ASSETS_DIR, `${shot.id}.png`);
  if (SKIP_ASSETS && existsSync(cachedPng)) {
    log("assets", `SKIP_ASSETS=1 → reusing cached still ${shot.id} → ${cachedPng}`);
    return { path: cachedPng, seed: shot.seed };
  }
  log("assets", `runpy-image t2i → ${shot.id} still (seed ${shot.seed}, ${T2I.width}x${T2I.height}, ${T2I.steps} steps)`);
  const entryId = costEstimate(PROJECT_ID, "runpy-image", `image_generation:t2i:${shot.id}`, 0);
  costReserve(PROJECT_ID, entryId);
  const out = await runPyImage({
    options: { action: "t2i", prompt: shot.prompt, seed: shot.seed, steps: T2I.steps, width: T2I.width, height: T2I.height },
    outputDir: ASSETS_DIR,
  });
  costReconcile(PROJECT_ID, entryId, 0, out.details.ok);
  if (!out.details.ok || out.details.outputs.length === 0) {
    throw new Error(`scene ${shot.id} still generation failed: ${out.stderrTail}`);
  }
  const png = out.details.outputs[0]!;
  if (!existsSync(png.path)) throw new Error(`scene ${shot.id}: reported PNG missing at ${png.path}`);
  copyFileSync(png.path, cachedPng);
  log("assets", `✓ ${shot.id} still → ${png.path} (model=${out.details.model}, ${out.details.elapsedSeconds?.toFixed(1) ?? "?"}s, cached → ${cachedPng})`);
  return { path: cachedPng, seed: png.seed ?? shot.seed };
}

/**
 * Stage 2: REAL LTX I2V motion clip from the T2I still. This is the actual
 * fix for the "no motion, only static images" gap — everything downstream
 * (asset_manifest, edit_decisions, compose-motion) treats the result as a
 * normal video source; compose_motion.ts's own extension-sniffing already
 * skips its zoompan fallback for real video files.
 */
async function generateMotion(
  shot: (typeof SHOTS)[number],
  stillPath: string,
): Promise<{ path: string; frames: number }> {
  const cachedMp4 = join(ASSETS_DIR, `${shot.id}_motion.mp4`);
  if (SKIP_ASSETS && existsSync(cachedMp4)) {
    log("assets", `SKIP_ASSETS=1 → reusing cached motion ${shot.id} → ${cachedMp4}`);
    return { path: cachedMp4, frames: Math.round((shot.end - shot.start) * FPS) + 1 };
  }
  const duration = shot.end - shot.start;
  // LTX-2.3 requires (frames-1) % 8 == 0 (8k+1); 10s@24fps -> 241 frames = 8*30+1, exact.
  const frames = Math.round(duration * FPS) + 1;
  log("assets", `ltx i2v → ${shot.id} motion (from-image, ${frames} frames @ ${FPS}fps ≈ ${duration}s, seed ${shot.seed})`);
  console.log(`  [assets] this stage is slow — measured ~3min per 5s/121-frame clip on this hardware; ~6min expected here`);
  const entryId = costEstimate(PROJECT_ID, "ltx-runpy", `video_generation:i2v:${shot.id}`, 0);
  costReserve(PROJECT_ID, entryId);
  const t0 = Date.now();
  // No outputDir override: the movie-director project workspace lives under
  // ~/video_generation__output (home-root), but runPyVideo's path-safety
  // sandbox only allows repo-root-or-parent locations — the two conventions
  // don't overlap. Let run.py write to its own default (allowed) output dir,
  // then copy the result into ASSETS_DIR below (same pattern generateStill
  // already uses for the T2I still).
  const out = await runPyVideo({
    options: {
      fromImage: stillPath,
      prompt: shot.motionPrompt,
      seed: shot.seed,
      frames,
      fps: FPS,
    },
  });
  const elapsed = (Date.now() - t0) / 1000;
  costReconcile(PROJECT_ID, entryId, 0, out.details.ok);
  if (!out.details.ok || !out.details.output) {
    throw new Error(`scene ${shot.id} I2V motion generation failed: ${out.stderrTail}`);
  }
  if (!existsSync(out.details.output)) throw new Error(`scene ${shot.id}: reported mp4 missing at ${out.details.output}`);
  copyFileSync(out.details.output, cachedMp4);
  log("assets", `✓ ${shot.id} motion → ${cachedMp4} (${elapsed.toFixed(1)}s real LTX I2V, model=${out.details.model ?? "ltx-2.3"}, cached)`);
  return { path: cachedMp4, frames };
}

async function generateNarration(): Promise<string> {
  const mp3 = join(PROJECT_DIR, "narration_edge.mp3");
  if (SKIP_ASSETS && existsSync(mp3)) {
    log("assets", `SKIP_ASSETS=1 → reusing cached narration → ${mp3}`);
    return mp3;
  }
  log("assets", `narration → edge-tts (Microsoft neural TTS, ${TTS_VOICE})`);
  const out = await runPyTts({ options: { text: NARRATION_TEXT, voice: TTS_VOICE }, output: mp3 });
  if (!out.details.ok) throw new Error(`edge-tts narration failed: ${out.stderrTail}`);
  log("assets", `✓ narration → ${mp3} (${out.details.sizeBytes} bytes)`);
  return mp3;
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
  console.log(`movie-director real e2e #4 (motion+voice) — project: ${PROJECT_ID}`);
  console.log(`workspace: ${PROJECT_DIR}`);

  const order = getStageOrder(PIPELINE);
  if (order.length === 0) throw new Error(`pipeline "${PIPELINE}" not loadable`);
  log("preflight", `stages: ${order.join(" → ")}`);

  // 1. research (gated) — same grounded sources as v2 (real, cited, unchanged story).
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
        visual_approach: "abstract glowing network diagram → macro close-up on a single connection adjusting, both with real LTX motion",
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
      stages: order.map((s) => ({ stage: s, tools: [], approach: "local MLX T2I + LTX-2.3 I2V motion + edge-tts narration + ffmpeg compose-motion" })),
      renderer_family: "explainer-data",
      render_runtime: "ffmpeg",
      composition_mode: "templated",
    },
    cost_estimate: {
      total_estimated_usd: 0,
      line_items: [
        { tool: "runpy-image:t2i", operation: "2x native local MLX T2I stills", estimated_usd: 0 },
        { tool: "ltx-runpy:i2v", operation: "2x native local LTX-2.3 I2V motion clips (~6min each)", estimated_usd: 0 },
        { tool: "edge-tts", operation: "natural-voice narration (Microsoft neural TTS)", estimated_usd: 0 },
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
      required_assets: [{ type: "video", description: s.motionPrompt, source: "generate" }],
    })),
  };
  assertValid("scene_plan", scenePlan);
  writeCheckpointGated("scene_plan", { scene_plan: scenePlan });

  // 5. assets (gated) — REAL generation: T2I still -> LTX I2V motion, per scene.
  const narrationMp3 = await generateNarration();
  const sceneResults: Array<{ shot: (typeof SHOTS)[number]; still: string; motion: string; frames: number; seed: number }> = [];
  for (const shot of SHOTS) {
    const still = await generateStill(shot);
    const motion = await generateMotion(shot, still.path);
    sceneResults.push({ shot, still: still.path, motion: motion.path, frames: motion.frames, seed: still.seed });
  }
  const assetManifest = {
    version: "1.0",
    assets: [
      {
        id: "narration_full",
        type: "narration",
        path: narrationMp3,
        source_tool: "edge-tts",
        scene_id: "_all",
        duration_seconds: 20,
        generation_summary: `Microsoft neural TTS (edge-tts, ${TTS_VOICE}), natural voice, no local robotic synthesis.`,
      },
      ...sceneResults.flatMap(({ shot, still, motion, frames, seed }) => [
        {
          id: `${shot.id}_still`,
          type: "image" as const,
          path: still,
          source_tool: "runpy-image",
          scene_id: shot.id,
          prompt: shot.prompt,
          seed,
          model: "zimage-turbo",
          provider: "runpy-image",
          resolution: `${T2I.width}x${T2I.height}`,
          format: "png",
          subtype: "i2v-source-still",
          generation_summary: `Local MLX Z-Image T2I via python run.py, ${T2I.steps} steps — the I2V seed frame for ${shot.id}.`,
        },
        {
          id: shot.id,
          type: "video" as const,
          path: motion,
          source_tool: "ltx-runpy",
          scene_id: shot.id,
          prompt: shot.motionPrompt,
          seed,
          model: "ltx-2.3-dasiwa",
          provider: "ltx-runpy",
          resolution: `${WIDTH}x${HEIGHT}`,
          duration_seconds: shot.end - shot.start,
          format: "mp4",
          subtype: "i2v-motion",
          generation_summary: `Local MLX LTX-2.3 I2V (${frames} frames @ ${FPS}fps) from ${shot.id}_still — real motion, not ffmpeg zoompan.`,
        },
      ]),
    ],
    total_cost_usd: 0,
  };
  assertValid("asset_manifest", assetManifest);
  writeCheckpointGated("assets", { asset_manifest: assetManifest });

  // 6. edit (not gated). Cuts point at the real motion .mp4 clips.
  const editDecisions = {
    version: "1.0",
    render_runtime: "ffmpeg",
    renderer_family: "explainer-data",
    composition_mode: "templated",
    cuts: sceneResults.map(({ shot, motion }) => ({
      id: shot.id,
      source: motion,
      in_seconds: 0,
      out_seconds: shot.end - shot.start,
      transform: { animation: "static" as const }, // real motion is baked into the source; compose_motion skips zoompan for video sources anyway
      transition_in: shot.id === "scene1" ? "fade" : "dissolve",
      transition_duration: 0.5,
      reason: `real LTX I2V motion clip for ${shot.id} (no ffmpeg-synthesized animation)`,
    })),
    audio: { narration: { segments: SHOTS.map((s) => ({ asset_id: "narration_full", start_seconds: s.start, end_seconds: s.end })) } },
  };
  assertValid("edit_decisions", editDecisions);
  writeCheckpoint("edit", { edit_decisions: editDecisions });

  // 7. compose — pre-compose gate, then compose-motion. Sources are real .mp4
  //    clips now; compose_motion.ts's isImage extension check routes them
  //    through the trim+scale path and skips zoompan entirely (no code change
  //    needed there — this is the whole point of the plan).
  const motionEdit: RemotionEditDecisions = {
    version: "1.0",
    cuts: sceneResults.map(({ shot, motion }) => ({
      id: shot.id,
      source: motion,
      // Relative to EACH clip's own timeline (0..duration), not the composed
      // output's absolute position (shot.start/shot.end) — for a real video
      // source, composeMotion's non-image branch does `-ss in_seconds` (a
      // literal seek INTO the source file), unlike a still image (-loop 1,
      // where in_seconds is a harmless no-op). Using shot.start/shot.end here
      // (v2's convention, safe only for stills) seeks 10s into scene2's own
      // ~10s clip, leaving ~0.04s — this collapsed the composed output to
      // ~10s total instead of ~20s on the first real run (2026-07-11).
      in_seconds: 0,
      out_seconds: shot.end - shot.start,
      type: "media" as const,
      animation: "static" as const,
    })),
    audio: { narration: { src: narrationMp3, volume: 1 } },
    transition: "crossfade",
    transitionSeconds: 0.5,
    theme: "dark",
  };
  const gate = await preComposeGate(motionEdit);
  log("compose", `pre-compose gate: ${gate.verdict} — ${gate.checks.map((c) => `${c.name}=${c.status}`).join(", ")}`);
  if (gate.verdict === "fail") throw new Error(`pre-compose gate FAILED — refusing to render: ${JSON.stringify(gate.checks)}`);

  const mp4 = join(PROJECT_DIR, "neuralnet_motion_20s.mp4");
  log("compose", `compose-motion → ${mp4} (${WIDTH}x${HEIGHT}@${FPS}, real motion sources)`);
  const report = await composeMotion(motionEdit, { workDir: PROJECT_DIR, output: mp4, width: WIDTH, height: HEIGHT, fps: FPS });
  if (report.outputs.length === 0) {
    throw new Error(`compose-motion produced no output. warnings=${JSON.stringify(report.warnings)} notes=${JSON.stringify(report.verification_notes)}`);
  }
  const out = report.outputs[0]!;
  log("compose", `✓ rendered ${out.resolution} ${out.codec} / audio ${out.audio_codec ?? "?"}, ${out.duration_seconds?.toFixed(2)}s, ${out.file_size_bytes ?? "?"} bytes`);
  // composeMotion reconciles the audio-mixed result back onto opts.output (fixed
  // 2026-07-11), so out.path === mp4 here; kept as out.path since that's always
  // correct regardless of which internal stage ran last.
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
  console.log(allGreen ? "✓ REAL E2E #4 (MOTION+VOICE) GATE PASSED — real LTX I2V motion + edge-tts narration throughout." : `✗ gate NOT met; missing stages: ${missing.join(", ")}`);
  console.log("=".repeat(72));
  if (!allGreen) process.exit(1);
}

main().catch((err) => {
  console.error(`\n✗ real e2e #4 (motion+voice) failed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
