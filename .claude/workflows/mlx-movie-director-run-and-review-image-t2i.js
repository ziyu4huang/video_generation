// mlx-movie-director-run-and-review-image-t2i — Dynamic T2I generation + VLM quality scoring
//
// Runs run.py t2i (or replay previous run configs) and auto-scores each output
// image with run.py caption --style score/review. Uses --json-summary to get
// machine-readable output paths instead of fragile find -newer markers.
//
// Usage:
//   Workflow({ name: 'mlx-movie-director-run-and-review-image-t2i' })
//     → self-test (default: run.py t2i --self-test)
//
//   Workflow({ name: 'mlx-movie-director-run-and-review-image-t2i', args: "A moody portrait in soft lighting" })
//     → single T2I with prompt string
//
//   Workflow({ name: 'mlx-movie-director-run-and-review-image-t2i', args: { prompt: "...", pipeline: "flux2-klein", steps: 4, seed: 100 } })
//     → T2I with full config object
//
//   Workflow({ name: 'mlx-movie-director-run-and-review-image-t2i', args: ["output_20260610_194901.run.json"] })
//     → replay one or more previous run.json files (relative to output/ or absolute)
//
//   Workflow({ name: 'mlx-movie-director-run-and-review-image-t2i', args: [{prompt: "A"}, {prompt: "B", seed: 100}] })
//     → multiple T2I configs in parallel
//
// Supported args config object fields (all optional except prompt):
//   prompt, pipeline ("zimage"|"flux2-klein"), steps, seed, width, height,
//   lora_path, lora_scale, draft, upscale, count, seed_start,
//   variant ("4b"|"9b"), ab_test, quantize, transformer, flux2_model_path

export const meta = {
  name: "mlx-movie-director-run-and-review-image-t2i",
  description: "Run T2I generation via mlx-movie-director run.py and auto-score output quality via VLM caption --style score/review",
  whenToUse: "Test T2I output quality: default self-test, or pass a prompt/config/run.json array. Scores each output image with local VLM (LM Studio required for scoring).",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root via git rev-parse — eliminates CWD drift" },
    { title: "Generate", detail: "Execute T2I with --json-summary and parse output paths from stdout" },
    { title: "VLM Check", detail: "Verify LM Studio is running before caption phase" },
    { title: "Review", detail: "Score each output PNG via run.py caption --style score/review (requires LM Studio)" },
    { title: "Report", detail: "Summarize quality scores and improvement recommendations" },
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

// ── Args normalization (pure JS — no agent needed) ───────────────────────────

function resolveJsonPath(p) {
  return p.startsWith("/") ? p : `${OUT_DIR}/${p}`
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

let runSpecs = []

if (!args) {
  runSpecs = [{ type: "self-test", id: null }]
} else if (typeof args === "string") {
  const norm = normalizeItem(args)
  runSpecs = norm ? [norm] : [{ type: "self-test", id: null }]
} else if (Array.isArray(args)) {
  runSpecs = args.map(normalizeItem).filter(Boolean)
} else if (typeof args === "object") {
  const norm = normalizeItem(args)
  runSpecs = norm ? [norm] : [{ type: "self-test", id: null }]
}

if (runSpecs.length === 0) {
  log("WARNING: No valid run specs from args — falling back to self-test.")
  runSpecs = [{ type: "self-test", id: null }]
}

log(`Run specs: ${runSpecs.length} item(s)`)
runSpecs.forEach((s, i) => log(`  [${i}] type=${s.type}${s.prompt ? ` prompt="${s.prompt.slice(0, 60)}..."` : ""}${s.path ? ` path=${s.path}` : ""}${s.id ? ` id=${s.id}` : ""}`))

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

// ── Phase 1: Generate (pipeline — each spec runs independently) ───────────────

const genResults = await pipeline(
  runSpecs,

  async (spec, _orig, idx) => {
    const cmd = buildCommand(spec)
    if (!cmd) {
      return { status: "error", outputPngs: [], runJsonPath: "", error: `Cannot build command for spec: ${JSON.stringify(spec)}` }
    }

    return agent(
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
  },
)

// ── Phase 2: VLM pre-flight check ────────────────────────────────────────────

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

// ── Phase 3: Review — Caption each PNG ───────────────────────────────────────

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
  allResults.forEach(r => { r.captions = [] })
} else {
  // Caption each genResult's PNGs (merged read-prompt + caption agent)
  const captionedResults = await pipeline(
    allResults.filter(r => r.genResult?.outputPngs?.length > 0),
    async (item, _orig, idx) => {
      const { genResult } = item

      log(`[${idx}] Captioning ${genResult.outputPngs.length} PNG(s)...`)

      const captions = await parallel(
        genResult.outputPngs.map((pngPath, pngIdx) => () => {
          const captionFile = `${pngPath}.caption.json`

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
      const idx = allResults.findIndex(r => r.genResult === captioned.genResult)
      if (idx >= 0) allResults[idx] = captioned
    }
  })
}

// ── Phase 4: Report ──────────────────────────────────────────────────────────

phase("Report")

const validResults = allResults.filter(Boolean)
const totalPngs    = validResults.reduce((n, r) => n + (r.genResult?.outputPngs?.length || 0), 0)
const totalCapped  = validResults.reduce((n, r) => n + (r.captions?.filter(c => c.overall != null).length || 0), 0)

log(`Summary: ${validResults.length}/${runSpecs.length} specs ran | ${totalPngs} PNG(s) generated | ${totalCapped} scored`)

const reportResult = await agent(
  `Generate a concise quality report for this T2I workflow run.

## Run Configuration (${runSpecs.length} spec(s))
${JSON.stringify(runSpecs, null, 2)}

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

**6. Errors** — if any generation failed or LM Studio was unavailable, briefly note it.

Keep the report concise. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)

log("=== T2I Run-and-Review Complete ===")
log(reportResult || "(no report)")

return {
  specs:   runSpecs,
  runs:    validResults,
  report:  reportResult,
}
