// mlx-movie-director-run-and-review-image-i2i — I2I self-test + VLM review + self-fix
//
// Mirrors the T2I workflow structure but targets `run.py image i2i --self-test <mode>`.
// Adds a self-fix phase absent from T2I: after scoring, if results are poor it auto-proposes
// parameter changes and re-runs them.
//
// ── MODES ────────────────────────────────────────────────────────────────────
//
//   GENERATION (default) — run self-test or explicit i2i configs, score, (auto-fix), report.
//
//     Workflow({ name: "mlx-movie-director-run-and-review-image-i2i" })
//       → default self-test (_I2I_SELF_TEST_VARIATIONS, 13 variants)
//     Workflow({ name: "...", args: "debug" })
//       → i2i --self-test debug  (1 variant, fast)
//     Workflow({ name: "...", args: "seed-sweep" })
//       → i2i --self-test seed-sweep
//     Workflow({ name: "...", args: { mode: "cnet-pose" } })
//       → i2i --self-test cnet-pose
//     Workflow({ name: "...", args: [{ input_image:"src.png", prompt:"...", denoise_strength:0.9, seed:200 }] })
//       → explicit i2i config(s), no self-test
//     Workflow({ name: "...", args: { mode: "debug", feedback: "i2i_review_20260613.json" } })
//       → ingest prior human-review JSON for guidance
//     Workflow({ name: "...", args: { mode: "debug", autoFix: true, autoFixThreshold: 6.0 } })
//       → after scoring, if any overall < 6.0, auto-propose fixes and re-run them
//
//   FINALIZE — skip generation; build review HTML from explicit caption JSONs.
//     Workflow({ name: "...", args: { finalize: ["a.caption.json", "b.caption.json"] } })
//       → flat single-set HTML
//     Workflow({ name: "...", args: { finalize: [{ name:"set1", files:["a.json","b.json"] }] } })
//       → multi-set grouped HTML
//
// ── SELF-FIX LOGIC ───────────────────────────────────────────────────────────
// When autoFix:true and best overall score < autoFixThreshold (default 6.0):
//   - An agent analyzes score weaknesses and maps them to parameter changes:
//       detail < 5   → +5 steps
//       sharpness < 5 → denoise_strength − 0.1
//       artifacts < 5 → ctrl_strength − 0.2 OR add cnet_active_steps:8
//       composition < 5 → try a different seed
//   - Up to 2 fix specs are generated and run sequentially (GPU-safe)
//   - Fix results are scored and included in the final report
//
// ── COMMAND NOTE ─────────────────────────────────────────────────────────────
// `run.py image i2i` does NOT implement --json-summary. PNG paths are parsed from
// stdout lines matching /^Saved: (.+\.png)$/.

export const meta = {
  name: "mlx-movie-director-run-and-review-image-i2i",
  description: "I2I self-test + VLM review + self-fix: run named modes or explicit configs, score each output, auto-propose and re-run fixes when quality is poor, build interactive review HTML",
  whenToUse: "Test I2I quality iteratively under GPU limits. Self-fix mode auto-proposes parameter improvements when VLM scores fall below a threshold.",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root via git rev-parse" },
    { title: "Feedback", detail: "Optional — ingest prior human-review JSON from the self-test HTML export" },
    { title: "GPU Wait", detail: "Wait if another run.py generation is already using the GPU" },
    { title: "Generate", detail: "Execute i2i --self-test <mode> or explicit configs sequentially (GPU-safe)" },
    { title: "VLM Check", detail: "Verify LM Studio is running before caption phase" },
    { title: "Review", detail: "Score each output PNG via run.py caption --style score" },
    { title: "Self-Fix", detail: "Analyze score weaknesses, propose 1–2 fix specs, re-run and re-score (autoFix:true only)" },
    { title: "Report", detail: "Summarize quality scores, self-fix outcome, and improvement recommendations" },
    { title: "Review HTML", detail: "Build multi-set A/B review HTML via caption --ab-manifest" },
    { title: "Persist", detail: "Write run history JSON to .claude/workflows/history/ for trend analysis" },
  ],
}

// ── Phase 0: Resolve absolute paths ──────────────────────────────────────────

phase("Resolve")

const PATH_SCHEMA = {
  type: "object",
  properties: {
    projectRoot: { type: "string", description: "Absolute path to the git project root" },
  },
  required: ["projectRoot"],
}

const pathResolution = await agent(
  `Detect the absolute path of the git project root for the video_generation project.

  Run: Bash("git rev-parse --show-toplevel")

  Return it as { projectRoot: "<the-path>" }.
  IMPORTANT: Return ONLY the JSON object. Normalize backslashes to forward slashes.`,
  { label: "resolve-paths", phase: "Resolve", model: "haiku", schema: PATH_SCHEMA },
)

const PROJECT_ROOT = (pathResolution?.projectRoot || "").replace(/\\/g, "/")
if (!PROJECT_ROOT) {
  log("ERROR: Could not resolve project root. Absolute paths unavailable — CWD drift may cause failures.")
}

const PYTHON  = `${PROJECT_ROOT}/python/venv/bin/python`
const RUN_PY  = `${PROJECT_ROOT}/python/mlx-movie-director/run.py`
const OUT_DIR = `${PROJECT_ROOT}/python/mlx-movie-director/output`

log(`Resolved: PROJECT_ROOT=${PROJECT_ROOT}`)
log(`  PYTHON:  ${PYTHON}`)
log(`  RUN_PY:  ${RUN_PY}`)
log(`  OUT_DIR: ${OUT_DIR}`)

// ── Phase tracking ──────────────────────────────────────────────────────────
const phaseStatus = {
  resolve: "pending", feedback: "pending", gpuWait: "pending",
  generate: "pending", vlmCheck: "pending", review: "pending",
  selfFix: "pending", report: "pending", reviewHtml: "pending", persist: "pending",
}
const phasesCompleted = []
const phasesFailed = []
const filesTouched = new Set()
function markPhase(name, status) {
  phaseStatus[name] = status
  if (status === "completed") phasesCompleted.push(name)
  if (status === "failed") phasesFailed.push(name)
}
markPhase("resolve", "completed")

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveJsonPath(p) {
  return p.startsWith("/") ? p : `${OUT_DIR}/${p}`
}

// caption.py strips the image extension (os.path.splitext) → img.png writes img.caption.json
function captionPathFor(pngPath) {
  return pngPath.replace(/\.[^.\/]+$/, "") + ".caption.json"
}

function baseName(p) {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

// ── Args normalization ────────────────────────────────────────────────────────

let resolvedArgs = args
if (typeof resolvedArgs === "string") {
  try {
    const parsed = JSON.parse(resolvedArgs)
    if (Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null)) {
      resolvedArgs = parsed
      log(`Parsed string args as ${Array.isArray(parsed) ? `array[${parsed.length}]` : "object"}`)
    }
  } catch {
    // Not JSON — treat as mode name string
  }
}

const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x)

// Mode detection
let mode = "gen"            // "gen" | "finalize"
let selfTestMode = null     // null = default test, string = named mode
let explicitSpecs = []      // custom i2i configs (non-self-test)
let feedbackPath = ""
let autoFix = false
let autoFixThreshold = 6.0
let finalizeFiles = []
let htmlOutput = ""

if (isObj(resolvedArgs) && resolvedArgs.finalize != null) {
  mode = "finalize"
  const f = resolvedArgs.finalize
  finalizeFiles = Array.isArray(f) ? f : [f]
  htmlOutput = typeof resolvedArgs.htmlOutput === "string" ? resolvedArgs.htmlOutput : ""
} else {
  // Generation mode
  if (typeof resolvedArgs === "string") {
    // Plain string → mode name
    selfTestMode = resolvedArgs || null
  } else if (Array.isArray(resolvedArgs)) {
    // Array of explicit i2i configs
    explicitSpecs = resolvedArgs.filter(Boolean)
  } else if (isObj(resolvedArgs)) {
    if (typeof resolvedArgs.mode === "string") selfTestMode = resolvedArgs.mode || null
    if (typeof resolvedArgs.feedback === "string") feedbackPath = resolvedArgs.feedback
    if (resolvedArgs.autoFix === true) autoFix = true
    if (typeof resolvedArgs.autoFixThreshold === "number") autoFixThreshold = resolvedArgs.autoFixThreshold
    if (Array.isArray(resolvedArgs.specs)) explicitSpecs = resolvedArgs.specs.filter(Boolean)
  } else if (!resolvedArgs) {
    // No args → default self-test
    selfTestMode = null
  }
}

// Determine whether this is a self-test run or explicit configs
const isSelfTest = explicitSpecs.length === 0

if (mode === "finalize") {
  const grouped = finalizeFiles.length > 0 && typeof finalizeFiles[0] === "object"
  log(`MODE: finalize — ${grouped ? `${finalizeFiles.length} set(s)` : `${finalizeFiles.length} caption JSON(s)`}`)
} else if (isSelfTest) {
  log(`MODE: generation (self-test) — mode="${selfTestMode || "default"}"${feedbackPath ? ` | feedback: ${feedbackPath}` : ""}${autoFix ? ` | autoFix:true threshold=${autoFixThreshold}` : ""}`)
} else {
  log(`MODE: generation (explicit) — ${explicitSpecs.length} spec(s)${feedbackPath ? ` | feedback: ${feedbackPath}` : ""}${autoFix ? ` | autoFix:true threshold=${autoFixThreshold}` : ""}`)
}

const wfLang = (isObj(resolvedArgs) && typeof resolvedArgs.lang === "string") ? resolvedArgs.lang : "zh_TW"

// GPU-gate config
const gpuWaitOn = !(isObj(resolvedArgs) && resolvedArgs.gpuWait === false)
const maxGpuWait = (isObj(resolvedArgs) && typeof resolvedArgs.maxGpuWait === "number")
  ? resolvedArgs.maxGpuWait : 1800

// ── Command builder ──────────────────────────────────────────────────────────

function buildSelfTestCommand(modeId) {
  const modeFlag = modeId ? ` ${modeId}` : ""
  return `${PYTHON} ${RUN_PY} image i2i --self-test${modeFlag}`
}

function buildExplicitCommand(spec) {
  if (!spec.input_image) return null
  const safeInput = spec.input_image.replace(/'/g, "'\\''")
  const safePrompt = (spec.prompt || "").replace(/'/g, "'\\''")
  let cmd = `${PYTHON} ${RUN_PY} image i2i --input-image '${safeInput}'`
  if (safePrompt) cmd += ` --prompt '${safePrompt}'`
  if (spec.denoise_strength != null) cmd += ` --denoise-strength ${spec.denoise_strength}`
  if (spec.reference_image) cmd += ` --reference-image '${spec.reference_image.replace(/'/g, "'\\''")}'`
  if (spec.controlnet_strength != null) cmd += ` --controlnet-strength ${spec.controlnet_strength}`
  // openpose requires --skip-preprocess (preprocess_mode is handled by the Python layer when flag set)
  if (spec.preprocess_mode === "openpose") cmd += ` --skip-preprocess`
  if (spec.seed != null) cmd += ` --seed ${spec.seed}`
  if (spec.steps != null) cmd += ` --steps ${spec.steps}`
  if (spec.cnet_active_steps != null) cmd += ` --cnet-active-steps ${spec.cnet_active_steps}`
  return cmd
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const GEN_SCHEMA = {
  type: "object",
  properties: {
    status:     { type: "string", enum: ["success", "error"] },
    outputPngs: { type: "array", items: { type: "string" }, description: "Absolute paths to generated PNG files parsed from 'Saved: ' lines in stdout" },
    error:      { type: "string" },
  },
  required: ["status", "outputPngs"],
}

const VLM_CHECK_SCHEMA = {
  type: "object",
  properties: { available: { type: "boolean" } },
  required: ["available"],
}

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

const FEEDBACK_SCHEMA = {
  type: "object",
  properties: {
    winners:  { type: "array", items: { type: "string" }, description: "IDs of images marked as winners by the human" },
    guidance: { type: "string", description: "Concise keep/change guidance derived from the human ratings and comments" },
    perImage: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:      { type: "string" },
          ratings: {
            type: "object",
            properties: {
              source_identity: { type: "number" },
              style_change:    { type: "number" },
              pose_match:      { type: "number" },
              artifact_level:  { type: "number" },
            },
          },
          comment:   { type: "string" },
          is_winner: { type: "boolean" },
        },
      },
    },
    error: { type: "string" },
  },
  required: ["guidance"],
}

const FIX_SCHEMA = {
  type: "object",
  properties: {
    fixSpecs: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          label:               { type: "string", description: "Short identifier for this fix (e.g. 'fix-fewer-steps-s42')" },
          rationale:           { type: "string", description: "What weakness this fix targets" },
          input_image:         { type: "string" },
          reference_image:     { type: "string" },
          prompt:              { type: "string" },
          denoise_strength:    { type: "number" },
          controlnet_strength: { type: "number" },
          preprocess_mode:     { type: "string" },
          seed:                { type: "number" },
          steps:               { type: "number" },
          cnet_active_steps:   { type: "number" },
        },
        required: ["label", "rationale", "prompt"],
      },
    },
    analysis: { type: "string", description: "Brief explanation of the detected failure modes and the fixes proposed" },
  },
  required: ["fixSpecs", "analysis"],
}

const HTML_SCHEMA = {
  type: "object",
  properties: {
    htmlPath:   { type: "string" },
    imageCount: { type: "number" },
    error:      { type: "string" },
  },
  required: ["htmlPath"],
}

// ════════════════════════════════════════════════════════════════════════════
// FINALIZE MODE
// ════════════════════════════════════════════════════════════════════════════

if (mode === "finalize") {
  phase("Review HTML")

  const first = finalizeFiles[0]
  const grouped = first && typeof first === "object"

  if (grouped) {
    const sets = finalizeFiles.map((s, si) => ({
      name: s.name || `Set ${si + 1}`,
      prompt: s.prompt || "",
      guide: s.guide || "Compare I2I output quality across variants.",
      variants: s.variants || [],
      files: (s.files || []).map(resolveJsonPath),
    }))
    const manifestJson = JSON.stringify({ lang: wfLang, sets }, null, 2)
    const totalFiles = sets.reduce((n, s) => n + s.files.length, 0)
    log(`Building MULTI-SET review HTML — ${sets.length} set(s), ${totalFiles} image(s)...`)

    const htmlResult = await agent(
      `Write a multi-set A/B review manifest JSON to disk, then build the review HTML.

MANIFEST CONTENT (write VERBATIM — exactly this JSON, no changes):
${manifestJson}

STEPS:
1. Write the manifest verbatim to ${OUT_DIR}/ab_manifest.json using a quoted heredoc:
   Bash("cat > '${OUT_DIR}/ab_manifest.json' <<'MANIFEST_EOF'\\n${manifestJson}\\nMANIFEST_EOF")
   Verify: Bash("cat '${OUT_DIR}/ab_manifest.json'")
2. Build the HTML:
   Bash("${PYTHON} ${RUN_PY} caption --ab-manifest '${OUT_DIR}/ab_manifest.json' 2>&1", timeout=120000)
3. Parse stdout for: Review HTML: /abs/path/review_*.html
   Extract the absolute path after "Review HTML: ".
4. On error or missing line, set error to the relevant excerpt.

Return JSON: { "htmlPath": "/abs/path/review.html" or "", "imageCount": ${totalFiles}, "error": "" }`,
      { label: "review-html", phase: "Review HTML", schema: HTML_SCHEMA },
    )

    const reviewHtml = htmlResult?.htmlPath || ""
    log(htmlResult?.error ? `Review HTML FAILED: ${htmlResult.error}` : `Review HTML: ${reviewHtml}`)
    return { reviewHtml, imageCount: htmlResult?.imageCount ?? totalFiles, captionSets: sets, error: htmlResult?.error || "" }
  }

  // Flat finalize
  const resolvedFiles = finalizeFiles.filter((s) => typeof s === "string" && s.length > 0).map(resolveJsonPath)
  if (resolvedFiles.length === 0) {
    log("ERROR: finalize mode received no caption JSON paths.")
    return { reviewHtml: "", imageCount: 0, captionFiles: [], error: "no files" }
  }

  const filesArg = resolvedFiles.map((p) => `"${p}"`).join(" ")
  const outputFlag = htmlOutput ? ` --html-output "${resolveJsonPath(htmlOutput)}"` : ""
  const cmd = `${PYTHON} ${RUN_PY} caption --review-html ${filesArg}${outputFlag}`
  log(`Building flat review HTML from ${resolvedFiles.length} caption JSON(s)...`)

  const htmlResult = await agent(
    `Build the interactive review HTML from accumulated caption JSON files.

COMMAND:
${cmd}

STEPS:
1. Run: Bash("${cmd} 2>&1", timeout=120000)
2. Parse stdout for a line like: Review HTML: /abs/path/review_YYYYMMDD_HHMMSS.html
3. If error or no "Review HTML:" line, set error to the relevant excerpt.

Return JSON: { "htmlPath": "...", "imageCount": ${resolvedFiles.length}, "error": "" }`,
    { label: "review-html", phase: "Review HTML", schema: HTML_SCHEMA },
  )

  const reviewHtml = htmlResult?.htmlPath || ""
  log(htmlResult?.error ? `Review HTML FAILED: ${htmlResult.error}` : `Review HTML: ${reviewHtml}`)
  return { reviewHtml, imageCount: htmlResult?.imageCount ?? resolvedFiles.length, captionFiles: resolvedFiles, error: htmlResult?.error || "" }
}

// ════════════════════════════════════════════════════════════════════════════
// GENERATION MODE
// ════════════════════════════════════════════════════════════════════════════

// ── Phase 1: Feedback (optional) ─────────────────────────────────────────────

let feedbackGuidance = ""

if (feedbackPath) {
  phase("Feedback")
  const feedbackAbs = resolveJsonPath(feedbackPath)
  log(`Reading prior feedback: ${feedbackAbs}`)

  const feedbackResult = await agent(
    `Read a human-feedback JSON exported from the I2I self-test review HTML and synthesize guidance for the next iteration.

FEEDBACK FILE: ${feedbackAbs}

The file has this format (generated by the i2i review HTML's "Generate JSON" button):
{
  "title": "Z-Image I2I Self-Test Results",
  "date": "...",
  "source_image": "...",
  "reference_image": "...",
  "winners": ["dn04-9st", ...],
  "results": [
    {
      "id": "dn04-9st",
      "label": "...",
      "image_file": "...",
      "parameters": { "denoise_strength": 0.4, "steps": 9, "seed": 42, "controlnet_strength": null, ... },
      "run_config": { ... },
      "feedback": {
        "ratings": { "source_identity": 4, "style_change": 5, "pose_match": 3, "artifact_level": 5 },
        "comment": "...",
        "is_winner": true
      }
    }
  ]
}

STEPS:
1. Read the file: Bash("cat '${feedbackAbs}'")
2. Identify the winning image(s) and what ratings they received.
3. For losing images, identify the lowest-rated criterion and link it to parameter values.
4. Synthesize concise guidance:
   - Which parameters produced the best results (KEEP)
   - Which parameters to change and what direction (CHANGE): denoise_strength, seed, steps, ctrl_strength, preprocess_mode
   - Any patterns in comments (e.g. "V-pose not fully formed" → try higher ctrl_strength or seed-sweep)

Return JSON:
{
  "winners": ["id1", ...],
  "guidance": "<bullet-point guidance as one string>",
  "perImage": [{ "id": "...", "ratings": {...}, "comment": "...", "is_winner": false }],
  "error": ""
}`,
    { label: "feedback", phase: "Feedback", schema: FEEDBACK_SCHEMA },
  )

  feedbackGuidance = feedbackResult?.guidance || ""
  if (feedbackResult?.winners?.length > 0) log(`  Human winners: ${feedbackResult.winners.join(", ")}`)
  log(`  Guidance:\n${feedbackGuidance.split("\n").map((l) => "    " + l).join("\n")}`)
  markPhase("feedback", "completed")
} else {
  log("No feedback for this iteration — skipping Feedback phase.")
  markPhase("feedback", "skipped")
}

// ── Phase 1.5: GPU gate ──────────────────────────────────────────────────────

const GPU_PROBE_SCHEMA = {
  type: "object",
  properties: { busy: { type: "boolean" }, pids: { type: "string" } },
  required: ["busy"],
}

if (gpuWaitOn) {
  phase("GPU Wait")
  log("GPU check before Generate (GPU-requiring phase)...")
  let gpuWaited = 0
  while (gpuWaited < maxGpuWait) {
    const probe = await agent(
      `Check whether any run.py generation process is currently running (using the GPU).

Run: Bash("pgrep -f 'run\\\\.py' || true")

Return JSON: { "busy": <true if pgrep printed any PID>, "pids": "<raw output>" }
NOTE: pgrep matches command-lines — this detection command ("pgrep ...") will NOT match itself.`,
      { label: "gpu-probe", phase: "GPU Wait", model: "haiku", schema: GPU_PROBE_SCHEMA },
    )
    if (!probe?.busy) {
      log(gpuWaited > 0 ? `GPU free after ${gpuWaited}s — proceeding.` : "GPU free — proceeding.")
      break
    }
    log(`GPU busy (${(probe?.pids || "").trim().replace(/\n/g, " ")}). Waiting 20s...`)
    await agent(`Sleep 20 seconds. Run: Bash("sleep 20"). Return { "ok": true }.`,
      { label: "gpu-sleep", phase: "GPU Wait", model: "haiku",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } })
    gpuWaited += 20
  }
  if (gpuWaited >= maxGpuWait) log(`WARNING: GPU still busy after ${maxGpuWait}s — proceeding anyway.`)
  markPhase("gpuWait", "completed")
} else {
  log("GPU gate SKIPPED (gpuWait:false).")
  markPhase("gpuWait", "skipped")
}

// ── Phase 2: Generate ────────────────────────────────────────────────────────

phase("Generate")

// Build commands — either one self-test command or N explicit configs
const cmdList = []
if (isSelfTest) {
  cmdList.push({ cmd: buildSelfTestCommand(selfTestMode), label: `self-test:${selfTestMode || "default"}` })
} else {
  explicitSpecs.forEach((spec, i) => {
    const cmd = buildExplicitCommand(spec)
    if (cmd) cmdList.push({ cmd, label: spec.label || `explicit-${i}` })
    else log(`[${i}] Cannot build command for spec (missing input_image?) — skipping.`)
  })
}

if (cmdList.length === 0) {
  log("ERROR: No valid commands to run. Falling back to default self-test.")
  cmdList.push({ cmd: buildSelfTestCommand(null), label: "self-test:default" })
}

const genResults = []
for (let i = 0; i < cmdList.length; i++) {
  const { cmd, label } = cmdList[i]
  log(`[${i + 1}/${cmdList.length}] Generating (${label}) — sequential, GPU-safe...`)

  try {
    const res = await agent(
      `Execute an I2I generation command and extract the output PNG paths from stdout.

COMMAND:
${cmd}

STEPS:
1. Run the command with a 20-minute timeout (I2I self-test can run many variants):
   Bash("${cmd} 2>&1", timeout=1200000)
   Capture all stdout/stderr.

2. Parse ALL lines matching this exact pattern (one per generated image):
     Saved: /absolute/path/to/image.png
   Collect every absolute path ending in .png from these lines.
   There may be MANY "Saved: " lines (one per test variation in a self-test run).

3. Also check for the source/reference image save lines — those look like:
     Saved: /path/i2i_selftest_source-s42.png
     Saved: /path/i2i_selftest_ref-pose-s43.png
   EXCLUDE source/reference images (filenames containing "selftest_source" or "selftest_ref-pose")
   from outputPngs. Only include the VARIATION images.

4. If the command exits with non-zero or stdout contains "Error" / "Traceback", set status="error".

Return JSON:
{
  "status": "success" or "error",
  "outputPngs": ["/abs/path/variation1.png", "/abs/path/variation2.png", ...],
  "error": ""
}`,
      { label: `generate-${i}-${label}`, phase: "Generate", schema: GEN_SCHEMA },
    )
    genResults.push({ label, cmd, result: res })
    const n = res?.outputPngs?.length || 0
    log(`[${i + 1}/${cmdList.length}] Done — ${n} PNG(s) found (status=${res?.status || "??"})`)
  } catch (e) {
    log(`[${i + 1}/${cmdList.length}] Generation agent failed: ${e?.message || e}`)
    genResults.push({ label, cmd, result: null })
  }
}

// Flatten all output PNGs across all generation runs
const allOutputPngs = genResults.flatMap((r) => r.result?.outputPngs || [])
log(`Total output PNGs collected: ${allOutputPngs.length}`)
markPhase("generate", "completed")

// ── Phase 3: VLM Check ───────────────────────────────────────────────────────

phase("VLM Check")

const vlmCheck = await agent(
  `Check if LM Studio VLM is running at http://localhost:1234.
Run: Bash("curl -sf http://localhost:1234/v1/models -o /dev/null -w '%{http_code}'")
Return { "available": true } if HTTP 200, { "available": false } otherwise.
IMPORTANT: Return ONLY the JSON object.`,
  { label: "vlm-check", phase: "VLM Check", model: "haiku", schema: VLM_CHECK_SCHEMA },
)

const vlmAvailable = vlmCheck?.available === true
log(vlmAvailable ? "VLM available — proceeding with Review." : "VLM UNAVAILABLE — skipping Review phase.")
markPhase("vlmCheck", vlmAvailable ? "completed" : "failed")

// ── Phase 4: Review ──────────────────────────────────────────────────────────

phase("Review")

let captions = []

if (!vlmAvailable || allOutputPngs.length === 0) {
  log("Skipping Review (VLM unavailable or no PNGs to score).")
} else {
  log(`Captioning ${allOutputPngs.length} PNG(s) with --style score...`)

  const captionResults = await pipeline(
    allOutputPngs,
    (pngPath, _orig, idx) => {
      const captionFile = captionPathFor(pngPath)
      return agent(
        `Score the image quality of an I2I output using the VLM caption tool.

IMAGE PATH: ${pngPath}
EXPECTED CAPTION OUTPUT: ${captionFile}

STEPS:
1. Run the caption command (requires LM Studio at http://localhost:1234):
   Bash("${PYTHON} ${RUN_PY} caption '${pngPath}' --style score --lang en 2>&1", timeout=120000)

   If this fails with a connection error (e.g. "Connection refused"), set:
     error = "VLM unavailable — LM Studio not running"
   and return with all score fields absent.

2. The command writes output to: ${captionFile}
   Read that file: Bash("cat '${captionFile}'")

3. Parse the outer JSON. The "caption" field is a nested JSON STRING — parse it again.
   Example: { "image": "...", "style": "score", "caption": "{\"overall\": 7, ...}" }
   The caption string MAY be wrapped in markdown fences — strip them and extract the first {...} block.
   Extract: overall, detail, sharpness, composition, prompt_adherence, artifacts,
            issues[], strengths[], summary.

Return flat JSON:
{
  "imagePath": "${pngPath}",
  "overall": <1-10>,
  "detail": <1-10>,
  "sharpness": <1-10>,
  "composition": <1-10>,
  "prompt_adherence": <1-10>,
  "artifacts": <1-10>,
  "issues": ["..."],
  "strengths": ["..."],
  "summary": "one sentence",
  "style": "score",
  "model": "<VLM model name>",
  "error": ""
}`,
        { label: `caption-${idx}`, phase: "Review", schema: CAPTION_SCHEMA },
      )
    },
  )

  captions = captionResults.filter(Boolean)
  const scored = captions.filter((c) => c.overall != null).length
  log(`Scored ${scored}/${allOutputPngs.length} PNG(s).`)
  markPhase("review", scored > 0 ? "completed" : "failed")
} else {
  markPhase("review", "failed")
}

// ── Phase 5: Self-Fix (optional) ─────────────────────────────────────────────

let fixCaptions = []
let fixAnalysis = ""

if (autoFix && vlmAvailable && captions.length > 0) {
  const scoredCaptions = captions.filter((c) => c.overall != null)
  const bestScore = scoredCaptions.reduce((best, c) => Math.max(best, c.overall || 0), 0)
  const worstCaptions = scoredCaptions.filter((c) => (c.overall || 0) < autoFixThreshold)

  if (worstCaptions.length > 0 && bestScore < autoFixThreshold) {
    phase("Self-Fix")
    log(`Self-Fix triggered: best overall=${bestScore.toFixed(1)} < threshold=${autoFixThreshold}. Analyzing ${worstCaptions.length} under-threshold PNG(s)...`)

    // Step A: Analyze failures and propose fix specs
    const fixProposalResult = await agent(
      `Analyze I2I quality scores and propose 1–2 targeted parameter fixes.

## Scored Outputs (below threshold ${autoFixThreshold})
${JSON.stringify(worstCaptions, null, 2)}

## All Scored Outputs (for context)
${JSON.stringify(scoredCaptions, null, 2)}

## Self-Test Mode: ${selfTestMode || "default"}
## Prior Feedback Guidance: ${feedbackGuidance || "(none)"}

## Fix Rules (apply these rules to identify fixes):
- detail < 5 → increase steps by 5 (helps with fine texture rendering)
- sharpness < 5 → reduce denoise_strength by 0.1 (less blurring of source)
- artifacts < 5 → reduce controlnet_strength by 0.2 OR add cnet_active_steps: 8 (prevent anatomy collapse)
- composition < 5 → try a different seed (stochastic sampling issue)
- If ALL dimensions are low → try both a lower denoise AND a different seed

## Your Task
1. Identify the PRIMARY failure mode(s) from the scores.
2. Propose at most 2 concrete fix specs. Each spec MUST include:
   - label: short identifier (e.g. "fix-lower-dn-s42", "fix-act8-s200")
   - rationale: one sentence explaining what it fixes
   - prompt: re-use the prompt from the worst-scoring output (extract from its imagePath filename pattern)
   - denoise_strength, seed, steps, controlnet_strength, cnet_active_steps: only include fields that CHANGE

   For self-test mode runs (imagePath contains "i2i_selftest_"):
   - Use the source image: ${OUT_DIR}/i2i_selftest_source-s42.png (or adjust seed in filename)
   - Use reference image: ${OUT_DIR}/i2i_selftest_ref-pose-s43.png (if ControlNet was involved)
   - Use the prompt matching the output type:
     * Pure I2I outputs: "A young woman, oil painting style, warm golden lighting, classical portraiture, rich brushstrokes, museum quality painting."
     * ControlNet outputs: "A single young Asian woman with black hair, full body shot, arms raised high in victory V-pose, pure white background, studio photography, one person only, no other people, no crowd, isolated figure, ultra sharp focus, high quality portrait photography."

3. Write a brief analysis of what failed and why these fixes should help.

Return JSON: { "fixSpecs": [...], "analysis": "..." }`,
      { label: "fix-analysis", phase: "Self-Fix", model: "sonnet", schema: FIX_SCHEMA },
    )

    fixAnalysis = fixProposalResult?.analysis || ""
    const fixSpecs = fixProposalResult?.fixSpecs || []
    log(`Self-Fix analysis: ${fixAnalysis}`)
    log(`Proposed ${fixSpecs.length} fix spec(s).`)

    // Step B: Run fix specs sequentially (GPU-safe)
    const fixGenResults = []
    for (let fi = 0; fi < fixSpecs.length; fi++) {
      const spec = fixSpecs[fi]
      log(`[Fix ${fi + 1}/${fixSpecs.length}] Running "${spec.label}": ${spec.rationale}`)

      const fixCmd = buildExplicitCommand({
        input_image: spec.input_image || `${OUT_DIR}/i2i_selftest_source-s42.png`,
        reference_image: spec.reference_image || null,
        prompt: spec.prompt,
        denoise_strength: spec.denoise_strength,
        controlnet_strength: spec.controlnet_strength,
        preprocess_mode: spec.preprocess_mode,
        seed: spec.seed,
        steps: spec.steps,
        cnet_active_steps: spec.cnet_active_steps,
      })

      if (!fixCmd) {
        log(`[Fix ${fi + 1}] Cannot build command — skipping.`)
        continue
      }

      try {
        const fixGen = await agent(
          `Execute an I2I fix generation command.

COMMAND: ${fixCmd}

STEPS:
1. Run: Bash("${fixCmd} 2>&1", timeout=600000)
2. Parse stdout for "Saved: " lines to collect output PNG paths (exclude source/ref images).
3. Return status and paths.

Return JSON: { "status": "success" or "error", "outputPngs": [...], "error": "" }`,
          { label: `fix-gen-${fi}-${spec.label}`, phase: "Self-Fix", schema: GEN_SCHEMA },
        )

        // Score the fix output immediately
        const fixPngs = fixGen?.outputPngs || []
        log(`[Fix ${fi + 1}] Generated ${fixPngs.length} PNG(s). Scoring...`)

        const fixScores = await parallel(
          fixPngs.map((pngPath, pi) => () => {
            const captionFile = captionPathFor(pngPath)
            return agent(
              `Score the I2I fix output image.

IMAGE PATH: ${pngPath}

STEPS:
1. Bash("${PYTHON} ${RUN_PY} caption '${pngPath}' --style score --lang en 2>&1", timeout=120000)
2. Read: Bash("cat '${captionFile}'")
3. Parse outer JSON, double-parse the "caption" string field.

Return: { "imagePath": "${pngPath}", "overall": <1-10>, "detail": <1-10>, "sharpness": <1-10>, "composition": <1-10>, "artifacts": <1-10>, "summary": "...", "error": "" }`,
              { label: `fix-score-${fi}-${pi}`, phase: "Self-Fix", schema: CAPTION_SCHEMA },
            )
          }),
        )

        const validScores = fixScores.filter(Boolean)
        fixCaptions.push(...validScores)
        const bestFix = validScores.reduce((b, c) => Math.max(b, c.overall || 0), 0)
        log(`[Fix ${fi + 1}/${fixSpecs.length}] "${spec.label}" → best overall=${bestFix.toFixed(1)}`)
        fixGenResults.push({ spec, fixGen, scores: validScores })
      } catch (e) {
        log(`[Fix ${fi + 1}] Agent failed: ${e?.message || e}`)
      }
    }
    markPhase("selfFix", "completed")
  } else if (bestScore >= autoFixThreshold) {
    log(`Self-Fix skipped: best overall=${bestScore.toFixed(1)} ≥ threshold=${autoFixThreshold} — quality is acceptable.`)
    markPhase("selfFix", "skipped")
  } else {
    log("Self-Fix skipped: no below-threshold outputs to fix.")
    markPhase("selfFix", "skipped")
  }
} else if (autoFix && !vlmAvailable) {
  log("Self-Fix skipped: VLM unavailable.")
  markPhase("selfFix", "skipped")
} else if (autoFix && captions.length === 0) {
  log("Self-Fix skipped: no scored outputs.")
  markPhase("selfFix", "skipped")
} else {
  markPhase("selfFix", "skipped")
}

// ── Phase 6: Report ──────────────────────────────────────────────────────────

phase("Report")

const totalPngs  = allOutputPngs.length
const totalScored = captions.filter((c) => c.overall != null).length
const totalFix   = fixCaptions.filter((c) => c.overall != null).length

log(`Summary: ${totalPngs} PNG(s) generated | ${totalScored} scored | ${totalFix} fix PNG(s) scored`)

// Build captionSets for Review HTML (one set per generation run)
const captionFiles = []
const captionSetsMap = {}
captions.concat(fixCaptions).forEach((c, idx) => {
  if (!c.imagePath) return
  const capPath = captionPathFor(c.imagePath)
  captionFiles.push(capPath)
  const setIdx = fixCaptions.includes(c) ? 99 : 0
  const setName = fixCaptions.includes(c) ? "Self-Fix Candidates" : (isSelfTest ? `Self-Test (${selfTestMode || "default"})` : "Custom I2I")
  if (!captionSetsMap[setIdx]) {
    captionSetsMap[setIdx] = { name: setName, prompt: "", variants: [], files: [] }
  }
  captionSetsMap[setIdx].files.push(capPath)
  captionSetsMap[setIdx].variants.push({ label: baseName(c.imagePath).replace(".png", "") })
})
const captionSets = Object.keys(captionSetsMap).sort((a, b) => Number(a) - Number(b)).map((k) => captionSetsMap[k])

const feedbackSection = feedbackGuidance
  ? `## Prior Iteration Guidance\n${feedbackGuidance}\n\n`
  : ""
const fixSection = fixAnalysis
  ? `## Self-Fix Analysis\n${fixAnalysis}\n\n## Self-Fix Results\n${JSON.stringify(fixCaptions, null, 2)}\n\n`
  : ""

const reportResult = await agent(
  `Generate a concise quality report for this I2I workflow run.

## Self-Test Mode: ${selfTestMode || "default (all _I2I_SELF_TEST_VARIATIONS)"}
## Explicit Specs: ${isSelfTest ? "(self-test, see mode above)" : JSON.stringify(explicitSpecs, null, 2)}

${feedbackSection}## Scored Outputs (${captions.length})
${JSON.stringify(captions, null, 2)}

${fixSection}## Your Task

**1. Results table** — one row per scored image:
| Image (filename only) | Overall | Detail | Sharp | Comp | Artifacts | Top Issue | Summary |
|---|---|---|---|---|---|---|---|

**2. Best image** — name the image with the highest overall score.

**3. Failure mode analysis** — identify patterns:
- Source identity loss (output looks too different from source)
- Pose mismatch (ControlNet pose not transferred)
- Artifacts (extra limbs, deformed anatomy)
- Style transfer failure

**4. Self-fix verdict** (if applicable) — did the auto-fix improve scores? By how much?

**5. Recommendations** — 2–3 actionable suggestions for the NEXT iteration:
- Which mode/parameters to try
- Which modes to avoid
- Whether to switch preprocess_mode (canny vs openpose)

If prior feedback guidance was provided, explicitly address whether this run followed it.

Keep the report concise. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)
markPhase("report", "completed")

// ── Phase 7: Review HTML ─────────────────────────────────────────────────────

let reviewHtml = ""
const noHtml = isObj(resolvedArgs) && resolvedArgs.noHtml === true

if (captionFiles.length > 0 && !noHtml) {
  phase("Review HTML")

  const guideText = wfLang === "zh_TW"
    ? "比較 I2I 輸出品質：Source Identity（來源身份保留）、Style Change（風格轉換）、Pose Match（姿勢匹配）、Artifacts（瑕疵）。"
    : "Compare I2I output quality: source identity preservation, style transfer fidelity, pose match (ControlNet), and absence of artifacts."

  const setsWithGuide = captionSets.map((s) => ({ ...s, guide: guideText }))
  const manifestJson = JSON.stringify({ lang: wfLang, sets: setsWithGuide }, null, 2)
  log(`Building review HTML — ${captionSets.length} set(s), ${captionFiles.length} image(s)...`)

  const htmlResult = await agent(
    `Write a multi-set A/B review manifest JSON to disk, then build the review HTML.

MANIFEST CONTENT (write VERBATIM — exactly this JSON, no changes):
${manifestJson}

STEPS:
1. Write the manifest verbatim to ${OUT_DIR}/ab_manifest.json using a quoted heredoc:
   Bash("cat > '${OUT_DIR}/ab_manifest.json' <<'MANIFEST_EOF'\\n${manifestJson}\\nMANIFEST_EOF")
   Verify: Bash("cat '${OUT_DIR}/ab_manifest.json'")
2. Build the HTML:
   Bash("${PYTHON} ${RUN_PY} caption --ab-manifest '${OUT_DIR}/ab_manifest.json' 2>&1", timeout=120000)
3. Parse stdout for: Review HTML: /abs/path/review_*.html
4. On error or missing line, set error to the excerpt.

Return JSON: { "htmlPath": "/abs/path/review.html" or "", "imageCount": ${captionFiles.length}, "error": "" }`,
    { label: "review-html", phase: "Review HTML", schema: HTML_SCHEMA },
  )

  reviewHtml = htmlResult?.htmlPath || ""
  log(reviewHtml
    ? `Review HTML: ${reviewHtml}`
    : (htmlResult?.error ? `Review HTML FAILED: ${htmlResult.error}` : "Review HTML build failed."))
  markPhase("reviewHtml", reviewHtml ? "completed" : "failed")
} else {
  markPhase("reviewHtml", "skipped")
}

// ── Persist — write run history ──────────────────────────────────────────────
phase("Persist")
const _i2i_tsR = await agent(
  `Run: Bash("date -u '+%Y-%m-%dT%H-%M-%S'") and return { timestamp: "<exact output trimmed>" }.`,
  { label: "get-persist-ts", phase: "Persist", model: "haiku",
    schema: { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] } },
)
const _i2i_RUN_TS   = (_i2i_tsR?.timestamp || "unknown").trim()
const _i2i_HIST_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${meta.name}`
const _i2i_INDEX_FILE = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`

const _i2i_signals = {
  run_quality: phasesFailed.length === 0 ? "good" : "degraded",
  key_metric: allOutputPngs.length,
  delta_from_last: null,
  highlights: [
    `${allOutputPngs.length} image(s) generated, ${captions.length} captioned`,
    selfTestMode ? `mode=${selfTestMode}` : "mode=default",
    reviewHtml ? "review HTML built" : "no review HTML",
  ],
  warnings: fixAnalysis ? ["self-fix triggered"] : [],
}

const _i2i_HIST_JSON = JSON.stringify({
  schema_version: 1, run_id: _i2i_RUN_TS, workflow: meta.name, started_at: _i2i_RUN_TS,
  args: resolvedArgs,
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  signals: _i2i_signals,
  result: { mode: selfTestMode || "default", imageCount: allOutputPngs.length,
    captionCount: captions.length, selfFix: !!fixAnalysis, reviewHtml: !!reviewHtml },
}, null, 2)

await agent(
  `Persist workflow run history to disk.
1. Bash("mkdir -p '${_i2i_HIST_DIR}'")
2. Write file: Write({ file_path: '${_i2i_HIST_DIR}/${_i2i_RUN_TS}.json', content: <json> })
   Content: ${_i2i_HIST_JSON}
3. Bash("wc -c '${_i2i_HIST_DIR}/${_i2i_RUN_TS}.json' && echo OK")
4. Bash("cd '${_i2i_HIST_DIR}' && ls -t *.json 2>/dev/null | tail -n +16 | xargs rm -f")
Return { written: true }.`,
  { label: "persist-history", phase: "Persist", model: "haiku" },
)

await agent(
  `Append a summary entry to the cross-workflow index.
1. Bash("cat '${_i2i_INDEX_FILE}' 2>/dev/null || echo '[]'")
2. Parse JSON array. Append: ${JSON.stringify({ run_id: _i2i_RUN_TS, workflow: meta.name, started_at: _i2i_RUN_TS, run_quality: _i2i_signals.run_quality, key_metric: _i2i_signals.key_metric, highlights: _i2i_signals.highlights })}
3. Keep only latest 50 entries.
4. Write back: Write({ file_path: '${_i2i_INDEX_FILE}', content: <updated array as JSON> })
Return { updated: true }.`,
  { label: "update-index", phase: "Persist", model: "haiku" },
)

markPhase("persist", "completed")
log(`History: ${_i2i_HIST_DIR}/${_i2i_RUN_TS}.json`)

log("=== I2I Run-and-Review Complete ===")
log(reportResult || "(no report)")
if (fixAnalysis) log(`Self-Fix: ${fixAnalysis}`)
if (captionSets.length > 0) {
  log(`Caption JSONs produced (${captionSets.length} set(s)):`)
  captionSets.forEach((s) => log(`  [${s.name}] ${s.files.join(", ")}`))
}
if (reviewHtml) log(`Review HTML ready for human feedback: ${reviewHtml}`)

return {
  selfTestMode:    selfTestMode || "default",
  outputPngs:      allOutputPngs,
  captions,
  fixCaptions,
  fixAnalysis,
  report:          reportResult,
  feedbackGuidance,
  captionFiles,
  captionSets,
  reviewHtml,
  history: { runId: _i2i_RUN_TS, path: `${_i2i_HIST_DIR}/${_i2i_RUN_TS}.json` },
}
