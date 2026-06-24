// multi-character-compose — put two characters (same art style, different look) in ONE picture.
//
// WHY THIS EXISTS
//   MLX has no regional prompting / attention-couple / latent couple (the ComfyUI mechanisms
//   that let one image carry two different prompts in two regions). The cleanest MLX-faithful
//   route is the Latent-Couple approach: generate each character separately with a SHARED style
//   anchor (same transformer + identical style tags), composite the two LATENTS side-by-side,
//   then resume-denoise the merge so the DiT's self-attention crosses the seam and regenerates
//   ONE coherent background.
//
//   v1 of this workflow used a PIXEL composite + low-denoise i2i; that bakes two incompatible
//   backgrounds in (the VAE encode of a hard seam is a fact low denoise can't undo), so the
//   central seam stayed visible (~2/5 background continuity). v2 (this file) drives the
//   `image multicouple` command, which composites in LATENT space — see docs/multi-character-compose.md.
//
// PIPELINE (all GPU work is SERIAL — one model process, one command, Apple-Silicon-safe)
//   `run.py image multicouple` does all of:
//     1. generate charA  (return latent)
//     2. generate charB  (return latent)
//     3. composite latents side-by-side (feathered) → resume denoise → final
//   then this workflow adds:
//     4. Reflect — run.py caption (VLM) to understand + explain the result — self-reflection, default on
//
// Usage:
//   Workflow({ scriptPath: ".../multi-character-compose.js" })
//     → defaults: two dreamlike girls (luciddreamer-z), A=raven/petite/19 (seed 42),
//       B=auburn/athletic/26 (seed 777), merge-denoise 0.6, feather 8 — the samples shipped with this PR.
//   Workflow({ scriptPath: "...", args: {
//       transformer:"luciddreamer-z", width:640, height:960, steps:9,
//       mergeDenoise:0.6, mergeFeather:8,
//       style:"cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, painterly fantasy atmosphere",
//       charA:{ prompt:"<appearance A>", seed:42 },
//       charB:{ prompt:"<appearance B>", seed:777 },
//   }})
//
// NOTE — both characters must share the SAME transformer AND the SAME trailing style tags for
// style consistency. The per-character prompt should describe appearance + which side of the
// frame (left/right) + gaze direction, so the two face each other once composited.
//
// See docs/multi-character-compose.md for the technique + the ComfyUI rationale + the planned
// regional-attention R&D follow-up.

export const meta = {
  name: "multi-character-compose",
  description:
    "Put two characters (same art style, different look/body/age) in one picture via Latent-Couple: " +
    "run.py image multicouple generates each, composites the latents, and resume-denoises a unified " +
    "background; then a VLM reflect pass explains the result.",
  whenToUse:
    "Two distinct characters in a single coherent image with consistent style but different " +
    "appearance (e.g. two girls, different age/hair/build, same dreamlike art style).",
  phases: [
    { title: "Latent-Couple", detail: "run.py image multicouple — generate A+B, composite latents, resume-denoise one background" },
    { title: "Reflect", detail: "run.py caption (VLM) to understand + explain the result — self-reflection, default on" },
  ],
}

// ---------------------------------------------------------------------------
// Config — defaults reproduce the two-girl samples shipped with this PR.
// Caller `args` (if any) shallow-override these.
// ---------------------------------------------------------------------------

const PYTHON = "python/venv/bin/python"
const RUN = "python/mlx-movie-director/run.py"
const OUTPUT_DIR = "/Users/huangziyu/proj/video_generation__output"

const DEFAULTS = {
  pipeline: "zimage",
  transformer: "luciddreamer-z",
  width: 640,
  height: 960,
  steps: 9,
  // Trailing style tags appended to BOTH character prompts — the style-consistency lever.
  style:
    "cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, painterly fantasy atmosphere",
  // Latent-Couple resume knobs:
  mergeDenoise: 0.6, // resume strength: 0.5–0.7 unifies the two backgrounds into one (higher = harder unify, more drift)
  mergeFeather: 8, // latent-space seam feather (latent cols; image px = ×8 = 64px band)
  mergeSeed: 42,
  mergePrompt:
    "two young women standing together in a dreamlike surreal fantasy scene, one on the left, one on the " +
    "right, facing each other, unified cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, " +
    "painterly fantasy atmosphere",
  // Self-reflection: by default the workflow understands + explains its own output via
  // run.py caption (VLM). Graceful — if LM Studio is down, the step is skipped, not fatal.
  reflect: true,
  captionStyle: "default", // run.py caption --style — default=robust description (review needs --prompt)
  charA: {
    seed: 42,
    prompt:
      "a dreamlike surreal portrait of a young 19-year-old girl, standing on the left side of the frame, " +
      "slim petite build, long straight raven-black hair, delicate porcelain skin, large dark eyes, " +
      "soft natural makeup, wearing a flowing white summer dress with subtle silver embroidery, " +
      "gentle shy smile, looking toward the right",
  },
  charB: {
    seed: 777,
    prompt:
      "a dreamlike surreal portrait of a 26-year-old woman, standing on the right side of the frame, " +
      "taller athletic curvy build, wavy auburn copper hair, warm tan skin, green eyes, elegant bold makeup, " +
      "wearing a deep emerald silk gown, confident serene expression, looking toward the left",
  },
}

const cfg = { ...DEFAULTS, ...(args || {}) }
cfg.charA = { ...DEFAULTS.charA, ...((args && args.charA) || {}) }
cfg.charB = { ...DEFAULTS.charB, ...((args && args.charB) || {}) }

// ---------------------------------------------------------------------------
// Schema — agents return the absolute path of the PNG they produced/found.
// ---------------------------------------------------------------------------

const PATH_SCHEMA = {
  type: "object",
  properties: {
    imagePath: {
      type: "string",
      description: "Absolute path to the produced/found PNG.",
    },
    note: {
      type: "string",
      description: "One line: what happened (e.g. 'latent-couple final image' or 'explained').",
    },
  },
  required: ["imagePath"],
  additionalProperties: false,
}

const PATH_FIND = `After the command exits, find the FINAL PNG (the multicouple_* output, not the
per-character _a/_b files). Prefer the JSON_SUMMARY "final" field; fallback the newest
multicouple_dn*.png in ${OUTPUT_DIR}. Return its absolute path as imagePath.`

// ---------------------------------------------------------------------------
// Phase 1 — Latent-Couple (one command: generate A + B, composite latents, resume)
// ---------------------------------------------------------------------------

phase("Latent-Couple")

const cmd = [
  `${PYTHON} ${RUN} image multicouple`,
  `--pipeline ${cfg.pipeline}`,
  `--transformer ${cfg.transformer}`,
  `--width ${cfg.width} --height ${cfg.height}`,
  `--steps ${cfg.steps}`,
  `--seed-a ${cfg.charA.seed}`,
  `--seed-b ${cfg.charB.seed}`,
  `--merge-seed ${cfg.mergeSeed}`,
  `--merge-denoise ${cfg.mergeDenoise}`,
  `--merge-feather ${cfg.mergeFeather}`,
  `--style "${cfg.style}"`,
  `--merge-prompt "${cfg.mergePrompt}"`,
  `--prompt-a "${cfg.charA.prompt}"`,
  `--prompt-b "${cfg.charB.prompt}"`,
  `--json-summary`,
].join(" \\\n  ")

const coupleTask =
  `Generate a two-character Latent-Couple image by running this bash command FROM THE REPO ROOT. ` +
  `Do NOT cd anywhere (cd is blocked); the command resolves paths from the repo root.\n\n` +
  `${cmd}\n\n${PATH_FIND}\n` +
  `This loads a large MLX model three times (charA, charB, resume) — it takes several minutes; ` +
  `let it run to completion. note: "latent-couple final (dn=${cfg.mergeDenoise}, feather=${cfg.mergeFeather})".`

const finalPath = await agent(coupleTask, {
  label: "multicouple:run",
  phase: "Latent-Couple",
  schema: PATH_SCHEMA,
})
log(`final → ${finalPath ? finalPath.imagePath : "(failed)"}`)

if (!finalPath || !finalPath.imagePath) {
  return { error: "latent-couple generation failed", finalPath }
}

// ---------------------------------------------------------------------------
// Phase 2 — Reflect (VLM self-description via run.py caption — default ON)
// ---------------------------------------------------------------------------
// Self-reflection: the workflow looks at its own output and explains it with
// run.py's VLM caption. GRACEFUL — caption needs LM Studio running locally; if
// it is down (non-zero exit), the agent notes that and we continue. Generation
// already succeeded by this point, so a missing explainer never fails the run.
let reflection = null
if (cfg.reflect !== false) {
  phase("Reflect")
  const style = cfg.captionStyle || "review"
  const reflectTask =
    `Understand and explain the final two-character image via run.py's VLM caption. ` +
    `Run FROM THE REPO ROOT (no cd):\n\n` +
    `  ${PYTHON} ${RUN} caption "${finalPath.imagePath}" --style ${style} --lang en\n\n` +
    `This writes <image>.caption.json next to the PNG. Read that JSON and return its ` +
    `textual content (the description/assessment) as the 'note' field, with imagePath = ` +
    `the same final image. If the command FAILS with a non-zero exit (most likely cause: ` +
    `LM Studio is not running locally), do NOT treat it as an error — return ` +
    `note="caption unavailable (is LM Studio running?)" and imagePath= the same image. ` +
    `This is a graceful self-reflection step; the image already exists.`
  const r = await agent(reflectTask, {
    label: "reflect:caption",
    phase: "Reflect",
    schema: PATH_SCHEMA,
  })
  reflection = r ? r.note : null
  log(`reflect → ${reflection ? "explained" : "(skipped)"}`)
}

return {
  final: finalPath.imagePath,
  reflection,
  config: {
    pipeline: cfg.pipeline,
    transformer: cfg.transformer,
    width: cfg.width,
    height: cfg.height,
    steps: cfg.steps,
    mergeDenoise: cfg.mergeDenoise,
    mergeFeather: cfg.mergeFeather,
    mergeSeed: cfg.mergeSeed,
    reflect: cfg.reflect !== false,
    captionStyle: cfg.captionStyle || "review",
  },
}
