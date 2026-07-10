// lora-quality-gate — LoRA Scale Sweep + VLM Gate Review
//
// Standalone workflow for diagnosing and validating LoRA quality at a given scale.
// Generates test images at multiple scales, scores each with the specialized
// `lora_quality` VLM style, determines the optimal scale, and gates PASS/FAIL.
//
// The `lora_quality` VLM style (in caption.py) specifically hunts for:
//   - Over-activation: watercolor wash, plastic skin, style bleed, texture loss
//   - Under-activation: invisible LoRA effect, missing trigger-word content
//   - Standard AI defects (from shared _DEFECT_BLOCK): hands, face, plasticky skin
//
// USAGE:
//   Workflow({ name: "lora-quality-gate", args: { lora: "nsfw-master" } })
//     → sweep default scales [0.3, 0.5, 0.65, 0.8, 1.0, 1.2], include baseline
//
//   Workflow({ name: "lora-quality-gate", args: {
//     lora: "z-image-asian-girl-2-2",
//     scales: [0.5, 0.7, 0.9, 1.1],
//     seed: 42,
//     steps: 9,
//   } })
//     → custom scales with fixed seed for apples-to-apples comparison
//
//   Workflow({ name: "lora-quality-gate", args: {
//     lora: "nsfw-master",
//     prompt: "a beautiful woman in casual clothing, photorealistic portrait",
//     updateManifest: true,
//   } })
//     → use custom prompt and write recommended_scale back to manifest on success
//
// ARGS:
//   lora             (required) LoRA name, e.g. "nsfw-master"
//   scales           (optional) float array, default [0.3, 0.5, 0.65, 0.8, 1.0, 1.2]
//   prompt           (optional) override test prompt (default: manifest.test_prompt)
//   seed             (optional) fixed seed for all variants (default: 42)
//   steps            (optional) inference steps (default: 9)
//   includeBaseline  (optional) generate a no-LoRA reference image (default: true)
//   updateManifest   (optional) write optimal recommended_scale to manifest.json (default: false)
//   gpuWait          (optional) wait if GPU busy (default: true)
//   maxGpuWait       (optional) max GPU wait seconds (default: 1800)
//   lang             (optional) review HTML chrome language: "zh_TW" | "en" (default: "zh_TW")
//
// GATE LOGIC:
//   pass     → lora_quality gate="pass"   AND overall >= 7 AND artifacts >= 7
//   marginal → lora_quality gate="marginal" OR (pass criteria narrowly missed)
//   fail     → lora_quality gate="fail"   OR overall < 6 OR artifacts < 6
//
// OPTIMAL SCALE: scale with highest lora_activation score among "pass" gates,
//   tiebroken by artifacts then overall. Falls back to lowest-fail if no passes.

export const meta = {
  name: "lora-quality-gate",
  description: "LoRA scale sweep + VLM gate review: generate at multiple scales, score with lora_quality VLM style, find optimal scale, gate PASS/FAIL",
  whenToUse: "Diagnose LoRA quality issues. Run after importing a new LoRA or when image quality regressions are suspected. Sweeps scales and gates on over/under-activation.",
  phases: [
    { title: "Resolve",    detail: "Detect project root and locate LoRA manifest" },
    { title: "Knowledge",  detail: "Load prior gate run knowledge for this LoRA" },
    { title: "GPU Wait",   detail: "Wait if another run.py process is using the GPU" },
    { title: "Generate",   detail: "Sequential scale sweep + optional baseline (GPU-safe)" },
    { title: "VLM Check",  detail: "Verify LM Studio is running before caption phase" },
    { title: "Gate Score", detail: "Score each variant with lora_quality VLM style (parallel)" },
    { title: "Analysis",   detail: "Rank scales, pick optimal, determine gate verdict" },
    { title: "Review HTML",detail: "Build A/B review HTML across scale variants" },
    { title: "Manifest",   detail: "Optional: write recommended_scale back to manifest.json" },
    { title: "Persist",    detail: "Save run history + extract knowledge for future runs" },
    { title: "Report",     detail: "Final gate verdict and scale recommendation" },
  ],
}

const _WF_NAME = "lora-quality-gate"

// ── Phase 0: Resolve ─────────────────────────────────────────────────────────

phase("Resolve")

const PATH_SCHEMA = {
  type: "object",
  properties: {
    projectRoot: { type: "string" },
    loraDir:     { type: "string", description: "Absolute path to the LoRA directory (models/lora/<name>)" },
    manifestPath:{ type: "string", description: "Absolute path to manifest.json, empty if missing" },
    manifest:    { type: "object", description: "Parsed manifest.json content, null if missing" },
  },
  required: ["projectRoot"],
}

// ── Args normalization ──────────────────────────────────────────────────────

let resolvedArgs = args
if (typeof resolvedArgs === "string") {
  try {
    const parsed = JSON.parse(resolvedArgs)
    if (typeof parsed === "object" && parsed !== null) resolvedArgs = parsed
  } catch {
    resolvedArgs = { lora: resolvedArgs }
  }
}
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x)
if (!isObj(resolvedArgs)) resolvedArgs = {}

const loraName      = (resolvedArgs.lora || "").trim()
const sweepScales   = Array.isArray(resolvedArgs.scales) && resolvedArgs.scales.length > 0
                        ? resolvedArgs.scales.map(Number)
                        : [0.3, 0.5, 0.65, 0.8, 1.0, 1.2]
const fixedSeed     = resolvedArgs.seed != null ? Number(resolvedArgs.seed) : 42
const inferSteps    = resolvedArgs.steps != null ? Number(resolvedArgs.steps) : 9
const includeBase   = resolvedArgs.includeBaseline !== false
const doUpdateMf    = resolvedArgs.updateManifest === true
const gpuWaitOn     = resolvedArgs.gpuWait !== false
const maxGpuWait    = resolvedArgs.maxGpuWait != null ? Number(resolvedArgs.maxGpuWait) : 1800
const wfLang        = typeof resolvedArgs.lang === "string" ? resolvedArgs.lang : "zh_TW"
const promptOverride= typeof resolvedArgs.prompt === "string" ? resolvedArgs.prompt : null

if (!loraName) {
  log("ERROR: args.lora is required (e.g. { lora: 'nsfw-master' }). Aborting.")
  return { error: "args.lora is required" }
}

log(`LoRA: ${loraName}`)
log(`Scales: [${sweepScales.join(", ")}]${includeBase ? " + baseline" : ""}`)
log(`Seed: ${fixedSeed}  Steps: ${inferSteps}`)

const pathResolution = await agent(
  `Locate the LoRA directory and manifest for "${loraName}".

1. Run: Bash("git rev-parse --show-toplevel")
   This gives PROJECT_ROOT.

2. The canonical LoRA store is in the parent of PROJECT_ROOT under video_generation__models:
   LORA_STORE="\${PROJECT_ROOT}/../video_generation__models/lora"
   Also check LOCAL: "\${PROJECT_ROOT}/python/mlx-movie-director/models/lora"
   Try both:
   Bash("ls '\${LORA_STORE}/${loraName}/' 2>/dev/null || echo MISSING")
   Bash("ls '\${PROJECT_ROOT}/python/mlx-movie-director/models/lora/${loraName}/' 2>/dev/null || echo MISSING")

3. Use the first directory that exists as loraDir.

4. Read the manifest:
   Bash("cat '\${loraDir}/manifest.json' 2>/dev/null || echo __MISSING__")
   If not __MISSING__, parse as JSON and return it as manifest object.

5. Return:
   {
     projectRoot: "/abs/path",
     loraDir: "/abs/path/to/${loraName}" or "",
     manifestPath: "/abs/path/to/${loraName}/manifest.json" or "",
     manifest: { ...parsed JSON... } or null
   }`,
  { label: "resolve-lora", phase: "Resolve", tier: "small", schema: PATH_SCHEMA },
)

const PROJECT_ROOT  = (pathResolution?.projectRoot || "").replace(/\\/g, "/")
const LORA_DIR      = (pathResolution?.loraDir || "").replace(/\\/g, "/")
const MANIFEST_PATH = (pathResolution?.manifestPath || "").replace(/\\/g, "/")
const manifest      = pathResolution?.manifest || {}

if (!PROJECT_ROOT) {
  log("ERROR: Could not resolve project root. Aborting.")
  return { error: "project root resolution failed" }
}
if (!LORA_DIR) {
  log(`ERROR: LoRA directory not found for "${loraName}". Check models/lora/ or ../video_generation__models/lora/`)
  return { error: `LoRA "${loraName}" not found` }
}

const PYTHON  = `${PROJECT_ROOT}/python/venv/bin/python`
const RUN_PY  = `${PROJECT_ROOT}/python/mlx-movie-director/run.py`
const OUT_DIR = `${PROJECT_ROOT}/../video_generation__output`
const KB_FILE = `${PROJECT_ROOT}/.claude/workflows/${_WF_NAME}.knowledge.jsonl`
const HIST_DIR= `${PROJECT_ROOT}/.claude/workflows/history`
const IDX_FILE= `${PROJECT_ROOT}/.claude/workflows/history/index.json`

// Extract manifest fields for generation
const manifestRecommendedScale = manifest.recommended_scale != null ? Number(manifest.recommended_scale) : null
const manifestTestPrompt       = manifest.test_prompt || null
const manifestDescription      = manifest.description || loraName
const manifestTriggerWords     = Array.isArray(manifest.trigger_words) ? manifest.trigger_words : []
const manifestCompatible       = Array.isArray(manifest.compatible_with) ? manifest.compatible_with : []

// Determine generation prompt
let testPrompt = promptOverride || manifestTestPrompt
if (!testPrompt) {
  // Construct a generic portrait prompt with trigger words if available
  const tw = manifestTriggerWords.length > 0 ? manifestTriggerWords[0] + ", " : ""
  testPrompt = `${tw}a beautiful woman, photorealistic portrait, natural skin texture, soft lighting`
}

log(`Resolved: PROJECT_ROOT=${PROJECT_ROOT}`)
log(`  LORA_DIR: ${LORA_DIR}`)
log(`  manifest.recommended_scale: ${manifestRecommendedScale ?? "(not set)"}`)
log(`  test_prompt: "${testPrompt.slice(0, 80)}..."`)
log(`  trigger_words: [${manifestTriggerWords.join(", ")}]`)

// ── Knowledge loading helper ──────────────────────────────────────────────────

async function loadKnowledge(kbFile) {
  const load = await agent(
    `Load distilled workflow knowledge for injection into this run.
1. Bash("test -f '${kbFile}' && echo EXISTS || echo MISSING")
2. If MISSING → return { found: false, records: [], digest: "" }.
3. If EXISTS: Bash("cat '${kbFile}'")
4. Parse each non-empty line as JSON. Keep ONLY records where status === "active".
5. Build a compact digest (<= 800 chars), grouped by type:
   - AVOID/GOTCHA: "- AVOID: <title> — <detail>"
   - LEVER:        "- LEVER: <title>"
   - METRIC:       "- METRIC: <title>: <detail>"
   Truncate each detail to ~120 chars.
Return { found: true, records: <array>, digest: <string> }.`,
    { label: "load-knowledge", phase: "Knowledge", tier: "small",
      schema: { type: "object", properties: {
        found: { type: "boolean" },
        records: { type: "array", items: { type: "object" } },
        digest: { type: "string" },
      }, required: ["found", "digest"] } },
  )
  const n = Array.isArray(load?.records) ? load.records.length : 0
  log(`Knowledge: ${n} active record(s)${load?.digest ? "" : " (empty/new)"} ← ${kbFile}`)
  return load
}

// ── publishKnowledge — identical in every workflow; update _shared-patterns.md first ──
// Converges kbFile's records into the shared knowledge-graph vault via zk-ingest.
// Opt-in (PI_PUBLISH_KNOWLEDGE=1); best-effort (never throws, never fails the run).
async function publishKnowledge(kbFile, workflowName) {
  const vault = `${PROJECT_ROOT}/vaults_root/pi-agent-vault`
  const sourceLabel = `workflow-jsonl:${workflowName}`
  // Resolve the pi-agent-cli entry. Prefer the built dist binary when present
  // (production), fall back to the workspace source (dev) — both accept the
  // same zk-ingest subcommand.
  const cli = await agent(
    `Check PI_PUBLISH_KNOWLEDGE env var, then run the ingest CLI if enabled.
1. Bash("printenv PI_PUBLISH_KNOWLEDGE || echo 1")
   If "0", return { published: false, reason: "opt-out" }.
2. Bash("OB_VAULT_PATH='${vault}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-ingest '${kbFile}' --source-label '${sourceLabel}' 2>&1 | tail -20")
3. Report { published: <true iff output contains "created" or "unchanged" or "updated" with no "Error">, summary: <the tail output> }.`,
    { label: "publish-knowledge", phase: "Persist", tier: "big",
      schema: { type: "object", properties: {
        published: { type: "boolean" },
        summary: { type: "string" },
      }, required: ["published"] } },
  )
  if (cli?.published) log(`Knowledge: published → ${vault} (zk-ingest)`)
  else log(`WARNING: knowledge publish skipped/failed — run continues. ${(cli?.summary || "").slice(0, 160)}`)
  return cli
}

// ── Phase 1: Knowledge ───────────────────────────────────────────────────────

phase("Knowledge")
const kb = await loadKnowledge(KB_FILE)
const kbDigest = kb?.digest || ""
log(kbDigest ? `  Prior knowledge:\n${kbDigest}` : "  No prior knowledge for this LoRA.")

// ── Phase 2: GPU Wait ────────────────────────────────────────────────────────

const GPU_PROBE_SCHEMA = {
  type: "object",
  properties: { busy: { type: "boolean" }, pids: { type: "string" } },
  required: ["busy"],
}

if (gpuWaitOn) {
  phase("GPU Wait")
  const gpuCheck = await agent(
    `Check if any run.py generation process is currently using the GPU.
Run: Bash("pgrep -f 'run.py' || echo NONE")
If there are pids (not "NONE"), the GPU may be busy.
Return { busy: true, pids: "<pids>" } if busy, else { busy: false, pids: "" }.`,
    { label: "gpu-probe", phase: "GPU Wait", tier: "small", schema: GPU_PROBE_SCHEMA },
  )
  if (gpuCheck?.busy) {
    log(`GPU busy (pids: ${gpuCheck.pids}) — waiting up to ${maxGpuWait}s...`)
    const waitResult = await agent(
      `Wait until no run.py generation process is running (up to ${maxGpuWait} seconds).
Poll every 30s: Bash("pgrep -f 'run.py' || echo NONE")
Stop when output is "NONE" or ${maxGpuWait} seconds have elapsed.
Return { cleared: true } when clear, { cleared: false, elapsed: N } on timeout.`,
      { label: "gpu-wait", phase: "GPU Wait", tier: "small",
        schema: { type: "object", properties: { cleared: { type: "boolean" } }, required: ["cleared"] } },
    )
    log(waitResult?.cleared ? "GPU cleared — proceeding." : "GPU wait timed out — proceeding anyway.")
  } else {
    log("GPU idle — proceeding.")
  }
}

// ── Phase 3: Generate ─────────────────────────────────────────────────────────
// Sequential (one model process at a time, GPU-safe).

phase("Generate")

// Build the list of generation specs
const genSpecs = []
const loraPath = `${LORA_DIR}/${loraName}.safetensors`

// Baseline (no LoRA)
if (includeBase) {
  genSpecs.push({ label: "baseline (no LoRA)", scale: null, isBaseline: true })
}

// Scale sweep
for (const sc of sweepScales) {
  genSpecs.push({ label: `scale=${sc}`, scale: sc, isBaseline: false })
}

log(`Generating ${genSpecs.length} variant(s) sequentially...`)

const GEN_SCHEMA = {
  type: "object",
  properties: {
    status:      { type: "string", enum: ["success", "error"] },
    outputPng:   { type: "string", description: "Absolute path of the generated PNG" },
    error:       { type: "string" },
  },
  required: ["status"],
}

const generatedVariants = []  // { label, scale, isBaseline, pngPath }

for (const spec of genSpecs) {
  const safePrompt = testPrompt.replace(/'/g, "'\\''")
  let cmd = `${PYTHON} ${RUN_PY} t2i --prompt '${safePrompt}' --seed ${fixedSeed} --steps ${inferSteps} --json-summary`
  if (!spec.isBaseline) {
    cmd += ` --lora-path '${loraPath}' --lora-scale ${spec.scale}`
  }

  log(`  Generating: ${spec.label}`)
  const result = await agent(
    `Run a T2I generation command and capture the output PNG path.

COMMAND:
${cmd}

STEPS:
1. Bash("${cmd} 2>&1", timeout=180000)
   The command prints JSON_SUMMARY like:
   JSON_SUMMARY {"status":"ok","output_path":"/abs/path/image.png",...}
   Also look for "Saved: /abs/path/image.png" fallback lines.

2. If status=ok, extract output_path from JSON_SUMMARY.
   If JSON_SUMMARY missing, extract path from "Saved: ..." line.
   If no path found, status="error".

3. Confirm file exists: Bash("test -f '<output_path>' && echo EXISTS || echo MISSING")
   If MISSING, status="error".

Return { status: "success"|"error", outputPng: "/abs/path/image.png" or "", error: "..." }`,
    { label: `gen-${spec.isBaseline ? "baseline" : spec.scale}`, phase: "Generate", tier: "small", schema: GEN_SCHEMA },
  )

  if (result?.status === "success" && result?.outputPng) {
    generatedVariants.push({ ...spec, pngPath: result.outputPng })
    log(`    → ${result.outputPng}`)
  } else {
    log(`    FAILED: ${result?.error || "unknown error"}`)
    generatedVariants.push({ ...spec, pngPath: null })
  }
}

const successfulVariants = generatedVariants.filter((v) => v.pngPath)
log(`Generate complete: ${successfulVariants.length}/${genSpecs.length} succeeded.`)

if (successfulVariants.length === 0) {
  log("ERROR: No images generated. Aborting gate review.")
  return { error: "generation failed — no output images", lora: loraName }
}

// ── Phase 4: VLM Check ────────────────────────────────────────────────────────

phase("VLM Check")
const vlmCheckResult = await agent(
  `Check if LM Studio VLM is running and accessible.
Run: Bash("curl -s --max-time 5 http://localhost:1234/v1/models | python3 -c 'import sys,json; d=json.load(sys.stdin); print(\\"LOADED:\\" + str(len(d.get(\\"data\\",[])))) if d else print(\\"EMPTY\\")' 2>/dev/null || echo OFFLINE")
Return { online: true } if the output starts with "LOADED", else { online: false }.`,
  { label: "vlm-check", phase: "VLM Check", tier: "small",
    schema: { type: "object", properties: { online: { type: "boolean" } }, required: ["online"] } },
)
if (!vlmCheckResult?.online) {
  log("WARNING: LM Studio appears offline. Caption scores will likely fail.")
  log("  To start: open LM Studio and load qwen/qwen3-vl-4b")
}

// ── Phase 5: Gate Score ───────────────────────────────────────────────────────
// Run lora_quality VLM scoring in parallel (caption only, no GPU needed).

phase("Gate Score")

const GATE_SCORE_SCHEMA = {
  type: "object",
  properties: {
    overall:          { type: "number" },
    detail:           { type: "number" },
    artifacts:        { type: "number" },
    lora_activation:  { type: "number" },
    activation_level: { type: "string", enum: ["under", "correct", "over"] },
    gate:             { type: "string", enum: ["pass", "marginal", "fail"] },
    over_symptoms:    { type: "array", items: { type: "string" } },
    under_symptoms:   { type: "array", items: { type: "string" } },
    issues:           { type: "array", items: { type: "string" } },
    strengths:        { type: "array", items: { type: "string" } },
    summary:          { type: "string" },
    captionPath:      { type: "string" },
    vote_count:       { type: "number" },
    vote_agreement:   { type: "string" },
    all_lma_scores:   { type: "array", items: { type: "number" } },
    error:            { type: "string" },
  },
  required: ["gate", "activation_level"],
}

// Ensemble: 3 independent VLM votes per non-baseline variant → majority gate + median scores.
// Baseline always uses 1 vote (the answer is deterministic: lora_activation=1).
const ENSEMBLE_VOTES = 3

// Build a shared context snippet for VLM agents
const loraCtx = [
  `LoRA: ${loraName}`,
  `Description: ${manifestDescription}`,
  `Trigger words: [${manifestTriggerWords.join(", ") || "none"}]`,
  `Manifest recommended_scale: ${manifestRecommendedScale ?? "(not set)"}`,
  `Test prompt: "${testPrompt}"`,
].join("\n")

// Caption each variant with lora_quality style.
// Outer parallel: all variants run concurrently (VLM on CPU, safe).
// Inner loop: each non-baseline variant gets ENSEMBLE_VOTES sequential votes
//   (sequential because caption.py writes to the same .caption.json per image —
//   concurrent writes would race; sequential gives independent VLM evaluations).
const captionResults = await parallel(
  successfulVariants.map((v) => async () => {
    const pngPath = v.pngPath
    const captionPath = pngPath.replace(/\.[^./]+$/, "") + ".caption.json"
    const scaleStr = v.isBaseline ? "0" : String(v.scale)
    const loraNameArg = v.isBaseline ? "none (baseline)" : loraName
    const descArg = v.isBaseline
      ? "No LoRA applied — baseline reference image"
      : manifestDescription

    const captionCmd = `${PYTHON} ${RUN_PY} caption '${pngPath}' --style lora_quality --lang en`
      + ` --lora-name '${loraNameArg.replace(/'/g, "'\\''")}'`
      + ` --lora-description '${descArg.replace(/'/g, "'\\''")}'`
      + ` --lora-scale ${scaleStr}`

    const promptText = `Score an image with the lora_quality VLM style and parse the result.

CONTEXT:
${loraCtx}
Scale being evaluated: ${v.label}

COMMAND:
${captionCmd}

STEPS:
1. Bash("${captionCmd} 2>&1", timeout=120000)
2. After the command, read the caption JSON:
   Bash("cat '${captionPath}' 2>/dev/null || echo __MISSING__")
3. Parse the JSON. The lora_quality score is inside:
   data.styles.lora_quality.caption  (a JSON string or dict)
   Parse that nested caption (may be a JSON string inside the styles entry).
4. Extract fields: overall, detail, artifacts, lora_activation, activation_level,
   gate, over_symptoms, under_symptoms, issues, strengths, summary.
   For BASELINE images (scale=0 or "${v.isBaseline}": true): override these fields:
     activation_level="under", lora_activation=1, gate="fail"
   (No LoRA was applied — baseline can never be "correct" or "pass" on the LoRA gate.)

IMPORTANT: Enforce consistency between activation_level and lora_activation:
  - activation_level="under"   → lora_activation must be 1-4 (cap at 4 if VLM gave higher)
  - activation_level="correct" → lora_activation must be 6-10
  - activation_level="over"    → lora_activation must be 1-3 (cap at 3 if VLM gave higher)

IMPORTANT: The lora_quality prompt has these HARD CAPS inherited from _DEFECT_BLOCK:
  - plasticky/waxy skin → artifacts <= 5, detail <= 6, overall <= 7
  - wrong finger count → artifacts <= 4, overall <= 6
Apply these caps yourself if the VLM missed them.

Return the parsed score fields plus captionPath="${captionPath}".
If the command or parse fails, return { gate: "fail", activation_level: "under", error: "..." }.`

    const voteCount = v.isBaseline ? 1 : ENSEMBLE_VOTES
    const votes = []
    for (let vi = 0; vi < voteCount; vi++) {
      const result = await agent(
        promptText,
        { label: `score-${v.label}${voteCount > 1 ? `-v${vi + 1}` : ""}`, phase: "Gate Score", tier: "small", schema: GATE_SCORE_SCHEMA },
      )
      if (result) votes.push(result)
    }

    if (votes.length === 0) {
      return { variant: v, score: { gate: "fail", activation_level: "under", error: "all votes failed" } }
    }

    if (votes.length === 1) {
      return { variant: v, score: { ...votes[0], captionPath, vote_count: 1, vote_agreement: "1/1" } }
    }

    // Aggregate: majority gate + activation_level, median numeric scores
    const gateCounts = { pass: 0, marginal: 0, fail: 0 }
    const levelCounts = { under: 0, correct: 0, over: 0 }
    for (const vote of votes) {
      const g = vote.gate || "fail"
      const l = vote.activation_level || "under"
      gateCounts[g] = (gateCounts[g] || 0) + 1
      levelCounts[l] = (levelCounts[l] || 0) + 1
    }
    const majorityGate  = Object.entries(gateCounts).sort((a, b) => b[1] - a[1])[0][0]
    const majorityLevel = Object.entries(levelCounts).sort((a, b) => b[1] - a[1])[0][0]

    const medianOf = (key) => {
      const vals = votes.map((vote) => Number(vote[key]) || 0).filter((n) => n > 0).sort((a, b) => a - b)
      if (vals.length === 0) return 0
      const mid = Math.floor(vals.length / 2)
      return vals.length % 2 === 0 ? Math.round((vals[mid - 1] + vals[mid]) / 2) : vals[mid]
    }

    const agree = votes.filter((vote) => (vote.gate || "fail") === majorityGate).length
    const allLma = votes.map((vote) => Number(vote.lora_activation) || 0)

    return {
      variant: v,
      score: {
        gate: majorityGate,
        activation_level: majorityLevel,
        overall:          medianOf("overall"),
        detail:           medianOf("detail"),
        artifacts:        medianOf("artifacts"),
        lora_activation:  medianOf("lora_activation"),
        summary:    votes.find((vote) => vote.summary)?.summary || "",
        over_symptoms:  [...new Set(votes.flatMap((vote) => vote.over_symptoms  || []))],
        under_symptoms: [...new Set(votes.flatMap((vote) => vote.under_symptoms || []))],
        issues:    [...new Set(votes.flatMap((vote) => vote.issues    || []))],
        strengths: [...new Set(votes.flatMap((vote) => vote.strengths || []))],
        captionPath,
        vote_count:     votes.length,
        vote_agreement: `${agree}/${votes.length}`,
        all_lma_scores: allLma,
      },
    }
  })
)

const scoredVariants = captionResults
  .filter(Boolean)
  .map((r) => ({ ...r.variant, score: r.score }))

log(`Gate Score complete: ${scoredVariants.length} variant(s) scored.`)
for (const sv of scoredVariants) {
  const s = sv.score || {}
  log(`  ${sv.label.padEnd(20)} gate=${s.gate || "?"} activation=${s.activation_level || "?"} overall=${s.overall ?? "?"} artifacts=${s.artifacts ?? "?"} lora_act=${s.lora_activation ?? "?"}`)
  if (s.summary) log(`    "${s.summary}"`)
}

// ── Phase 6: Analysis ────────────────────────────────────────────────────────

phase("Analysis")

// Separate baseline from scale variants
const baselineResult = scoredVariants.find((v) => v.isBaseline)
const scaleResults   = scoredVariants.filter((v) => !v.isBaseline)

// Gate logic:
//   pass     → gate="pass" AND overall >= 7 AND artifacts >= 7 AND activation_level="correct"
//   marginal → gate="marginal" OR (activation_level="under" with marginal VLM gate)
//   fail     → gate="fail" OR overall < 6 OR artifacts < 6 OR activation_level="over"
//              OR (activation_level="under" AND VLM gate not marginal)
function gateVerdict(sv) {
  const s = sv.score || {}
  const g = s.gate || "fail"
  const activationLevel = s.activation_level || "under"
  const overall = Number(s.overall) || 0
  const artifacts = Number(s.artifacts) || 0
  // Over-activation always fails regardless of other scores
  if (activationLevel === "over") return "fail"
  // Numeric floor failures
  if (g === "fail" || overall < 6 || artifacts < 6) return "fail"
  // Under-activation: downgrade "pass" to "marginal", keep "marginal" as marginal
  if (activationLevel === "under") {
    return g === "marginal" ? "marginal" : "fail"
  }
  // Correct activation: full pass requires good overall + artifacts
  if (g === "pass" && overall >= 7 && artifacts >= 7) return "pass"
  return "marginal"
}

// Scoring key for finding optimal scale (higher = better)
function rankScore(sv) {
  const s = sv.score || {}
  const verdict = gateVerdict(sv)
  const tier = verdict === "pass" ? 2 : verdict === "marginal" ? 1 : 0
  const loraAct = Number(s.lora_activation) || 0
  const artifacts = Number(s.artifacts) || 0
  const overall = Number(s.overall) || 0
  return tier * 10000 + loraAct * 100 + artifacts * 10 + overall
}

const rankedScales = [...scaleResults].sort((a, b) => rankScore(b) - rankScore(a))
const optimalScale = rankedScales.length > 0 ? rankedScales[0] : null
const optimalScaleValue = optimalScale?.scale ?? null

// Overall gate verdict for the LoRA (does it have at least one passing scale?)
const passingScales   = scaleResults.filter((v) => gateVerdict(v) === "pass")
const marginalScales  = scaleResults.filter((v) => gateVerdict(v) === "marginal")
const failingScales   = scaleResults.filter((v) => gateVerdict(v) === "fail")
const overallGate     = passingScales.length > 0 ? "pass"
                      : marginalScales.length > 0 ? "marginal"
                      : "fail"

// Compare to manifest recommended_scale
const manifestScaleInSweep = manifestRecommendedScale != null
  ? scaleResults.find((v) => Math.abs(v.scale - manifestRecommendedScale) < 0.01) || null
  : null
const manifestScaleVerdict = manifestScaleInSweep ? gateVerdict(manifestScaleInSweep) : null
const recommendedScaleAligned = manifestRecommendedScale != null
  && optimalScaleValue != null
  && Math.abs(optimalScaleValue - manifestRecommendedScale) < 0.01

// Inconclusive detection: if ALL scale variants returned the same lora_activation score
// and it's suspiciously high (>=9), the VLM could not discriminate between scales.
// This often happens when the LoRA effect is invisible on SFW prompts or the test
// prompt doesn't trigger the LoRA's trained content.
const lmaValues = scaleResults.map((v) => Number(v.score?.lora_activation) || 0)
const isVlmInconclusive = scaleResults.length > 1
  && lmaValues.every((v) => v === lmaValues[0])
  && lmaValues[0] >= 9

log(`\nANALYSIS RESULTS:`)
log(`  Overall gate: ${overallGate}`)
log(`  Optimal scale: ${optimalScaleValue ?? "none"} (${optimalScale ? gateVerdict(optimalScale) : "?"})`)
log(`  Manifest recommended_scale: ${manifestRecommendedScale ?? "(not set)"}`)
log(`  Manifest scale verdict: ${manifestScaleVerdict ?? "(not in sweep)"}`)
log(`  Passing scales: [${passingScales.map((v) => v.scale).join(", ")}]`)
log(`  Marginal scales: [${marginalScales.map((v) => v.scale).join(", ")}]`)
log(`  Failing scales: [${failingScales.map((v) => v.scale).join(", ")}]`)

// Non-monotonicity check: large VLM score swings between adjacent scales signal noise.
// Real LoRA behavior may be non-monotonic near a threshold, but swings > 3 on lora_activation
// (e.g. scale=0.5→7, scale=0.65→1, scale=0.8→8) indicate VLM inconsistency.
const sortedByScale = [...scaleResults].sort((a, b) => (a.scale || 0) - (b.scale || 0))
const lmaSeq = sortedByScale.map((v) => Number(v.score?.lora_activation) || 0)
const hasLargeSwing = lmaSeq.some((val, i) => i > 0 && Math.abs(val - lmaSeq[i - 1]) > 3)
if (hasLargeSwing) {
  log(`  ⚠  Non-monotonic lora_activation: [${lmaSeq.join(" → ")}] — adjacent swing > 3 detected.`)
  log(`     With ${ENSEMBLE_VOTES}-vote ensemble this should improve. If it persists, try a different test prompt.`)
}

if (isVlmInconclusive) {
  log(`  ⚠  VLM INCONCLUSIVE: all scales scored lora_activation=${lmaValues[0]} — VLM cannot`)
  log(`     discriminate scale differences. Likely causes:`)
  log(`       1. Test prompt does not trigger the LoRA's trained style`)
  log(`       2. LoRA has negligible effect on SFW content at these scales`)
  log(`       3. VLM prompt still not strong enough for this LoRA type`)
  log(`     Consider: use --prompt with explicit trigger words from the LoRA manifest.`)
}
if (!recommendedScaleAligned && optimalScaleValue != null && !isVlmInconclusive) {
  log(`  ⚠  Optimal scale (${optimalScaleValue}) differs from manifest recommended_scale (${manifestRecommendedScale ?? "not set"})`)
}
if (baselineResult) {
  const bs = baselineResult.score || {}
  log(`  Baseline quality: overall=${bs.overall ?? "?"} artifacts=${bs.artifacts ?? "?"} (${bs.summary || ""})`)
}

// ── Phase 7: Review HTML ──────────────────────────────────────────────────────

phase("Review HTML")

// Build A/B manifest for caption --ab-manifest
const captionFiles = scoredVariants.map((v) => {
  const capPath = v.pngPath ? v.pngPath.replace(/\.[^./]+$/, "") + ".caption.json" : null
  return { variant: v, captionPath: capPath }
}).filter((x) => x.captionPath)

const reviewSets = []
// Set 1: baseline vs. all scale variants
if (captionFiles.length > 0) {
  reviewSets.push({
    name: `${loraName} — Scale Sweep`,
    prompt: testPrompt,
    guide: `Compare LoRA activation quality across scales. Look for: over-activation (watercolor wash, plastic skin), under-activation (no LoRA effect), and image quality. Optimal scale: ${optimalScaleValue ?? "TBD"}.`,
    variants: captionFiles.map((x) => ({ label: x.variant.label })),
    files: captionFiles.map((x) => x.captionPath),
  })
}

let reviewHtmlPath = ""
if (reviewSets.length > 0 && captionFiles.length > 0) {
  const abManifestJson = JSON.stringify({ lang: wfLang, sets: reviewSets }, null, 2)
  const abManifestPath = `${OUT_DIR}/lora_gate_ab_manifest.json`

  // Write manifest with verify + heredoc fallback
  const writeResult = await agent(
    `Write a JSON file reliably.
1. Bash("mkdir -p '${OUT_DIR}'")
2. Bash("rm -f '${abManifestPath}'")
3. Write({ file_path: '${abManifestPath}', content: <JSON below> }):
${abManifestJson}
4. Bash("test -s '${abManifestPath}' && echo OK || echo MISSING")
5. If MISSING: Bash("cat > '${abManifestPath}' <<'ABEOF'\\n${abManifestJson}\\nABEOF")
6. Bash("wc -c < '${abManifestPath}'")
Return { written: true, bytes: <number from wc> }.`,
    { label: "write-ab-manifest", phase: "Review HTML", tier: "small",
      schema: { type: "object", properties: { written: { type: "boolean" }, bytes: { type: "number" } }, required: ["bytes"] } },
  )

  if ((writeResult?.bytes || 0) > 0) {
    const htmlResult = await agent(
      `Build the multi-set A/B review HTML from a manifest JSON.
MANIFEST: ${abManifestPath}
1. Bash("${PYTHON} ${RUN_PY} caption --ab-manifest '${abManifestPath}' 2>&1", timeout=120000)
2. Parse stdout for "Review HTML: /abs/path/review_*.html" — extract the path.
Return { htmlPath: "/abs/path/..." or "", error: "" }.`,
      { label: "review-html", phase: "Review HTML", tier: "small",
        schema: { type: "object", properties: { htmlPath: { type: "string" }, error: { type: "string" } }, required: ["htmlPath"] } },
    )
    reviewHtmlPath = htmlResult?.htmlPath || ""
    if (reviewHtmlPath) {
      log(`Review HTML: ${reviewHtmlPath}`)
    } else {
      log(`Review HTML FAILED: ${htmlResult?.error || "unknown error"}`)
    }
  } else {
    log("Review HTML SKIPPED: ab_manifest write failed.")
  }
}

// ── Phase 8: Manifest Update (optional) ──────────────────────────────────────

phase("Manifest")

let manifestUpdated = false
if (doUpdateMf && optimalScaleValue != null && MANIFEST_PATH && !recommendedScaleAligned) {
  log(`Updating manifest.json: recommended_scale → ${optimalScaleValue}`)
  const updateResult = await agent(
    `Update recommended_scale in a LoRA manifest.json.
MANIFEST: ${MANIFEST_PATH}
NEW VALUE: ${optimalScaleValue}

1. Bash("cat '${MANIFEST_PATH}'")
2. Parse JSON. Set manifest.recommended_scale = ${optimalScaleValue}.
3. Write back: Write({ file_path: '${MANIFEST_PATH}', content: <formatted JSON with 2-space indent> })
   NOTE: Write tool refuses to overwrite without prior Read — step 1 counts.
4. Bash("test -s '${MANIFEST_PATH}' && echo OK || echo MISSING")
5. Bash("cat '${MANIFEST_PATH}' | python3 -c \\"import sys,json; d=json.load(sys.stdin); print('scale:', d.get('recommended_scale'))\\" 2>&1")
Return { updated: true, newScale: ${optimalScaleValue} }.`,
    { label: "update-manifest", phase: "Manifest", tier: "small",
      schema: { type: "object", properties: { updated: { type: "boolean" }, newScale: { type: "number" } }, required: ["updated"] } },
  )
  manifestUpdated = updateResult?.updated || false
  if (manifestUpdated) {
    log(`Manifest updated: recommended_scale=${optimalScaleValue}`)
  } else {
    log("Manifest update FAILED — see above for errors.")
  }
} else if (!doUpdateMf) {
  log("Manifest update skipped (updateManifest=false).")
} else if (recommendedScaleAligned) {
  log(`Manifest already has recommended_scale=${manifestRecommendedScale} — no update needed.`)
} else if (!MANIFEST_PATH) {
  log("Manifest update skipped: no manifest.json found.")
}

// ── Phase 9: Persist ──────────────────────────────────────────────────────────

phase("Persist")

const runId = `${_WF_NAME}-${loraName}-${fixedSeed}`
const runEntry = {
  run_id: runId,
  workflow: _WF_NAME,
  started_at: runId,
  lora: loraName,
  sweep_scales: sweepScales,
  optimal_scale: optimalScaleValue,
  overall_gate: overallGate,
  manifest_recommended_scale: manifestRecommendedScale,
  recommended_scale_aligned: recommendedScaleAligned,
  passing_scales: passingScales.map((v) => v.scale),
  marginal_scales: marginalScales.map((v) => v.scale),
  failing_scales: failingScales.map((v) => v.scale),
  review_html: reviewHtmlPath,
  variants: scoredVariants.map((v) => ({
    label: v.label,
    scale: v.scale,
    isBaseline: v.isBaseline,
    gate: v.score?.gate,
    activation_level: v.score?.activation_level,
    overall: v.score?.overall,
    artifacts: v.score?.artifacts,
    lora_activation: v.score?.lora_activation,
    summary: v.score?.summary,
  })),
}

const signals = {
  run_quality: overallGate,
  key_metric: `optimal_scale=${optimalScaleValue} gate=${overallGate}`,
  highlights: [
    `LoRA: ${loraName}`,
    `optimal scale: ${optimalScaleValue}`,
    `manifest recommended: ${manifestRecommendedScale ?? "none"}`,
    `passes: [${passingScales.map((v) => v.scale).join(", ")}]`,
    `fails: [${failingScales.map((v) => v.scale).join(", ")}]`,
  ],
}

const histJson = JSON.stringify({ ...runEntry, signals }, null, 2)
const histPath = `${HIST_DIR}/${_WF_NAME}-${loraName}.json`

await agent(
  `Persist workflow history to disk RELIABLY.
1. Bash("mkdir -p '${HIST_DIR}'")
2. Write({ file_path: '${histPath}', content: <JSON below> }):
${histJson}
3. Bash("test -s '${histPath}' && echo OK || echo MISSING")
4. If MISSING: Bash("cat > '${histPath}' <<'HIST_EOF'\\n${histJson}\\nHIST_EOF")
5. Bash("wc -c < '${histPath}'")
Return { written: true, bytes: <number> }.`,
  { label: "persist-history", phase: "Persist", tier: "small",
    schema: { type: "object", properties: { written: { type: "boolean" }, bytes: { type: "number" } }, required: ["bytes"] } },
)

// Extract knowledge from this run
await agent(
  `Distill durable knowledge from THIS lora-quality-gate run into the knowledge file.
KNOWLEDGE FILE: ${KB_FILE}
RUN DATA:
- LoRA: ${loraName}
- Sweep: [${sweepScales.join(", ")}]
- Optimal scale: ${optimalScaleValue}
- Overall gate: ${overallGate}
- Passing scales: [${passingScales.map((v) => v.scale).join(", ")}]
- Failing scales: [${failingScales.map((v) => v.scale).join(", ")}]
- Scale failure reasons:
${failingScales.map((v) => `  scale=${v.scale}: gate=${v.score?.gate} activation=${v.score?.activation_level} symptoms=[${(v.score?.over_symptoms || []).join("; ")}]`).join("\n")}

RECORD SCHEMA — every record MUST contain ONLY these top-level keys (any extra key,
including run-specific *_runN keys, triggers check-workflow-patterns.mjs drift = exit 1):
  id | type(metric|avoid|lever) | lora | value(metric only: optimal scale) |
  note(human finding; put the per-run pass/fail narrative HERE) |
  failing_scales(avoid only: array merged unique across ALL runs) |
  passing_scales(lever only: array merged unique across runs) |
  consistently_passing(lever only: scales passing in EVERY run) |
  evidence_count(int: gate runs contributing) | updated(ISO date)
NEVER emit run-specific top-level keys like failing_scales_run2 / passing_scales_run3 —
merge this run's scales into the stable failing_scales / passing_scales arrays above and
put the per-run narrative ("Run 3: passing=[...] failing=[...]") inside `note`.

STEPS:
1. Bash("test -f '${KB_FILE}' && cat '${KB_FILE}' || echo '__EMPTY__'")
2. Parse existing records (non-empty lines, each a JSON object with "id" and "status" fields).
3. For each durable insight from this run:
   - Optimal scale for "${loraName}" → id "scale:${loraName}" type "metric"
   - Failure pattern at high/low scales → id "pattern:${loraName}-scale-over/under" type "avoid"
   - Known passing range → id "lever:${loraName}-scale-range" type "lever"
   Update evidence counts if id matches existing; append new records otherwise.
4. Write the updated file (one JSON object per line, no array wrapper).
   Bash("rm -f '${KB_FILE}'") first to allow Write overwrite.
   Write({ file_path: '${KB_FILE}', content: <updated content> })
5. Bash("wc -l < '${KB_FILE}'")
Return { updated: true, total_lines: N }.`,
  { label: "extract-knowledge", phase: "Persist", tier: "big",
    schema: { type: "object", properties: { updated: { type: "boolean" }, total_lines: { type: "number" } }, required: ["updated"] } },
)

// Converge the just-written records into the shared knowledge graph (opt-in,
// best-effort). The loop that LEARNS also PUBLISHES.
await publishKnowledge(KB_FILE, _WF_NAME)

// ── Phase 10: Report ──────────────────────────────────────────────────────────

phase("Report")

const gateEmoji = overallGate === "pass" ? "✓ PASS" : overallGate === "marginal" ? "~ MARGINAL" : "✗ FAIL"
const scaleRecommendation = optimalScaleValue != null
  ? `Optimal scale: **${optimalScaleValue}**${manifestRecommendedScale != null && !recommendedScaleAligned ? ` (manifest says ${manifestRecommendedScale} — consider updating)` : ""}`
  : "No optimal scale found — all scales failed."

log(`\n${"=".repeat(60)}`)
log(`LORA QUALITY GATE REPORT: ${loraName}`)
log(`${"=".repeat(60)}`)
log(`Gate: ${gateEmoji}`)
log(scaleRecommendation)
log("")
log("Scale results:")
for (const sv of [...scaleResults].sort((a, b) => (a.scale ?? 0) - (b.scale ?? 0))) {
  const v = gateVerdict(sv)
  const s = sv.score || {}
  const icon = v === "pass" ? "PASS" : v === "marginal" ? "MRGL" : "FAIL"
  const conf = s.vote_agreement ? ` [${s.vote_agreement}]` : ""
  const lmaDetail = s.all_lma_scores && s.all_lma_scores.length > 1
    ? ` (votes: ${s.all_lma_scores.join(",")})`
    : ""
  log(`  scale=${String(sv.scale).padEnd(4)} [${icon}]${conf} overall=${s.overall ?? "?"} artifacts=${s.artifacts ?? "?"} lora_act=${s.lora_activation ?? "?"}${lmaDetail} activation=${s.activation_level ?? "?"} | ${s.summary || ""}`)
}
if (baselineResult) {
  const bs = baselineResult.score || {}
  log(`  baseline     overall=${bs.overall ?? "?"} artifacts=${bs.artifacts ?? "?"} | ${bs.summary || ""}`)
}
log("")
if (reviewHtmlPath) log(`Review HTML: ${reviewHtmlPath}`)
if (manifestUpdated) log(`Manifest updated: recommended_scale → ${optimalScaleValue}`)
if (isVlmInconclusive) {
  log(`⚠  VLM INCONCLUSIVE: all scales scored lora_activation=${lmaValues[0]}.`)
  log(`   Retry with explicit trigger words: --prompt "..." or --lora-name matching LoRA content.`)
}
log(`${"=".repeat(60)}`)

return {
  lora: loraName,
  gate: overallGate,
  optimalScale: optimalScaleValue,
  manifestRecommendedScale,
  recommendedScaleAligned,
  passingScales: passingScales.map((v) => v.scale),
  marginalScales: marginalScales.map((v) => v.scale),
  failingScales: failingScales.map((v) => v.scale),
  variants: runEntry.variants,
  reviewHtml: reviewHtmlPath,
  manifestUpdated,
  vlmInconclusive: isVlmInconclusive,
}
