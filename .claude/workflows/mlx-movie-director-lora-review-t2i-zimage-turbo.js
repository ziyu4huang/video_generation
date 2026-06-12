// mlx-movie-director-lora-review-t2i-zimage-turbo — LoRA A/B review for zimage-turbo
//
// Auto-discovers all zimage-turbo LoRAs, generates baseline vs LoRA pairs across
// multiple seeds, captions each via VLM, then builds ONE interactive review HTML
// for human feedback.
//
// Usage:
//   Workflow({ name: "mlx-movie-director-lora-review-t2i-zimage-turbo" })
//     → auto-discover all zimage-turbo LoRAs, portrait prompt, 4 seeds
//   Workflow({ name: "...", args: "A moody portrait in soft lighting" })
//     → custom prompt with auto-discovered LoRAs
//   Workflow({ name: "...", args: {
//     prompt: "...",             // T2I prompt (default: portrait)
//     seeds: [42, 123, 777],    // seeds (default: [42, 123, 777, 999])
//     steps: 9,                 // denoising steps (default: 9)
//     lora_scale: 1.0,          // single LoRA scale → skip sweep
//     lora_scales: [0.5, 0.8, 1.0, 1.2], // sweep range → auto-pick best per LoRA
//     loras: ["zit-sda-v1"],    // specific LoRAs (default: auto-discover all)
//     width: 640,               // image width (default: 640)
//     height: 960,              // image height (default: 960)
//     lang: "zh_TW",            // HTML language
//     noHtml: false,            // skip HTML generation
//     resume: "auto",           // "auto" | "fresh" | "continue"
//   } })
//
// Generation plan (auto-discover, 2 LoRAs × 4 seeds, scale sweep):
//   Scale sweep: 2 LoRAs × 4 scales × 1 probe seed = 8 probe images
//   Baselines: 4 images (shared across LoRA sets)
//   LoRA images: 2 × 4 = 8 images (at optimal scale per LoRA)
//   Total: ~20 images (sweep + baselines + LoRA at best scale)
//   ~40-50 min on Apple Silicon (sequential, GPU-safe)
//
// History:
//   Run history persisted to .claude/workflows/history/<workflow-name>/<timestamp>.json
//   Enables trend comparison across runs, resume from interrupted runs, and incremental improvement.
//
// Output:
//   { reviewHtml, captionFiles, captionSets, report, loras, seeds, bestScales, sweepResults, history }

export const meta = {
  name: "mlx-movie-director-lora-review-t2i-zimage-turbo",
  description: "LoRA A/B review: auto-discover zimage-turbo LoRAs, generate baseline vs LoRA pairs, caption, build interactive comparison HTML",
  whenToUse: "Compare all zimage-turbo LoRAs against baseline in one run. Generates paired images per seed, VLM-scores each, and produces a multi-set review HTML for human feedback.",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root via git rev-parse" },
    { title: "Discover", detail: "Auto-scan models/lora/*/manifest.json for zimage-turbo LoRAs" },
    { title: "GPU Wait", detail: "Wait if another run.py generation is using the GPU" },
    { title: "Scale Sweep", detail: "Probe each LoRA at multiple scales to find optimal setting" },
    { title: "Generate", detail: "Baseline + LoRA (optimal scale) variants per seed (sequential, GPU-safe)" },
    { title: "VLM Check", detail: "Verify LM Studio is running before caption phase" },
    { title: "Review", detail: "Score each output PNG via run.py caption --style review" },
    { title: "Report", detail: "Per-LoRA quality comparison with optimal scale + winner summary" },
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

const PYTHON      = `${PROJECT_ROOT}/python/venv/bin/python`
const RUN_PY      = `${PROJECT_ROOT}/python/mlx-movie-director/run.py`
const OUT_DIR     = `${PROJECT_ROOT}/python/mlx-movie-director/output`
const LORA_DIR    = `${PROJECT_ROOT}/python/mlx-movie-director/models/lora`

const WORKFLOW_NAME = "mlx-movie-director-lora-review-t2i-zimage-turbo"
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

  Current invocation args: ${JSON.stringify({ prompt: (typeof resolvedArgs === "string" ? resolvedArgs : resolvedArgs?.prompt || "default").slice(0, 60), seeds: (resolvedArgs?.seeds || [42, 123, 777, 999]).join(","), steps: resolvedArgs?.steps || 9, resume: resumeMode })}

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function captionPathFor(pngPath) {
  return pngPath.replace(/\.[^.\/]+$/, "") + ".caption.json"
}

// Default portrait prompt from test_prompts_image.py
const DEFAULT_PROMPT = (
  "photorealistic portrait of a young woman, sharp eyes with detailed irises, " +
  "natural skin texture with fine pores, soft studio lighting, bokeh background, " +
  "high detail, ultra sharp focus"
)

const DEFAULT_SEEDS  = [42, 123, 777, 999]
const DEFAULT_STEPS  = 9
const DEFAULT_WIDTH  = 640
const DEFAULT_HEIGHT = 960
const DEFAULT_SCALE  = 1.0
const DEFAULT_SCALES = [0.5, 0.8, 1.0, 1.2]  // sweep range for auto-optimal

// ── Args normalization ───────────────────────────────────────────────────────

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

let prompt     = DEFAULT_PROMPT
let seeds      = DEFAULT_SEEDS
let steps      = DEFAULT_STEPS
let width      = DEFAULT_WIDTH
let height     = DEFAULT_HEIGHT
let loraScale  = DEFAULT_SCALE
let loraScales = null    // null = use DEFAULT_SCALES (sweep), array = custom sweep, single-element = skip sweep
let wfLang     = "zh_TW"
let noHtml     = false
let resumeMode = "auto"  // "auto" | "fresh" | "continue"
let loraFilter = null   // null = auto-discover, array = specific names

if (typeof resolvedArgs === "string" && resolvedArgs.length > 0) {
  prompt = resolvedArgs
} else if (isObj(resolvedArgs)) {
  if (typeof resolvedArgs.prompt === "string")      prompt     = resolvedArgs.prompt
  if (Array.isArray(resolvedArgs.seeds))             seeds      = resolvedArgs.seeds.map(Number)
  if (resolvedArgs.steps != null)                    steps      = Number(resolvedArgs.steps)
  if (resolvedArgs.width != null)                    width      = Number(resolvedArgs.width)
  if (resolvedArgs.height != null)                   height     = Number(resolvedArgs.height)
  if (resolvedArgs.lora_scale != null)               loraScale  = Number(resolvedArgs.lora_scale)
  if (Array.isArray(resolvedArgs.lora_scales))       loraScales = resolvedArgs.lora_scales.map(Number)
  if (typeof resolvedArgs.lang === "string")         wfLang     = resolvedArgs.lang
  if (resolvedArgs.noHtml === true)                  noHtml     = true
  if (["auto", "fresh", "continue"].includes(resolvedArgs.resume)) resumeMode = resolvedArgs.resume
  if (Array.isArray(resolvedArgs.loras))             loraFilter = resolvedArgs.loras
}

// Determine sweep behavior:
//   - lora_scales provided → use that array for sweep
//   - lora_scale provided (but not lora_scales) → single scale, skip sweep
//   - neither → use DEFAULT_SCALES for sweep
const doSweep = loraScales === null && resolvedArgs?.lora_scale == null
const sweepScales = loraScales || (resolvedArgs?.lora_scale != null ? [Number(resolvedArgs.lora_scale)] : DEFAULT_SCALES)

// ── Phase 1: Discover zimage-turbo LoRAs ─────────────────────────────────────

phase("Discover")

const DISCOVER_SCHEMA = {
  type: "object",
  properties: {
    loras: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name:        { type: "string" },
          dirName:     { type: "string" },
          description: { type: "string" },
          loraPath:    { type: "string" },
        },
        required: ["name", "dirName", "loraPath"],
      },
    },
  },
  required: ["loras"],
}

const discovery = await agent(
  `Discover all zimage-turbo compatible LoRA models by scanning manifest.json files.

LORA_DIR: ${LORA_DIR}
${loraFilter ? `FILTER: Only include these LoRA names: ${JSON.stringify(loraFilter)}` : "FILTER: None — discover all zimage-turbo LoRAs"}

STEPS:
1. List all subdirectories in ${LORA_DIR}:
   Bash("ls -1 '${LORA_DIR}'")

2. For each subdirectory that has a manifest.json, read it:
   Bash("cat '${LORA_DIR}/<dirname>/manifest.json'")

3. Filter: keep only entries where "arch" is "zimage-turbo" AND "type" is "lora".
   ${loraFilter ? `Also filter: only keep entries whose "name" field is in: ${JSON.stringify(loraFilter)}` : ""}

4. For each matching LoRA, build:
   - name: manifest "name" field
   - dirName: the subdirectory name
   - description: manifest "description" field (or "No description")
   - loraPath: "${LORA_DIR}/<dirname>/"  (directory path for --lora-path)

Return JSON: { "loras": [<array of objects above>] }
If no LoRAs found, return { "loras": [] }.`,
  { label: "discover-loras", phase: "Discover", model: "haiku", schema: DISCOVER_SCHEMA },
)

const loras = discovery?.loras || []

if (loras.length === 0) {
  log("ERROR: No zimage-turbo LoRAs found. Check models/lora/*/manifest.json files.")
  return { reviewHtml: "", captionFiles: [], captionSets: [], report: "No LoRAs found", loras: [], seeds }
}

log(`Discovered ${loras.length} zimage-turbo LoRA(s):`)
loras.forEach((l, i) => log(`  [${i}] ${l.name} — ${l.description} (${l.dirName})`))

markPhase("discover", "completed")
//
// Plan structure (with sweep):
//   Scale sweep:  N LoRAs × M scales × 1 probe seed
//   Baselines:    N seeds × 1 (no LoRA)  — shared across all LoRA sets
//   LoRA images:  N LoRAs × N seeds × 1 (at best scale per LoRA)
//
// Plan structure (without sweep, lora_scale set):
//   Baselines:   N seeds × 1
//   LoRA images: N LoRAs × N seeds × 1 (at specified scale)
//   Total:       seeds.length + loras.length × seeds.length

const baseSpecs = seeds.map((seed) => ({
  type: "baseline",
  seed,
  cmd: `${PYTHON} ${RUN_PY} t2i --prompt '${prompt.replace(/'/g, "'\\''")}' --pipeline zimage --steps ${steps} --seed ${seed} --width ${width} --height ${height} --json-summary`,
}))

const loraSpecs = []
loras.forEach((lora) => {
  seeds.forEach((seed) => {
    loraSpecs.push({
      type: "lora",
      loraName: lora.name,
      loraPath: lora.loraPath,
      seed,
      scale: loraScale,  // will be updated after sweep
      cmd: "",  // placeholder, rebuilt after sweep
    })
  })
})

log(`\nGeneration plan:`)
log(`  Seeds:  ${seeds.join(", ")}`)
log(`  Steps:  ${steps}`)
log(`  Size:   ${width}×${height}`)
log(`  Sweep:  ${doSweep ? `YES — scales ${DEFAULT_SCALES.join(", ")}` : `NO — using lora_scale=${loraScale}`}`)
log(`  Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`)

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

// ── Phase 3a: Scale Sweep (find optimal scale per LoRA) ──────────────────────

const bestScales = {}   // loraName → optimal scale
const sweepResults = [] // full sweep data for report

if (doSweep) {
  phase("Scale Sweep")

  const probeSeed = seeds[0]  // use first seed as probe
  const sweepSpecs = []
  loras.forEach((lora) => {
    sweepScales.forEach((scale) => {
      sweepSpecs.push({
        type: "sweep",
        loraName: lora.name,
        loraPath: lora.loraPath,
        seed: probeSeed,
        scale,
        cmd: `${PYTHON} ${RUN_PY} t2i --prompt '${prompt.replace(/'/g, "'\\''")}' --pipeline zimage --steps ${steps} --seed ${probeSeed} --width ${width} --height ${height} --lora-path '${lora.loraPath}' --lora-scale ${scale} --json-summary`,
      })
    })
  })

  const totalSweep = sweepSpecs.length
  log(`Scale sweep: ${loras.length} LoRAs × ${sweepScales.length} scales = ${totalSweep} probe images (seed=${probeSeed})`)

  // Generate sweep images (reuse GEN_SCHEMA defined later, but we need it now)
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
1. Run the command (may take 2-5 min per image):
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

  const sweepScores = [] // { loraName, scale, overall, detail, ... }

  for (let idx = 0; idx < sweepCaptionable.length; idx++) {
    const item = sweepCaptionable[idx]
    const pngPath = item.outputPngs[0]
    const captionFile = captionPathFor(pngPath)
    const loraName = item.spec.loraName
    const scale = item.spec.scale

    try {
      const cap = await agent(
        `Quick quality score for a sweep probe image.

IMAGE PATH: ${pngPath}
LoRA: ${loraName} at scale=${scale}

STEPS:
1. Run: Bash("${PYTHON} ${RUN_PY} caption '${pngPath}' --style review --prompt '${prompt.replace(/'/g, "'\\''")}' --lang en")
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
  loras.forEach((lora) => {
    const loraScores = sweepScores.filter((s) => s.loraName === lora.name && s.overall > 0)
    if (loraScores.length === 0) {
      bestScales[lora.name] = loraScale  // fallback to default
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
  loras.forEach((l) => log(`  ${l.name}: best scale = ${bestScales[l.name] || loraScale}`))
} else {
  // No sweep — use the single specified scale for all LoRAs
  loras.forEach((lora) => { bestScales[lora.name] = loraScale })
  log(`Scale sweep: SKIPPED (using lora_scale=${loraScale} for all LoRAs)`)
}

markPhase("scaleSweep", doSweep ? "completed" : "skipped")

loraSpecs.forEach((spec) => {
  const scale = bestScales[spec.loraName] || loraScale
  spec.scale = scale
  spec.cmd = `${PYTHON} ${RUN_PY} t2i --prompt '${prompt.replace(/'/g, "'\\''")}' --pipeline zimage --steps ${steps} --seed ${spec.seed} --width ${width} --height ${height} --lora-path '${spec.loraPath}' --lora-scale ${scale} --json-summary`
})

const allSpecs = [...baseSpecs, ...loraSpecs]
const totalImages = allSpecs.length

log(`\nMain generation: ${seeds.length} baselines + ${loraSpecs.length} LoRA = ${totalImages} images`)
loras.forEach((l) => {
  const count = loraSpecs.filter((s) => s.loraName === l.name).length
  log(`  ${l.name}: ${count} images at scale=${bestScales[l.name]}`)
})

// ── Phase 3b: Generate (sequential, GPU-safe) ────────────────────────────────

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
const genCache = {}  // cmd → result (dedup identical commands)

for (let idx = 0; idx < allSpecs.length; idx++) {
  const spec = allSpecs[idx]
  const cmd = spec.cmd

  if (genCache[cmd]) {
    log(`[${idx + 1}/${totalImages}] Dedup — reusing cached result (${spec.type}${spec.type === "lora" ? ` ${spec.loraName}` : ""}, seed=${spec.seed})`)
    genResults.push({ ...genCache[cmd], spec })
    continue
  }

  log(`[${idx + 1}/${totalImages}] Generating ${spec.type}${spec.type === "lora" ? ` ${spec.loraName}` : ""}, seed=${spec.seed}...`)

  try {
    const res = await agent(
      `Execute a T2I generation command and extract output paths from JSON_SUMMARY.

COMMAND:
${cmd}

STEPS:
1. Run the command (may take 2-5 min per image):
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
      { label: `gen-${idx}-${spec.type}`, phase: "Generate", schema: GEN_SCHEMA },
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

markPhase("generate", failCount === 0 ? "completed" : "completed")

// ── Phase 4: VLM pre-flight check ────────────────────────────────────────────

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

// ── Phase 5: Review — Caption each PNG ───────────────────────────────────────

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

// Only caption results that have PNGs
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
          const label = item.spec.type === "lora" ? item.spec.loraName : "baseline"

          return agent(
            `Score the image quality of a T2I output using the VLM caption tool.

IMAGE PATH: ${pngPath}
VARIANT: ${label}
SEED: ${item.spec.seed}

STEPS:
1. Run the caption command with the original prompt for review scoring:
   Bash("${PYTHON} ${RUN_PY} caption '${pngPath}' --style review --prompt '${prompt.replace(/'/g, "'\\''")}' --lang en")

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

// ── Build caption sets for manifest ──────────────────────────────────────────
//
// Each LoRA gets one set: { name, prompt, guide, variants, files }
// Baseline images are shared across all sets.

const captionSets = loras.map((lora) => {
  const scale = bestScales[lora.name] || loraScale
  const setName = `Baseline vs ${lora.name} (scale=${scale})`
  const zh = wfLang === "zh_TW"
  const guide = zh
    ? `比較 Baseline（無 LoRA）與 ${lora.name} (scale=${scale}) 的整體畫質、寫實度與細節。LoRA 是否改善了圖像品質？`
    : `Compare Baseline (no LoRA) vs ${lora.name} (scale=${scale}). Does the LoRA improve overall quality, realism, and detail?`

  const variantLabels = ["Baseline", `${lora.name} (s=${scale})`]
  const files = []

  // Add baseline captions for this set
  seeds.forEach((seed) => {
    const baseResult = genResults.find(
      (r) => r.spec?.type === "baseline" && r.spec?.seed === seed && r.outputPngs?.[0],
    )
    if (baseResult) {
      files.push(captionPathFor(baseResult.outputPngs[0]))
    }
  })

  // Add LoRA captions for this set
  seeds.forEach((seed) => {
    const loraResult = genResults.find(
      (r) => r.spec?.type === "lora" && r.spec?.loraName === lora.name && r.spec?.seed === seed && r.outputPngs?.[0],
    )
    if (loraResult) {
      files.push(captionPathFor(loraResult.outputPngs[0]))
    }
  })

  return { name: setName, prompt, guide, variants: variantLabels.map((l) => ({ label: l })), files }
})

const captionFiles = captionSets.flatMap((s) => s.files)

log(`Caption sets built: ${captionSets.length} set(s), ${captionFiles.length} caption file(s)`)
captionSets.forEach((s) => log(`  [${s.name}] ${s.files.length} images`))

markPhase("review", "completed")

// ── Phase 6: Report ──────────────────────────────────────────────────────────

phase("Report")

// Aggregate per-LoRA scores
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
  return { name: lora.name, ...scores }
})

// Baseline scores
const baseScoreSummary = { count: 0, overall: 0, detail: 0, sharpness: 0, composition: 0, prompt_adherence: 0, artifacts: 0 }
genResults.forEach((r) => {
  if (r.spec?.type === "baseline" && r.captions) {
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
  `Generate a concise LoRA comparison report for this zimage-turbo A/B test.

## Test Configuration
- Pipeline: zimage (zimage-turbo LoRAs)
- Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? "..." : ""}
- Seeds: ${seeds.join(", ")}
- Steps: ${steps}
- Size: ${width}×${height}
- Scale sweep: ${doSweep ? `YES (${sweepScales.join(", ")})` : "NO (single scale)"}
- Optimal scales: ${loras.map((l) => `${l.name}=${bestScales[l.name]}`).join(", ")}
- LoRAs tested: ${loras.map((l) => l.name).join(", ")}

${doSweep && sweepResults.length > 0 ? `## Scale Sweep Results
${JSON.stringify(sweepResults.map((sr) => ({
  loraName: sr.loraName,
  bestScale: sr.bestScale,
  sweepScores: sr.scores.map((s) => ({ scale: s.scale, overall: s.overall, detail: s.detail })),
})), null, 2)}` : ""}

## Baseline Scores (avg over ${baseScoreSummary.count} images)
${JSON.stringify(baseScoreSummary, null, 2)}

## Per-LoRA Scores at Optimal Scale (avg over seeds)
${JSON.stringify(loraScoreSummary, null, 2)}

## Full Results
${JSON.stringify(genResults.map((r) => ({
  type: r.spec?.type,
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

**1. Scale Sweep Summary** (if sweep was done) — for each LoRA, show which scale won and why:
| LoRA | Best Scale | Overall at Best | Sweep Scores |
Show all tested scales and highlight the winner.

**2. Score comparison table** — one row per LoRA + baseline (at optimal scale):
| Variant | Scale | Overall | Detail | Sharp | Comp | Adherence | Artifacts | Δ Overall |
|---|---|---|---|---|---|---|---|---|
Show Δ (delta) from baseline for each metric.

**3. Winner** — which LoRA + scale has the highest overall score? Is it a meaningful improvement over baseline?

**4. Per-LoRA strengths** — based on captured/strengths, what does each LoRA excel at?

**5. Per-LoRA issues** — top issues per LoRA (from issues[]).

**6. Trend comparison** (if prior run data available) — how scores changed vs prior run, different prompt/scale effects.

**7. Recommendation** — which LoRA to use, at what scale, and for what types of prompts. If scores hit ceiling (9/9 everywhere), suggest harder test prompts.

Keep the report concise. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)

markPhase("report", "completed")

// ── Phase 7: Review HTML ─────────────────────────────────────────────────────

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

// ── Phase 8: Persist — write run history to disk ─────────────────────────────

phase("Persist")

// Reuse successCount/failCount from Generate phase (already defined)

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
  },
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  tags: ["lora-review", "zimage-turbo", ...(doSweep ? ["scale-sweep"] : [])],
  result: {
    loras: loras.map((l) => ({ name: l.name, dirName: l.dirName, description: l.description })),
    seeds,
    bestScales,
    sweepResults,
    loraScoreSummary,
    baseScoreSummary,
    reviewHtml,
    generation: {
      totalImages: genResults.length,
      successCount,
      failCount,
      generatedImages: genResults
        .filter((r) => r.status === "success" && r.outputPngs?.[0])
        .map((r) => ({
          type: r.spec?.type,
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

log("\n=== LoRA Review Complete ===")
log(`Run: ${RUN_ID} | Images: ${genResults.length} (${successCount} ok, ${failCount} fail)`)
log(reportResult || "(no report)")
log(`\nLoRAs tested: ${loras.length}`)
loras.forEach((l) => {
  const summary = loraScoreSummary.find((s) => s.name === l.name)
  log(`  ${l.name}: scale=${bestScales[l.name]} overall=${summary?.overall ?? "?"} (${summary?.count ?? 0} images)`)
})
log(`Baseline: overall=${baseScoreSummary.overall ?? "?"} (${baseScoreSummary.count} images)`)
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
  loraScoreSummary,
  baseScoreSummary,
  history: {
    runId: RUN_ID,
    path: `${HISTORY_DIR}/${RUN_ID}.json`,
    phasesCompleted,
    phasesFailed,
    priorRunLoaded: !!priorHistory,
  },
}
