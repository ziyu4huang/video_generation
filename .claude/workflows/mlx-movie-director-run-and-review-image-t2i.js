// mlx-movie-director-run-and-review-image-t2i — Iterative T2I generation + VLM review
//
// An iterative loop for GPU-limited Apple Silicon:
//   1. Generation iteration — run.py t2i (sequentially, one model process at a time),
//      auto-score each output with run.py caption --style review.
//   2. Finalize — aggregate an explicit list of accumulated caption JSONs into ONE
//      interactive review HTML for a human.
//   3. Feedback — the human exports feedback (best image + comments) from that HTML,
//      which is fed back into the next generation iteration.
//
// Two modes (selected by args):
//
//   GENERATION (default) — generate + caption. Returns captionFiles[] to accumulate.
//     Workflow({ name: "mlx-movie-director-run-and-review-image-t2i" })
//       → self-test (default: run.py t2i --self-test)
//     Workflow({ name: "...", args: "A moody portrait in soft lighting" })
//       → single T2I with prompt string
//     Workflow({ name: "...", args: { prompt: "...", pipeline: "flux2-klein", steps: 4, seed: 100 } })
//       → T2I with full config object
//     Workflow({ name: "...", args: { runs: [{prompt:"A",seed:1}, {prompt:"A",seed:2}], feedback: "review_feedback.json" } })
//       → multi-spec generation + ingest prior human feedback (iteration N>1)
//     Workflow({ name: "...", args: ["output_20260610_194901.run.json"] })
//       → replay one or more previous run.json files (relative to output/ or absolute)
//     Workflow({ name: "...", args: [{prompt: "A"}, {prompt: "B", seed: 100}] })
//       → multiple T2I configs (generated sequentially — GPU-safe)
//
//   FINALIZE — skip generation; build the human-review HTML from explicit caption JSONs.
//     Workflow({ name: "...", args: { finalize: ["a.caption.json", "b.caption.json"] } })
//     Workflow({ name: "...", args: { finalize: ["a.caption.json", "b.caption.json"], htmlOutput: "output/review.html" } })
//
// Supported gen config fields (all optional except prompt): prompt, pipeline
// ("zimage"|"flux2-klein"), steps, seed, width, height, lora_path, lora_scale, draft,
// upscale, upscale_method ("esrgan"|"seedvr2"), count, seed_start, variant ("4b"|"9b"),
// ab_test, quantize, transformer, flux2_model_path.
//
// NOTE: caption.py writes <image>.caption.json (extension stripped), so paths returned
// in captionFiles are the real on-disk caption JSON paths — collect them and pass to finalize.

export const meta = {
  name: "mlx-movie-director-run-and-review-image-t2i",
  description: "Iterative T2I generation + VLM review: generate/caption sequentially, finalize an interactive review HTML, ingest human feedback for the next iteration",
  whenToUse: "Test T2I output quality iteratively under GPU limits: generate runs return captionFiles to accumulate; finalize builds the human-review HTML; feedback drives the next run.",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root via git rev-parse — eliminates CWD drift" },
    { title: "Feedback", detail: "Optional — read exported human-feedback JSON and emit keep/change guidance for this iteration" },
    { title: "Generate", detail: "Execute T2I sequentially (one model process at a time, GPU-safe) with --json-summary" },
    { title: "VLM Check", detail: "Verify LM Studio is running before caption phase" },
    { title: "Review", detail: "Score each output PNG via run.py caption --style review (requires LM Studio)" },
    { title: "Report", detail: "Summarize quality scores and improvement recommendations" },
    { title: "Review HTML", detail: "Finalize mode — build interactive review HTML from explicit caption JSONs via run.py caption --review-html" },
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

// ── Helpers (pure JS — no agent needed) ──────────────────────────────────────

function resolveJsonPath(p) {
  return p.startsWith("/") ? p : `${OUT_DIR}/${p}`
}

// caption.py strips the image extension (os.path.splitext) → img.png writes img.caption.json
function captionPathFor(pngPath) {
  return pngPath.replace(/\.[^.\/]+$/, "") + ".caption.json"
}

function normalizeItem(item) {
  if (!item) return null
  if (typeof item === "string") {
    if (item.endsWith(".run.json") || item.endsWith(".json")) {
      return { type: "replay", path: resolveJsonPath(item) }
    }
    return { type: "t2i", prompt: item }
  }
  if (typeof item === "object" && !Array.isArray(item)) {
    if (item.selfTest) {
      return { type: "self-test", id: typeof item.selfTest === "string" ? item.selfTest : null }
    }
    if (item.prompt) {
      return { type: "t2i", ...item }
    }
  }
  return null
}

// ── Args normalization + mode detection ──────────────────────────────────────

// Resolve args — handles string-serialized JSON (Workflow tool may stringify)
let resolvedArgs = args
if (typeof resolvedArgs === "string") {
  try {
    const parsed = JSON.parse(resolvedArgs)
    if (Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null)) {
      resolvedArgs = parsed
      log(`Parsed string args as ${Array.isArray(parsed) ? `array[${parsed.length}]` : "object"}`)
    }
  } catch {
    // Not JSON — treat as a plain prompt string
  }
}

// Two modes:
//   finalize: { finalize: "<path>" | ["<paths>"], htmlOutput?: "<path>" }
//             → skip generation; build the human-review HTML from explicit caption JSONs.
//   gen (default): generate + caption; optionally ingest prior human feedback.
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x)

let mode = "gen"
let feedbackPath = ""
let htmlOutput = ""
let finalizeFiles = []
let runSpecs = []

if (isObj(resolvedArgs) && resolvedArgs.finalize != null) {
  mode = "finalize"
  const f = resolvedArgs.finalize
  finalizeFiles = (Array.isArray(f) ? f : [f]).filter((s) => typeof s === "string" && s.length > 0)
  htmlOutput = typeof resolvedArgs.htmlOutput === "string" ? resolvedArgs.htmlOutput : ""
} else {
  // Generation mode — pull optional iteration-level feedback, then resolve run specs
  if (isObj(resolvedArgs) && typeof resolvedArgs.feedback === "string") {
    feedbackPath = resolvedArgs.feedback
  }
  if (isObj(resolvedArgs) && Array.isArray(resolvedArgs.runs)) {
    runSpecs = resolvedArgs.runs.map(normalizeItem).filter(Boolean) // {runs:[...], feedback?} wrapper
  } else if (!resolvedArgs) {
    runSpecs = [{ type: "self-test", id: null }]
  } else if (typeof resolvedArgs === "string") {
    const norm = normalizeItem(resolvedArgs)
    runSpecs = norm ? [norm] : [{ type: "self-test", id: null }]
  } else if (Array.isArray(resolvedArgs)) {
    runSpecs = resolvedArgs.map(normalizeItem).filter(Boolean)
  } else if (isObj(resolvedArgs)) {
    const norm = normalizeItem(resolvedArgs)
    runSpecs = norm ? [norm] : [{ type: "self-test", id: null }]
  }
  if (runSpecs.length === 0) {
    log("WARNING: No valid run specs from args — falling back to self-test.")
    runSpecs = [{ type: "self-test", id: null }]
  }
}

if (mode === "finalize") {
  log(`MODE: finalize — ${finalizeFiles.length} caption JSON(s) to aggregate`)
  finalizeFiles.forEach((p, i) => log(`  [${i}] ${p}`))
} else {
  log(`MODE: generation — ${runSpecs.length} spec(s)${feedbackPath ? ` | feedback: ${feedbackPath}` : " | no feedback (first iteration)"}`)
  runSpecs.forEach((s, i) => log(`  [${i}] type=${s.type}${s.prompt ? ` prompt="${s.prompt.slice(0, 60)}..."` : ""}${s.path ? ` path=${s.path}` : ""}${s.id ? ` id=${s.id}` : ""}`))
}

// ── Shell command builder (pure JS) ─────────────────────────────────────────

function buildCommand(spec) {
  if (spec.type === "self-test") {
    const idFlag = spec.id ? ` ${spec.id}` : ""
    return `${PYTHON} ${RUN_PY} t2i --self-test${idFlag} --json-summary`
  }

  if (spec.type === "replay") {
    return `${PYTHON} ${RUN_PY} replay '${spec.path}' --json-summary`
  }

  if (spec.type === "t2i") {
    // Single-quote escape for the prompt so shell handles special chars safely
    const safePrompt = (spec.prompt || "").replace(/'/g, "'\\''")
    let cmd = `${PYTHON} ${RUN_PY} t2i --prompt '${safePrompt}' --json-summary`
    if (spec.pipeline)           cmd += ` --pipeline ${spec.pipeline}`
    if (spec.steps != null)      cmd += ` --steps ${spec.steps}`
    if (spec.seed != null)       cmd += ` --seed ${spec.seed}`
    if (spec.width)              cmd += ` --width ${spec.width}`
    if (spec.height)             cmd += ` --height ${spec.height}`
    if (spec.lora_path)          cmd += ` --lora-path '${spec.lora_path}'`
    if (spec.lora_scale != null) cmd += ` --lora-scale ${spec.lora_scale}`
    if (spec.draft)              cmd += ` --draft`
    if (spec.upscale)            cmd += ` --upscale`
    if (spec.upscale_method)     cmd += ` --upscale-method ${spec.upscale_method}`
    if (spec.count != null)      cmd += ` --count ${spec.count}`
    if (spec.seed_start != null) cmd += ` --seed-start ${spec.seed_start}`
    if (spec.variant)            cmd += ` --variant ${spec.variant}`
    if (spec.ab_test)            cmd += ` --ab-test`
    if (spec.quantize != null)   cmd += ` --quantize ${spec.quantize}`
    if (spec.transformer)        cmd += ` --transformer ${spec.transformer}`
    if (spec.flux2_model_path)   cmd += ` --flux2-model-path '${spec.flux2_model_path}'`
    return cmd
  }

  return null
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const GEN_SCHEMA = {
  type: "object",
  properties: {
    status:      { type: "string", enum: ["success", "error"] },
    outputPngs:  { type: "array", items: { type: "string" }, description: "Absolute paths of generated PNG files (from JSON_SUMMARY)" },
    runJsonPath: { type: "string", description: "Absolute path to the .run.json file, empty string if not found" },
    error:       { type: "string", description: "Error message, empty string on success" },
  },
  required: ["status", "outputPngs"],
}

const VLM_CHECK_SCHEMA = {
  type: "object",
  properties: {
    available: { type: "boolean", description: "Whether LM Studio VLM is reachable" },
  },
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
    error:            { type: "string", description: "Error message, empty string on success" },
  },
  required: ["imagePath"],
}

const FEEDBACK_SCHEMA = {
  type: "object",
  properties: {
    bestFilename: { type: "string", description: "Filename the human marked best, empty string if none" },
    guidance:     { type: "string", description: "Concise keep/change guidance for the next iteration" },
    perImage:     { type: "array", items: { type: "object", properties: { filename: { type: "string" }, comment: { type: "string" } } } },
    error:        { type: "string" },
  },
  required: ["guidance"],
}

const HTML_SCHEMA = {
  type: "object",
  properties: {
    htmlPath:   { type: "string", description: "Absolute path to generated review HTML, empty string on failure" },
    imageCount: { type: "number", description: "Number of images included in the HTML" },
    error:      { type: "string" },
  },
  required: ["htmlPath"],
}

// ════════════════════════════════════════════════════════════════════════════
// FINALIZE MODE — build the human-review HTML from explicit caption JSONs
// ════════════════════════════════════════════════════════════════════════════

if (mode === "finalize") {
  phase("Review HTML")

  const resolvedFiles = finalizeFiles.map(resolveJsonPath)
  if (resolvedFiles.length === 0) {
    log("ERROR: finalize mode received no caption JSON paths.")
    return { reviewHtml: "", imageCount: 0, captionFiles: [], error: "no files" }
  }

  const filesArg = resolvedFiles.map((p) => `"${p}"`).join(" ")
  const outputFlag = htmlOutput ? ` --html-output "${resolveJsonPath(htmlOutput)}"` : ""
  const cmd = `${PYTHON} ${RUN_PY} caption --review-html ${filesArg}${outputFlag}`

  log(`Building review HTML from ${resolvedFiles.length} caption JSON(s)...`)

  const htmlResult = await agent(
    `Build the interactive review HTML from accumulated caption JSON files.

COMMAND:
${cmd}

STEPS:
1. Run: Bash("${cmd} 2>&1", timeout=120000)
2. Parse stdout for a line like:
   Review HTML: /abs/path/review_YYYYMMDD_HHMMSS.html
   Extract the absolute path after "Review HTML: ".
3. If the command errors (e.g. a caption file is missing) or no "Review HTML:" line is found,
   set error to the relevant stderr/stdout excerpt.

Return JSON:
{
  "htmlPath": "/abs/path/review.html" or "",
  "imageCount": ${resolvedFiles.length},
  "error": ""
}`,
    { label: "review-html", phase: "Review HTML", schema: HTML_SCHEMA },
  )

  const reviewHtml = htmlResult?.htmlPath || ""
  log(htmlResult?.error ? `Review HTML FAILED: ${htmlResult.error}` : `Review HTML: ${reviewHtml}`)

  return {
    reviewHtml,
    imageCount: htmlResult?.imageCount ?? resolvedFiles.length,
    captionFiles: resolvedFiles,
    error: htmlResult?.error || "",
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GENERATION MODE
// ════════════════════════════════════════════════════════════════════════════

// ── Phase 1: Feedback (optional — drives this iteration from prior human review) ──

let feedbackGuidance = ""

if (feedbackPath) {
  phase("Feedback")
  const feedbackAbs = resolveJsonPath(feedbackPath)
  log(`Reading prior feedback: ${feedbackAbs}`)

  const feedbackResult = await agent(
    `Read a human-feedback JSON exported from a prior review HTML and turn it into guidance for the NEXT T2I iteration.

FEEDBACK FILE: ${feedbackAbs}

STEPS:
1. Read the file: Bash("cat '${feedbackAbs}'")
   Structure: { timestamp, best_image: <index|null>, images: [{ index, filename, comment }] }
   Each entry's "filename" identifies which previously-generated image the comment refers to.

2. Filenames correspond to prior output PNGs under ${OUT_DIR}. For images that have a comment,
   you MAY best-effort recall what prompt produced them by reading the sibling caption JSON:
   Bash("cat '${OUT_DIR}/<filename-without-extension>.caption.json'")   (skip silently if missing)

3. Synthesize concise GUIDANCE for this next iteration:
   - BEST: which image (filename) the human picked as best, and why (infer from its scores/comments).
   - KEEP: prompt choices / elements to preserve.
   - CHANGE: concrete suggestions — prompt wording, seed, steps, upscale on/off, pipeline —
     derived from the comments and any score weaknesses.

Return JSON:
{
  "bestFilename": "<filename or empty>",
  "guidance": "<3-6 concise bullet lines as one string>",
  "perImage": [{ "filename": "...", "comment": "..." }],
  "error": ""
}`,
    { label: "feedback", phase: "Feedback", schema: FEEDBACK_SCHEMA },
  )

  feedbackGuidance = feedbackResult?.guidance || ""
  if (feedbackResult?.bestFilename) log(`  Human's best: ${feedbackResult.bestFilename}`)
  log(`  Guidance:\n${feedbackGuidance.split("\n").map((l) => "    " + l).join("\n")}`)
} else {
  log("No feedback for this iteration (first iteration) — skipping Feedback phase.")
}

// ── Phase 2: Generate (sequential — one model process at a time, GPU-safe) ───

phase("Generate")

const genResults = []
for (let idx = 0; idx < runSpecs.length; idx++) {
  const spec = runSpecs[idx]
  const cmd = buildCommand(spec)
  if (!cmd) {
    log(`[${idx}] Cannot build command for spec — skipping.`)
    genResults.push({ status: "error", outputPngs: [], runJsonPath: "", error: `Cannot build command for spec: ${JSON.stringify(spec)}` })
    continue
  }
  log(`[${idx}/${runSpecs.length}] Generating (${spec.type}) — sequential, one model process at a time (GPU-safe)...`)

  try {
    const res = await agent(
      `Execute a T2I generation command and extract the output paths from the JSON_SUMMARY line.

COMMAND:
${cmd}

STEPS — execute in order:

1. Run the generation command. This may take 5–15 minutes — use a 10-minute timeout:
   Bash("${cmd} 2>&1", timeout=600000)

   Capture the full stdout/stderr output.

2. Parse the JSON_SUMMARY line from stdout. It looks like:
   JSON_SUMMARY:{"status":"success","run_json":"...","manifest_json":"...","outputs":["/path/to/img.png"]}

   Extract the JSON after "JSON_SUMMARY:" prefix.

3. If no JSON_SUMMARY line found (older run.py without --json-summary support), fall back:
   - Search stdout for lines starting with "Saved: " to find output PNG paths
   - Search stdout for lines starting with "Run config: " to find the run.json path

4. If the command exit code is non-zero or stdout contains "Error" / "Traceback",
   set status="error".

Return JSON:
{
  "status": "success" or "error",
  "outputPngs": ["/abs/path/img.png", ...],
  "runJsonPath": "/abs/path/img.run.json" or "",
  "error": ""
}`,
      { label: `generate-${idx}-${spec.type}`, phase: "Generate", schema: GEN_SCHEMA },
    )
    genResults.push(res)
  } catch (e) {
    log(`[${idx}] Generation agent failed: ${e?.message || e}`)
    genResults.push(null)
  }
}

// ── Phase 3: VLM pre-flight check ────────────────────────────────────────────

phase("VLM Check")

const vlmCheck = await agent(
  `Check if LM Studio VLM is running at http://localhost:1234.

Run: Bash("curl -sf http://localhost:1234/v1/models -o /dev/null -w '%{http_code}'")

Return { "available": true } if HTTP 200, { "available": false } otherwise.
IMPORTANT: Return ONLY the JSON object.`,
  { label: "vlm-check", phase: "VLM Check", model: "haiku", schema: VLM_CHECK_SCHEMA },
)

const vlmAvailable = vlmCheck?.available === true

if (vlmAvailable) {
  log("VLM available — proceeding with Review phase.")
} else {
  log("VLM UNAVAILABLE — LM Studio not running at localhost:1234. Skipping Review phase.")
  log("Start LM Studio with a VLM model (e.g. qwen3-vl-4b) to enable scoring.")
}

// ── Phase 4: Review — Caption each PNG ───────────────────────────────────────

phase("Review")

const allResults = genResults.map((genResult, idx) => {
  const originalSpec = runSpecs[idx]
  if (!genResult || !genResult.outputPngs || genResult.outputPngs.length === 0) {
    log(`[${idx}] No PNGs to caption (gen status=${genResult?.status || "null"}).`)
    return {
      spec: originalSpec,
      genResult: genResult || { status: "error", outputPngs: [], runJsonPath: "", error: "null result from generate stage" },
      captions: [],
    }
  }
  return { spec: originalSpec, genResult }
})

if (!vlmAvailable) {
  // Skip Review — fill empty captions
  allResults.forEach((r) => { r.captions = [] })
} else {
  // Caption each genResult's PNGs (merged read-prompt + caption agent)
  const captionedResults = await pipeline(
    allResults.filter((r) => r.genResult?.outputPngs?.length > 0),
    async (item, _orig, idx) => {
      const { genResult } = item

      log(`[${idx}] Captioning ${genResult.outputPngs.length} PNG(s)...`)

      const captions = await parallel(
        genResult.outputPngs.map((pngPath, pngIdx) => () => {
          const captionFile = captionPathFor(pngPath)

          return agent(
            `Score the image quality of a T2I output using the VLM caption tool.

IMAGE PATH: ${pngPath}
RUN.JSON: ${genResult.runJsonPath || "(none)"}

STEPS:

1. If a run.json path is available, read it to extract the original prompt:
   Bash("cat '${genResult.runJsonPath}'")
   Extract the "prompt" field value. If missing or file not found, use null.

2. Choose the caption style based on whether we have the original prompt:
   - If prompt found: use --style review --prompt '<safe_prompt>'
   - If no prompt: use --style score

3. Run the caption command (requires LM Studio at http://localhost:1234):
   Bash("${PYTHON} ${RUN_PY} caption '${pngPath}' --style <review|score> [--prompt '<prompt>'] --lang en")

   If this fails with a connection error (e.g. "Connection refused"), set:
     error = "VLM unavailable — LM Studio not running at localhost:1234"
   and return with all score fields absent.

4. If successful, the command writes output to: ${captionFile}
   Read that file:
   Bash("cat '${captionFile}'")

5. Parse the outer JSON. The "caption" field is a nested JSON STRING — parse it again.
   Example structure:
   {
     "image": "...", "style": "review", "model": "...",
     "caption": "{\\"overall\\": 7, \\"detail\\": 8, \\"captured\\": [...], ... }"
   }
   The caption string MAY be wrapped in markdown fences (triple-backtick json blocks) or prose —
   strip fences and extract the first {...} block before parsing.
   After double-parsing, extract: overall, detail, sharpness, composition,
   prompt_adherence, artifacts, captured[], missed[], issues[], strengths[], summary.

Return flat JSON:
{
  "imagePath": "${pngPath}",
  "overall": <1-10>,
  "detail": <1-10>,
  "sharpness": <1-10>,
  "composition": <1-10>,
  "prompt_adherence": <1-10>,
  "artifacts": <1-10 — 10=no artifacts, 1=severe artifacts>,
  "captured": ["element from prompt present in image", ...],
  "missed": ["element from prompt absent or wrong", ...],
  "issues": ["..."],
  "strengths": ["..."],
  "summary": "one sentence",
  "style": "<the style used>",
  "model": "<the VLM model name>",
  "error": ""
}`,
            { label: `caption-${idx}-${pngIdx}`, phase: "Review", schema: CAPTION_SCHEMA },
          )
        }),
      )

      item.captions = captions.filter(Boolean)
      return item
    },
  )

  // Merge captioned results back into allResults
  captionedResults.forEach((captioned, i) => {
    if (captioned) {
      const idx = allResults.findIndex((r) => r.genResult === captioned.genResult)
      if (idx >= 0) allResults[idx] = captioned
    }
  })
}

// ── Phase 5: Report ──────────────────────────────────────────────────────────

phase("Report")

const validResults = allResults.filter(Boolean)
const totalPngs    = validResults.reduce((n, r) => n + (r.genResult?.outputPngs?.length || 0), 0)
const totalCapped  = validResults.reduce((n, r) => n + (r.captions?.filter((c) => c.overall != null).length || 0), 0)

log(`Summary: ${validResults.length}/${runSpecs.length} specs ran | ${totalPngs} PNG(s) generated | ${totalCapped} scored`)

// Collect caption JSON paths produced this iteration (for the user to accumulate → finalize)
const captionFiles = [...new Set(
  validResults.flatMap((r) => (r.captions || []).map((c) => (c.imagePath ? captionPathFor(c.imagePath) : null))).filter(Boolean),
)]

const feedbackSection = feedbackGuidance
  ? `## Prior Iteration Feedback (guidance applied to this run)\n${feedbackGuidance}\n`
  : ""

const reportResult = await agent(
  `Generate a concise quality report for this T2I workflow run.

## Run Configuration (${runSpecs.length} spec(s))
${JSON.stringify(runSpecs, null, 2)}

${feedbackSection}
## Results (${validResults.length} result(s))
${JSON.stringify(validResults, null, 2)}

## Your Task

**1. Results table** — one row per scored image:
| Image (filename only) | Overall | Detail | Sharp | Comp | Adherence | Artifacts | Captured | Missed | Summary |
|---|---|---|---|---|---|---|---|---|---|
For Captured/Missed columns: list the top 2–3 items, comma-separated. If not available, show "—".

**2. Best image** — name the image with the highest overall score.

**3. Prompt adherence analysis** — if captured/missed data is available, summarize which prompt elements
   were consistently captured or missed across images. This is the KEY insight of this report.

**4. Common issues** — top 3 issues found across all images (aggregate from issues[] arrays).

**5. Recommendations** — 2–3 specific, actionable suggestions for improving future T2I quality
   (e.g. prompt wording changes based on missed elements, parameter tuning, pipeline choice).
   If prior feedback guidance was provided above, explicitly address whether this run followed it.

**6. Errors** — if any generation failed or LM Studio was unavailable, briefly note it.

Keep the report concise. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)

log("=== T2I Run-and-Review Complete ===")
log(reportResult || "(no report)")
if (captionFiles.length > 0) {
  log(`Caption JSONs produced this iteration (pass these to {finalize:[...]} when ready to build the review HTML):`)
  captionFiles.forEach((p) => log(`  ${p}`))
}

return {
  specs:           runSpecs,
  runs:            validResults,
  report:          reportResult,
  feedbackGuidance,
  captionFiles,
}
