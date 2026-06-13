// mlx-movie-director-lora-review-flux2-klein — Dynamic LoRA A/B review for Flux2 Klein
//
// Auto-discovers flux2-klein-9b LoRAs, classifies them (style/slider/anime2real/face-swap),
// and routes each to its optimal test mode. Generates per-LoRA adaptive prompts from
// manifest metadata (test_prompt, trigger_words) to avoid the ceiling effect.
//
// Multi-lane architecture:
//   T2I Lane (always active):       style + slider LoRAs via `run.py t2i --pipeline flux2-klein`
//   Anime2Real Lane (if animeImage): anime2real LoRA via `run.py image anime2real`
//   Faceswap Lane (if face+body):    face-swap LoRA via `run.py image faceswap`
//
// Usage:
//   Workflow({ name: "mlx-movie-director-lora-review-flux2-klein" })
//     → auto-discover all flux2-klein-9b LoRAs, T2I lane only, 4 seeds
//   Workflow({ name: "...", args: "A moody portrait in soft lighting" })
//     → custom prompt, T2I lane only
//   Workflow({ name: "...", args: {
//     prompt: "...",                 // global T2I prompt (overridden per-LoRA by test_prompt)
//     seeds: [42, 123, 777],        // seeds (default: [42, 123, 777, 999])
//     steps: 4,                     // denoising steps (default: 4 for flux2-klein)
//     lora_scale: 1.0,              // single LoRA scale (default)
//     doSweep: true,                 // enable scale sweep (opt-in; prior run showed no sensitivity)
//     lora_scales: [0.5, 0.8, 1.0, 1.2], // explicit sweep range → auto-pick best per LoRA
//     loras: ["klein-slider-anatomy"], // specific LoRAs (default: auto-discover all)
//     width: 640,                   // image width (default: 640)
//     height: 960,                  // image height (default: 960)
//     lang: "zh_TW",               // HTML language
//     noHtml: false,                // skip HTML generation
//     resume: "auto",              // "auto" | "fresh" | "continue"
//     useTestPrompts: true,         // use per-LoRA test_prompt from manifest (default: true)
//     includeFaceswap: false,       // include face-swap LoRAs in T2I lane (default: false)
//     animeImage: "/path/to/anime.png",   // activate anime2real lane
//     bodyImage: "/path/to/body.png",     // activate faceswap lane (needs faceImage too)
//     faceImage: "/path/to/face.png",     // activate faceswap lane (needs bodyImage too)
//     denoiseStrength: 0.4,         // I2I denoise strength (default: 0.4)
//     realismStyle: "photorealistic", // anime2real style (default: "photorealistic")
//   } })
//
// Generation plan (default: 3-5 LoRAs × 3 seeds, no sweep, T2I lane only):
//   Baselines: 1-3 unique prompts × 3 seeds = 3-9 images (per-LoRA prompt)
//   LoRA images: 3-5 × 3 = 9-15 images (at scale 1.0)
//   Total: ~12-24 images
//   ~15-30 min on Apple Silicon (sequential, GPU-safe, flux2-klein ~40s/4steps)
//
// History:
//   Run history persisted to .claude/workflows/history/<workflow-name>/<timestamp>.json
//   Enables trend comparison across runs, resume from interrupted runs, and incremental improvement.
//
// Output:
//   { reviewHtml, captionFiles, captionSets, report, loras, seeds, bestScales,
//     sweepResults, promptMap, lanes, loraScoreSummary, baseScoreSummary, history }

export const meta = {
  name: "mlx-movie-director-lora-review-flux2-klein",
  description: "Dynamic LoRA A/B review: auto-discover flux2-klein-9b LoRAs, classify, route to optimal test mode (T2I/anime2real/faceswap), caption, build interactive comparison HTML",
  whenToUse: "Compare all flux2-klein LoRAs against baseline. Auto-classifies LoRAs and routes to T2I, anime2real, or faceswap lanes based on type and available inputs.",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root via git rev-parse" },
    { title: "Discover", detail: "Auto-scan manifest.json for flux2-klein-9b LoRAs, classify by category" },
    { title: "GPU Wait", detail: "Wait if another run.py generation is using the GPU" },
    { title: "Scale Sweep", detail: "Probe each LoRA at multiple scales to find optimal setting" },
    { title: "Generate", detail: "Multi-lane generation: T2I + optional anime2real/faceswap (sequential, GPU-safe)" },
    { title: "VLM Check", detail: "Verify LM Studio is running before caption phase" },
    { title: "Review", detail: "Score each output PNG via run.py caption --style review" },
    { title: "Report", detail: "Per-LoRA quality comparison with lane grouping, category analysis, ceiling warning" },
    { title: "Review HTML", detail: "Build multi-set A/B HTML via caption --ab-manifest" },
    { title: "Persist", detail: "Write run history to disk for trend analysis and incremental improvement" },
  ],
}

// ── Phase tracking (in-memory) ───────────────────────────────────────────────

const phaseStatus = {
  resolve: "pending",
  discover: "pending",
  gpuWait: "pending",
  scaleSweep: "pending",
  generate: "pending",
  vlmCheck: "pending",
  review: "pending",
  report: "pending",
  reviewHtml: "pending",
  persist: "pending",
}

const phasesCompleted = []
const phasesFailed = []

function markPhase(name, status) {
  phaseStatus[name] = status
  if (status === "completed") phasesCompleted.push(name)
  if (status === "failed") phasesFailed.push(name)
}

// ── Schemas (shared across phases) ───────────────────────────────────────────

const PATH_SCHEMA = {
  type: "object",
  properties: {
    projectRoot: { type: "string", description: "Absolute path to the git project root" },
  },
  required: ["projectRoot"],
}

const TIMESTAMP_SCHEMA = {
  type: "object",
  properties: {
    timestamp: { type: "string", description: "ISO-8601 timestamp like 2026-06-13T14-30-52" },
  },
  required: ["timestamp"],
}

const RESUME_CHECK_SCHEMA = {
  type: "object",
  properties: {
    action:                  { type: "string", enum: ["fresh", "resume", "compare"] },
    previousRunId:           { type: "string" },
    previousTimestamp:       { type: "string" },
    previousArgs:            { type: "object" },
    previousStatus:          { type: "string" },
    previousPhasesCompleted: { type: "array", items: { type: "string" } },
  },
  required: ["action"],
}

// ── Helpers + Constants ──────────────────────────────────────────────────────

function captionPathFor(pngPath) {
  return pngPath.replace(/\.[^.\/]+$/, "") + ".caption.json"
}

const DEFAULT_PROMPT = (
  "full body shot of a woman standing in a narrow cobblestone alley, wearing a flowing " +
  "red dress, one hand raised to adjust her hair with visible individual fingers, natural " +
  "afternoon side lighting casting long shadows, photorealistic, detailed hands and face, " +
  "ultra sharp focus"
)

const DEFAULT_SEEDS  = [42, 123, 777]
const DEFAULT_STEPS  = 4     // flux2-klein default (vs 9 for zimage)
const DEFAULT_WIDTH  = 640
const DEFAULT_HEIGHT = 960
const DEFAULT_SCALE  = 1.0
const DEFAULT_SCALES = [0.5, 0.8, 1.0, 1.2]
const PIPELINE       = "flux2-klein"
const LORA_ARCH      = "flux2-klein-9b"

// ── Args normalization (BEFORE Resolve so all vars are defined) ───────────────

let resolvedArgs = args
if (typeof resolvedArgs === "string") {
  try {
    const parsed = JSON.parse(resolvedArgs)
    if (Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null)) {
      resolvedArgs = parsed
    }
  } catch {
    // Not JSON — treat as prompt string
  }
}

const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x)

let prompt          = DEFAULT_PROMPT
let seeds           = DEFAULT_SEEDS
let steps           = DEFAULT_STEPS
let width           = DEFAULT_WIDTH
let height          = DEFAULT_HEIGHT
let loraScale       = DEFAULT_SCALE
let loraScales      = null
let wfLang          = "zh_TW"
let noHtml          = false
let resumeMode      = "auto"
let loraFilter      = null
let useTestPrompts  = true
let includeFaceswap = false
let animeImage      = null
let bodyImage       = null
let faceImage       = null
let denoiseStrength = 0.4
let realismStyle    = "photorealistic"

if (typeof resolvedArgs === "string" && resolvedArgs.length > 0) {
  prompt = resolvedArgs
} else if (isObj(resolvedArgs)) {
  if (typeof resolvedArgs.prompt === "string")      prompt          = resolvedArgs.prompt
  if (Array.isArray(resolvedArgs.seeds))             seeds           = resolvedArgs.seeds.map(Number)
  if (resolvedArgs.steps != null)                    steps           = Number(resolvedArgs.steps)
  if (resolvedArgs.width != null)                    width           = Number(resolvedArgs.width)
  if (resolvedArgs.height != null)                   height          = Number(resolvedArgs.height)
  if (resolvedArgs.lora_scale != null)               loraScale       = Number(resolvedArgs.lora_scale)
  if (Array.isArray(resolvedArgs.lora_scales))       loraScales      = resolvedArgs.lora_scales.map(Number)
  if (typeof resolvedArgs.lang === "string")         wfLang          = resolvedArgs.lang
  if (resolvedArgs.noHtml === true)                  noHtml          = true
  if (["auto", "fresh", "continue"].includes(resolvedArgs.resume)) resumeMode = resolvedArgs.resume
  if (Array.isArray(resolvedArgs.loras))             loraFilter      = resolvedArgs.loras
  if (resolvedArgs.useTestPrompts === false)         useTestPrompts  = false
  if (resolvedArgs.includeFaceswap === true)         includeFaceswap = true
  if (typeof resolvedArgs.animeImage === "string")   animeImage      = resolvedArgs.animeImage
  if (typeof resolvedArgs.bodyImage === "string")    bodyImage       = resolvedArgs.bodyImage
  if (typeof resolvedArgs.faceImage === "string")    faceImage       = resolvedArgs.faceImage
  if (resolvedArgs.denoiseStrength != null)          denoiseStrength = Number(resolvedArgs.denoiseStrength)
  if (typeof resolvedArgs.realismStyle === "string") realismStyle    = resolvedArgs.realismStyle
}

// Sweep is opt-in (prior run showed zero scale sensitivity 0.5-1.2 across all LoRAs).
// Pass doSweep: true or lora_scales: [...] to enable.
const doSweep = resolvedArgs?.doSweep === true || Array.isArray(resolvedArgs?.lora_scales)
const sweepScales = loraScales || (resolvedArgs?.lora_scale != null ? [Number(resolvedArgs.lora_scale)] : DEFAULT_SCALES)

// ── Phase 0: Resolve absolute paths + timestamp + resume check ───────────────

phase("Resolve")

const pathResolution = await agent(
  `Detect the absolute path of the git project root for the video_generation project.

  Run: Bash("git rev-parse --show-toplevel")

  Return it as { projectRoot: "<the-path>" }.
  IMPORTANT: Return ONLY the JSON object. Normalize backslashes to forward slashes.`,
  { label: "resolve-paths", phase: "Resolve", model: "haiku", schema: PATH_SCHEMA },
)

const PROJECT_ROOT = (pathResolution?.projectRoot || "").replace(/\\/g, "/")
if (!PROJECT_ROOT) {
  log("ERROR: Could not resolve project root.")
}

const PYTHON    = `${PROJECT_ROOT}/python/venv/bin/python`
const RUN_PY    = `${PROJECT_ROOT}/python/mlx-movie-director/run.py`
const OUT_DIR   = `${PROJECT_ROOT}/python/mlx-movie-director/output`
const LORA_DIR  = `${PROJECT_ROOT}/python/mlx-movie-director/models/lora`

const WORKFLOW_NAME = "mlx-movie-director-lora-review-flux2-klein"
const HISTORY_DIR   = `${PROJECT_ROOT}/.claude/workflows/history/${WORKFLOW_NAME}`

log(`Resolved: PROJECT_ROOT=${PROJECT_ROOT}`)
log(`  PYTHON:   ${PYTHON}`)
log(`  RUN_PY:   ${RUN_PY}`)
log(`  OUT_DIR:  ${OUT_DIR}`)
log(`  LORA_DIR: ${LORA_DIR}`)
log(`  HISTORY_DIR: ${HISTORY_DIR}`)

// Get timestamp for this run
const timestampResult = await agent(
  `Get the current timestamp in ISO-8601 basic format (no colons, suitable for filenames).
  Run: Bash("date -u '+%Y-%m-%dT%H-%M-%S'")
  Return { timestamp: "<the-output>" }. Use the exact output from date.`,
  { label: "get-timestamp", phase: "Resolve", model: "haiku", schema: TIMESTAMP_SCHEMA },
)

const RUN_TIMESTAMP = (timestampResult?.timestamp || "unknown").trim()
const RUN_ID = RUN_TIMESTAMP

log(`Run ID: ${RUN_ID}`)

// ── Resume check: look for prior run history ─────────────────────────────────

let priorHistory = null
let isResume = false
let resumeFromPhase = null

if (resumeMode === "fresh") {
  log("Resume: fresh mode — ignoring prior history.")
} else {
  const resumeCheck = await agent(
    `Check for a previous run history file for the workflow "${WORKFLOW_NAME}".

  Steps:
  1. Run: Bash("mkdir -p '${HISTORY_DIR}'")
  2. Run: Bash("ls -t '${HISTORY_DIR}'/*.json 2>/dev/null | head -1")
  3. If a file path was returned, read it: Bash("cat '<path>'")
  4. Examine the JSON:
     - Check "status": is it "complete", "partial", or "error"?
     - Check "phases_completed": which phases finished?
     - Check "args": do they match the current invocation?

  Current invocation args: ${JSON.stringify({ prompt: prompt.slice(0, 60), seeds: seeds.join(","), steps, pipeline: PIPELINE, resume: resumeMode })}

  Decide:
  - If no file found: action = "fresh"
  - If file found and status = "complete": action = "compare" (prior run finished, use for trend)
  - If file found and status = "partial" or "error": action = "resume", set resumeFromPhase to the phase AFTER the last completed phase
  - If file found but args differ significantly (different prompt entirely): action = "fresh" (different scope)

  Return your decision.`,
    { label: "resume-check", phase: "Resolve", model: "haiku", schema: RESUME_CHECK_SCHEMA },
  )

  if (resumeCheck) {
    if (resumeCheck.action === "resume") {
      isResume = true
      resumeFromPhase = resumeCheck.resumeFromPhase
      log(`Resume: picking up from phase "${resumeFromPhase}" (prior run: ${resumeCheck.previousRunId})`)
    } else if (resumeCheck.action === "compare") {
      log(`Resume: prior run ${resumeCheck.previousRunId} completed — loading for trend comparison.`)
      const priorLoad = await agent(
        `Read the prior run history file and return its "result" field (the workflow-specific payload).
      Run: Bash("cat '${HISTORY_DIR}/${resumeCheck.previousRunId}.json'")
      Extract the "result" object and return it as { result: <payload> }.
      If the file cannot be read, return { result: null }.`,
        { label: "load-prior", phase: "Resolve", model: "haiku" },
      )
      priorHistory = priorLoad?.result || null
      if (priorHistory) {
        const ps = priorHistory.baseScoreSummary
        log(`  Prior run: baseline overall=${ps?.overall ?? "?"}, LoRAs=${priorHistory.loraScoreSummary?.length || 0}`)
      }
    } else {
      log("Resume: no prior history found — starting fresh.")
    }
  }

  if (resumeMode === "continue" && !isResume && resumeCheck?.action !== "compare") {
    log("WARNING: resume=continue but no prior run found. Starting fresh.")
  }
}

markPhase("resolve", "completed")

// ── Phase 1: Discover flux2-klein-9b LoRAs with classification ──────────────

phase("Discover")

const DISCOVER_SCHEMA = {
  type: "object",
  properties: {
    loras: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name:          { type: "string" },
          dirName:       { type: "string" },
          description:   { type: "string" },
          loraPath:      { type: "string" },
          category:      { type: "string" },
          test_prompt:   { type: "string" },
          trigger_words: { type: "array", items: { type: "string" } },
        },
        required: ["name", "dirName", "loraPath", "category"],
      },
    },
  },
  required: ["loras"],
}

const discovery = await agent(
  `Discover all flux2-klein-9b compatible LoRA models by scanning manifest.json files.
Classify each LoRA into a category for multi-lane routing.

LORA_DIR: ${LORA_DIR}
ARCH_FILTER: "${LORA_ARCH}"
${loraFilter ? `NAME_FILTER: Only include: ${JSON.stringify(loraFilter)}` : "NAME_FILTER: None — discover all flux2-klein-9b LoRAs"}
FACESWAP: ${includeFaceswap ? "Include face-swap LoRAs" : "Skip face-swap LoRAs (includeFaceswap=false)"}

STEPS:
1. List all subdirectories in ${LORA_DIR}:
   Bash("ls -1 '${LORA_DIR}'")

2. For each subdirectory that has a manifest.json, read it:
   Bash("cat '${LORA_DIR}/<dirname>/manifest.json'")

3. Filter: keep only entries where "arch" is "${LORA_ARCH}" AND "type" is "lora".
   ${loraFilter ? `Also filter: only keep entries whose "name" field is in: ${JSON.stringify(loraFilter)}` : ""}

4. CLASSIFY each matching LoRA by "category":
   - If name or description contains "face" or "swap" or "bfs" → "face-swap"
   - If name or description contains "anime" or "real person" → "anime2real"
   - If name contains "slider" or description contains "anatomy" or "bodyweight" → "slider"
   - Else → "style"

5. SKIP face-swap LoRAs if FACESWAP is disabled (category = "face-swap" and includeFaceswap=false).

6. For each matching LoRA, extract:
   - name: manifest "name" field
   - dirName: the subdirectory name
   - description: manifest "description" field (or "No description")
   - loraPath: "${LORA_DIR}/<dirname>/"  (directory path for --lora-path)
   - category: the classified category ("style", "slider", "anime2real", "face-swap")
   - test_prompt: manifest "test_prompt" field (or null if absent)
   - trigger_words: manifest "trigger_words" array (or null if absent)

Return JSON: { "loras": [<array of objects above>] }
If no LoRAs found, return { "loras": [] }.`,
  { label: "discover-loras", phase: "Discover", model: "haiku", schema: DISCOVER_SCHEMA },
)

const loras = discovery?.loras || []

if (loras.length === 0) {
  log("ERROR: No flux2-klein-9b LoRAs found. Check models/lora/*/manifest.json files.")
  return { reviewHtml: "", captionFiles: [], captionSets: [], report: "No LoRAs found", loras: [], seeds }
}

log(`Discovered ${loras.length} flux2-klein-9b LoRA(s):`)
loras.forEach((l, i) => log(`  [${i}] ${l.name} [${l.category}] — ${l.description} (${l.dirName})`))

markPhase("discover", "completed")

// ── Lane routing + Per-LoRA prompt resolution ────────────────────────────────

// Partition LoRAs by lane
const t2iLoras       = loras.filter((l) => l.category === "style" || l.category === "slider")
const anime2realLoras = loras.filter((l) => l.category === "anime2real")
const faceswapLoras   = loras.filter((l) => l.category === "face-swap")

const hasAnime2real = anime2realLoras.length > 0 && !!animeImage
const hasFaceswap   = faceswapLoras.length > 0 && !!faceImage && !!bodyImage

// Fallback: non-T2I LoRAs with no inputs → test in T2I mode with warning
const fallbackLoras = []
if (anime2realLoras.length > 0 && !animeImage) {
  fallbackLoras.push(...anime2realLoras)
  log(`WARNING: anime2real LoRAs found but no animeImage provided — testing in T2I mode: ${anime2realLoras.map((l) => l.name).join(", ")}`)
}
if (faceswapLoras.length > 0 && !hasFaceswap) {
  fallbackLoras.push(...faceswapLoras)
  log(`WARNING: face-swap LoRAs found but no face+body images provided — testing in T2I mode: ${faceswapLoras.map((l) => l.name).join(", ")}`)
}

// All LoRAs tested in T2I lane (including fallbacks)
const allT2iLoras = [...t2iLoras, ...fallbackLoras]

// Build per-LoRA prompt map
const promptMap = {}
allT2iLoras.forEach((lora) => {
  let resolvedPrompt = prompt
  if (useTestPrompts && lora.test_prompt) {
    resolvedPrompt = lora.test_prompt
  }
  if (lora.trigger_words && lora.trigger_words.length > 0) {
    const triggerPrefix = lora.trigger_words.join(", ")
    if (!resolvedPrompt.toLowerCase().includes(triggerPrefix.toLowerCase())) {
      resolvedPrompt = `${triggerPrefix}, ${resolvedPrompt}`
    }
  }
  promptMap[lora.name] = resolvedPrompt
})
// anime2real and faceswap lanes have their own prompts
if (hasAnime2real) {
  anime2realLoras.forEach((lora) => {
    promptMap[lora.name] = lora.test_prompt || `Convert this anime character to realistic photorealistic style`
  })
}
if (hasFaceswap) {
  faceswapLoras.forEach((lora) => {
    promptMap[lora.name] = prompt  // faceswap uses internal prompt from --input/--face
  })
}

// Unique T2I prompts for baseline grouping
const uniqueT2iPrompts = [...new Set(allT2iLoras.map((l) => promptMap[l.name]))]

log(`\nLane routing:`)
log(`  T2I Lane:       ${allT2iLoras.length} LoRAs (${t2iLoras.length} style/slider + ${fallbackLoras.length} fallback)`)
log(`  Anime2Real Lane: ${hasAnime2real ? `${anime2realLoras.length} LoRAs (${animeImage})` : "inactive"}`)
log(`  Faceswap Lane:   ${hasFaceswap ? `${faceswapLoras.length} LoRAs` : "inactive"}`)
log(`  Unique T2I prompts: ${uniqueT2iPrompts.length}`)
allT2iLoras.forEach((l) => {
  const p = promptMap[l.name]
  log(`  ${l.name}: "${p.slice(0, 60)}${p.length > 60 ? "..." : ""}"`)
})

// ── Build generation specs ───────────────────────────────────────────────────

// T2I baselines: one per unique prompt × seed
const t2iBaseSpecs = []
uniqueT2iPrompts.forEach((up) => {
  seeds.forEach((seed) => {
    t2iBaseSpecs.push({
      type: "baseline",
      lane: "t2i",
      promptUsed: up,
      seed,
      cmd: `${PYTHON} ${RUN_PY} t2i --prompt '${up.replace(/'/g, "'\\''")}' --pipeline ${PIPELINE} --steps ${steps} --seed ${seed} --width ${width} --height ${height} --json-summary`,
    })
  })
})

// T2I LoRA specs (scale TBD after sweep)
const t2iLoraSpecs = []
allT2iLoras.forEach((lora) => {
  const loraPrompt = promptMap[lora.name]
  seeds.forEach((seed) => {
    t2iLoraSpecs.push({
      type: "lora",
      lane: "t2i",
      loraName: lora.name,
      loraPath: lora.loraPath,
      promptUsed: loraPrompt,
      seed,
      scale: loraScale,
      cmd: "",
    })
  })
})

// Anime2Real baselines (without LoRA — pure pipeline)
const a2rBaseSpecs = []
if (hasAnime2real) {
  seeds.forEach((seed) => {
    a2rBaseSpecs.push({
      type: "baseline",
      lane: "anime2real",
      promptUsed: promptMap[anime2realLoras[0].name],
      seed,
      cmd: `${PYTHON} ${RUN_PY} image anime2real --input-image '${animeImage}' --realism-style ${realismStyle} --seed ${seed} --no-lora --json-summary 2>&1 || ${PYTHON} ${RUN_PY} image anime2real --input-image '${animeImage}' --realism-style ${realismStyle} --seed ${seed} --lora-scale 0 --json-summary`,
    })
  })
}

// Anime2Real LoRA specs
const a2rLoraSpecs = []
if (hasAnime2real) {
  anime2realLoras.forEach((lora) => {
    seeds.forEach((seed) => {
      a2rLoraSpecs.push({
        type: "lora",
        lane: "anime2real",
        loraName: lora.name,
        loraPath: lora.loraPath,
        promptUsed: promptMap[lora.name],
        seed,
        scale: loraScale,
        cmd: "",
      })
    })
  })
}

// Faceswap specs (always uses a LoRA, baseline = default bfs at default scale)
const fsBaseSpecs = []
const fsLoraSpecs = []
if (hasFaceswap) {
  // Baseline: faceswap with default LoRA at scale 1.0
  seeds.forEach((seed) => {
    fsBaseSpecs.push({
      type: "baseline",
      lane: "faceswap",
      promptUsed: prompt,
      seed,
      cmd: `${PYTHON} ${RUN_PY} image faceswap --input '${bodyImage}' --face '${faceImage}' --lora-scale ${loraScale} --seed ${seed} --json-summary`,
    })
  })
  // LoRA variants: faceswap with each face-swap LoRA at varied scales
  faceswapLoras.forEach((lora) => {
    seeds.forEach((seed) => {
      fsLoraSpecs.push({
        type: "lora",
        lane: "faceswap",
        loraName: lora.name,
        loraPath: lora.loraPath,
        promptUsed: prompt,
        seed,
        scale: loraScale,
        cmd: "",
      })
    })
  })
}

log(`\nGeneration plan:`)
log(`  Seeds:  ${seeds.join(", ")}`)
log(`  Steps:  ${steps} (flux2-klein)`)
log(`  Size:   ${width}×${height}`)
log(`  Sweep:  ${doSweep ? `YES — scales ${sweepScales.join(", ")}` : `NO — using lora_scale=${loraScale}`}`)
log(`  T2I lane:         ${t2iBaseSpecs.length} baselines + ${t2iLoraSpecs.length} LoRA`)
if (hasAnime2real) log(`  Anime2Real lane:  ${a2rBaseSpecs.length} baselines + ${a2rLoraSpecs.length} LoRA`)
if (hasFaceswap)   log(`  Faceswap lane:    ${fsBaseSpecs.length} baselines + ${fsLoraSpecs.length} LoRA`)

// ── Phase 2: GPU gate ────────────────────────────────────────────────────────

phase("GPU Wait")

const GPU_PROBE_SCHEMA = {
  type: "object",
  properties: { busy: { type: "boolean" }, pids: { type: "string" } },
  required: ["busy"],
}

log("GPU check before Generate...")
let gpuWaited = 0
const maxGpuWait = 1800
while (gpuWaited < maxGpuWait) {
  const probe = await agent(
    `Check whether any run.py generation process is currently running (using the GPU).

Run: Bash("pgrep -f 'run\\\\.py' || true")

Return JSON:
{ "busy": <true if pgrep printed any PID, else false>, "pids": "<the raw pgrep output>" }`,
    { label: "gpu-probe", phase: "GPU Wait", model: "haiku", schema: GPU_PROBE_SCHEMA },
  )
  if (!probe?.busy) {
    log(gpuWaited > 0 ? `GPU free after ${gpuWaited}s — proceeding.` : "GPU free — proceeding.")
    break
  }
  log(`GPU busy (PIDs: ${(probe?.pids || "").trim()}). Waiting 20s...`)
  await agent(`Sleep. Run: Bash("sleep 20"). Return { "ok": true }.`,
    { label: "gpu-sleep", phase: "GPU Wait", model: "haiku", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } })
  gpuWaited += 20
}
if (gpuWaited >= maxGpuWait) log(`WARNING: GPU still busy after ${maxGpuWait}s — proceeding anyway.`)

markPhase("gpuWait", "completed")

// ── Phase 3: Scale Sweep (find optimal scale per LoRA) ───────────────────────

const bestScales = {}   // loraName → optimal scale
const sweepResults = [] // full sweep data for report

// Only sweep T2I LoRAs (anime2real/faceswap sweeps would need lane-specific logic)
const sweepableLoras = allT2iLoras

if (doSweep && sweepableLoras.length > 0) {
  phase("Scale Sweep")

  const probeSeed = seeds[0]
  const sweepSpecs = []
  sweepableLoras.forEach((lora) => {
    const loraPrompt = promptMap[lora.name]
    sweepScales.forEach((scale) => {
      sweepSpecs.push({
        type: "sweep",
        loraName: lora.name,
        loraPath: lora.loraPath,
        seed: probeSeed,
        scale,
        promptUsed: loraPrompt,
        cmd: `${PYTHON} ${RUN_PY} t2i --prompt '${loraPrompt.replace(/'/g, "'\\''")}' --pipeline ${PIPELINE} --steps ${steps} --seed ${probeSeed} --width ${width} --height ${height} --lora-path '${lora.loraPath}' --lora-scale ${scale} --json-summary`,
      })
    })
  })

  const totalSweep = sweepSpecs.length
  log(`Scale sweep: ${sweepableLoras.length} LoRAs × ${sweepScales.length} scales = ${totalSweep} probe images (seed=${probeSeed})`)

  const SWEEP_GEN_SCHEMA = {
    type: "object",
    properties: {
      status:      { type: "string", enum: ["success", "error"] },
      outputPngs:  { type: "array", items: { type: "string" } },
      runJsonPath: { type: "string" },
      error:       { type: "string" },
    },
    required: ["status", "outputPngs"],
  }

  const sweepGenResults = []
  const sweepGenCache = {}

  for (let idx = 0; idx < sweepSpecs.length; idx++) {
    const spec = sweepSpecs[idx]
    const cmd = spec.cmd

    if (sweepGenCache[cmd]) {
      sweepGenResults.push({ ...sweepGenCache[cmd], spec })
      continue
    }

    log(`  [${idx + 1}/${totalSweep}] ${spec.loraName} scale=${spec.scale}...`)

    try {
      const res = await agent(
        `Execute a T2I generation command and extract output paths from JSON_SUMMARY.

COMMAND:
${cmd}

STEPS:
1. Run the command (may take 1-2 min per image on flux2-klein):
   Bash("${cmd} 2>&1", timeout=600000)

2. Parse JSON_SUMMARY line from stdout:
   JSON_SUMMARY:{"status":"success","run_json":"...","manifest_json":"...","outputs":["/path/img.png"]}
   Extract the JSON after "JSON_SUMMARY:" prefix.

3. If no JSON_SUMMARY found, fall back:
   - "Saved: " lines → output PNG paths
   - "Run config: " lines → run.json path

4. If non-zero exit or "Error"/"Traceback" in output, set status="error".

Return JSON:
{
  "status": "success" or "error",
  "outputPngs": ["/abs/path/img.png"],
  "runJsonPath": "/abs/path/img.run.json" or "",
  "error": ""
}`,
        { label: `sweep-${idx}-${spec.loraName}`, phase: "Scale Sweep", schema: SWEEP_GEN_SCHEMA },
      )
      res.spec = spec
      sweepGenResults.push(res)
      if (res?.status === "success") sweepGenCache[cmd] = res
    } catch (e) {
      log(`  [${idx + 1}] Sweep generation failed: ${e?.message || e}`)
      sweepGenResults.push({ status: "error", outputPngs: [], runJsonPath: "", error: String(e?.message || e), spec })
    }
  }

  const sweepSuccessCount = sweepGenResults.filter((r) => r.status === "success").length
  log(`Sweep generation: ${sweepSuccessCount}/${totalSweep} succeeded`)

  // VLM-score each sweep image
  const sweepCaptionSchema = {
    type: "object",
    properties: {
      imagePath:        { type: "string" },
      overall:          { type: "number" },
      detail:           { type: "number" },
      sharpness:        { type: "number" },
      composition:      { type: "number" },
      prompt_adherence: { type: "number" },
      artifacts:        { type: "number" },
      error:            { type: "string" },
    },
    required: ["imagePath"],
  }

  const sweepCaptionable = sweepGenResults.filter((r) => r.outputPngs && r.outputPngs.length > 0)
  log(`Captioning ${sweepCaptionable.length} sweep images...`)

  const sweepScores = []

  for (let idx = 0; idx < sweepCaptionable.length; idx++) {
    const item = sweepCaptionable[idx]
    const pngPath = item.outputPngs[0]
    const captionFile = captionPathFor(pngPath)
    const loraName = item.spec.loraName
    const scale = item.spec.scale
    const sweepPrompt = item.spec.promptUsed

    try {
      const cap = await agent(
        `Quick quality score for a sweep probe image.

IMAGE PATH: ${pngPath}
LoRA: ${loraName} at scale=${scale}

STEPS:
1. Run: Bash("${PYTHON} ${RUN_PY} caption '${pngPath}' --style review --prompt '${sweepPrompt.replace(/'/g, "'\\''")}' --lang en")
2. Read: Bash("cat '${captionFile}'")
3. Parse the outer JSON, then parse the nested "caption" string.
   Strip markdown fences if present. Extract the first {...}.

Return JSON (scores only):
{
  "imagePath": "${pngPath}",
  "overall": <1-10>,
  "detail": <1-10>,
  "sharpness": <1-10>,
  "composition": <1-10>,
  "prompt_adherence": <1-10>,
  "artifacts": <1-10>,
  "error": ""
}`,
        { label: `sweep-cap-${loraName}-${scale}`, phase: "Scale Sweep", schema: sweepCaptionSchema },
      )
      sweepScores.push({
        loraName,
        scale,
        overall: cap?.overall || 0,
        detail: cap?.detail || 0,
        sharpness: cap?.sharpness || 0,
        composition: cap?.composition || 0,
        prompt_adherence: cap?.prompt_adherence || 0,
        artifacts: cap?.artifacts || 0,
      })
    } catch (e) {
      log(`  Sweep caption failed for ${loraName} scale=${scale}: ${e?.message || e}`)
      sweepScores.push({ loraName, scale, overall: 0, detail: 0, sharpness: 0, composition: 0, prompt_adherence: 0, artifacts: 0 })
    }
  }

  // Pick best scale per LoRA (highest overall, tiebreak on detail)
  sweepableLoras.forEach((lora) => {
    const loraScores = sweepScores.filter((s) => s.loraName === lora.name && s.overall > 0)
    if (loraScores.length === 0) {
      bestScales[lora.name] = loraScale
      log(`  ${lora.name}: no valid scores, using default scale=${loraScale}`)
      return
    }
    loraScores.sort((a, b) => b.overall - a.overall || b.detail - a.detail)
    const best = loraScores[0]
    bestScales[lora.name] = best.scale
    sweepResults.push({ loraName: lora.name, bestScale: best.scale, scores: loraScores })
    log(`  ${lora.name}: best scale=${best.scale} (overall=${best.overall}, detail=${best.detail})`)
  })

  log(`\nScale Sweep results:`)
  sweepableLoras.forEach((l) => log(`  ${l.name}: best scale = ${bestScales[l.name] || loraScale}`))
} else {
  // No sweep — use the single specified scale for all LoRAs
  loras.forEach((lora) => { bestScales[lora.name] = loraScale })
  log(`Scale sweep: SKIPPED (using lora_scale=${loraScale} for all LoRAs)`)
}

markPhase("scaleSweep", doSweep ? "completed" : "skipped")

// ── Rebuild LoRA specs with optimal scales ───────────────────────────────────

// T2I LoRA specs
t2iLoraSpecs.forEach((spec) => {
  const scale = bestScales[spec.loraName] || loraScale
  spec.scale = scale
  const loraPrompt = spec.promptUsed
  spec.cmd = `${PYTHON} ${RUN_PY} t2i --prompt '${loraPrompt.replace(/'/g, "'\\''")}' --pipeline ${PIPELINE} --steps ${steps} --seed ${spec.seed} --width ${width} --height ${height} --lora-path '${spec.loraPath}' --lora-scale ${scale} --json-summary`
})

// Anime2Real LoRA specs
a2rLoraSpecs.forEach((spec) => {
  const scale = bestScales[spec.loraName] || loraScale
  spec.scale = scale
  spec.cmd = `${PYTHON} ${RUN_PY} image anime2real --input-image '${animeImage}' --realism-style ${realismStyle} --lora-path '${spec.loraPath}' --lora-scale ${scale} --seed ${spec.seed} --json-summary`
})

// Faceswap LoRA specs
fsLoraSpecs.forEach((spec) => {
  const scale = bestScales[spec.loraName] || loraScale
  spec.scale = scale
  spec.cmd = `${PYTHON} ${RUN_PY} image faceswap --input '${bodyImage}' --face '${faceImage}' --lora '${spec.loraPath}' --lora-scale ${scale} --seed ${spec.seed} --json-summary`
})

const allSpecs = [...t2iBaseSpecs, ...t2iLoraSpecs, ...a2rBaseSpecs, ...a2rLoraSpecs, ...fsBaseSpecs, ...fsLoraSpecs]
const totalImages = allSpecs.length

log(`\nFinal generation plan: ${totalImages} total images`)
log(`  T2I:         ${t2iBaseSpecs.length} baselines + ${t2iLoraSpecs.length} LoRA`)
if (hasAnime2real) log(`  Anime2Real:  ${a2rBaseSpecs.length} baselines + ${a2rLoraSpecs.length} LoRA`)
if (hasFaceswap)   log(`  Faceswap:    ${fsBaseSpecs.length} baselines + ${fsLoraSpecs.length} LoRA`)

// ── Phase 4: Generate (sequential, GPU-safe) ─────────────────────────────────

phase("Generate")

const GEN_SCHEMA = {
  type: "object",
  properties: {
    status:      { type: "string", enum: ["success", "error"] },
    outputPngs:  { type: "array", items: { type: "string" } },
    runJsonPath: { type: "string" },
    error:       { type: "string" },
  },
  required: ["status", "outputPngs"],
}

const genResults = []
const genCache = {}

for (let idx = 0; idx < allSpecs.length; idx++) {
  const spec = allSpecs[idx]
  const cmd = spec.cmd

  if (genCache[cmd]) {
    log(`[${idx + 1}/${totalImages}] Dedup — reusing cached result (${spec.lane}/${spec.type}${spec.type === "lora" ? ` ${spec.loraName}` : ""}, seed=${spec.seed})`)
    genResults.push({ ...genCache[cmd], spec })
    continue
  }

  const laneTag = spec.lane !== "t2i" ? `[${spec.lane}] ` : ""
  log(`[${idx + 1}/${totalImages}] ${laneTag}Generating ${spec.type}${spec.type === "lora" ? ` ${spec.loraName}` : ""}, seed=${spec.seed}...`)

  try {
    const res = await agent(
      `Execute a generation command and extract output paths from JSON_SUMMARY.

COMMAND:
${cmd}

STEPS:
1. Run the command (may take 1-5 min per image):
   Bash("${cmd} 2>&1", timeout=600000)

2. Parse JSON_SUMMARY line from stdout:
   JSON_SUMMARY:{"status":"success","run_json":"...","manifest_json":"...","outputs":["/path/img.png"]}
   Extract the JSON after "JSON_SUMMARY:" prefix.

3. If no JSON_SUMMARY found, fall back:
   - "Saved: " lines → output PNG paths
   - "Run config: " lines → run.json path

4. If non-zero exit or "Error"/"Traceback" in output, set status="error".

Return JSON:
{
  "status": "success" or "error",
  "outputPngs": ["/abs/path/img.png"],
  "runJsonPath": "/abs/path/img.run.json" or "",
  "error": ""
}`,
      { label: `gen-${idx}-${spec.lane}-${spec.type}`, phase: "Generate", schema: GEN_SCHEMA },
    )
    res.spec = spec
    genResults.push(res)
    if (res?.status === "success") genCache[cmd] = res
  } catch (e) {
    log(`[${idx + 1}] Generation agent failed: ${e?.message || e}`)
    genResults.push({ status: "error", outputPngs: [], runJsonPath: "", error: String(e?.message || e), spec })
  }
}

const successCount = genResults.filter((r) => r.status === "success").length
const failCount = genResults.filter((r) => r.status !== "success").length
log(`Generation complete: ${successCount} success, ${failCount} failed`)

markPhase("generate", "completed")

// ── Phase 5: VLM pre-flight check ────────────────────────────────────────────

phase("VLM Check")

const VLM_CHECK_SCHEMA = {
  type: "object",
  properties: { available: { type: "boolean" } },
  required: ["available"],
}

const vlmCheck = await agent(
  `Check if LM Studio VLM is running at http://localhost:1234.

Run: Bash("curl -sf http://localhost:1234/v1/models -o /dev/null -w '%{http_code}'")

Return { "available": true } if HTTP 200, { "available": false } otherwise.
IMPORTANT: Return ONLY the JSON object.`,
  { label: "vlm-check", phase: "VLM Check", model: "haiku", schema: VLM_CHECK_SCHEMA },
)

const vlmAvailable = vlmCheck?.available === true
log(vlmAvailable ? "VLM available — proceeding with Review." : "VLM UNAVAILABLE — skipping Review. Start LM Studio with a VLM model.")

markPhase("vlmCheck", "completed")

// ── Phase 6: Review — Caption each PNG ───────────────────────────────────────

phase("Review")

const CAPTION_SCHEMA = {
  type: "object",
  properties: {
    imagePath:        { type: "string" },
    overall:          { type: "number" },
    detail:           { type: "number" },
    sharpness:        { type: "number" },
    composition:      { type: "number" },
    prompt_adherence: { type: "number" },
    artifacts:        { type: "number" },
    captured:         { type: "array", items: { type: "string" } },
    missed:           { type: "array", items: { type: "string" } },
    issues:           { type: "array", items: { type: "string" } },
    strengths:        { type: "array", items: { type: "string" } },
    summary:          { type: "string" },
    style:            { type: "string" },
    model:            { type: "string" },
    error:            { type: "string" },
  },
  required: ["imagePath"],
}

const captionable = genResults.filter((r) => r.outputPngs && r.outputPngs.length > 0)

if (!vlmAvailable) {
  log("Skipping caption phase (VLM unavailable).")
  captionable.forEach((r) => { r.captions = [] })
} else {
  const captionedResults = await pipeline(
    captionable,
    async (item, _orig, idx) => {
      log(`[${idx + 1}/${captionable.length}] Captioning ${item.outputPngs.length} PNG(s)...`)

      const captions = await parallel(
        item.outputPngs.map((pngPath, pngIdx) => () => {
          const captionFile = captionPathFor(pngPath)
          const label = item.spec.type === "lora" ? `${item.spec.lane}/${item.spec.loraName}` : `${item.spec.lane}/baseline`
          // Use per-image prompt for accurate prompt-adherence scoring
          const imagePrompt = item.spec.promptUsed || prompt

          return agent(
            `Score the image quality using the VLM caption tool.

IMAGE PATH: ${pngPath}
VARIANT: ${label}
SEED: ${item.spec.seed}
LANE: ${item.spec.lane}

STEPS:
1. Run the caption command with the prompt used for generation:
   Bash("${PYTHON} ${RUN_PY} caption '${pngPath}' --style review --prompt '${imagePrompt.replace(/'/g, "'\\''")}' --lang en")

   If connection error, set error = "VLM unavailable" and return.

2. Read the output caption JSON:
   Bash("cat '${captionFile}'")

3. Parse the outer JSON. The "caption" field is a nested JSON STRING — parse it again.
   The caption string may be wrapped in markdown fences — strip fences and extract the first {...}.
   Extract: overall, detail, sharpness, composition, prompt_adherence, artifacts,
   captured[], missed[], issues[], strengths[], summary.

Return flat JSON:
{
  "imagePath": "${pngPath}",
  "overall": <1-10>,
  "detail": <1-10>,
  "sharpness": <1-10>,
  "composition": <1-10>,
  "prompt_adherence": <1-10>,
  "artifacts": <1-10>,
  "captured": [...],
  "missed": [...],
  "issues": [...],
  "strengths": [...],
  "summary": "...",
  "style": "review",
  "model": "...",
  "error": ""
}`,
            { label: `caption-${label}-${item.spec.seed}`, phase: "Review", schema: CAPTION_SCHEMA },
          )
        }),
      )

      item.captions = captions.filter(Boolean)
      return item
    },
  )

  // Merge captioned results back
  captionedResults.forEach((captioned) => {
    if (captioned) {
      const idx = genResults.findIndex((r) => r.spec === captioned.spec)
      if (idx >= 0) genResults[idx] = captioned
    }
  })
}

// ── Build caption sets for manifest (multi-lane aware) ───────────────────────

const captionSets = []

// T2I lane sets: one per T2I LoRA, paired with baselines that used the same prompt
allT2iLoras.forEach((lora) => {
  const scale = bestScales[lora.name] || loraScale
  const loraPrompt = promptMap[lora.name]
  const setName = `T2I: Baseline vs ${lora.name} (${lora.category}, s=${scale})`
  const zh = wfLang === "zh_TW"
  const guide = zh
    ? `比較 T2I Baseline 與 ${lora.name} (${lora.category}, scale=${scale}) 的畫質。LoRA 是否改善了圖像？`
    : `Compare T2I Baseline vs ${lora.name} (${lora.category}, scale=${scale}). Does the LoRA improve quality?`

  const files = []
  // Baselines with matching prompt
  seeds.forEach((seed) => {
    const baseResult = genResults.find(
      (r) => r.spec?.type === "baseline" && r.spec?.lane === "t2i" && r.spec?.promptUsed === loraPrompt && r.spec?.seed === seed && r.outputPngs?.[0],
    )
    if (baseResult) files.push(captionPathFor(baseResult.outputPngs[0]))
  })
  // LoRA images
  seeds.forEach((seed) => {
    const loraResult = genResults.find(
      (r) => r.spec?.type === "lora" && r.spec?.lane === "t2i" && r.spec?.loraName === lora.name && r.spec?.seed === seed && r.outputPngs?.[0],
    )
    if (loraResult) files.push(captionPathFor(loraResult.outputPngs[0]))
  })

  captionSets.push({
    name: setName,
    prompt: loraPrompt,
    guide,
    variants: ["Baseline", `${lora.name} (s=${scale})`].map((l) => ({ label: l })),
    files,
  })
})

// Anime2Real lane sets
if (hasAnime2real) {
  anime2realLoras.forEach((lora) => {
    const scale = bestScales[lora.name] || loraScale
    const setName = `anime2real: Baseline vs ${lora.name} (s=${scale})`
    const zh = wfLang === "zh_TW"
    const guide = zh
      ? `比較 anime2real Baseline 與 ${lora.name} (scale=${scale}) 的寫實轉換品質。`
      : `Compare anime2real Baseline vs ${lora.name} (scale=${scale}) realism quality.`

    const files = []
    seeds.forEach((seed) => {
      const baseResult = genResults.find(
        (r) => r.spec?.type === "baseline" && r.spec?.lane === "anime2real" && r.spec?.seed === seed && r.outputPngs?.[0],
      )
      if (baseResult) files.push(captionPathFor(baseResult.outputPngs[0]))
    })
    seeds.forEach((seed) => {
      const loraResult = genResults.find(
        (r) => r.spec?.type === "lora" && r.spec?.lane === "anime2real" && r.spec?.loraName === lora.name && r.spec?.seed === seed && r.outputPngs?.[0],
      )
      if (loraResult) files.push(captionPathFor(loraResult.outputPngs[0]))
    })

    captionSets.push({
      name: setName,
      prompt: promptMap[lora.name],
      guide,
      variants: ["Baseline (no LoRA)", `${lora.name} (s=${scale})`].map((l) => ({ label: l })),
      files,
    })
  })
}

// Faceswap lane sets
if (hasFaceswap) {
  faceswapLoras.forEach((lora) => {
    const scale = bestScales[lora.name] || loraScale
    const setName = `faceswap: Default vs ${lora.name} (s=${scale})`
    const zh = wfLang === "zh_TW"
    const guide = zh
      ? `比較預設 faceswap 與 ${lora.name} (scale=${scale}) 的臉部替換品質。`
      : `Compare default faceswap vs ${lora.name} (scale=${scale}) face swap quality.`

    const files = []
    seeds.forEach((seed) => {
      const baseResult = genResults.find(
        (r) => r.spec?.type === "baseline" && r.spec?.lane === "faceswap" && r.spec?.seed === seed && r.outputPngs?.[0],
      )
      if (baseResult) files.push(captionPathFor(baseResult.outputPngs[0]))
    })
    seeds.forEach((seed) => {
      const loraResult = genResults.find(
        (r) => r.spec?.type === "lora" && r.spec?.lane === "faceswap" && r.spec?.loraName === lora.name && r.spec?.seed === seed && r.outputPngs?.[0],
      )
      if (loraResult) files.push(captionPathFor(loraResult.outputPngs[0]))
    })

    captionSets.push({
      name: setName,
      prompt,
      guide,
      variants: ["Default faceswap", `${lora.name} (s=${scale})`].map((l) => ({ label: l })),
      files,
    })
  })
}

const captionFiles = captionSets.flatMap((s) => s.files)

log(`Caption sets built: ${captionSets.length} set(s), ${captionFiles.length} caption file(s)`)
captionSets.forEach((s) => log(`  [${s.name}] ${s.files.length} images`))

markPhase("review", "completed")

// ── Phase 7: Report ──────────────────────────────────────────────────────────

phase("Report")

// Aggregate per-LoRA scores (all lanes combined)
const loraScoreSummary = loras.map((lora) => {
  const scores = { count: 0, overall: 0, detail: 0, sharpness: 0, composition: 0, prompt_adherence: 0, artifacts: 0 }
  genResults.forEach((r) => {
    if (r.spec?.type === "lora" && r.spec?.loraName === lora.name && r.captions) {
      r.captions.forEach((c) => {
        if (c.overall != null) {
          scores.count++
          scores.overall += c.overall || 0
          scores.detail += c.detail || 0
          scores.sharpness += c.sharpness || 0
          scores.composition += c.composition || 0
          scores.prompt_adherence += c.prompt_adherence || 0
          scores.artifacts += c.artifacts || 0
        }
      })
    }
  })
  if (scores.count > 0) {
    for (const k of ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"]) {
      scores[k] = Math.round((scores[k] / scores.count) * 100) / 100
    }
  }
  return { name: lora.name, category: lora.category, lane: lora.category === "style" || lora.category === "slider" || fallbackLoras.some((f) => f.name === lora.name) ? "t2i" : lora.category, ...scores }
})

// Baseline scores (T2I lane only for fair comparison)
const baseScoreSummary = { count: 0, overall: 0, detail: 0, sharpness: 0, composition: 0, prompt_adherence: 0, artifacts: 0 }
genResults.forEach((r) => {
  if (r.spec?.type === "baseline" && r.spec?.lane === "t2i" && r.captions) {
    r.captions.forEach((c) => {
      if (c.overall != null) {
        baseScoreSummary.count++
        baseScoreSummary.overall += c.overall || 0
        baseScoreSummary.detail += c.detail || 0
        baseScoreSummary.sharpness += c.sharpness || 0
        baseScoreSummary.composition += c.composition || 0
        baseScoreSummary.prompt_adherence += c.prompt_adherence || 0
        baseScoreSummary.artifacts += c.artifacts || 0
      }
    })
  }
})
if (baseScoreSummary.count > 0) {
  for (const k of ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"]) {
    baseScoreSummary[k] = Math.round((baseScoreSummary[k] / baseScoreSummary.count) * 100) / 100
  }
}

const reportResult = await agent(
  `Generate a concise LoRA comparison report for this flux2-klein dynamic A/B test.

## Test Configuration
- Pipeline: ${PIPELINE} (flux2-klein-9b LoRAs)
- Prompt (global): ${prompt.slice(0, 120)}${prompt.length > 120 ? "..." : ""}
- Per-LoRA prompts: ${JSON.stringify(Object.fromEntries(loras.map((l) => [l.name, promptMap[l.name]?.slice(0, 80) + "..."])))}
- Seeds: ${seeds.join(", ")}
- Steps: ${steps}
- Size: ${width}×${height}
- Scale sweep: ${doSweep ? `YES (${sweepScales.join(", ")})` : "NO (single scale)"}
- Optimal scales: ${loras.map((l) => `${l.name}=${bestScales[l.name]}`).join(", ")}
- LoRAs tested: ${loras.map((l) => `${l.name}[${l.category}]`).join(", ")}
- Lanes: T2I (${allT2iLoras.length} LoRAs)${hasAnime2real ? `, anime2real (${anime2realLoras.length})` : ""}${hasFaceswap ? `, faceswap (${faceswapLoras.length})` : ""}

${doSweep && sweepResults.length > 0 ? `## Scale Sweep Results
${JSON.stringify(sweepResults.map((sr) => ({
  loraName: sr.loraName,
  bestScale: sr.bestScale,
  sweepScores: sr.scores.map((s) => ({ scale: s.scale, overall: s.overall, detail: s.detail })),
})), null, 2)}` : ""}

## Baseline Scores (T2I lane, avg over ${baseScoreSummary.count} images)
${JSON.stringify(baseScoreSummary, null, 2)}

## Per-LoRA Scores at Optimal Scale (avg over seeds)
${JSON.stringify(loraScoreSummary, null, 2)}

## Full Results
${JSON.stringify(genResults.map((r) => ({
  type: r.spec?.type,
  lane: r.spec?.lane,
  lora: r.spec?.loraName || null,
  seed: r.spec?.seed,
  scale: r.spec?.scale || null,
  status: r.status,
  outputPngs: r.outputPngs,
  captions: r.captions?.map((c) => ({
    overall: c.overall, detail: c.detail, sharpness: c.sharpness,
    composition: c.composition, prompt_adherence: c.prompt_adherence, artifacts: c.artifacts,
    summary: c.summary, issues: c.issues, strengths: c.strengths,
  })),
})), null, 2)}

${priorHistory ? `## Prior Run Comparison (Trend)
- Previous run baseline: overall=${priorHistory.baseScoreSummary?.overall ?? "?"}, detail=${priorHistory.baseScoreSummary?.detail ?? "?"}
- Previous LoRA scores: ${JSON.stringify(priorHistory.loraScoreSummary?.map((s) => ({ name: s.name, overall: s.overall, detail: s.detail })) ?? [])}
- Previous best scales: ${JSON.stringify(priorHistory.bestScales ?? {})}
- Previous prompt: ${(priorHistory.args?.prompt || "unknown").slice(0, 100)}
- Delta baseline overall: ${baseScoreSummary.overall != null && priorHistory.baseScoreSummary?.overall != null ? (baseScoreSummary.overall - priorHistory.baseScoreSummary.overall).toFixed(2) : "N/A"}

Compare current vs prior run. Did scores improve, regress, or stay the same? Note if the prompt changed.` : "## Prior Run Comparison: No prior history (first run or fresh mode)."}

## Your Task

**1. Scale Sweep Summary** (if sweep was done) — for each LoRA, show which scale won and why.

**2. Per-lane results** — separate section for T2I lane, anime2real lane, faceswap lane (if active).

**3. Score comparison table** (T2I lane) — one row per LoRA + baseline:
| Variant | Category | Scale | Overall | Detail | Sharp | Comp | Adherence | Artifacts | Δ Overall |
Show Δ (delta) from baseline for each metric.

**4. Per-LoRA prompt analysis** — did using per-LoRA test_prompt help differentiate? Were trigger words effective?

**5. Winner** — which LoRA + scale has the highest overall score per category?

**6. Ceiling effect check** — if ALL T2I scores ≥ 8.5, add a warning: "CEILING EFFECT: All scores are very high. The base model already excels at these prompts. Consider testing with harder/adversarial prompts."

**7. Per-LoRA strengths/issues** — based on captions.

**8. Trend comparison** (if prior run data available).

**9. Recommendation** — per-category recommendations with optimal scale.

Keep the report concise. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)

markPhase("report", "completed")

// ── Phase 8: Review HTML ─────────────────────────────────────────────────────

let reviewHtml = ""
if (captionFiles.length > 0 && !noHtml) {
  phase("Review HTML")

  const manifestJson = JSON.stringify({ lang: wfLang, sets: captionSets }, null, 2)
  const totalFiles = captionSets.reduce((n, s) => n + s.files.length, 0)
  log(`Building review HTML — ${captionSets.length} set(s), ${totalFiles} image(s), lang=${wfLang}...`)

  const HTML_SCHEMA = {
    type: "object",
    properties: {
      htmlPath:   { type: "string" },
      imageCount: { type: "number" },
      error:      { type: "string" },
    },
    required: ["htmlPath"],
  }

  const htmlResult = await agent(
    `Write a multi-set A/B review manifest JSON to disk, then build the review HTML.

MANIFEST CONTENT (write VERBATIM — exactly this JSON, no changes):
${manifestJson}

STEPS:
1. Write the manifest verbatim to ${OUT_DIR}/ab_manifest.json. A quoted heredoc is safest:
   Bash("cat > '${OUT_DIR}/ab_manifest.json' <<'MANIFEST_EOF'\n${manifestJson}\nMANIFEST_EOF")
   Verify: Bash("cat '${OUT_DIR}/ab_manifest.json'")
2. Build the HTML:
   Bash("${PYTHON} ${RUN_PY} caption --ab-manifest '${OUT_DIR}/ab_manifest.json' 2>&1", timeout=120000)
3. Parse stdout for: Review HTML: /abs/path/review_*.html — extract the absolute path.
4. On error or missing line, set error to the excerpt.

Return JSON: { "htmlPath": "/abs/path/review.html" or "", "imageCount": ${totalFiles}, "error": "" }`,
    { label: "review-html", phase: "Review HTML", schema: HTML_SCHEMA },
  )

  reviewHtml = htmlResult?.htmlPath || ""
  log(reviewHtml ? `Review HTML: ${reviewHtml}` : (htmlResult?.error ? `Review HTML FAILED: ${htmlResult.error}` : "Review HTML build failed."))
}

markPhase("reviewHtml", reviewHtml ? "completed" : "skipped")

// ── Phase 9: Persist — write run history to disk ─────────────────────────────

phase("Persist")

const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: WORKFLOW_NAME,
  started_at: RUN_TIMESTAMP,
  args: {
    prompt: prompt.slice(0, 200),
    seeds,
    steps,
    width,
    height,
    lora_scale: loraScale,
    lora_scales: loraScales,
    loras: loraFilter,
    lang: wfLang,
    resume: resumeMode,
    useTestPrompts,
    includeFaceswap,
    animeImage: animeImage ? animeImage.slice(-60) : null,
    bodyImage: bodyImage ? bodyImage.slice(-60) : null,
    faceImage: faceImage ? faceImage.slice(-60) : null,
    denoiseStrength,
    realismStyle,
  },
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  tags: ["lora-review", "flux2-klein-9b", ...(doSweep ? ["scale-sweep"] : []), ...(hasAnime2real ? ["anime2real"] : []), ...(hasFaceswap ? ["faceswap"] : [])],
  result: {
    loras: loras.map((l) => ({ name: l.name, dirName: l.dirName, description: l.description, category: l.category })),
    seeds,
    bestScales,
    sweepResults,
    promptMap,
    loraScoreSummary,
    baseScoreSummary,
    reviewHtml,
    lanes: {
      t2i: { active: true, loraCount: allT2iLoras.length, baselines: t2iBaseSpecs.length, images: t2iLoraSpecs.length },
      anime2real: { active: hasAnime2real, loraCount: hasAnime2real ? anime2realLoras.length : 0, images: hasAnime2real ? a2rLoraSpecs.length : 0 },
      faceswap: { active: hasFaceswap, loraCount: hasFaceswap ? faceswapLoras.length : 0, images: hasFaceswap ? fsLoraSpecs.length : 0 },
    },
    generation: {
      totalImages: genResults.length,
      successCount,
      failCount,
      generatedImages: genResults
        .filter((r) => r.status === "success" && r.outputPngs?.[0])
        .map((r) => ({
          type: r.spec?.type,
          lane: r.spec?.lane,
          loraName: r.spec?.loraName || null,
          seed: r.spec?.seed,
          scale: r.spec?.scale || null,
          path: r.outputPngs[0],
        })),
    },
    priorRunId: priorHistory?.runId || null,
  },
}

const historyJson = JSON.stringify(historyEntry, null, 2)

await agent(
  `Persist the workflow run history to disk.

Steps:
1. Ensure directory exists: Bash("mkdir -p '${HISTORY_DIR}'")
2. Write the history JSON file using a heredoc:
   Bash("cat > '${HISTORY_DIR}/${RUN_ID}.json' <<'HISTORY_EOF'
${historyJson}
HISTORY_EOF")
3. Verify it was written: Bash("wc -c '${HISTORY_DIR}/${RUN_ID}.json'")
4. Prune old runs — keep only the 15 most recent:
   Bash("cd '${HISTORY_DIR}' && ls -t *.json 2>/dev/null | tail -n +16 | xargs rm -f")

Return { written: true, path: "${HISTORY_DIR}/${RUN_ID}.json" }.`,
  { label: "persist-history", phase: "Persist", model: "haiku" },
)

log(`History: persisted to ${HISTORY_DIR}/${RUN_ID}.json`)
markPhase("persist", "completed")

// ── Summary ──────────────────────────────────────────────────────────────────

log("\n=== Flux2 Klein LoRA Review Complete ===")
log(`Run: ${RUN_ID} | Images: ${genResults.length} (${successCount} ok, ${failCount} fail)`)
log(`Lanes: T2I (${allT2iLoras.length} LoRAs)${hasAnime2real ? ` + anime2real (${anime2realLoras.length})` : ""}${hasFaceswap ? ` + faceswap (${faceswapLoras.length})` : ""}`)
log(reportResult || "(no report)")
log(`\nLoRAs tested: ${loras.length}`)
loras.forEach((l) => {
  const summary = loraScoreSummary.find((s) => s.name === l.name)
  log(`  ${l.name} [${l.category}]: scale=${bestScales[l.name]} overall=${summary?.overall ?? "?"} (${summary?.count ?? 0} images)`)
})
log(`Baseline (T2I): overall=${baseScoreSummary.overall ?? "?"} (${baseScoreSummary.count} images)`)
if (reviewHtml) log(`\nReview HTML: ${reviewHtml}`)
log(`History: ${HISTORY_DIR}/${RUN_ID}.json`)
if (priorHistory) log(`Prior run comparison: loaded (baseline=${priorHistory.baseScoreSummary?.overall ?? "?"})`)

return {
  reviewHtml,
  captionFiles,
  captionSets,
  report: reportResult,
  loras,
  seeds,
  bestScales,
  sweepResults,
  promptMap,
  loraScoreSummary,
  baseScoreSummary,
  lanes: {
    t2i: { active: true, loraCount: allT2iLoras.length },
    anime2real: { active: hasAnime2real, loraCount: hasAnime2real ? anime2realLoras.length : 0 },
    faceswap: { active: hasFaceswap, loraCount: hasFaceswap ? faceswapLoras.length : 0 },
  },
  history: {
    runId: RUN_ID,
    path: `${HISTORY_DIR}/${RUN_ID}.json`,
    phasesCompleted,
    phasesFailed,
    priorRunLoaded: !!priorHistory,
  },
}
