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
//     challengePrompts: true,       // use built-in anatomy challenge prompts (6 stress-test prompts)
//     prompts: [                    // custom multi-prompt set (overrides challengePrompts)
//       "prompt 1 ...",
//       "prompt 2 ...",
//     ],
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

// ── Retry helper (rate-limit / transient-failure resilience) ─────────────────
// The orchestrator's model API can return 429 ("Rate limit reached") when too many
// subagents run concurrently. parallel() swallows a thrown agent() into null, which
// silently drops a caption score (degrading a LoRA's average). withRetry wraps an
// agent call and retries on TRANSIENT failures (429 / rate limit / timeout /
// overloaded / null), backing off via a sleep-subagent. It does NOT retry PERMANENT
// failures ("VLM unavailable" / "connection" — the local VLM is genuinely down;
// retrying wastes ~30s each).

async function sleepBackoff(secs) {
  await agent(
    `Backoff sleep to clear API rate limit. Run: Bash("sleep ${secs}"). Return { ok: true }.`,
    { label: "retry-sleep", model: "haiku", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
  )
}

// Usage-limit 429 (account quota: "Usage limit reached for 5 hour", code 1308) will NOT
// clear in a 30-60s backoff — retrying just burns time and attempts. Treat it as PERMANENT
// (return immediately) so we don't sleep through a doomed retry loop. Distinguished from a
// per-call rate-limit 429, which IS transient and worth retrying.
const USAGE_LIMIT_RE = /usage limit|limit reached|code 1308|reset at/

async function withRetry(fn, { retries = 2, backoff = 30 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r
    try {
      r = await fn()
    } catch (err) {
      const m = String(err?.message || err).toLowerCase()
      if (USAGE_LIMIT_RE.test(m)) return null // permanent quota — do not retry
      if (attempt < retries && /429|rate|timeout|overloaded/.test(m)) {
        await sleepBackoff(backoff * (attempt + 1))
        continue
      }
      return null // non-transient throw
    }
    const e = String(r?.error || "").toLowerCase()
    if (e && USAGE_LIMIT_RE.test(e)) return r // permanent quota — do not retry
    if (e && /vlm unavailable|connection/.test(e)) return r // permanent — don't retry
    const transient = r == null || /429|rate|timeout|overloaded/.test(e)
    if (transient && attempt < retries) {
      await sleepBackoff(backoff * (attempt + 1))
      continue
    }
    return r
  }
  return null
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

// Raw-string load schemas — the agent returns the EXACT cat output and the SCRIPT parses it.
// Asking a haiku agent to both cat AND parse a 75-line JSON in one shot is unreliable (it
// returned {reflection:null} in the wfkn9vjf8 run, silently disabling ceiling escalation).
const RAW_STRING_SCHEMA = {
  type: "object",
  properties: { raw: { type: "string" } },
  required: ["raw"],
}
const RESUME_RAW_SCHEMA = {
  type: "object",
  properties: { latestFile: { type: "string" }, raw: { type: "string" } },
  required: ["latestFile", "raw"],
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

// Built-in anatomy challenge prompts for ceiling-effect busting
const ANATOMY_CHALLENGE_PROMPTS = [
  {
    name: "anatomy-hands-complex",
    prompt: "photorealistic close-up of a woman's hands holding a small origami crane, five fingers clearly visible on each hand with distinct knuckles and fingernails, fingers delicately folding paper with visible tension in the joints, natural skin texture with fine creases at each finger joint, even studio lighting, macro photography, ultra sharp focus on fingers",
    width: 640,
    height: 960,
  },
  {
    name: "anatomy-ballet-action",
    prompt: "full body shot of a female ballet dancer in mid-grand jete leap, left leg fully extended forward with pointed toes, right leg stretched back at 180 degree split, arms in fifth position with elbows slightly bent, visible muscle definition in calves and thighs, torso twisted with chest facing camera, photorealistic, detailed anatomy, dramatic stage lighting, ultra sharp focus",
    width: 640,
    height: 960,
  },
  {
    name: "anatomy-foreshortening",
    prompt: "photorealistic portrait of a man reaching his right hand directly toward the camera in a foreshortened perspective, hand appearing disproportionately large with clearly visible five fingers and knuckles, arm receding dramatically into the background with correct elliptical foreshortening at the elbow joint, head and shoulders smaller in the distance, natural lighting, wide-angle perspective distortion, ultra sharp focus",
    width: 640,
    height: 960,
  },
  {
    name: "anatomy-torso-twist",
    prompt: "full body shot of a young woman in a dramatic contrapposto pose, torso twisted 45 degrees to the right while hips face forward, visible oblique muscle engagement, right arm raised behind her head with elbow bent at a sharp angle, left hand resting on her hip with five individual fingers visible, weight on left leg with right knee slightly bent, correct spinal curve, photorealistic, detailed anatomy, studio lighting, ultra sharp focus",
    width: 640,
    height: 960,
  },
  {
    name: "anatomy-multi-person",
    prompt: "photorealistic image of two young women dancing salsa together, their arms intertwined with the leader's right hand holding the follower's left hand showing five fingers each, the follower's right arm draped over the leader's left shoulder, torsos close together with visible correct torso angles, their legs in mid-step with knees at different angles, natural club lighting, detailed hands and limb anatomy, ultra sharp focus",
    width: 640,
    height: 960,
  },
  {
    name: "anatomy-low-angle",
    prompt: "extreme low angle shot looking up at a man standing on a ledge above the camera, camera at knee height looking upward, visible perspective distortion with legs appearing large and head appearing small, hands on hips with clearly defined five fingers and knuckles, jawline and chin visible from below with correct neck anatomy, dramatic sky background, photorealistic, wide-angle lens distortion, detailed anatomy, ultra sharp focus",
    width: 640,
    height: 960,
  },
]

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
let challengePrompts = false
let customPrompts    = null   // array of prompt strings
let noCeilingEscalation = false // opt out of auto-escalating ceiling-prone LoRAs to challenge prompts

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
  if (resolvedArgs.challengePrompts === true)         challengePrompts = true
  if (Array.isArray(resolvedArgs.prompts))             customPrompts = resolvedArgs.prompts
  if (resolvedArgs.noCeilingEscalation === true)       noCeilingEscalation = true
}

// Sweep is opt-in (prior run showed zero scale sensitivity 0.5-1.2 across all LoRAs).
// Pass doSweep: true or lora_scales: [...] to enable.
const doSweep = resolvedArgs?.doSweep === true || Array.isArray(resolvedArgs?.lora_scales)
const sweepScales = loraScales || (resolvedArgs?.lora_scale != null ? [Number(resolvedArgs.lora_scale)] : DEFAULT_SCALES)

// Multi-prompt challenge mode
const multiPromptSet = customPrompts
  ? customPrompts.map((p, i) => ({ name: `custom-${i}`, prompt: p, width, height }))
  : challengePrompts
    ? ANATOMY_CHALLENGE_PROMPTS
    : null
const isMultiPrompt = multiPromptSet !== null

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

const WORKFLOW_NAME  = "mlx-movie-director-lora-review-flux2-klein"
const HISTORY_DIR    = `${PROJECT_ROOT}/.claude/workflows/history/${WORKFLOW_NAME}`
const REFLECTION_FILE = `${HISTORY_DIR}/reflection.json`
const INDEX_FILE     = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`

// ── saveHistory — identical in every workflow; update _shared-patterns.md first ──
// Writes history JSON then VERIFIES (test -s) and rewrites via a quoted heredoc if the Write
// tool silently produced nothing — a reliability fix: the prior run's persist subagent reported
// success but never wrote the file, breaking the trend/reflection/resume loops.
async function saveHistory(histDir, indexFile, entry, signals) {
  const histJson = JSON.stringify({ ...entry, signals }, null, 2)
  const runId = entry.run_id
  const targetPath = `${histDir}/${runId}.json`
  const persist = await agent(
    `Persist workflow history to disk RELIABLY.
1. Bash("mkdir -p '${histDir}'")
2. Write the file with the Write tool: file_path='${targetPath}', content is the JSON below — paste it VERBATIM, do not summarize or truncate:
${histJson}
3. Verify it landed: Bash("test -s '${targetPath}' && echo OK || echo MISSING")
4. If step 3 printed MISSING, rewrite via a quoted heredoc (no expansion):
   Bash("cat > '${targetPath}' <<'HIST_EOF'
${histJson}
HIST_EOF")
5. Bash("wc -c < '${targetPath}'")
6. Prune old (keep newest 15, exclude reflection): Bash("cd '${histDir}' && ls -t *.json 2>/dev/null | grep -v reflection | tail -n +16 | xargs rm -f 2>/dev/null || true")
Return { written: true, bytes: <the number printed by wc> }.`,
    { label: "persist-history", phase: "Persist", model: "haiku" },
  )
  const histBytes = Number(persist?.bytes) || 0
  if (histBytes > 0) {
    log(`History: written ${histBytes} bytes → ${targetPath}`)
  } else {
    log(`WARNING: history file verification FAILED (0 bytes) — run continues but trend/reflection will miss this run.`)
  }
  await agent(
    `Update cross-workflow index at ${indexFile}.
1. Bash("cat '${indexFile}' 2>/dev/null || echo '[]'")
2. Parse JSON array. Append: ${JSON.stringify({ run_id: runId, workflow: entry.workflow, started_at: entry.started_at, run_quality: signals.run_quality, key_metric: signals.key_metric, highlights: signals.highlights })}
3. Keep only latest 50 entries (sort by run_id descending).
4. Write({ file_path: '${indexFile}', content: <updated array, 2-space indent> })
5. Verify: Bash("test -s '${indexFile}' && echo OK || echo MISSING")
6. If MISSING, rewrite the index via a quoted heredoc with the same array content.
Return { updated: true }.`,
    { label: "update-index", phase: "Persist", model: "haiku" },
  )
}

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
  // Find the most recent prior run file (EXCLUDING reflection.json) and return its RAW
  // contents — the SCRIPT parses it. An LLM cat+parse+decide was unreliable: the
  // wfkn9vjf8 run logged "no prior history found" despite files existing on disk.
  const resumeRaw = await agent(
    `Find the most recent prior run history file for "${WORKFLOW_NAME}" (EXCLUDE reflection.json) and return its RAW contents.
1. Bash("mkdir -p '${HISTORY_DIR}'")
2. Bash("ls -t '${HISTORY_DIR}'/*.json 2>/dev/null | grep -v reflection | head -1")
3. If a path was returned, cat it: Bash("cat '<path>'")
Return { latestFile: "<the path, or '' if none>", raw: "<the EXACT full cat output verbatim — or '__NONE__' if no file>" }.
Do NOT parse, summarize, or modify the output.`,
    { label: "resume-check", phase: "Resolve", model: "haiku", schema: RESUME_RAW_SCHEMA },
  )

  let priorParsed = null
  const latestFile = (resumeRaw?.latestFile || "").trim()
  const latestRaw = resumeRaw?.raw || ""
  if (latestFile && latestRaw && latestRaw !== "__NONE__") {
    try { priorParsed = JSON.parse(latestRaw) } catch { priorParsed = null }
  }

  if (!priorParsed) {
    log("Resume: no prior history found — starting fresh.")
  } else {
    const priorStatus = priorParsed.status || ""
    const priorRunId = priorParsed.run_id || (latestFile.split("/").pop() || "").replace(/\.json$/, "")
    // No robust mid-phase resume exists (no image-level cache), so both "complete" and
    // "partial" prior runs are loaded for trend comparison only.
    priorHistory = priorParsed.result || null
    log(`Resume: prior run ${priorRunId} (status="${priorStatus}") loaded for trend comparison.`)
    if (priorHistory) {
      const ps = priorHistory.baseScoreSummary
      log(`  Prior run: baseline overall=${ps?.overall ?? "?"}, LoRAs=${priorHistory.loraScoreSummary?.length || 0}`)
    }
  }

  if (resumeMode === "continue" && !priorHistory) {
    log("WARNING: resume=continue but no prior run found. Starting fresh.")
  }
}

// ── Load LoRA reflection (score baselines from prior runs) ──────────────────

let loraReflection = null
if (resumeMode !== "fresh") {
  // Agent returns the RAW file contents; the SCRIPT parses. Asking haiku to cat+parse a
  // 75-line JSON returned {reflection:null} in wfkn9vjf8, which silently emptied
  // ceiling_prone_loras and disabled the ceiling-escalation fix below.
  const reflectLoad = await agent(
    `Read the LoRA reflection file and return its RAW contents.
Run: Bash("cat '${REFLECTION_FILE}' 2>/dev/null || echo '__NONE__'")
Return { raw: "<the EXACT full output verbatim>" }. Do NOT parse or modify it.
If the output is "__NONE__", return { raw: "__NONE__" }.`,
    { label: "load-lora-reflection", phase: "Resolve", model: "haiku", schema: RAW_STRING_SCHEMA },
  )
  const reflectRaw = reflectLoad?.raw || ""
  if (reflectRaw && reflectRaw !== "__NONE__") {
    try { loraReflection = JSON.parse(reflectRaw) }
    catch { log("Reflection: file present but failed to JSON.parse — treating as none."); loraReflection = null }
  }
  if (loraReflection?.score_baselines) {
    const count = Object.keys(loraReflection.score_baselines).length
    log(`Reflection: loaded baselines for ${count} LoRA(s) from ${loraReflection.runs_analyzed || 0} prior run(s)`)
  } else {
    log("Reflection: no prior LoRA reflection.json — will create after this run")
  }
}

const loraBaselineCtx = loraReflection?.score_baselines
  ? `\n## LORA SCORE BASELINES FROM PRIOR RUNS (flag regression if drop > 0.5):\n` +
    Object.entries(loraReflection.score_baselines)
      .map(([n, b]) => `- ${n}: overall=${b.overall} (${b.runs} run(s))`)
      .join("\n") +
    (loraReflection.regression_alerts?.length
      ? `\n\n## REGRESSION ALERTS — check these LoRAs:\n` +
        loraReflection.regression_alerts.map((a) => `- ⚠️ ${a}`).join("\n")
      : "") +
    (loraReflection.ceiling_prone_loras?.length
      ? `\n\n## CEILING-PRONE LoRAs (always ≥8.5 — scores not meaningful, use challenge prompts):\n` +
        loraReflection.ceiling_prone_loras.map((n) => `- ${n}`).join("\n")
      : "") +
    (loraReflection.worst_prompt_adherence_loras?.length
      ? `\n\n## LOW PROMPT ADHERENCE LoRAs (prompt_adherence < 6.0 — prompts are ignored):\n` +
        loraReflection.worst_prompt_adherence_loras.map((n) => `- ${n}`).join("\n")
      : "") +
    "\n"
  : ""

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
const promptMap = {}          // loraName -> string (single-prompt or first prompt in multi)
const promptMapMulti = {}     // loraName -> [{name, prompt, width, height}] (multi-prompt mode)

if (isMultiPrompt) {
  // Multi-prompt mode: each LoRA gets the full challenge set
  allT2iLoras.forEach((lora) => {
    const prompts = multiPromptSet.map((cp) => {
      let resolvedPrompt = cp.prompt
      if (lora.trigger_words && lora.trigger_words.length > 0) {
        const triggerPrefix = lora.trigger_words.join(", ")
        if (!resolvedPrompt.toLowerCase().includes(triggerPrefix.toLowerCase())) {
          resolvedPrompt = `${triggerPrefix}, ${resolvedPrompt}`
        }
      }
      return { ...cp, prompt: resolvedPrompt }
    })
    promptMapMulti[lora.name] = prompts
    promptMap[lora.name] = prompts[0].prompt  // backward compat
  })
  // anime2real and faceswap lanes use single prompt (unchanged)
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
} else {
  // Original single-prompt logic
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
}

// ── Ceiling-aware prompt escalation ──────────────────────────────────────────
// LoRAs flagged ceiling-prone in prior reflection.json (always scored ≥8.5) ride the
// base model's ceiling and can never show improvement on the easy per-LoRA test_prompt.
// Substitute a harder anatomy challenge prompt for them. Baselines are generated
// per-unique-prompt (below), so the escalated LoRA gets its OWN baseline on the same
// hard prompt — the A/B stays fair (no easy-vs-hard mismatch). Disabled in multi-prompt
// (challenge) mode, where every LoRA already gets all challenge prompts.
const ceilingProneSet = new Set(loraReflection?.ceiling_prone_loras || [])
const ceilingEscalations = [] // [{ loraName, originalPrompt, escalatedPrompt, challengeName }]

if (!noCeilingEscalation && ceilingProneSet.size > 0 && !isMultiPrompt) {
  const escalationCp = ANATOMY_CHALLENGE_PROMPTS[0] // anatomy-hands-complex
  allT2iLoras.forEach((lora) => {
    if (!ceilingProneSet.has(lora.name)) return
    const original = promptMap[lora.name]
    let escalated = escalationCp.prompt
    if (lora.trigger_words && lora.trigger_words.length > 0) {
      const triggerPrefix = lora.trigger_words.join(", ")
      if (!escalated.toLowerCase().includes(triggerPrefix.toLowerCase())) {
        escalated = `${triggerPrefix}, ${escalated}`
      }
    }
    promptMap[lora.name] = escalated
    ceilingEscalations.push({
      loraName: lora.name,
      originalPrompt: original.slice(0, 60),
      escalatedPrompt: escalated.slice(0, 60),
      challengeName: escalationCp.name,
    })
    log(`  CEILING ESCALATION: ${lora.name} prompt overridden to "${escalationCp.name}" challenge`)
  })
}

// Unique T2I prompts for baseline grouping
const uniqueT2iPrompts = isMultiPrompt
  ? [...new Set(allT2iLoras.flatMap((l) => (promptMapMulti[l.name] || []).map((cp) => cp.prompt)))]
  : [...new Set(allT2iLoras.map((l) => promptMap[l.name]))]

log(`\nLane routing:`)
log(`  T2I Lane:       ${allT2iLoras.length} LoRAs (${t2iLoras.length} style/slider + ${fallbackLoras.length} fallback)`)
log(`  Anime2Real Lane: ${hasAnime2real ? `${anime2realLoras.length} LoRAs (${animeImage})` : "inactive"}`)
log(`  Faceswap Lane:   ${hasFaceswap ? `${faceswapLoras.length} LoRAs` : "inactive"}`)
log(`  Unique T2I prompts: ${uniqueT2iPrompts.length}`)
if (isMultiPrompt) {
  log(`  Challenge mode: ${multiPromptSet.length} prompts × ${seeds.length} seeds`)
  multiPromptSet.forEach((cp) => log(`    [${cp.name}] "${cp.prompt.slice(0, 50)}..."`))
} else {
  allT2iLoras.forEach((l) => {
    const p = promptMap[l.name]
    log(`  ${l.name}: "${p.slice(0, 60)}${p.length > 60 ? "..." : ""}"`)
  })
}

// ── Build generation specs ───────────────────────────────────────────────────

// T2I baselines: one per unique prompt × seed (shared across LoRAs)
const t2iBaseSpecs = []
if (isMultiPrompt) {
  // Multi-prompt: one baseline per challenge prompt × seed
  uniqueT2iPrompts.forEach((up) => {
    const cpMatch = allT2iLoras.flatMap((l) => promptMapMulti[l.name] || []).find((cp) => cp.prompt === up)
    const w = cpMatch?.width || width
    const h = cpMatch?.height || height
    seeds.forEach((seed) => {
      t2iBaseSpecs.push({
        type: "baseline",
        lane: "t2i",
        promptUsed: up,
        challengeName: cpMatch?.name || "",
        seed,
        cmd: `${PYTHON} ${RUN_PY} t2i --prompt '${up.replace(/'/g, "'\\''")}' --pipeline ${PIPELINE} --steps ${steps} --seed ${seed} --width ${w} --height ${h} --json-summary`,
      })
    })
  })
} else {
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
}

// T2I LoRA specs (scale TBD after sweep)
const t2iLoraSpecs = []
if (isMultiPrompt) {
  // Multi-prompt: each LoRA × each challenge prompt × each seed
  allT2iLoras.forEach((lora) => {
    (promptMapMulti[lora.name] || []).forEach((cp) => {
      seeds.forEach((seed) => {
        t2iLoraSpecs.push({
          type: "lora",
          lane: "t2i",
          loraName: lora.name,
          loraPath: lora.loraPath,
          promptUsed: cp.prompt,
          challengeName: cp.name,
          seed,
          scale: loraScale,
          cmd: "",
        })
      })
    })
  })
} else {
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
}

// Anime2Real baselines (without LoRA — pure pipeline)
const a2rBaseSpecs = []
if (hasAnime2real) {
  seeds.forEach((seed) => {
    a2rBaseSpecs.push({
      type: "baseline",
      lane: "anime2real",
      promptUsed: promptMap[anime2realLoras[0].name],
      seed,
      cmd: `${PYTHON} ${RUN_PY} image anime2real --input-image '${animeImage}' --realism-style ${realismStyle} --anime2real-lora-scale 0 --seed ${seed} --json-summary`,
      // anime2real has NO --no-lora mode; it always loads _DEFAULT_LORA. Baseline =
      // default LoRA at --anime2real-lora-scale 0 (neutral weight → reference conditioning
      // only). MUST use --anime2real-lora-scale: anime2real ignores the shared --lora-scale.
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

// Usage-limit abort flag — set when a generation agent hits the 5-hour account quota
// (429 code 1308). Checked at phase boundaries to skip downstream agent-spawning phases
// and persist partial results, instead of burning more doomed spawns (wfkn9vjf8 wasted ~15).
let hitUsageLimit = false
let usageLimitReset = ""

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

  // BATCHED: one agent per LoRA runs all its scales sequentially (separate Bash call each),
  // returning a per-command results array. Cuts sweep gen agents 20→5. The 429 usage-limit
  // is incurred per agent SPAWN; generation itself (run.py, local GPU) costs no Claude quota.
  const BATCH_SWEEP_SCHEMA = {
    type: "object",
    properties: { results: { type: "array", items: SWEEP_GEN_SCHEMA } },
    required: ["results"],
  }

  const sweepGenResults = []
  const sweepGenCache = {}

  // In-run dedup first (shared cmds), then group remaining by LoRA.
  const remainingSweep = []
  for (const spec of sweepSpecs) {
    if (sweepGenCache[spec.cmd]) sweepGenResults.push({ ...sweepGenCache[spec.cmd], spec })
    else remainingSweep.push(spec)
  }
  const sweepGroups = {}
  remainingSweep.forEach((spec) => { (sweepGroups[spec.loraName] = sweepGroups[spec.loraName] || []).push(spec) })

  const sweepGroupKeys = Object.keys(sweepGroups)
  for (let gi = 0; gi < sweepGroupKeys.length; gi++) {
    const loraName = sweepGroupKeys[gi]
    const specs = sweepGroups[loraName]
    log(`  Sweep gen [group ${gi + 1}/${sweepGroupKeys.length}] ${loraName}: ${specs.length} scales`)
    const cmdsBlock = specs.map((s, i) => `(${i + 1}/${specs.length}) scale=${s.scale}\n${s.cmd}`).join("\n\n")

    let batchRes = null
    try {
      batchRes = await agent(
        `Execute ${specs.length} T2I generation commands SEQUENTIALLY — one Bash call per command — and return per-command results.

COMMANDS (run each in order, each via its OWN Bash("<cmd> 2>&1", timeout=600000)):
${cmdsBlock}

FOR EACH command:
1. Run it with its own Bash call: Bash("<cmd> 2>&1", timeout=600000).
2. Parse that command's "JSON_SUMMARY:" line: JSON_SUMMARY:{"status":"success","outputs":["/path/img.png"]}
   Extract the JSON after "JSON_SUMMARY:".
3. If no JSON_SUMMARY, fall back to "Saved: " lines → output PNG paths.
4. Non-zero exit or "Error"/"Traceback" → status="error".
Append {status, outputPngs, runJsonPath, error} to results[] IN COMMAND ORDER.

Each command is INDEPENDENT — if one errors, still run and report the rest.

Return JSON: { "results": [ {status, outputPngs, runJsonPath, error}, ... ] } in the same order as the commands above.`,
        { label: `sweep-${gi}-${loraName}`, phase: "Scale Sweep", schema: BATCH_SWEEP_SCHEMA },
      )
    } catch (e) {
      const em = String(e?.message || e)
      log(`  Sweep batch [${loraName}] agent failed: ${em}`)
      if (USAGE_LIMIT_RE.test(em)) { hitUsageLimit = true; usageLimitReset = em }
    }

    const got = Array.isArray(batchRes?.results) ? batchRes.results : null
    specs.forEach((spec, i) => {
      const r = got
        ? (got[i] || { status: "error", outputPngs: [], runJsonPath: "", error: "missing result in batch" })
        : { status: "error", outputPngs: [], runJsonPath: "", error: "batch agent failed" }
      r.spec = spec
      sweepGenResults.push(r)
      if (r.status === "success") {
        sweepGenCache[spec.cmd] = r
        log(`    ${loraName} scale=${spec.scale} → ${r.outputPngs?.[0] || "(no png)"}`)
      } else {
        if (USAGE_LIMIT_RE.test(String(r.error || ""))) { hitUsageLimit = true; usageLimitReset = String(r.error || "") }
        log(`    ${loraName} scale=${spec.scale} → FAILED: ${String(r.error || "").slice(0, 100)}`)
      }
    })

    if (hitUsageLimit) { log(`  USAGE LIMIT HIT during sweep (${usageLimitReset.slice(0, 80)}) — stopping sweep early.`); break }
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

  // BATCHED: one caption agent per LoRA scores all its sweep PNGs sequentially. 20→5 agents.
  // Direct agent() (no withRetry): only ~5 sequential agents (low per-call-429 risk), and a
  // direct catch lets us detect a usage-limit 429 and abort the sweep cleanly.
  const sweepScores = []
  const sweepCapGroups = {}
  sweepCaptionable.forEach((item) => {
    const k = item.spec.loraName
    ;(sweepCapGroups[k] = sweepCapGroups[k] || []).push(item)
  })

  const BATCH_SWEEP_CAP_SCHEMA = {
    type: "object",
    properties: { scores: { type: "array", items: sweepCaptionSchema } },
    required: ["scores"],
  }

  const sweepCapKeys = Object.keys(sweepCapGroups)
  for (let gi = 0; gi < sweepCapKeys.length; gi++) {
    const loraName = sweepCapKeys[gi]
    const items = sweepCapGroups[loraName]
    log(`  Sweep caption [group ${gi + 1}/${sweepCapKeys.length}] ${loraName}: ${items.length} images`)

    const tasks = items.map((item) => {
      const pngPath = item.outputPngs[0]
      const sweepPrompt = item.spec.promptUsed
      return {
        pngPath,
        captionFile: captionPathFor(pngPath),
        scale: item.spec.scale,
        cmd: `${PYTHON} ${RUN_PY} caption '${pngPath}' --style review --prompt '${sweepPrompt.replace(/'/g, "'\\''")}' --lang en`,
      }
    })
    const tasksBlock = tasks.map((t, i) => `(${i + 1}/${tasks.length}) scale=${t.scale} image=${t.pngPath}\ncmd: ${t.cmd}\nthen: cat '${t.captionFile}'`).join("\n\n")

    let capBatch = null
    try {
      capBatch = await agent(
        `Quick quality scores for ${tasks.length} sweep probe images of LoRA "${loraName}". Score them SEQUENTIALLY — one caption command each.

TASKS (for each: run its own Bash("<cmd>"), then Bash("cat '<captionFile>'"); parse the outer JSON then the nested "caption" string — strip markdown fences, extract the first {...}):
${tasksBlock}

For EACH task append a scores object to scores[] IN TASK ORDER:
{ "imagePath": "<pngPath>", "overall": <1-10>, "detail": <1-10>, "sharpness": <1-10>, "composition": <1-10>, "prompt_adherence": <1-10>, "artifacts": <1-10>, "error": "" }

Each task is INDEPENDENT — if one fails, set its error and continue with the rest.
If a caption command's output contains "Failed to load model" or "400 Client Error", the VLM is
under memory pressure: run Bash("sleep 15"), then re-run that SAME caption command ONCE. If it
still fails, set that task's error="VLM load failed" and continue to the next task.

Return JSON: { "scores": [ {...}, ... ] } in task order.`,
        { label: `sweep-cap-${loraName}`, phase: "Scale Sweep", schema: BATCH_SWEEP_CAP_SCHEMA },
      )
    } catch (e) {
      const em = String(e?.message || e)
      log(`  Sweep caption batch [${loraName}] failed: ${em}`)
      if (USAGE_LIMIT_RE.test(em)) { hitUsageLimit = true; usageLimitReset = em }
    }

    const caps = Array.isArray(capBatch?.scores) ? capBatch.scores : []
    items.forEach((item, i) => {
      const c = caps[i] || {}
      sweepScores.push({
        loraName,
        scale: item.spec.scale,
        overall: c.overall || 0,
        detail: c.detail || 0,
        sharpness: c.sharpness || 0,
        composition: c.composition || 0,
        prompt_adherence: c.prompt_adherence || 0,
        artifacts: c.artifacts || 0,
      })
    })

    if (hitUsageLimit) { log(`  USAGE LIMIT HIT during sweep caption — stopping.`); break }
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
  // In multi-prompt mode, use per-challenge width/height
  const cpMatch = isMultiPrompt ? multiPromptSet.find((cp) => cp.prompt === loraPrompt) : null
  const w = cpMatch?.width || width
  const h = cpMatch?.height || height
  spec.cmd = `${PYTHON} ${RUN_PY} t2i --prompt '${loraPrompt.replace(/'/g, "'\\''")}' --pipeline ${PIPELINE} --steps ${steps} --seed ${spec.seed} --width ${w} --height ${h} --lora-path '${spec.loraPath}' --lora-scale ${scale} --json-summary`
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

// BATCHED: one agent per group (baseline-prompt group OR LoRA group) runs all its seeds
// sequentially. Cuts final-gen agents 30→~10. Direct agent() with catch so a usage-limit
// 429 aborts generation and we persist partial results instead of spawning doomed agents.
const BATCH_GEN_SCHEMA = {
  type: "object",
  properties: { results: { type: "array", items: GEN_SCHEMA } },
  required: ["results"],
}

const genResults = []
const genCache = {}

if (hitUsageLimit) {
  log("Generate: SKIPPED — usage limit hit during sweep; proceeding to persist partial results.")
} else {
  // In-run dedup first (shared cmds), then group remaining by baseline-prompt or LoRA.
  const remainingGen = []
  for (const spec of allSpecs) {
    if (genCache[spec.cmd]) {
      log(`Dedup — reusing cached result (${spec.lane}/${spec.type}${spec.type === "lora" ? ` ${spec.loraName}` : ""}, seed=${spec.seed})`)
      genResults.push({ ...genCache[spec.cmd], spec })
    } else {
      remainingGen.push(spec)
    }
  }
  const genGroups = {}
  remainingGen.forEach((spec) => {
    const key = spec.type === "baseline" ? `baseline|${spec.promptUsed}` : `lora|${spec.loraName}`
    ;(genGroups[key] = genGroups[key] || []).push(spec)
  })

  const genGroupKeys = Object.keys(genGroups)
  for (let gi = 0; gi < genGroupKeys.length; gi++) {
    const key = genGroupKeys[gi]
    const specs = genGroups[key]
    const gLabel = specs[0].type === "baseline" ? `baseline "${(specs[0].promptUsed || "").slice(0, 30)}"` : `lora ${specs[0].loraName}`
    const laneTag = specs[0].lane !== "t2i" ? `[${specs[0].lane}] ` : ""
    log(`Generate [group ${gi + 1}/${genGroupKeys.length}] ${laneTag}${gLabel}: ${specs.length} seed(s)`)
    const cmdsBlock = specs.map((s, i) => `(${i + 1}/${specs.length}) seed=${s.seed}${s.type === "lora" ? ` scale=${s.scale}` : ""}\n${s.cmd}`).join("\n\n")

    let batchRes = null
    try {
      batchRes = await agent(
        `Execute ${specs.length} generation commands SEQUENTIALLY — one Bash call per command — and return per-command results.

COMMANDS (run each in order, each via its OWN Bash("<cmd> 2>&1", timeout=600000)):
${cmdsBlock}

FOR EACH command:
1. Run it with its own Bash call: Bash("<cmd> 2>&1", timeout=600000).
2. Parse that command's "JSON_SUMMARY:" line: JSON_SUMMARY:{"status":"success","outputs":["/path/img.png"]}
   Extract the JSON after "JSON_SUMMARY:".
3. If no JSON_SUMMARY, fall back to "Saved: " lines → output PNG paths.
4. Non-zero exit or "Error"/"Traceback" → status="error".
Append {status, outputPngs, runJsonPath, error} to results[] IN COMMAND ORDER.

Each command is INDEPENDENT — if one errors, still run and report the rest.

Return JSON: { "results": [ {status, outputPngs, runJsonPath, error}, ... ] } in the same order as the commands above.`,
        { label: `gen-${gi}-${specs[0].lane}-${specs[0].type}`, phase: "Generate", schema: BATCH_GEN_SCHEMA },
      )
    } catch (e) {
      const em = String(e?.message || e)
      log(`  Generate batch [${gLabel}] agent failed: ${em}`)
      if (USAGE_LIMIT_RE.test(em)) { hitUsageLimit = true; usageLimitReset = em }
    }

    const got = Array.isArray(batchRes?.results) ? batchRes.results : null
    specs.forEach((spec, i) => {
      const r = got
        ? (got[i] || { status: "error", outputPngs: [], runJsonPath: "", error: "missing result in batch" })
        : { status: "error", outputPngs: [], runJsonPath: "", error: "batch agent failed" }
      r.spec = spec
      genResults.push(r)
      if (r.status === "success") {
        genCache[spec.cmd] = r
        log(`    ${gLabel} seed=${spec.seed} → ${r.outputPngs?.[0] || "(no png)"}`)
      } else {
        if (USAGE_LIMIT_RE.test(String(r.error || ""))) { hitUsageLimit = true; usageLimitReset = String(r.error || "") }
        log(`    ${gLabel} seed=${spec.seed} → FAILED: ${String(r.error || "").slice(0, 100)}`)
      }
    })

    if (hitUsageLimit) { log(`  USAGE LIMIT HIT during generate (${usageLimitReset.slice(0, 80)}) — stopping generation.`); break }
  }
}

const successCount = genResults.filter((r) => r.status === "success").length
const failCount = genResults.filter((r) => r.status !== "success").length
log(`Generation complete: ${successCount} success, ${failCount} failed`)

markPhase("generate", hitUsageLimit ? "skipped" : "completed")

// ── Phase 5: VLM pre-flight check ────────────────────────────────────────────

phase("VLM Check")

const VLM_CHECK_SCHEMA = {
  type: "object",
  properties: { available: { type: "boolean" } },
  required: ["available"],
}

let vlmAvailable = false
if (hitUsageLimit) {
  log("VLM check: SKIPPED — usage limit hit earlier; skipping Review/report/HTML.")
  markPhase("vlmCheck", "skipped")
} else {
  const vlmCheck = await agent(
    `Verify the VLM can actually LOAD and serve inference — NOT just that it's listed. (LM Studio
lists models in /v1/models even when they fail to load under GPU memory pressure.)

1. Server up? Bash("curl -sf http://localhost:1234/v1/models -o /dev/null -w '%{http_code}'")
2. Probe LOADABILITY with a tiny inference (the first request may take 10-90s while the model
   loads into GPU memory — that is normal, use timeout=120000):
   Bash("curl -s http://localhost:1234/v1/chat/completions -H 'Content-Type: application/json' -d '{\\"model\\":\\"qwen/qwen3-vl-4b\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"reply OK\\"}],\\"max_tokens\\":5}'", timeout=120000)
3. If the response body contains "error" or "Failed to load model", the VLM is NOT usable yet:
   wait 20s — Bash("sleep 20") — and retry step 2 ONCE.
Return { "available": true } ONLY if step 2 returned a real chat completion (no "error"/"Failed
to load model" in the body). Otherwise { "available": false }.
IMPORTANT: Return ONLY the JSON object.`,
    { label: "vlm-check", phase: "VLM Check", model: "haiku", schema: VLM_CHECK_SCHEMA },
  )
  vlmAvailable = vlmCheck?.available === true
  log(vlmAvailable ? "VLM available — proceeding with Review." : "VLM UNAVAILABLE — skipping Review. Start LM Studio with a VLM model.")
  markPhase("vlmCheck", "completed")
}

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
  // BATCHED: one caption agent per group (baseline-prompt or LoRA) captions all its images
  // sequentially. ~19→~10 agents. captionable items are references into genResults, so we
  // mutate item.captions in place (no merge-back needed). Direct agent() with catch for
  // usage-limit detection.
  const BATCH_CAP_SCHEMA = {
    type: "object",
    properties: { captions: { type: "array", items: CAPTION_SCHEMA } },
    required: ["captions"],
  }

  const captionGroups = {}
  captionable.forEach((item) => {
    const key = item.spec.type === "baseline" ? `baseline|${item.spec.promptUsed}` : `lora|${item.spec.loraName}`
    ;(captionGroups[key] = captionGroups[key] || []).push(item)
  })

  const capGroupKeys = Object.keys(captionGroups)
  for (let gi = 0; gi < capGroupKeys.length; gi++) {
    const key = capGroupKeys[gi]
    const items = captionGroups[key]
    const gLabel = items[0].spec.type === "lora" ? items[0].spec.loraName : "baseline"
    log(`Review caption [group ${gi + 1}/${capGroupKeys.length}] ${gLabel}: ${items.reduce((n, it) => n + it.outputPngs.length, 0)} image(s)`)

    // Flatten one task per PNG across the group.
    const tasks = []
    items.forEach((item) => {
      item.outputPngs.forEach((pngPath) => {
        const imagePrompt = item.spec.promptUsed || prompt
        tasks.push({
          pngPath,
          captionFile: captionPathFor(pngPath),
          cmd: `${PYTHON} ${RUN_PY} caption '${pngPath}' --style review --prompt '${imagePrompt.replace(/'/g, "'\\''")}' --lang en`,
        })
      })
    })
    const tasksBlock = tasks.map((t, i) => `(${i + 1}/${tasks.length}) image=${t.pngPath}\ncmd: ${t.cmd}\nthen: cat '${t.captionFile}'`).join("\n\n")

    let capBatch = null
    try {
      capBatch = await agent(
        `Score ${tasks.length} images for quality using the VLM caption tool. Score them SEQUENTIALLY — one caption command each.

TASKS (for each: run its own Bash("<cmd>"), then Bash("cat '<captionFile>'"); parse the outer JSON, then the nested "caption" string — strip markdown fences, extract the first {...}):
${tasksBlock}

For EACH task append a caption object to captions[] IN TASK ORDER:
{ "imagePath": "<pngPath>", "overall": <1-10>, "detail": <1-10>, "sharpness": <1-10>, "composition": <1-10>, "prompt_adherence": <1-10>, "artifacts": <1-10>, "captured": [...], "missed": [...], "issues": [...], "strengths": [...], "summary": "...", "style": "review", "model": "...", "error": "" }

If a connection error occurs for a task, set its error = "VLM unavailable" and continue with the rest. Each task is INDEPENDENT.
If a caption command's output contains "Failed to load model" or "400 Client Error", the VLM is
under memory pressure: run Bash("sleep 15"), then re-run that SAME caption command ONCE. If it
still fails, set that task's error="VLM load failed" and continue to the next task.

Return JSON: { "captions": [ {...}, ... ] } in task order.`,
        { label: `caption-${gLabel}`, phase: "Review", schema: BATCH_CAP_SCHEMA },
      )
    } catch (e) {
      const em = String(e?.message || e)
      log(`  Review caption batch [${gLabel}] failed: ${em}`)
      if (USAGE_LIMIT_RE.test(em)) { hitUsageLimit = true; usageLimitReset = em }
    }

    const caps = Array.isArray(capBatch?.captions) ? capBatch.captions : []
    let capIdx = 0
    items.forEach((item) => {
      item.captions = []
      item.outputPngs.forEach(() => {
        const c = caps[capIdx]
        if (c) item.captions.push(c)
        capIdx++
      })
    })

    if (hitUsageLimit) { log(`  USAGE LIMIT HIT during review caption — stopping.`); break }
  }
}

// ── Build caption sets for manifest (multi-lane aware) ───────────────────────

const captionSets = []

// T2I lane sets: one per T2I LoRA (single-prompt) or per challenge×LoRA (multi-prompt)
if (isMultiPrompt) {
  // Multi-prompt: one caption set per (challenge prompt × LoRA)
  allT2iLoras.forEach((lora) => {
    const scale = bestScales[lora.name] || loraScale
    ;(promptMapMulti[lora.name] || []).forEach((cp) => {
      const setName = `Challenge "${cp.name}": Baseline vs ${lora.name} (s=${scale})`
      const guide = `Compare baseline vs ${lora.name} on anatomy challenge "${cp.name}". Does the LoRA fix the anatomy issues?`

      const files = []
      seeds.forEach((seed) => {
        const baseResult = genResults.find(
          (r) => r.spec?.type === "baseline" && r.spec?.lane === "t2i" && r.spec?.promptUsed === cp.prompt && r.spec?.seed === seed && r.outputPngs?.[0],
        )
        if (baseResult) files.push(captionPathFor(baseResult.outputPngs[0]))
      })
      seeds.forEach((seed) => {
        const loraResult = genResults.find(
          (r) => r.spec?.type === "lora" && r.spec?.lane === "t2i" && r.spec?.loraName === lora.name && r.spec?.promptUsed === cp.prompt && r.spec?.seed === seed && r.outputPngs?.[0],
        )
        if (loraResult) files.push(captionPathFor(loraResult.outputPngs[0]))
      })

      captionSets.push({
        name: setName,
        prompt: cp.prompt,
        challengeName: cp.name,
        guide,
        variants: ["Baseline", `${lora.name} (s=${scale})`].map((l) => ({ label: l })),
        files,
      })
    })
  })
} else {
  // Original single-prompt caption sets
  allT2iLoras.forEach((lora) => {
    const scale = bestScales[lora.name] || loraScale
    const loraPrompt = promptMap[lora.name]
    const setName = `T2I: Baseline vs ${lora.name} (${lora.category}, s=${scale})`
    const zh = wfLang === "zh_TW"
    const guide = zh
      ? `比較 T2I Baseline 與 ${lora.name} (${lora.category}, scale=${scale}) 的畫質。LoRA 是否改善了圖像？`
      : `Compare T2I Baseline vs ${lora.name} (${lora.category}, scale=${scale}). Does the LoRA improve quality?`

    const files = []
    seeds.forEach((seed) => {
      const baseResult = genResults.find(
        (r) => r.spec?.type === "baseline" && r.spec?.lane === "t2i" && r.spec?.promptUsed === loraPrompt && r.spec?.seed === seed && r.outputPngs?.[0],
      )
      if (baseResult) files.push(captionPathFor(baseResult.outputPngs[0]))
    })
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
}

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

// ── Ceiling analysis ─────────────────────────────────────────────────────────
// ceilingBound = baseline already ≥8.5 AND |LoRA−baseline| < 0.5 → the LoRA adds no
// measurable improvement over the base model's ceiling. NOTE: baseScoreSummary.overall
// is the GLOBAL T2I average across all unique prompts; for LoRAs that were ceiling-
// escalated onto a hard prompt, the precise per-prompt delta comes from the caption-set
// comparisons surfaced to the report agent (threshold 8.5 matches reflection.json).
const ceilingAnalysis = loraScoreSummary.map((l) => {
  const base = baseScoreSummary.overall || 0
  const overall = l.overall || 0
  const delta = +(overall - base).toFixed(2)
  return {
    loraName: l.name,
    baselineOverall: +base.toFixed(2),
    loraOverall: overall,
    bestScale: bestScales[l.name],
    delta,
    ceilingBound: base >= 8.5 && Math.abs(delta) < 0.5,
    escalated: ceilingEscalations.some((c) => c.loraName === l.name),
  }
})

let reportResult = null
if (hitUsageLimit) {
  log("Report: SKIPPED — usage limit hit; persisting partial results without a narrative report.")
  markPhase("report", "skipped")
} else {
  reportResult = await agent(
  `Generate a concise LoRA comparison report for this flux2-klein dynamic A/B test.
${loraBaselineCtx}
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
- Challenge mode: ${isMultiPrompt ? `YES — ${multiPromptSet.length} anatomy challenge prompts` : "NO"}

${ceilingEscalations.length > 0 ? `## Ceiling-Prompt Escalations (auto-applied)
These LoRAs were flagged ceiling-prone in prior reflection.json (always scored ≥8.5), so they
were retested on a harder anatomy challenge prompt instead of their easy test_prompt:
${JSON.stringify(ceilingEscalations, null, 2)}` : "## Ceiling-Prompt Escalations: none (no ceiling-prone LoRAs, or escalation disabled)."}

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

## Ceiling Analysis
${JSON.stringify(ceilingAnalysis, null, 2)}
- ceilingBound=true ⇒ baseline ≥8.5 AND |Δ overall| < 0.5: the LoRA adds no measurable improvement over the ceiling.
- escalated=true ⇒ tested on a harder challenge prompt; the per-prompt caption-set delta is the precise signal.

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

${isMultiPrompt ? `**10. Per-Challenge Anatomy Breakdown** — for each challenge prompt, show:
- Baseline vs LoRA scores (overall, detail, prompt_adherence)
- Which anatomy features were captured vs missed (from captions captured[]/missed[])
- Whether the LoRA specifically improved the targeted weakness (hands, pose, foreshortening, etc.)

**11. Anatomy Challenge Summary** — rank challenges by LoRA improvement delta. Which anatomy weaknesses does this LoRA actually fix?

Use a lower ceiling threshold for challenge prompts (7.0 instead of 8.5) since they are designed to be harder.` : ""}
Keep the report concise. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)
  markPhase("report", "completed")
}

// ── Phase 8: Review HTML ─────────────────────────────────────────────────────

let reviewHtml = ""
if (captionFiles.length > 0 && !noHtml && !hitUsageLimit) {
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

const topLora = loraScoreSummary.length > 0
  ? loraScoreSummary.reduce((best, l) => ((l.overall || 0) > (best.overall || 0) ? l : best), loraScoreSummary[0])
  : null

const scoreDeltaFromLast = loraReflection?.score_baselines
  ? loraScoreSummary.reduce((acc, l) => {
      const base = loraReflection.score_baselines[l.name]
      if (base) acc[l.name] = { delta: +(l.overall - base.overall).toFixed(2), regression: l.overall < base.overall - 0.5 }
      return acc
    }, {})
  : null

const signals = {
  run_quality: hitUsageLimit ? "usage-limited" : (phasesFailed.length === 0 ? "good" : "degraded"),
  key_metric: topLora?.overall ?? null,
  delta_from_last: null,
  highlights: [
    `${loras.length} LoRA(s) tested, ${genResults.filter((r) => r.status === "success").length} images generated`,
    topLora ? `Best: ${topLora.name} overall=${topLora.overall}` : "no LoRA scores",
    `Baseline: overall=${baseScoreSummary.overall ?? "?"}`,
  ],
  warnings: loraScoreSummary
    .filter((l) => (l.overall || 0) < (baseScoreSummary.overall || 0))
    .map((l) => `${l.name} below baseline (${l.overall} < ${baseScoreSummary.overall})`),
}

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
    challengePrompts,
    customPromptCount: customPrompts ? customPrompts.length : null,
  },
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: hitUsageLimit ? "partial" : (phasesFailed.length === 0 ? "complete" : "partial"),
  reason: hitUsageLimit ? "usage-limit" : null,
  usage_limit_reset: hitUsageLimit ? usageLimitReset.slice(0, 200) : null,
  signals,
  tags: ["lora-review", "flux2-klein-9b", ...(doSweep ? ["scale-sweep"] : []), ...(hasAnime2real ? ["anime2real"] : []), ...(hasFaceswap ? ["faceswap"] : []), ...(isMultiPrompt ? ["anatomy-challenge"] : [])],
  result: {
    loras: loras.map((l) => ({ name: l.name, dirName: l.dirName, description: l.description, category: l.category })),
    seeds,
    bestScales,
    sweepResults,
    promptMap,
    loraScoreSummary,
    baseScoreSummary,
    ceilingAnalysis,
    ceilingEscalations,
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
    score_delta_from_last: scoreDeltaFromLast,
  },
}

await saveHistory(HISTORY_DIR, INDEX_FILE, historyEntry, signals)

// ── Synthesize LoRA reflection ───────────────────────────────────────────────

const LORA_REFLECT_SCHEMA = {
  type: "object",
  properties: {
    score_baselines: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          overall: { type: "number" },
          detail: { type: "number" },
          sharpness: { type: "number" },
          prompt_adherence: { type: "number" },
          runs: { type: "number" },
        },
        required: ["overall", "runs"],
      },
    },
    regression_alerts: { type: "array", items: { type: "string" } },
    confirmed_best_settings: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { scale: { type: "number" }, runs_stable: { type: "number" } },
        required: ["scale", "runs_stable"],
      },
    },
    prompt_patterns: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
    ceiling_prone_loras: {
      type: "array",
      items: { type: "string" },
      description: "LoRA names that scored >= 8.5 in every run — scores not meaningful, use harder prompts",
    },
    worst_prompt_adherence_loras: {
      type: "array",
      items: { type: "string" },
      description: "LoRA names with prompt_adherence < 6.0 in majority of runs",
    },
    best_prompt_strategy: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Per LoRA category: which prompt strategy produced best score differentiation (test_prompt|challenge|default)",
    },
    runs_analyzed: { type: "number" },
    updated_at: { type: "string" },
  },
  required: ["score_baselines", "regression_alerts", "runs_analyzed", "updated_at"],
}

const reflectResult = await agent(
  `Synthesize a LoRA score reflection from the run history.
1. List history files: Bash("ls -t '${HISTORY_DIR}'/*.json 2>/dev/null | head -10")
2. Read up to 5 most recent: for each path, Bash("cat '<path>'")
3. For each LoRA that appears across runs, compute rolling average of: overall, detail, sharpness, prompt_adherence. Count how many runs it appeared in.
4. Flag regression_alerts: any LoRA where current run overall dropped > 0.5 vs its prior average.
5. Identify confirmed_best_settings: LoRAs whose optimal scale was consistent across ≥2 runs.
6. Extract prompt_patterns: group effective prompts by category (style, slider, anime2real).
7. ceiling_prone_loras: any LoRA with overall >= 8.5 in ALL runs it appeared in (ceiling effect).
8. worst_prompt_adherence_loras: any LoRA with prompt_adherence < 6.0 in ≥ 2 runs.
9. best_prompt_strategy: per category (style/slider/anime2real), which prompt type (test_prompt/challenge/default) produced the highest score spread or differentiation across runs?
10. Return the synthesized reflection object with updated_at = "${RUN_TIMESTAMP}".`,
  { label: "synthesize-lora-reflection", phase: "Persist", model: "haiku", schema: LORA_REFLECT_SCHEMA },
)

if (reflectResult) {
  const reflectJson = JSON.stringify(reflectResult, null, 2)
  const reflectWrite = await agent(
    `Write the LoRA reflection JSON file RELIABLY.
1. Write with the Write tool: file_path='${REFLECTION_FILE}', content is the JSON below VERBATIM:
${reflectJson}
2. Verify: Bash("test -s '${REFLECTION_FILE}' && echo OK || echo MISSING")
3. If MISSING, rewrite via a quoted heredoc:
   Bash("cat > '${REFLECTION_FILE}' <<'REFLECT_EOF'
${reflectJson}
REFLECT_EOF")
4. Bash("wc -c < '${REFLECTION_FILE}'")
Return { written: true, bytes: <number> }.`,
    { label: "write-lora-reflection", phase: "Persist", model: "haiku" },
  )
  const reflectBytes = Number(reflectWrite?.bytes) || 0
  if (reflectBytes > 0) {
    log(`Reflection: updated ${REFLECTION_FILE} (${reflectResult.runs_analyzed} run(s) analyzed, ${reflectBytes} bytes)`)
  } else {
    log(`WARNING: reflection write verification FAILED (0 bytes) — reflection.json may be stale.`)
  }
}

log(`History: ${HISTORY_DIR}/${RUN_ID}.json`)
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
  ceilingAnalysis,
  ceilingEscalations,
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
