// multi-character-compose — put two characters (same art style, different look) in ONE picture.
//
// WHY THIS EXISTS
//   MLX has no regional prompting / attention-couple / latent couple (the ComfyUI mechanisms
//   that let one image carry two different prompts in two regions). The cleanest MLX-faithful
//   route is therefore: generate each character separately with a SHARED style anchor (same
//   transformer + identical style tags), then composite them side-by-side and seam-blend.
//   This workflow orchestrates exactly that via run.py.
//
// PIPELINE (all GPU steps are SERIAL — one model process at a time, Apple-Silicon-safe)
//   1. Generate  — run.py image t2i for character A, then B (same transformer/style, diff look+seed)
//   2. Compose   — PIL side-by-side composite with a feathered vertical seam in the background gap
//   3. Harmonize — run.py image i2i (NO ControlNet) at low denoise to heal the seam + unify lighting
//
// Usage:
//   Workflow({ scriptPath: ".../multi-character-compose.js" })
//     → defaults: two dreamlike girls (luciddreamer-z), A=raven/petite/19 (seed 42),
//       B=auburn/athletic/26 (seed 777), the exact samples shipped with this PR.
//   Workflow({ scriptPath: "...", args: {
//       transformer:"luciddreamer-z", width:640, height:960, steps:9, denoise:0.35, feather:60,
//       style:"cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, painterly fantasy atmosphere",
//       charA:{ prompt:"<appearance A>", seed:42 },
//       charB:{ prompt:"<appearance B>", seed:777 },
//   }})
//
// NOTE — compose/harmonize only style-match if BOTH characters share the SAME transformer AND
// the SAME trailing style tags. The per-character prompt should describe appearance + which side
// of the frame (left/right) + gaze direction, so the two face each other once composited.
//
// See docs/multi-character-compose.md for the technique + the ComfyUI rationale + the planned
// regional-attention R&D follow-up.

export const meta = {
  name: "multi-character-compose",
  description:
    "Put two characters (same art style, different look/body/age) in one picture: " +
    "generate each via run.py t2i, then PIL composite + I2I seam-blend into one frame. " +
    "MLX has no regional prompting, so this uses the composite+blend approach.",
  whenToUse:
    "Two distinct characters in a single coherent image with consistent style but different " +
    "appearance (e.g. two girls, different age/hair/build, same dreamlike art style).",
  phases: [
    { title: "Generate", detail: "t2i each character — serial, GPU-safe (one model load each)" },
    { title: "Compose", detail: "PIL side-by-side composite, feathered vertical seam" },
    { title: "Harmonize", detail: "I2I seam-blend (no ControlNet) to unify lighting + heal seam" },
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
  // Trailing style tags appended to BOTH character prompts — this is the style-consistency lever.
  style:
    "cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, painterly fantasy atmosphere",
  feather: 60, // vertical-seam feather width in px (overlap band)
  denoise: 0.35, // I2I seam-blend strength (low = preserve identities, heal seam)
  // Self-reflection: by default the workflow understands + explains its own output via
  // run.py caption (VLM). Graceful — if LM Studio is down, the step is skipped, not fatal.
  reflect: true,
  captionStyle: "review", // run.py caption --style (review|score|t2i|default|…)
  harmonizeSeed: 42,
  harmonizePrompt:
    "two young women standing together in a dreamlike surreal fantasy scene, left and right, " +
    "facing each other, unified cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, " +
    "painterly fantasy atmosphere",
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
      description: "One line: what happened (e.g. 'generated charA seed=42' or 'harmonized').",
    },
  },
  required: ["imagePath"],
  additionalProperties: false,
}

// run.py prints the output path to stdout; as a robust fallback the agent also takes the
// newest PNG in OUTPUT_DIR (generation is serial, so the newest IS the just-produced image).
const PATH_FIND = `After the command exits, find the produced PNG. Prefer the path run.py printed
(stdout line containing the .png, or the --json-summary JSON). Fallback: the newest *.png in
${OUTPUT_DIR} via \`ls -t ${OUTPUT_DIR}/*.png | head -1\`. Return its absolute path as imagePath.`

// ---------------------------------------------------------------------------
// Phase 1 — Generate (serial: A, then B)
// ---------------------------------------------------------------------------

phase("Generate")

function t2iTask(char, label) {
  const cmd = [
    `${PYTHON} ${RUN} image t2i`,
    `--pipeline ${cfg.pipeline}`,
    `--transformer ${cfg.transformer}`,
    `--width ${cfg.width} --height ${cfg.height}`,
    `--steps ${cfg.steps} --seed ${char.seed}`,
    `--prompt "${char.prompt}, ${cfg.style}"`,
    `--json-summary`,
  ].join(" \\\n  ")
  return (
    `Generate character "${label}" by running this bash command FROM THE REPO ROOT. ` +
    `Do NOT cd anywhere (cd is blocked); the command resolves paths from the repo root.\n\n` +
    `${cmd}\n\n${PATH_FIND}\n` +
    `This loads a large MLX model — it takes 1-3 minutes; let it run to completion. ` +
    `note: "generated ${label} seed=${char.seed}".`
  )
}

const aPath = await agent(t2iTask(cfg.charA, "charA (left, raven hair)"), {
  label: "generate:charA",
  phase: "Generate",
  schema: PATH_SCHEMA,
})
log(`charA → ${aPath ? aPath.imagePath : "(failed)"}`)

const bPath = await agent(t2iTask(cfg.charB, "charB (right, auburn hair)"), {
  label: "generate:charB",
  phase: "Generate",
  schema: PATH_SCHEMA,
})
log(`charB → ${bPath ? bPath.imagePath : "(failed)"}`)

if (!aPath || !bPath || !aPath.imagePath || !bPath.imagePath) {
  return { error: "generation failed", aPath, bPath }
}

// ---------------------------------------------------------------------------
// Phase 2 — Compose (PIL side-by-side with feathered vertical seam)
// ---------------------------------------------------------------------------

phase("Compose")

const overlap = cfg.feather
const composePy = `python3 - <<'PY'
from PIL import Image
import numpy as np
A = "${aPath.imagePath}"; B = "${bPath.imagePath}"
W = ${cfg.width}; H = ${cfg.height}; O = ${overlap}
a = np.array(Image.open(A).convert("RGB").resize((W, H))).astype(np.float32)
b = np.array(Image.open(B).convert("RGB").resize((W, H))).astype(np.float32)
cw = 2 * W - O
canvas = np.zeros((H, cw, 3), dtype=np.float32)
canvas[:, 0:W] = a                                   # A fills [0, W)
alpha = np.linspace(0.0, 1.0, O)[None, :, None]      # feather across seam band [W-O, W)
canvas[:, W - O:W] = (1 - alpha) * a[:, W - O:W] + alpha * b[:, 0:O]
canvas[:, W:] = b[:, O:]                              # rest of B
out = "${OUTPUT_DIR}/multichar_compose.png"
Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8)).save(out)
print("COMPOSE_OUT=" + out)
PY`

const composeTask =
  `Composite the two character images side-by-side with a feathered vertical seam. ` +
  `Run this from the repo root (no cd):\n\n${composePy}\n\n` +
  `Then read the printed COMPOSE_OUT= path and return it as imagePath. ` +
  `note: "composite ${cfg.width}x2-${overlap}px seam".`

const composePath = await agent(composeTask, {
  label: "compose:A+B",
  phase: "Compose",
  schema: PATH_SCHEMA,
})
log(`compose → ${composePath ? composePath.imagePath : "(failed)"}`)
if (!composePath || !composePath.imagePath) {
  return { error: "compose failed", aPath, bPath }
}

// ---------------------------------------------------------------------------
// Phase 3 — Harmonize (I2I seam-blend, NO ControlNet → pure img2img)
// ---------------------------------------------------------------------------

phase("Harmonize")

const harmonizeCmd = [
  `${PYTHON} ${RUN} image i2i`,
  `--pipeline ${cfg.pipeline}`,
  `--transformer ${cfg.transformer}`,
  `--input ${composePath.imagePath}`,
  `--prompt "${cfg.harmonizePrompt}"`,
  `--denoise-strength ${cfg.denoise}`,
  `--seed ${cfg.harmonizeSeed}`,
  `--steps ${cfg.steps}`,
  // NOTE: deliberately NO --reference-image — that would enable canny ControlNet, which we
  // do NOT want here. With no reference, i2i runs as pure img2img harmonization.
].join(" \\\n  ")

const harmonizeTask =
  `Seam-blend the composite by running this img2img pass FROM THE REPO ROOT (no cd). ` +
  `Low denoise heals the seam + unifies lighting while preserving each girl's identity.\n\n` +
  `${harmonizeCmd}\n\n${PATH_FIND}\n` +
  `note: "harmonized denoise=${cfg.denoise}".`

const finalPath = await agent(harmonizeTask, {
  label: "harmonize:i2i",
  phase: "Harmonize",
  schema: PATH_SCHEMA,
})
log(`final → ${finalPath ? finalPath.imagePath : "(failed)"}`)

// ---------------------------------------------------------------------------
// Phase 4 — Reflect (VLM self-description via run.py caption — default ON)
// ---------------------------------------------------------------------------
// Self-reflection: the workflow looks at its own output and explains it with
// run.py's VLM caption. GRACEFUL — caption needs LM Studio running locally; if
// it is down (non-zero exit), the agent notes that and we continue. The compose
// already succeeded by this point, so a missing explainer never fails the run.
let reflection = null
if (cfg.reflect !== false && finalPath && finalPath.imagePath) {
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
  charA: aPath && aPath.imagePath,
  charB: bPath && bPath.imagePath,
  composite: composePath && composePath.imagePath,
  final: finalPath ? finalPath.imagePath : null,
  reflection,
  config: {
    pipeline: cfg.pipeline,
    transformer: cfg.transformer,
    width: cfg.width,
    height: cfg.height,
    steps: cfg.steps,
    feather: cfg.feather,
    denoise: cfg.denoise,
    reflect: cfg.reflect !== false,
    captionStyle: cfg.captionStyle || "review",
  },
}
