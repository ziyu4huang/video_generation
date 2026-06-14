// mlx-movie-director-run-self-improve-image — Unified iterative T2I/I2I generation + VLM review + self-fix
//
// ONE workflow for BOTH text-to-image and image-to-image on GPU-limited Apple Silicon.
// Select the pipeline via the `kind` dimension: "t2i" (default) or "i2i".
//   - kind:"t2i" → run.py t2i (text-to-image; emits JSON_SUMMARY + <base>.manifest/run.json siblings)
//   - kind:"i2i" → run.py image i2i (image-to-image; Z-Image prints only "Saved:" lines;
//                  pipeline:"flux2-klein" routes through execute_generation like t2i)
//
// Loop:
//   1. Generation — run specs sequentially (one model process at a time, GPU-safe).
//   2. VLM review — auto-score each output via run.py caption --style review, or --style score
//      when no prompt is known (e.g. i2i self-test variations).
//   3. Self-Fix (optional, autoFix:true) — when best score < autoFixThreshold, auto-propose
//      parameter changes and re-run. A score-gate keeps a fix ONLY if it beats the baseline
//      (strict >); otherwise the fix output is dropped and originals are kept. BOTH kinds.
//   4. Review HTML — one multi-set A/B HTML via caption --ab-manifest, with per-image
//      reproducibility panels (models/LoRA/denoise) read from sibling <base>.manifest.json.
//      i2i Z-Image / i2i self-test have NO manifest siblings → panels gracefully absent.
//   5. Finalize — aggregate explicit caption JSONs into the review HTML (no generation).
//   6. Feedback — human exports feedback from the HTML; fed back into the next iteration.
//
// `kind` = the generation pipeline ("t2i"|"i2i", default "t2i"). `pipeline` = the MODEL
// pipeline ("zimage"|"flux2-klein"), identical to run.py --pipeline (no clash with kind).
//
// GENERATION (default kind:"t2i"):
//   Workflow({ scriptPath: ".../mlx-movie-director-run-self-improve-image.js" })
//     → t2i self-test (default: run.py t2i --self-test)
//   Workflow({ scriptPath: "...", args: "A moody portrait in soft lighting" })
//     → single T2I with prompt string
//   Workflow({ scriptPath: "...", args: { prompt:"...", pipeline:"flux2-klein", steps:4, seed:100 } })
//     → T2I with full config (pipeline here = MODEL: zimage|flux2-klein)
//   Workflow({ scriptPath: "...", args: { runs:[{prompt:"A",seed:1},{prompt:"A",seed:2}], feedback:"review_feedback.json" } })
//     → multi-spec generation + ingest prior human feedback (iteration N>1)
//   Workflow({ scriptPath: "...", args: ["output_20260610_194901.run.json"] })
//     → replay one or more previous run.json files (relative to output/ or absolute)
//
// GENERATION (kind:"i2i"):
//   Workflow({ scriptPath: "...", args: { kind:"i2i" } })
//     → i2i self-test (default: run.py image i2i --self-test, many variations)
//   Workflow({ scriptPath: "...", args: { kind:"i2i", mode:"debug" } })
//     → named i2i self-test mode (debug / cnet-pose / cnet-sweep / seed-sweep / ...)
//   Workflow({ scriptPath: "...", args: { kind:"i2i", specs:[{ input_image:"x.png", prompt:"oil painting", denoise_strength:0.6, seed:200, steps:9 }] } })
//     → explicit i2i config(s). pipeline:"flux2-klein" routes through execute_generation
//       (manifest/run.json siblings + JSON_SUMMARY → reproducibility panels populated).
//   Workflow({ scriptPath: "...", args: { kind:"i2i" } })            // bare string also works
//   Workflow({ scriptPath: "...", args: "debug" })                  //   treated as i2i mode under kind:"i2i"
//
// MULTI-SET A/B GENERATION — NAMED comparison sets, all bundled into ONE review HTML.
// Each set compares ONE variable across 2+ variants (sequential — GPU-safe). Gen mode
// AUTO-BUILDS the review HTML at the end (one <section> per set). { noHtml:true } skips it.
//   Workflow({ scriptPath: "...", args: { sets: [
//     { name: "SeedVR2 off/on", prompt: "...", variants: [
//         { pipeline:"zimage", steps:9, seed:100 },
//         { pipeline:"zimage", steps:9, seed:100, upscale:true, upscale_method:"seedvr2" } ] },
//     { name: "Steps 6 vs 9",   prompt: "...", variants: [ {steps:6}, {steps:9} ] }
//   ], feedback: "review_feedback.json" } })
//     → optional variant.label overrides the auto-derived label; set.prompt is shared by its
//       variants (and used as the caption --prompt).
//
// FINALIZE — skip generation; build the human-review HTML from explicit caption JSONs.
//   Workflow({ scriptPath: "...", args: { finalize: ["a.caption.json", "b.caption.json"] } })
//       → flat single-set HTML
//   Workflow({ scriptPath: "...", args: { finalize: [{ name:"off/on", files:["a.caption.json","b.caption.json"], variants:[{label:"A"},{label:"B"}] }] } })
//       → multi-set grouped HTML
//
// Gen config fields (all optional unless marked required):
//   t2i spec: prompt (required), pipeline (zimage|flux2-klein), steps, seed, width, height,
//             lora_path, lora_scale, draft, upscale, upscale_method (esrgan|seedvr2), count,
//             seed_start, variant (4b|9b), ab_test, quantize, transformer, flux2_model_path.
//   i2i spec: input_image (required), prompt, pipeline (zimage|flux2-klein), denoise_strength,
//             reference_image, controlnet_strength, preprocess_mode (canny|openpose), seed,
//             steps, cnet_active_steps.
//
// NOTE: caption.py writes <image>.caption.json (extension stripped), so paths returned
// in captionFiles are the real on-disk caption JSON paths — collect them and pass to finalize.

export const meta = {
  name: "mlx-movie-director-run-self-improve-image",
  description: "Unified iterative T2I/I2I generation + VLM review + self-fix: generate/caption sequentially (kind: t2i|i2i), score-gated self-fix, finalize an interactive review HTML with per-image reproducibility, ingest human feedback for the next iteration",
  whenToUse: "Test image quality iteratively under GPU limits. kind:\"t2i\" (default) or kind:\"i2i\" selects the pipeline. Generate runs return captionFiles to accumulate; finalize builds the human-review HTML; feedback drives the next run.",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root via git rev-parse — eliminates CWD drift" },
    { title: "Feedback", detail: "Optional — read exported human-feedback JSON and emit keep/change guidance for this iteration" },
    { title: "GPU Wait", detail: "Wait if another run.py generation is already using the GPU (pgrep probe)" },
    { title: "Generate", detail: "Execute specs sequentially (one model process at a time, GPU-safe) — t2i (--json-summary) or i2i (--self-test/explicit)" },
    { title: "VLM Check", detail: "Verify LM Studio is running before caption phase" },
    { title: "Review", detail: "Score each output PNG via run.py caption --style review (or score when no prompt is known)" },
    { title: "Self-Fix", detail: "Analyze score weaknesses, propose 1–2 fix specs, re-run and re-score, score-gated (autoFix:true only)" },
    { title: "Report", detail: "Summarize quality scores, self-fix outcome, and improvement recommendations" },
    { title: "Review HTML", detail: "Auto-build after gen (or finalize) — multi-set A/B HTML via caption --ab-manifest, with reproducibility panels" },
    { title: "Persist", detail: "Write run history JSON to .claude/workflows/history/ for trend analysis" },
  ],
}

// The Workflow runtime strips `export const meta` to extract metadata, leaving `meta`
// unbound in execution scope. Mirror the name here so the Persist phase can reference it.
const _WF_NAME = "mlx-movie-director-run-self-improve-image"

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
4. Remove the stale file first (the Write tool refuses to overwrite an existing file without a
   prior Read, silently leaving the old index without the new entry): Bash("rm -f '${indexFile}'")
5. Write({ file_path: '${indexFile}', content: <updated array, 2-space indent> })
6. Verify: Bash("test -s '${indexFile}' && echo OK || echo MISSING")
7. If MISSING, rewrite the index via a quoted heredoc with the same array content.
Return { updated: true }.`,
    { label: "update-index", phase: "Persist", model: "haiku" },
  )
}

// ── reliableWrite — write a JSON artifact with verify + heredoc fallback ──────
// Extracted from saveHistory's proven persist pattern (Write tool → test -s verify
// → quoted-heredoc fallback). Used for ab_manifest.json so a haiku agent fumbling a
// bare heredoc can't silently lose the file (prior failure mode: reported success,
// wrote nothing). Modeled on gui-movie-director-review-optimize.js commit 0444284.
async function reliableWrite(targetPath, jsonStr, label) {
  const dir = targetPath.slice(0, targetPath.lastIndexOf("/"))
  const result = await agent(
    `Write a JSON file to disk RELIABLY.
1. Bash("mkdir -p '${dir}'")
2. Remove any existing file first — the Write tool REFUSES to overwrite an existing file
   without a prior Read, which silently leaves STALE content on disk while test -s still
   passes (verified bug: review HTML rendered images from a prior run). Bash("rm -f '${targetPath}'")
3. Write the file with the Write tool: file_path='${targetPath}', content is the JSON below — paste it VERBATIM, do not summarize or truncate:
${jsonStr}
4. Verify it landed: Bash("test -s '${targetPath}' && echo OK || echo MISSING")
5. If step 4 printed MISSING, rewrite via a quoted heredoc (no expansion):
   Bash("cat > '${targetPath}' <<'WFWITE'
${jsonStr}
WFWITE")
6. Bash("wc -c < '${targetPath}'")
Return { written: true, bytes: <the number printed by wc> }.`,
    { label: label || "reliable-write", phase: "Review HTML", model: "haiku",
      schema: {
        type: "object",
        properties: {
          written: { type: "boolean" },
          bytes: { type: "number", description: "Byte count printed by wc -c" },
        },
        required: ["written", "bytes"],
      },
    },
  )
  const bytes = Number(result?.bytes) || 0
  log(bytes > 0 ? `reliableWrite: ${bytes} bytes → ${targetPath}` : `WARNING: reliableWrite verification FAILED (0 bytes) → ${targetPath}`)
  return bytes
}

log(`Resolved: PROJECT_ROOT=${PROJECT_ROOT}`)
log(`  PYTHON:  ${PYTHON}`)
log(`  RUN_PY:  ${RUN_PY}`)
log(`  OUT_DIR: ${OUT_DIR}`)

// ── Phase tracking ──────────────────────────────────────────────────────────
const phaseStatus = {
  resolve: "pending", feedback: "pending", gpuWait: "pending", generate: "pending",
  vlmCheck: "pending", review: "pending", selfFix: "pending",
  report: "pending", reviewHtml: "pending", persist: "pending",
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

// ── Helpers (pure JS — no agent needed) ──────────────────────────────────────

function resolveJsonPath(p) {
  return p.startsWith("/") ? p : `${OUT_DIR}/${p}`
}

// caption.py strips the image extension (os.path.splitext) → img.png writes img.caption.json
function captionPathFor(pngPath) {
  return pngPath.replace(/\.[^.\/]+$/, "") + ".caption.json"
}

// manifest.json sibling: img.png → img.manifest.json (per-RUN; same splitext pattern).
// Used to read the runtime events trace (models/LoRA/denoise) for the review HTML.
function manifestPathFor(pngPath) {
  return pngPath.replace(/\.[^.\/]+$/, "") + ".manifest.json"
}

function baseName(p) {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

// Human-readable label for what differs in an A/B variant config (e.g. "zimage · steps=9 · upscale=seedvr2 · seed=100")
function variantLabelFor(c) {
  const parts = []
  if (c.pipeline) parts.push(c.pipeline)
  if (c.steps != null) parts.push(`steps=${c.steps}`)
  parts.push(c.upscale ? `upscale=${c.upscale_method || "on"}` : "upscale=off")
  if (c.seed != null) parts.push(`seed=${c.seed}`)
  return parts.join(" · ") || "variant"
}

// Per-set "what to compare" guide, derived from the set NAME (clean / user-authored).
// Variant labels are a noisy signal — variantLabelFor always emits "upscale=…", so we only
// consult them (with that token stripped) when the name is generic. set.guide always wins.
function guideFor(set, lang) {
  if (typeof set.guide === "string" && set.guide.trim()) return set.guide
  const zh = lang === "zh_TW"
  const categorize = (text) => {
    const t = (text || "").toLowerCase()
    if (/(seedvr|esrgan|放大)/.test(t)) return "upscale"          // NOT bare "upscale" (=off default)
    if (/(step|步數)/.test(t)) return "steps"
    if (/(zimage|flux|klein|pipeline|管線)/.test(t)) return "pipeline"
    return ""
  }
  const TXT = {
    upscale:  zh ? "比較細節：毛孔、髮絲、布料紋理。用 2×/4× 放大看邊緣銳利度；放大器應讓細節更銳利。"
                 : "Compare fine detail: skin pores, hair, fabric texture. Use 2×/4× zoom on edges; the upscaler should sharpen detail.",
    steps:    zh ? "比較整體品質；較少步數是否明顯變糊或失去細節。"
                 : "Compare overall quality; does fewer steps visibly blur or lose detail?",
    pipeline: zh ? "比較風格、寫實度、膚色與光影。" : "Compare style, realism, skin tone and lighting.",
  }
  const fallback = zh ? "比較整體畫質與對 prompt 的忠實度。" : "Compare overall quality and prompt adherence."
  let cat = categorize(set.name)
  if (!cat) {
    const labels = (set.variants || []).map((v) => (v && v.label) || "").join(" ").replace(/upscale=off/gi, "")
    cat = categorize(labels)
  }
  return cat ? TXT[cat] : fallback
}

// Variant label for an i2i spec (no upscale dimension; key params are denoise/controlnet/preprocess)
function variantLabelForI2i(c) {
  const parts = ["i2i"]
  if (c.pipeline === "flux2-klein") parts.push("flux2-klein")
  if (c.denoise_strength != null) parts.push(`dn${c.denoise_strength}`)
  if (c.controlnet_strength != null) parts.push(`cnet${c.controlnet_strength}`)
  if (c.preprocess_mode) parts.push(c.preprocess_mode)
  if (c.steps != null) parts.push(`${c.steps}st`)
  if (c.seed != null) parts.push(`s${c.seed}`)
  return parts.join(" · ")
}

// i2i comparison guide (source identity / style transfer / pose match / artifacts)
function i2iGuide(set, lang) {
  if (typeof set.guide === "string" && set.guide.trim()) return set.guide
  const zh = lang === "zh_TW"
  return zh
    ? "比較 I2I 輸出品質：來源人物特徵保留、風格轉換程度、姿態匹配、偽影。"
    : "Compare I2I output quality: source identity preservation, style transfer, pose match, artifacts."
}

function normalizeItem(item, defaultKind) {
  const dk = defaultKind || "t2i"
  if (!item) return null
  if (typeof item === "string") {
    if (item.endsWith(".run.json") || item.endsWith(".json")) {
      return { type: "replay", kind: "t2i", path: resolveJsonPath(item) }
    }
    // Bare non-path string:
    //   defaultKind "i2i" → i2i self-test mode name; else → t2i prompt
    if (dk === "i2i") return { type: "self-test", kind: "i2i", id: item || null }
    return { type: "t2i", kind: "t2i", prompt: item }
  }
  if (typeof item === "object" && !Array.isArray(item)) {
    if (item.selfTest !== undefined) {
      const k = item.kind === "i2i" ? "i2i" : (item.kind === "t2i" ? "t2i" : dk)
      return { type: "self-test", kind: k, id: typeof item.selfTest === "string" ? item.selfTest : null }
    }
    // i2i explicit (input_image is the i2i discriminator); pipeline here = MODEL (zimage|flux2-klein)
    if (item.input_image) {
      return { ...item, type: "i2i", kind: "i2i" }
    }
    if (item.prompt) {
      return { ...item, type: "t2i", kind: "t2i" }
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

// `kind` selects the generation pipeline: "t2i" (default) or "i2i". `pipeline` stays the
// MODEL pipeline (zimage|flux2-klein), identical to run.py --pipeline — no clash with kind.
const defaultKind = (isObj(resolvedArgs) && resolvedArgs.kind === "i2i") ? "i2i" : "t2i"

// i2i legacy: {mode:"debug"} aliases selfTest (only under kind:"i2i", so a t2i prompt never
// collides — t2i has no `mode` field).
let argsForSpecs = resolvedArgs
if (isObj(resolvedArgs) && defaultKind === "i2i" && typeof resolvedArgs.mode === "string") {
  argsForSpecs = { ...resolvedArgs, selfTest: resolvedArgs.mode }
}

let mode = "gen"
let feedbackPath = ""
let htmlOutput = ""
let finalizeFiles = []
let runSpecs = []
let setsConfig = null        // [{name, prompt, variants:[config]}] — multi-set A/B
let jobMeta = []             // aligned with runSpecs: {setIdx, setName, setPrompt, kind, variantIdx, variantLabel}

if (isObj(argsForSpecs) && argsForSpecs.finalize != null) {
  mode = "finalize"
  const f = argsForSpecs.finalize
  finalizeFiles = Array.isArray(f) ? f : [f]   // keep objects (grouped sets) AND strings (flat)
  htmlOutput = typeof argsForSpecs.htmlOutput === "string" ? argsForSpecs.htmlOutput : ""
} else {
  // Generation mode — pull optional iteration-level feedback, then resolve run specs
  if (isObj(argsForSpecs) && typeof argsForSpecs.feedback === "string") {
    feedbackPath = argsForSpecs.feedback
  }
  if (isObj(argsForSpecs) && Array.isArray(argsForSpecs.sets)) {
    // Multi-set A/B: expand each set's variants into sequential jobs, tracking grouping
    setsConfig = argsForSpecs.sets
    runSpecs = []
    jobMeta = []
    setsConfig.forEach((s, si) => {
      const setName = s.name || `Set ${si + 1}`
      const setPrompt = s.prompt || ""
      const setKind = s.kind === "i2i" ? "i2i" : (s.kind === "t2i" ? "t2i" : defaultKind)
      ;(s.variants || []).forEach((v, vi) => {
        const cfg = { ...v }
        if (!cfg.prompt) cfg.prompt = setPrompt
        const norm = normalizeItem(cfg, setKind)
        if (!norm) return
        runSpecs.push(norm)
        jobMeta.push({
          setIdx: si,
          setName,
          setPrompt,
          kind: setKind,
          variantIdx: vi,
          variantLabel: typeof v.label === "string" && v.label ? v.label : variantLabelFor(v),
        })
      })
    })
  } else if (isObj(argsForSpecs) && Array.isArray(argsForSpecs.runs)) {
    runSpecs = argsForSpecs.runs.map((x) => normalizeItem(x, defaultKind)).filter(Boolean)
  } else if (isObj(argsForSpecs) && Array.isArray(argsForSpecs.specs)) {
    // i2i legacy: {kind:"i2i", specs:[{input_image,...}]} — normalize each
    runSpecs = argsForSpecs.specs.map((x) => normalizeItem(x, defaultKind)).filter(Boolean)
  } else if (!resolvedArgs) {
    runSpecs = [{ type: "self-test", kind: defaultKind, id: null }]
  } else if (typeof resolvedArgs === "string") {
    const norm = normalizeItem(resolvedArgs, defaultKind)
    runSpecs = norm ? [norm] : [{ type: "self-test", kind: defaultKind, id: null }]
  } else if (Array.isArray(resolvedArgs)) {
    runSpecs = resolvedArgs.map((x) => normalizeItem(x, defaultKind)).filter(Boolean)
  } else if (isObj(resolvedArgs)) {
    const norm = normalizeItem(argsForSpecs, defaultKind)
    runSpecs = norm ? [norm] : [{ type: "self-test", kind: defaultKind, id: null }]
  }
  if (runSpecs.length === 0) {
    log("WARNING: No valid run specs from args — falling back to self-test.")
    runSpecs = [{ type: "self-test", kind: defaultKind, id: null }]
  }
}

if (mode === "finalize") {
  const grouped = finalizeFiles.length > 0 && typeof finalizeFiles[0] === "object"
  log(`MODE: finalize — ${grouped ? `${finalizeFiles.length} set(s)` : `${finalizeFiles.length} caption JSON(s)`} to aggregate`)
  finalizeFiles.forEach((p, i) => log(`  [${i}] ${typeof p === "object" ? `${p.name || "set"}: ${JSON.stringify(p.files || [])}` : p}`))
} else {
  log(`MODE: generation — ${setsConfig ? `${setsConfig.length} set(s), ${runSpecs.length} variant(s)` : `${runSpecs.length} spec(s)`}${feedbackPath ? ` | feedback: ${feedbackPath}` : " | no feedback (first iteration)"}`)
  runSpecs.forEach((s, i) => {
    const meta = jobMeta[i] ? ` [${jobMeta[i].setName} / ${jobMeta[i].variantLabel}]` : ""
    log(`  [${i}] type=${s.type}${s.prompt ? ` prompt="${s.prompt.slice(0, 60)}..."` : ""}${s.path ? ` path=${s.path}` : ""}${s.id ? ` id=${s.id}` : ""}${meta}`)
  })
}

// Chrome language for the review HTML (zh_TW default; args.lang overrides).
// VLM caption CONTENT is unaffected (controlled by run.py caption --lang).
const wfLang = (isObj(resolvedArgs) && typeof resolvedArgs.lang === "string")
  ? resolvedArgs.lang : "zh_TW"

// GPU-gate config: before the Generate (GPU-requiring) phase, wait if another run.py
// generation is already using the Apple-Silicon GPU. Review/caption is NOT gated (LM Studio
// serves over HTTP on its own resources).
const gpuWaitOn = !(isObj(resolvedArgs) && resolvedArgs.gpuWait === false)
const maxGpuWait = (isObj(resolvedArgs) && typeof resolvedArgs.maxGpuWait === "number")
  ? resolvedArgs.maxGpuWait : 1800
const GPU_PROBE_SCHEMA = {
  type: "object",
  properties: { busy: { type: "boolean" }, pids: { type: "string" } },
  required: ["busy"],
}

// ── Shell command builder (pure JS) ─────────────────────────────────────────

function buildCommand(spec) {
  // SELF-TEST
  if (spec.type === "self-test") {
    const idFlag = spec.id ? ` ${spec.id}` : ""
    if (spec.kind === "i2i") {
      // i2i self-test: NO --json-summary (run_i2i early-returns to _run_self_test)
      return `${PYTHON} ${RUN_PY} image i2i --self-test${idFlag}`
    }
    return `${PYTHON} ${RUN_PY} t2i --self-test${idFlag} --json-summary`
  }

  if (spec.type === "replay") {
    return `${PYTHON} ${RUN_PY} replay '${spec.path}' --json-summary`
  }

  if (spec.type === "t2i") return buildT2iCommand(spec)
  if (spec.type === "i2i") return buildI2iExplicitCommand(spec)

  return null
}

function buildT2iCommand(spec) {
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

// i2i explicit spec → run.py image i2i --input-image ... [flags]. `pipeline` here is the
// MODEL (zimage|flux2-klein); flux2-klein routes through execute_generation (manifest/run.json
// siblings + JSON_SUMMARY), so it gets --json-summary and the Generate parser uses JSON_SUMMARY.
function buildI2iExplicitCommand(spec) {
  const safeInput = (spec.input_image || "").replace(/'/g, "'\\''")
  const safePrompt = (spec.prompt || "").replace(/'/g, "'\\''")
  let cmd = `${PYTHON} ${RUN_PY} image i2i --input-image '${safeInput}'`
  if (spec.prompt)                       cmd += ` --prompt '${safePrompt}'`
  if (spec.pipeline === "flux2-klein")   cmd += ` --pipeline flux2-klein`
  if (spec.denoise_strength != null)     cmd += ` --denoise-strength ${spec.denoise_strength}`
  if (spec.reference_image)              cmd += ` --reference-image '${spec.reference_image.replace(/'/g, "'\\''")}'`
  if (spec.controlnet_strength != null)  cmd += ` --controlnet-strength ${spec.controlnet_strength}`
  if (spec.preprocess_mode === "openpose") cmd += ` --skip-preprocess`
  if (spec.seed != null)                 cmd += ` --seed ${spec.seed}`
  if (spec.steps != null)                cmd += ` --steps ${spec.steps}`
  if (spec.cnet_active_steps != null)    cmd += ` --cnet-active-steps ${spec.cnet_active_steps}`
  if (spec.pipeline === "flux2-klein")   cmd += ` --json-summary`
  return cmd
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
    bestFilename: { type: "string", description: "Overall best filename (or first set's best); empty if none" },
    guidance:     { type: "string", description: "Concise keep/change guidance for the next iteration (per-set if grouped)" },
    sets: { type: "array", description: "Per-set feedback (grouped format)",
      items: { type: "object", properties: {
        name: { type: "string" }, bestFilename: { type: "string" }, guidance: { type: "string" },
        perImage: { type: "array", items: { type: "object", properties: { filename: { type: "string" }, variant: { type: "string" }, comment: { type: "string" } } } },
      } } },
    perImage:     { type: "array", description: "Flat fallback (legacy format)", items: { type: "object", properties: { filename: { type: "string" }, comment: { type: "string" } } } },
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

  const first = finalizeFiles[0]
  const grouped = first && typeof first === "object"

  // ── Grouped finalize: {finalize: [{name, files:[...], variants?:[{label}], prompt?}]} ──
  if (grouped) {
    const sets = finalizeFiles.map((s, si) => ({
      name: s.name || `Set ${si + 1}`,
      prompt: s.prompt || "",
      guide: guideFor(s, wfLang),
      variants: s.variants || [],
      files: (s.files || []).map(resolveJsonPath),
    }))
    // ── Enrich manifest with per-image reproducibility (events/models/argv from sibling manifests) ──
    const reproMap = {}
    const finalizeCapFiles = sets.flatMap((s) => s.files)
    for (const capPath of finalizeCapFiles) {
      const base = capPath.replace(/\.caption\.json$/, "")
      const manifestSibling = `${base}.manifest.json`
      const runSibling = `${base}.run.json`
      const rep = await agent(
        `Read a generation manifest.json + run.json, extract a COMPACT reproducibility summary.
MANIFEST: ${manifestSibling}
RUN.JSON: ${runSibling}
STEPS:
1. Bash("cat '${manifestSibling}' 2>/dev/null || echo MISSING") — if MISSING, return { reproducibility: null }.
2. Parse the manifest JSON. From the "events" array extract:
   - models: for each event where event=="model_loaded" AND target in ["transformer","text_encoder","vae"], format "<target>:<detail.dir> (<detail.quant or detail.backend>)"
   - lora: find the event where event=="lora_applied"; if present { name: target, scale: detail.user_scale, applied_count: detail.applied_count }, else null
   - denoise: find the event where event=="denoise_config"; { steps: detail.steps, img2img: detail.img2img, scheduler: detail.scheduler }
3. Bash("cat '${runSibling}' 2>/dev/null || echo MISSING") — if present, extract seed (number) and argv (string array).
4. Build { models: [...], lora: {...}|null, denoise: {...}, seed: <number>|null, argv: [...] }
Return JSON: { reproducibility: <that object or null> }.`,
        { label: `repro-${baseName(capPath)}`, phase: "Review HTML", model: "haiku",
          schema: { type: "object", properties: { reproducibility: { type: ["object", "null"] } }, required: ["reproducibility"] } },
      )
      if (rep?.reproducibility) reproMap[baseName(capPath)] = rep.reproducibility
    }
    log(`Reproducibility: enriched ${Object.keys(reproMap).length}/${finalizeCapFiles.length} image(s).`)

    const manifestJson = JSON.stringify({ lang: wfLang, sets, reproducibility: reproMap }, null, 2)
    const totalFiles = sets.reduce((n, s) => n + s.files.length, 0)
    log(`Building MULTI-SET review HTML — ${sets.length} set(s), ${totalFiles} image(s), lang=${wfLang}...`)

    // ── reliableWrite the manifest (verify + heredoc fallback), then build HTML in a focused agent ──
    const manifestPath = `${OUT_DIR}/ab_manifest.json`
    const wfBytes = await reliableWrite(manifestPath, manifestJson, "write-ab-manifest-finalize")
    let htmlResult = null
    if (wfBytes > 0) {
      htmlResult = await agent(
        `Build the multi-set A/B review HTML from a manifest JSON already on disk.

MANIFEST: ${manifestPath}

STEPS:
1. Bash("${PYTHON} ${RUN_PY} caption --ab-manifest '${manifestPath}' 2>&1", timeout=120000)
2. Parse stdout for a line: Review HTML: /abs/path/review_*.html — extract the absolute path after "Review HTML: ".
3. On error or missing line, set error to the stderr/stdout excerpt.

Return JSON: { "htmlPath": "/abs/path/review.html" or "", "imageCount": ${totalFiles}, "error": "" }`,
        { label: "review-html", phase: "Review HTML", schema: HTML_SCHEMA },
      )
    } else {
      htmlResult = { htmlPath: "", imageCount: totalFiles, error: "ab_manifest.json write failed (verified 0 bytes)" }
    }

    const reviewHtml = htmlResult?.htmlPath || ""
    log(htmlResult?.error ? `Review HTML FAILED: ${htmlResult.error}` : `Review HTML: ${reviewHtml}`)
    return { reviewHtml, imageCount: htmlResult?.imageCount ?? totalFiles, captionSets: sets, error: htmlResult?.error || "" }
  }

  // ── Flat finalize (legacy): {finalize: ["a.caption.json", "b.caption.json"]} ──
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

The file may be in one of two formats — handle BOTH:
- GROUPED (new, multi-set): { timestamp, sets: [{ name, prompt, best_image: <local idx|null>, images: [{ index, filename, variant, comment }] }] }
- FLAT (legacy, single-set): { timestamp, best_image: <idx|null>, images: [{ index, filename, comment }] }

STEPS:
1. Read the file: Bash("cat '${feedbackAbs}'")
   Detect format: if it has a top-level "sets" array → grouped; else flat.
   Each image entry's "filename" identifies which previously-generated image the comment refers to.

2. For images that have a comment, you MAY best-effort recall what produced them by reading the
   sibling caption JSON (it holds the VLM scores + the prior prompt):
   Bash("cat '${OUT_DIR}/<filename-without-extension>.caption.json'")   (skip silently if missing)

3. Synthesize concise GUIDANCE for this next iteration:
   - GROUPED: address EACH set — which variant (label/filename) the human picked as best, why
     (infer from comments + caption scores), and what to KEEP / CHANGE for that set's variable.
   - FLAT: best image overall + keep/change.
   - KEEP: prompt elements to preserve. CHANGE: concrete suggestions — prompt wording, seed,
     steps, upscale on/off + method, pipeline — derived from comments and score weaknesses.

Return JSON:
{
  "bestFilename": "<overall best filename, or first set's best; empty if none>",
  "guidance": "<concise bullet lines as one string; PER-SET if grouped (label each set)>",
  "sets": [{ "name": "...", "bestFilename": "...", "guidance": "...", "perImage": [{ "filename": "...", "variant": "...", "comment": "..." }] }],
  "perImage": [{ "filename": "...", "comment": "..." }],
  "error": ""
}`,
    { label: "feedback", phase: "Feedback", schema: FEEDBACK_SCHEMA },
  )

  feedbackGuidance = feedbackResult?.guidance || ""
  if (feedbackResult?.bestFilename) log(`  Human's best: ${feedbackResult.bestFilename}`)
  log(`  Guidance:\n${feedbackGuidance.split("\n").map((l) => "    " + l).join("\n")}`)
  markPhase("feedback", "completed")
} else {
  log("No feedback for this iteration (first iteration) — skipping Feedback phase.")
  markPhase("feedback", "skipped")
}

// ── Phase 1.5: GPU gate — wait if another run.py generation is already using the GPU ──
// Generate is the GPU-requiring phase (Review/caption uses LM Studio over HTTP — not gated).
if (mode !== "finalize" && gpuWaitOn) {
  phase("GPU Wait")
  log("GPU check before Generate (GPU-requiring phase)...")
  let gpudWaited = 0
  while (gpudWaited < maxGpuWait) {
    const probe = await agent(
      `Check whether any run.py generation process is currently running (using the GPU).

Run: Bash("pgrep -f 'run\\\\.py' || true")

Return JSON:
{ "busy": <true if pgrep printed any PID, else false>, "pids": "<the raw pgrep output>" }
NOTE: pgrep matches process command-lines; this detection command is "pgrep ..." so it will
NOT match itself. Only real run.py invocations match.`,
      { label: "gpu-probe", phase: "GPU Wait", model: "haiku", schema: GPU_PROBE_SCHEMA },
    )
    if (!probe?.busy) {
      log(gpudWaited > 0 ? `GPU free after waiting ${gpudWaited}s — proceeding to Generate.` : "GPU free — proceeding to Generate.")
      break
    }
    log(`GPU busy — another run.py is running (${(probe?.pids || "").trim().replace(/\\n/g, " ")}). Waiting 20s before recheck...`)
    await agent(`Sleep to let the GPU free up. Run: Bash("sleep 20"). Return { "ok": true }.`,
      { label: "gpu-sleep", phase: "GPU Wait", model: "haiku", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } })
    gpudWaited += 20
  }
  if (gpudWaited >= maxGpuWait) log(`WARNING: GPU still busy after ${maxGpuWait}s wait budget — proceeding anyway.`)
  markPhase("gpuWait", "completed")
} else if (mode !== "finalize") {
  log(`GPU gate SKIPPED (gpuWait:false). Generate is the GPU-requiring phase.`)
  markPhase("gpuWait", "skipped")
} else {
  markPhase("gpuWait", "skipped")   // finalize mode — no generation, no GPU work
}

// ── Phase 2: Generate (sequential — one model process at a time, GPU-safe) ───

phase("Generate")

const genResults = []
const genCache = {}   // cmd → result; identical A/B variant configs are generated ONCE (GPU-safe dedup)
for (let idx = 0; idx < runSpecs.length; idx++) {
  const spec = runSpecs[idx]
  const cmd = buildCommand(spec)
  if (!cmd) {
    log(`[${idx}] Cannot build command for spec — skipping.`)
    genResults.push({ status: "error", outputPngs: [], runJsonPath: "", error: `Cannot build command for spec: ${JSON.stringify(spec)}` })
    continue
  }
  if (genCache[cmd]) {
    log(`[${idx}/${runSpecs.length}] Identical config to an earlier variant — reusing its generation (GPU-safe skip).`)
    genResults.push({ ...genCache[cmd] })   // distinct object so the Review phase can merge per-idx
    continue
  }
  log(`[${idx}/${runSpecs.length}] Generating (${spec.type}${spec.kind && spec.kind !== "t2i" ? `/${spec.kind}` : ""}) — sequential, one model process at a time (GPU-safe)...`)

  try {
    // Output form depends on spec: t2i/replay/i2i-flux2-klein emit JSON_SUMMARY;
    // i2i self-test and Z-Image i2i print only "Saved:" lines.
    const expectJson = (spec.type === "t2i" || spec.type === "replay" ||
                        (spec.type === "i2i" && spec.pipeline === "flux2-klein"))
    const isI2iSelfTest = (spec.type === "self-test" && spec.kind === "i2i")
    const timeoutMs = isI2iSelfTest ? 1200000 : 600000   // i2i self-test: source + ref + N variations
    const parseInstr = expectJson
      ? `2. Parse the JSON_SUMMARY line from stdout. It looks like:
   JSON_SUMMARY:{"status":"success","run_json":"...","manifest_json":"...","outputs":["/path/to/img.png"]}
   Extract the JSON after "JSON_SUMMARY:" prefix → outputs[] (PNG paths) + run_json (run.json path).
3. If no JSON_SUMMARY line found, fall back: collect "Saved: " lines for PNG paths and
   "Run config: " for the run.json path (runJsonPath = "" if neither found).`
      : `2. This command prints "Saved: <path>.png" lines (NO JSON_SUMMARY).
   Collect EVERY line matching ^Saved: (.+\\.png)$ as an output PNG.
3. EXCLUDE any PNG whose filename contains "selftest_source" or "selftest_ref-pose"
   (i2i self-test source/reference artifacts — NOT outputs to review). runJsonPath = "".`

    const res = await agent(
      `Execute an image generation command and extract the output paths.

COMMAND:
${cmd}

STEPS — execute in order:

1. Run the generation command (timeout ${timeoutMs}ms — i2i self-test can run 15-25 min):
   Bash("${cmd} 2>&1", timeout=${timeoutMs})

   Capture the full stdout/stderr output.

${parseInstr}

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
    if (res?.status === "success") genCache[cmd] = res
  } catch (e) {
    log(`[${idx}] Generation agent failed: ${e?.message || e}`)
    genResults.push(null)
  }
}
markPhase("generate", "completed")

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
  markPhase("vlmCheck", "completed")
} else {
  log("VLM UNAVAILABLE — LM Studio not running at localhost:1234. Skipping Review phase.")
  log("Start LM Studio with a VLM model (e.g. qwen3-vl-4b) to enable scoring.")
  markPhase("vlmCheck", "skipped")
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
          const specPrompt = item.spec?.prompt || null

          return agent(
            `Score the image quality of a generated output using the VLM caption tool.

IMAGE PATH: ${pngPath}
SPEC PROMPT: ${specPrompt ? JSON.stringify(specPrompt) : "(none in spec)"}
RUN.JSON: ${genResult.runJsonPath || "(none)"}

STEPS:

1. Determine the prompt for this image:
   - Prefer the SPEC PROMPT above (set for t2i prompts and i2i explicit configs).
   - If no spec prompt, read run.json (if available): Bash("cat '${genResult.runJsonPath}'")
     and extract the "prompt" field.
   - Use the first available prompt; if none, prompt = null.

2. Caption style:
   - If prompt found: --style review --prompt '<safe_prompt>'
   - If no prompt (e.g. i2i self-test variations): --style score

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
markPhase("review", vlmAvailable ? "completed" : "skipped")

// ── Phase 4.5: Self-Fix (optional) ──────────────────────────────────────────

const autoFix = isObj(resolvedArgs) && resolvedArgs.autoFix === true
const autoFixThreshold = (isObj(resolvedArgs) && typeof resolvedArgs.autoFixThreshold === "number")
  ? resolvedArgs.autoFixThreshold : 6.0

let fixCaptions = []
let fixAnalysis = ""

if (autoFix && vlmAvailable && mode !== "finalize") {
  // Collect all scored captions from allResults
  const scoredCaptions = allResults
    .flatMap((r) => (r.captions || []).filter((c) => c.overall != null))
  const bestScore = scoredCaptions.reduce((best, c) => Math.max(best, c.overall || 0), 0)
  const worstCaptions = scoredCaptions.filter((c) => (c.overall || 0) < autoFixThreshold)

  if (worstCaptions.length > 0 && bestScore < autoFixThreshold) {
    phase("Self-Fix")
    log(`Self-Fix triggered: best overall=${bestScore.toFixed(1)} < threshold=${autoFixThreshold}. Analyzing ${worstCaptions.length} under-threshold output(s)...`)
    // ── Score baseline for regression gating ──
    // A fix output is KEPT only if it beats this baseline; a fix that regresses (or
    // merely ties) is dropped so self-fix can never make the review set worse. The
    // original higher-scoring outputs remain in allResults/captionFiles untouched.
    const globalBaseline = bestScore
    log(`Self-Fix gate active: fix must beat baseline ${globalBaseline.toFixed(1)} to be kept (strict >; ties dropped).`)

    const FIX_SCHEMA = {
      type: "object",
      properties: {
        fixSpecs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              rationale: { type: "string" },
              // t2i fix fields
              prompt: { type: "string" },
              seed: { type: "number" },
              steps: { type: "number" },
              pipeline: { type: "string" },
              // i2i fix fields
              input_image: { type: "string" },
              reference_image: { type: "string" },
              denoise_strength: { type: "number" },
              controlnet_strength: { type: "number" },
              preprocess_mode: { type: "string" },
              cnet_active_steps: { type: "number" },
            },
          },
        },
        analysis: { type: "string" },
      },
      required: ["fixSpecs", "analysis"],
    }

    // kind-aware self-fix: i2i fixes need input_image (source/ref for self-test runs);
    // t2i fixes need prompt. Default source/ref paths match _run_self_test's seed=42.
    const isI2i = (defaultKind === "i2i")
    const i2iSourceImg = isI2i && runSpecs[0]?.type === "self-test"
      ? `${OUT_DIR}/i2i_selftest_source-s42.png`
      : (runSpecs[0]?.input_image || "")
    const i2iRefImg = isI2i && runSpecs[0]?.type === "self-test"
      ? `${OUT_DIR}/i2i_selftest_ref-pose-s43.png`
      : (runSpecs[0]?.reference_image || "")

    const fixRules = isI2i
      ? `## Fix Rules (I2I pipeline)
- detail < 5 → increase steps by 5
- sharpness < 5 → lower denoise_strength by 0.1
- artifacts < 5 → lower controlnet_strength by 0.2 OR set cnet_active_steps: 8
- composition < 5 → try a different seed
- overall low across all dimensions → lower denoise_strength by 0.1 AND try a different seed
Each i2i fixSpec MUST include: label, rationale, input_image ("${i2iSourceImg}"), prompt (reuse
the worst-scoring output's prompt), and ONLY the fields that change. reference_image: "${i2iRefImg}" if pose guidance applies.`
      : `## Fix Rules (T2I pipeline)
- detail < 5 → increase steps by 3–5 (helps with fine texture rendering)
- sharpness < 5 → try a different seed (stochastic quality variation)
- composition < 5 → try a different seed
- prompt_adherence < 5 → strengthen the prompt with more specific style keywords
- overall low across all dimensions → increase steps by 5 AND try a different seed
- If the pipeline is "zimage" and steps < 9 → try steps: 9
- If the pipeline is "flux2-klein" and steps < 4 → try steps: 4
Each t2i fixSpec MUST include: label, rationale, prompt (reuse the worst-scoring output's prompt),
and ONLY the fields that change (seed, steps, pipeline).`

    const fixProposalResult = await agent(
      `Analyze ${isI2i ? "I2I" : "T2I"} quality scores and propose 1–2 targeted parameter fixes.

## Scored Outputs (below threshold ${autoFixThreshold})
${JSON.stringify(worstCaptions, null, 2)}

## All Scored Outputs (for context)
${JSON.stringify(scoredCaptions, null, 2)}

## Prior Feedback Guidance: ${feedbackGuidance || "(none)"}

${fixRules}

## Your Task
1. Identify the PRIMARY failure mode(s) from the scores.
2. Propose at most 2 concrete fix specs (label + rationale + the required fields above + only what changes).
3. Write a brief analysis of what failed and why these fixes should help.

Return JSON: { "fixSpecs": [...], "analysis": "..." }`,
      { label: "fix-analysis", phase: "Self-Fix", model: "sonnet", schema: FIX_SCHEMA },
    )

    fixAnalysis = fixProposalResult?.analysis || ""
    const fixSpecs = fixProposalResult?.fixSpecs || []
    log(`Self-Fix analysis: ${fixAnalysis}`)
    log(`Proposed ${fixSpecs.length} fix spec(s).`)

    // Run fix specs sequentially (GPU-safe)
    for (let fi = 0; fi < fixSpecs.length; fi++) {
      const spec = fixSpecs[fi]
      log(`[Fix ${fi + 1}/${fixSpecs.length}] Running "${spec.label}": ${spec.rationale}`)

      // kind-aware fix-command builder: i2i → buildI2iExplicitCommand, t2i → buildT2iCommand
      let fixCmd
      if (defaultKind === "i2i") {
        fixCmd = buildCommand({
          type: "i2i", kind: "i2i",
          input_image: spec.input_image || i2iSourceImg,
          reference_image: spec.reference_image || i2iRefImg || undefined,
          prompt: spec.prompt || runSpecs[0]?.prompt || "",
          denoise_strength: spec.denoise_strength,
          controlnet_strength: spec.controlnet_strength,
          preprocess_mode: spec.preprocess_mode,
          seed: spec.seed,
          steps: spec.steps,
          cnet_active_steps: spec.cnet_active_steps,
          pipeline: spec.pipeline || runSpecs[0]?.pipeline,
        })
      } else {
        fixCmd = buildCommand({
          type: "t2i", kind: "t2i",
          prompt: spec.prompt || runSpecs[0]?.prompt || "A high quality photograph",
          seed: spec.seed,
          steps: spec.steps,
          pipeline: spec.pipeline || runSpecs[0]?.pipeline,
        })
      }

      if (!fixCmd) {
        log(`[Fix ${fi + 1}] Cannot build command — skipping.`)
        continue
      }

      try {
        // i2i Z-Image fix prints "Saved:" lines (no JSON_SUMMARY); t2i/i2i-flux2-klein do.
        const fixExpectJson = !(defaultKind === "i2i" && spec.pipeline !== "flux2-klein")
        const fixParse = fixExpectJson
          ? `2. Parse stdout for the JSON_SUMMARY line → outputs[] + run_json. Fallback: "Saved: " lines + "Run config: ".`
          : `2. Collect EVERY "Saved: <path>.png" line; EXCLUDE filenames with selftest_source/selftest_ref-pose. runJsonPath="".`
        const fixGen = await agent(
          `Execute a fix generation command.

COMMAND: ${fixCmd}

STEPS:
1. Run: Bash("${fixCmd} 2>&1", timeout=600000)
${fixParse}
3. Return status and paths.

Return JSON: { "status": "success" or "error", "outputPngs": [...], "runJsonPath": "...", "error": "" }`,
          { label: `fix-gen-${fi}-${spec.label}`, phase: "Self-Fix", schema: GEN_SCHEMA },
        )

        const fixPngs = fixGen?.outputPngs || []
        log(`[Fix ${fi + 1}] Generated ${fixPngs.length} PNG(s). Scoring...`)

        // Score the fix output
        const fixScores = await parallel(
          fixPngs.map((pngPath, pi) => () =>
            agent(
              `Score the T2I fix output image.

IMAGE PATH: ${pngPath}

STEPS:
1. Bash("${PYTHON} ${RUN_PY} caption '${pngPath}' --style score --lang en 2>&1", timeout=120000)
2. Read: Bash("cat '${captionPathFor(pngPath)}'")
3. Parse outer JSON, double-parse the "caption" string field.

Return: { "imagePath": "${pngPath}", "overall": <1-10>, "detail": <1-10>, "sharpness": <1-10>, "composition": <1-10>, "artifacts": <1-10>, "summary": "...", "error": "" }`,
              { label: `fix-score-${fi}-${pi}`, phase: "Self-Fix", schema: CAPTION_SCHEMA },
            ),
          ),
        )

        const validScores = fixScores.filter(Boolean)
        const bestFix = validScores.reduce((b, c) => Math.max(b, c.overall || 0), 0)
        // ── Score-gate: keep fix outputs only if they BEAT the baseline ──
        // Self-fix re-generates with tweaked prompt/seed/steps; the output is a NEW
        // image, so the honest bar is "did it beat the best we already have?". A fix
        // that can't adds noise to the review HTML — drop it, keep originals untouched.
        const passed = bestFix > globalBaseline
        if (passed) {
          fixCaptions.push(...validScores)
          log(`[Fix ${fi + 1}/${fixSpecs.length}] "${spec.label}" → best overall=${bestFix.toFixed(1)} > baseline ${globalBaseline.toFixed(1)} ✓ KEPT`)
        } else {
          log(`[Fix ${fi + 1}/${fixSpecs.length}] "${spec.label}" → best overall=${bestFix.toFixed(1)} <= baseline ${globalBaseline.toFixed(1)} ✗ REGRESSED — dropping fix output (originals kept)`)
        }
      } catch (e) {
        log(`[Fix ${fi + 1}] Agent failed: ${e?.message || e}`)
      }
    }
    markPhase("selfFix", "completed")
  } else if (bestScore >= autoFixThreshold) {
    log(`Self-Fix skipped: best overall=${bestScore.toFixed(1)} >= threshold=${autoFixThreshold} — quality is acceptable.`)
    markPhase("selfFix", "skipped")
  } else {
    log("Self-Fix skipped: no below-threshold outputs to fix.")
    markPhase("selfFix", "skipped")
  }
} else if (mode === "finalize") {
  markPhase("selfFix", "skipped")
} else if (!autoFix) {
  markPhase("selfFix", "skipped")
} else if (!vlmAvailable) {
  log("Self-Fix skipped: VLM unavailable.")
  markPhase("selfFix", "skipped")
}

// ── Phase 5: Report ──────────────────────────────────────────────────────────

phase("Report")

const validResults = allResults.filter(Boolean)
const totalPngs    = validResults.reduce((n, r) => n + (r.genResult?.outputPngs?.length || 0), 0)
const totalCapped  = validResults.reduce((n, r) => n + (r.captions?.filter((c) => c.overall != null).length || 0), 0)

log(`Summary: ${validResults.length}/${runSpecs.length} specs ran | ${totalPngs} PNG(s) generated | ${totalCapped} scored`)

// Collect caption JSON paths + group them into A/B sets (aligned with jobMeta)
const captionFiles = []
const captionSetsMap = {}
validResults.forEach((r, idx) => {
  const specKind = (runSpecs[idx] && runSpecs[idx].kind) || defaultKind
  const meta = jobMeta[idx] || {
    setIdx: 0,
    setName: specKind === "i2i"
      ? ((runSpecs[idx] && runSpecs[idx].type === "self-test")
           ? `I2I Self-Test (${(runSpecs[idx] && runSpecs[idx].id) || "default"})`
           : "I2I Custom")
      : "Comparison",
    setPrompt: (runSpecs[idx] && runSpecs[idx].prompt) || "",
    kind: specKind,
    variantIdx: idx, variantLabel: "",
  }
  ;(r.captions || []).forEach((c) => {
    if (!c.imagePath) return
    const capPath = captionPathFor(c.imagePath)
    captionFiles.push(capPath)
    if (!captionSetsMap[meta.setIdx]) {
      captionSetsMap[meta.setIdx] = { name: meta.setName, prompt: meta.setPrompt, kind: meta.kind, variants: [], files: [] }
    }
    captionSetsMap[meta.setIdx].files.push(capPath)
    captionSetsMap[meta.setIdx].variants.push({ label: meta.variantLabel })
  })
})
const captionSets = Object.keys(captionSetsMap).sort((a, b) => Number(a) - Number(b)).map((k) => captionSetsMap[k])

const feedbackSection = feedbackGuidance
  ? `## Prior Iteration Feedback (guidance applied to this run)\n${feedbackGuidance}\n`
  : ""
const setsSection = setsConfig
  ? `## A/B Sets (${captionSets.length})\nEach set compares ONE variable across 2+ variants; variant labels show what differs.\n${JSON.stringify(captionSets, null, 2)}\n`
  : ""

const reportResult = await agent(
  `Generate a concise quality report for this ${defaultKind === "i2i" ? "I2I" : "T2I"} workflow run.

## Run Configuration (${runSpecs.length} spec(s))
${JSON.stringify(runSpecs, null, 2)}

${feedbackSection}${setsSection}
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
   If A/B sets are present above, give a PER-SET verdict (which variant won each comparison and why).

**6. Errors** — if any generation failed or LM Studio was unavailable, briefly note it.

Keep the report concise. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)
markPhase("report", "completed")

// ── Phase 6: Review HTML (auto-build — ONE HTML with all sets, for human feedback) ──
let reviewHtml = ""
const noHtml = isObj(resolvedArgs) && resolvedArgs.noHtml === true
if (captionFiles.length > 0 && !noHtml) {
  phase("Review HTML")
  const setsWithGuide = captionSets.map((s) => ({ ...s, guide: (s.kind === "i2i" ? i2iGuide(s, wfLang) : guideFor(s, wfLang)) }))
  // ── Enrich manifest with per-image reproducibility (events/models/argv from sibling manifests) ──
  const reproMap = {}
  for (const capPath of captionFiles) {
    const base = capPath.replace(/\.caption\.json$/, "")
    const manifestSibling = `${base}.manifest.json`
    const runSibling = `${base}.run.json`
    const rep = await agent(
      `Read a generation manifest.json + run.json, extract a COMPACT reproducibility summary.
MANIFEST: ${manifestSibling}
RUN.JSON: ${runSibling}
STEPS:
1. Bash("cat '${manifestSibling}' 2>/dev/null || echo MISSING") — if MISSING, return { reproducibility: null }.
2. Parse the manifest JSON. From the "events" array extract:
   - models: for each event where event=="model_loaded" AND target in ["transformer","text_encoder","vae"], format "<target>:<detail.dir> (<detail.quant or detail.backend>)"
   - lora: find the event where event=="lora_applied"; if present { name: target, scale: detail.user_scale, applied_count: detail.applied_count }, else null
   - denoise: find the event where event=="denoise_config"; { steps: detail.steps, img2img: detail.img2img, scheduler: detail.scheduler }
3. Bash("cat '${runSibling}' 2>/dev/null || echo MISSING") — if present, extract seed (number) and argv (string array).
4. Build { models: [...], lora: {...}|null, denoise: {...}, seed: <number>|null, argv: [...] }
Return JSON: { reproducibility: <that object or null> }.`,
      { label: `repro-${baseName(capPath)}`, phase: "Review HTML", model: "haiku",
        schema: { type: "object", properties: { reproducibility: { type: ["object", "null"] } }, required: ["reproducibility"] } },
    )
    if (rep?.reproducibility) reproMap[baseName(capPath)] = rep.reproducibility
  }
  log(`Reproducibility: enriched ${Object.keys(reproMap).length}/${captionFiles.length} image(s).`)

  const manifestJson = JSON.stringify({ lang: wfLang, sets: setsWithGuide, reproducibility: reproMap }, null, 2)
  log(`Building review HTML — ${captionSets.length} set(s), ${captionFiles.length} image(s), lang=${wfLang}...`)
  // ── reliableWrite the manifest (verify + heredoc fallback), then build HTML in a focused agent ──
  const manifestPath = `${OUT_DIR}/ab_manifest.json`
  const wfBytes = await reliableWrite(manifestPath, manifestJson, "write-ab-manifest-gen")
  let htmlResult = null
  if (wfBytes > 0) {
    htmlResult = await agent(
      `Build the multi-set A/B review HTML from a manifest JSON already on disk.

MANIFEST: ${manifestPath}

STEPS:
1. Bash("${PYTHON} ${RUN_PY} caption --ab-manifest '${manifestPath}' 2>&1", timeout=120000)
2. Parse stdout for: Review HTML: /abs/path/review_*.html — extract the absolute path.
3. On error or missing line, set error to the excerpt.

Return JSON: { "htmlPath": "/abs/path/review.html" or "", "imageCount": ${captionFiles.length}, "error": "" }`,
      { label: "review-html", phase: "Review HTML", schema: HTML_SCHEMA },
    )
  } else {
    htmlResult = { htmlPath: "", imageCount: captionFiles.length, error: "ab_manifest.json write failed (verified 0 bytes)" }
  }
  reviewHtml = htmlResult?.htmlPath || ""
  log(reviewHtml ? `Review HTML: ${reviewHtml}` : (htmlResult?.error ? `Review HTML FAILED: ${htmlResult.error}` : "Review HTML build failed."))
  markPhase("reviewHtml", reviewHtml ? "completed" : "skipped")
}

// ── Persist — write run history ──────────────────────────────────────────────
phase("Persist")
const _t2i_tsR = await agent(
  `Run: Bash("date -u '+%Y-%m-%dT%H-%M-%S'") and return { timestamp: "<exact output trimmed>" }.`,
  { label: "get-persist-ts", phase: "Persist", model: "haiku",
    schema: { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] } },
)
const _t2i_RUN_TS   = (_t2i_tsR?.timestamp || "unknown").trim()
const _t2i_HIST_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${_WF_NAME}`
const _t2i_INDEX_FILE = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`

const _t2i_signals = {
  run_quality: phasesFailed.length === 0 ? "good" : "degraded",
  key_metric: validResults.length,
  delta_from_last: null,
  highlights: [
    `${validResults.length} image(s) generated, ${captionFiles.length} captioned`,
    fixAnalysis ? "self-fix triggered" : "no issues detected",
    reviewHtml ? "review HTML built" : "no review HTML",
  ],
  warnings: phasesFailed.length > 0 ? [`${phasesFailed.length} phase(s) failed`] : [],
}

const _t2i_histEntry = {
  schema_version: 1, run_id: _t2i_RUN_TS, workflow: _WF_NAME, started_at: _t2i_RUN_TS,
  args: resolvedArgs,
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  result: { specCount: runSpecs.length, imageCount: validResults.length,
    captionCount: captionFiles.length, selfFix: !!fixAnalysis,
    fixCaptions: fixCaptions.length, reviewHtml: !!reviewHtml },
}

await saveHistory(_t2i_HIST_DIR, _t2i_INDEX_FILE, _t2i_histEntry, _t2i_signals)
markPhase("persist", "completed")
log(`History: ${_t2i_HIST_DIR}/${_t2i_RUN_TS}.json`)

log("=== T2I Run-and-Review Complete ===")
log(reportResult || "(no report)")
if (captionSets.length > 0) {
  log(`Caption JSONs produced this iteration (${captionSets.length} set(s)):`)
  captionSets.forEach((s) => log(`  [${s.name}] ${s.files.join(", ")}`))
}
if (reviewHtml) log(`Review HTML ready for human feedback: ${reviewHtml}`)

return {
  specs:           runSpecs,
  runs:            validResults,
  report:          reportResult,
  feedbackGuidance,
  captionFiles,
  captionSets,
  reviewHtml,
  history: { runId: _t2i_RUN_TS, path: `${_t2i_HIST_DIR}/${_t2i_RUN_TS}.json` },
}
