// Flux 2 Klein 9B Character Profile — FP8 vs FP16 Quality Comparison
//
// Runs both fp16 and fp8 variants with identical parameters (fixed seeds),
// collects VLM quality reviews via local VLM server, and produces a side-by-side
// comparison report (terminal + HTML) to help decide whether to migrate to fp8.
//
// Companion scripts (in scripts/):
//   flux2-klein-bench-vlm-review.py     — local VLM image quality review (Review phase)
//   flux2-klein-bench-compare-html.py   — HTML comparison report generator (Report HTML phase)
//   comfy_bench.py                      — workflow runner + metrics (Run phases)
//
// Phases:
//   Resolve      → detect absolute project root, derive all paths, get timestamp
//   Plan         → resolve args, set fixed comparison seeds
//   Setup        → ensure ComfyUI running
//   Run FP16     → run fp16 variant with fixed seeds
//   Run FP8      → run fp8 variant with same fixed seeds
//   Review       → local VLM review of all images (skips if VLM server down)
//   Compare      → quality/performance/disk deltas
//   Report       → structured comparison + migration recommendation
//   Report HTML  → generate comparison.html with side-by-side images
//
// Usage:
//   /flux2-klein-character-profile-bench                         — run both fp16 + fp8 comparison (default)
//   /flux2-klein-character-profile-bench --variant fp16          — run fp16 only (no comparison)
//   /flux2-klein-character-profile-bench --variant fp8           — run fp8 only (no comparison)
//   /flux2-klein-character-profile-bench --seeds 42,43,44        — custom fixed seeds
//   /flux2-klein-character-profile-bench --skip-review           — metrics only, no VLM
//   /flux2-klein-character-profile-bench --tag experiment1       — custom tag
//   /flux2-klein-character-profile-bench --mode sweep            — legacy iterative sweep mode

export const meta = {
  name: "flux2-klein-character-profile-bench",
  description: "FP8 vs FP16 quality comparison with VLM review for Flux 2 Klein character profile workflow",
  whenToUse: "Compare fp8 vs fp16 quality, performance, and disk usage to decide on migration",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root, get timestamp" },
    { title: "Plan", detail: "Set fixed comparison seeds, resolve args" },
    { title: "Setup", detail: "Ensure ComfyUI is running" },
    { title: "Run FP16", detail: "Run fp16 variant with fixed seeds" },
    { title: "Run FP8", detail: "Run fp8 variant with same fixed seeds" },
    { title: "Review", detail: "Local VLM analysis of all generated images" },
    { title: "Compare", detail: "Compute quality/performance/disk deltas" },
    { title: "Report", detail: "Structured comparison + migration recommendation" },
    { title: "Report HTML", detail: "Generate comparison.html with side-by-side images and metrics" },
    { title: "Persist", detail: "Write run history JSON to .claude/workflows/history/ for trend analysis" },
  ],
};

// ── Resolve phase: absolute paths ──────────────────────────────────────────────

phase("Resolve")

const PATH_SCHEMA = {
  type: "object",
  properties: {
    projectRoot: { type: "string", description: "Absolute path to the git project root" },
  },
  required: ["projectRoot"],
}

const pathResolution = await agent(
  `Detect the absolute path of the git project root for the video_generation ComfyUI project.

  Run: Bash("git rev-parse --show-toplevel")

  This returns the absolute path to the repository root.
  Return it as { projectRoot: "<the-path>" }.

  IMPORTANT: Return ONLY the JSON object. Normalize backslashes to forward slashes.`,
  { label: "resolve-paths", phase: "Resolve", model: "haiku", schema: PATH_SCHEMA },
)

const PROJECT_ROOT = (pathResolution?.projectRoot || "").replace(/\\/g, "/")
if (!PROJECT_ROOT) {
  log("ERROR: Could not resolve project root. Falling back to relative paths — agent commands may fail if CWD drifts.")
}

const PYTHON = PROJECT_ROOT ? `${PROJECT_ROOT}/ComfyUI/.venv/bin/python` : "ComfyUI/.venv/bin/python"
const BENCH_SCRIPT = PROJECT_ROOT ? `${PROJECT_ROOT}/scripts/comfy_bench.py` : "scripts/comfy_bench.py"
const _BENCH_HIST_DIR_ROOT = `${PROJECT_ROOT}/.claude/workflows/history/${meta.name}`
const BENCH_REFLECTION_FILE = `${_BENCH_HIST_DIR_ROOT}/reflection.json`
const BENCH_INDEX_FILE = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`
const BENCH_RESULTS_DIR = PROJECT_ROOT ? `${PROJECT_ROOT}/comfyui_data/output/bench_results` : "comfyui_data/output/bench_results"
const VLM_REVIEW_SCRIPT = PROJECT_ROOT ? `${PROJECT_ROOT}/scripts/flux2-klein-bench-vlm-review.py` : "scripts/flux2-klein-bench-vlm-review.py"
const COMPARE_HTML_SCRIPT = PROJECT_ROOT ? `${PROJECT_ROOT}/scripts/flux2-klein-bench-compare-html.py` : "scripts/flux2-klein-bench-compare-html.py"

// ── saveHistory — identical in every workflow; update _shared-patterns.md first ──
async function saveHistory(histDir, indexFile, entry, signals) {
  const histJson = JSON.stringify({ ...entry, signals }, null, 2)
  const runId = entry.run_id
  await agent(
    `Persist workflow history to disk.
1. Bash("mkdir -p '${histDir}'")
2. Write({ file_path: '${histDir}/${runId}.json', content: <histJson below> })
   ${histJson}
3. Bash("wc -c '${histDir}/${runId}.json' && echo written")
4. Bash("cd '${histDir}' && ls -t *.json 2>/dev/null | grep -v reflection | tail -n +16 | xargs rm -f 2>/dev/null")
Return { written: true }.`,
    { label: "persist-history", phase: "Persist", model: "haiku" },
  )
  await agent(
    `Update cross-workflow index at ${indexFile}.
1. Bash("cat '${indexFile}' 2>/dev/null || echo '[]'")
2. Parse JSON array. Append: ${JSON.stringify({ run_id: runId, workflow: entry.workflow, started_at: entry.started_at, run_quality: signals.run_quality, key_metric: signals.key_metric, highlights: signals.highlights })}
3. Keep only latest 50 entries (sort by run_id descending).
4. Write({ file_path: '${indexFile}', content: <updated array, 2-space indent> })
Return { updated: true }.`,
    { label: "update-index", phase: "Persist", model: "haiku" },
  )
}

log("Resolved paths:")
log(`  PROJECT_ROOT: ${PROJECT_ROOT || "(fallback: relative)"}`)
log(`  PYTHON:       ${PYTHON}`)
log(`  BENCH_SCRIPT: ${BENCH_SCRIPT}`)

// Get precise timestamp for unique output directory
const TIMESTAMP_SCHEMA = {
  type: "object",
  properties: { timestamp: { type: "string" } },
  required: ["timestamp"],
}

const timestampResult = await agent(
  `Run this command and return its output as a JSON object with key "timestamp":\ndate "+%Y-%m-%d_%H%M%S"`,
  { label: "get-timestamp", phase: "Resolve", model: "haiku", schema: TIMESTAMP_SCHEMA },
)

const resolvedTimestamp = timestampResult?.timestamp || ""

// ── Phase tracking ────────────────────────────────────────────────────────────
const phaseStatus = { resolve: "pending", plan: "pending", setup: "pending", runFp16: "pending", runFp8: "pending", review: "pending", compare: "pending", report: "pending", reportHtml: "pending", persist: "pending" }
const phasesCompleted = []
const phasesFailed = []
const filesTouched = new Set()
function markPhase(name, status) {
  phaseStatus[name] = status
  if (status === "completed") phasesCompleted.push(name)
  if (status === "failed") phasesFailed.push(name)
}
// ── Load benchmark reflection (score baselines from prior runs) ──────────────

let benchReflection = null
const benchReflectLoad = await agent(
  `Read the benchmark reflection file if it exists.
Run: Bash("cat '${BENCH_REFLECTION_FILE}' 2>/dev/null || echo '{}'")
Parse the JSON output. If it is '{}' or invalid, return { reflection: null }.
Otherwise return { reflection: <the parsed object> }.`,
  { label: "load-bench-reflection", phase: "Resolve", model: "haiku" },
)
benchReflection = benchReflectLoad?.reflection || null
if (benchReflection?.fp16_baseline || benchReflection?.fp8_baseline) {
  log(`Reflection: fp16 baseline=${benchReflection.fp16_baseline?.overall ?? "?"} fp8 baseline=${benchReflection.fp8_baseline?.overall ?? "?"} (${benchReflection.runs_analyzed || 0} runs)`)
  if (benchReflection.regression_alerts?.length) {
    benchReflection.regression_alerts.forEach((a) => log(`  ⚠️ ${a}`))
  }
} else {
  log("Reflection: no prior benchmark reflection.json — will create after this run")
}

markPhase("resolve", "completed")

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseBenchOutput(text) {
  // Try structured JSON block first
  const jsonStart = text.indexOf("=== JSON START ===");
  const jsonEnd = text.indexOf("=== JSON END ===");
  if (jsonStart !== -1 && jsonEnd !== -1) {
    try {
      const jsonStr = text.substring(jsonStart + "=== JSON START ===".length, jsonEnd).trim();
      return JSON.parse(jsonStr);
    } catch (_) {
      // Fall through to line parsing
    }
  }

  // Fallback: line-by-line parsing
  const lines = text.split("\n");
  const result = {};
  const images = [];
  let inImages = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("variant:")) result.variant = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("tag:")) result.tag = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("prompt_id:")) result.prompt_id = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("wall_time:")) result.wall_time = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("peak_rss:")) result.peak_rss = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("disk_output:")) result.disk_output = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("status:")) result.status = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("error:")) result.error = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("metrics_json:")) result.metrics_json = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed === "images:") { inImages = true; continue; }
    else if (trimmed === "=== END BENCH RUN ===") { inImages = false; continue; }
    else if (inImages && trimmed.startsWith("- ")) images.push(trimmed.slice(2));
  }

  result.images = images;
  return result;
}

function avgScore(reviews) {
  if (!reviews || !reviews.length) return 0;
  const sum = reviews.reduce((s, r) => s + (r.overall || 0), 0);
  return sum / reviews.length;
}

function avgScoresByDim(reviews) {
  if (!reviews || !reviews.length) return {};
  const dims = ["anatomy", "consistency", "quality", "background", "clothing", "overall"];
  const result = {};
  for (const d of dims) {
    result[d] = reviews.reduce((s, r) => s + (r[d] || 0), 0) / reviews.length;
  }
  return result;
}

function buildParamFlags(params) {
  if (!params) return "";
  return Object.entries(params)
    .map(([k, val]) => `--param ${k}=${val}`)
    .join(" ");
}

function parseFloatSafe(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && !isNaN(n) ? n : 0;
}

// ── Phase 1: Plan ──────────────────────────────────────────────────────────────

phase("Plan");

const tag = args?.tag || "";
const variant = typeof args === "string" ? args : (args?.variant || "both");
const skipReview = args?.skip_review || args?.skipReview || false;
const mode = args?.mode || "compare";
const forceRestart = args?.force_restart || args?.forceRestart || false;
const userParams = args?.params || null;

// Fixed seeds for fair comparison — same for both variants
const DEFAULT_SEEDS = { seed_front: 42, seed_back: 43, seed_side: 44 };
const userSeeds = args?.seeds || null;
const comparisonSeeds = userSeeds
  ? { seed_front: userSeeds[0], seed_back: userSeeds[1], seed_side: userSeeds[2] }
  : DEFAULT_SEEDS;

const now = args?.timestamp || resolvedTimestamp || "unknown";
const runTag = tag || `compare-${now}`;
const variantsToRun = variant === "both" ? ["fp16", "fp8"] : [variant];

const paramFlags = buildParamFlags({ ...comparisonSeeds, ...userParams });

log(`Mode: ${mode}`);
log(`Variants: ${variantsToRun.join(" + ")}`);
log(`Fixed seeds: ${JSON.stringify(comparisonSeeds)}`);
log(`Extra params: ${userParams ? JSON.stringify(userParams) : "none"}`);

// ── Phase 2: Setup ────────────────────────────────────────────────────────────

markPhase("plan", "completed")
phase("Setup");

const statusResult = await agent(
  `Run this command and report the output:\n${PYTHON} ${BENCH_SCRIPT} status`,
  { label: "check-comfyui", phase: "Setup", schema: {
    type: "object",
    properties: {
      running: { type: "boolean" },
      output: { type: "string" },
    },
    required: ["running", "output"],
  }}
);

if (!statusResult.running) {
  log("ComfyUI not running — starting it...");
  await agent(
    `Run this command and wait for it to complete:\n${PYTHON} ${BENCH_SCRIPT} start`,
    { label: "start-comfyui", phase: "Setup" }
  );
  log("ComfyUI started");
} else {
  log("ComfyUI already running — reusing existing instance");
}

// ── Run each variant sequentially ─────────────────────────────────────────────

markPhase("setup", "completed")
const runResults = {};

for (const v of variantsToRun) {
  const phaseLabel = v === "fp16" ? "Run FP16" : "Run FP8";
  phase(phaseLabel);

  const variantTag = `${runTag}/${v}`;
  log(`Running ${v} with fixed seeds: ${JSON.stringify(comparisonSeeds)}`);

  const runOutput = await agent(
    `Run this exact command and return ALL of its stdout output verbatim:\n` +
    `${PYTHON} ${BENCH_SCRIPT} run --workflow ${v} --tag "${variantTag}" --json${forceRestart ? " --force-restart" : ""}${paramFlags ? " " + paramFlags : ""}`,
    { label: `run-${v}`, phase: phaseLabel }
  );

  const parsed = parseBenchOutput(runOutput);
  runResults[v] = {
    variant: v,
    ...parsed,
    reviews: [],
  };

  const status = parsed.status || "unknown";
  const wt = parsed.wall_time || "?";
  log(`${v}: ${status} in ${wt}s, ${parsed.images?.length || 0} images`);

  if (parsed.error) {
    log(`ERROR: ${parsed.error}`);
  }
  markPhase(v === "fp16" ? "runFp16" : "runFp8", "completed")
}

// ── Phase: Review (local VLM) ──────────────────────────────────────────────────

if (skipReview) {
  log("Skipping VLM review (--skip-review)");
} else {
  phase("Review");

  for (const v of variantsToRun) {
    const r = runResults[v];
    if (!r.images?.length) {
      log(`No images to review for ${v}`);
      continue;
    }

    // Determine the image directory from metrics_json path
    const metricsDir = r.metrics_json ? r.metrics_json.replace(/\/metrics\.json$/, "") : null;
    if (!metricsDir) {
      log(`No metrics directory found for ${v}, skipping review`);
      continue;
    }

    log(`Reviewing ${v} (${r.images.length} images) with local VLM...`);

    const reviewOutput = await agent(
      `Run this command and return ALL of its stdout output verbatim:\n` +
      `${PYTHON} ${VLM_REVIEW_SCRIPT} --batch-dir "${metricsDir}" --variant ${v}`,
      { label: `review-${v}`, phase: "Review" }
    );

    // Parse the JSON array of reviews from stdout
    try {
      const parsed = JSON.parse(reviewOutput);
      if (Array.isArray(parsed)) {
        r.reviews = parsed;
      } else if (parsed.status === "skipped") {
        log(`VLM review skipped: ${parsed.reason}`);
        r.reviews = [];
      } else {
        r.reviews = [parsed];
      }
    } catch (e) {
      log(`Warning: could not parse VLM review output for ${v}: ${e}`);
      r.reviews = [];
    }

    const score = avgScore(r.reviews);
    log(`${v} VLM review: avg score ${score.toFixed(1)}/10 (${r.reviews.length} images reviewed)`);
  }
}

// ── Phase: Compare ────────────────────────────────────────────────────────────

markPhase("review", "completed")
phase("Compare");

const qualityDeltas = {};
const performanceDeltas = {};

for (const v of variantsToRun) {
  const r = runResults[v];
  runResults[v].scores = avgScoresByDim(r.reviews);
}

// If both variants ran, compute deltas
if (variantsToRun.length === 2) {
  const fp16 = runResults["fp16"];
  const fp8 = runResults["fp8"];

  if (fp16 && fp8) {
    const fp16Scores = fp16.scores || {};
    const fp8Scores = fp8.scores || {};

    log("Quality comparison:");
    log(`  ${"Dimension".padEnd(14)} | ${"FP16".padStart(5)} | ${"FP8".padStart(5)} | ${"Delta".padStart(6)}`);
    log(`  ${"─".repeat(14)}─┼─${"─".repeat(5)}─┼─${"─".repeat(5)}─┼─${"─".repeat(6)}`);

    for (const d of ["anatomy", "consistency", "quality", "background", "clothing", "overall"]) {
      const s16 = fp16Scores[d] || 0;
      const s8 = fp8Scores[d] || 0;
      const delta = Math.round((s8 - s16) * 100) / 100;
      qualityDeltas[d] = delta;
      const marker = d === "overall" ? "★" : " ";
      log(`  ${marker}${d.padEnd(13)} | ${s16.toFixed(1).padStart(5)} | ${s8.toFixed(1).padStart(5)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(1).padStart(5)}`);
    }

    const fp16Wall = parseFloatSafe(fp16.wall_time);
    const fp8Wall = parseFloatSafe(fp8.wall_time);
    const fp16Rss = parseFloatSafe(fp16.peak_rss);
    const fp8Rss = parseFloatSafe(fp8.peak_rss);

    performanceDeltas.wall_time = Math.round((fp8Wall - fp16Wall) * 100) / 100;
    performanceDeltas.peak_rss = Math.round((fp8Rss - fp16Rss) * 10) / 10;

    log("");
    log("Performance comparison:");
    log(`  Wall time:  fp16=${fp16Wall.toFixed(1)}s  fp8=${fp8Wall.toFixed(1)}s  delta=${performanceDeltas.wall_time >= 0 ? "+" : ""}${performanceDeltas.wall_time.toFixed(1)}s`);
    log(`  Peak RSS:   fp16=${fp16Rss.toFixed(0)}MB  fp8=${fp8Rss.toFixed(0)}MB  delta=${performanceDeltas.peak_rss >= 0 ? "+" : ""}${performanceDeltas.peak_rss}MB`);
    log("");
    log("Disk comparison:");
    log(`  Model:  fp16=17.0GB  fp8=8.8GB  savings=8.2GB (48%)`);
    log(`  (Note: first fp8 run may be slower due to Metal kernel compilation)`);
  }
} else {
  // Single variant — just show scores
  const v = variantsToRun[0];
  const scores = runResults[v].scores || {};
  log(`${v} quality scores:`);
  for (const d of ["anatomy", "consistency", "quality", "background", "clothing", "overall"]) {
    log(`  ${d}: ${(scores[d] || 0).toFixed(1)}/10`);
  }
}

// ── Phase: Report ─────────────────────────────────────────────────────────────

markPhase("compare", "completed")
phase("Report");

log("");
log("=== FP8 vs FP16 COMPARISON REPORT ===");
log(`Run tag: ${runTag}`);
log(`Seeds: ${JSON.stringify(comparisonSeeds)}`);
log(`Extra params: ${userParams ? JSON.stringify(userParams) : "none"}`);
log("");

if (variantsToRun.length === 2) {
  const fp16 = runResults["fp16"];
  const fp8 = runResults["fp8"];
  const overallDelta = qualityDeltas.overall || 0;
  const absDelta = Math.abs(overallDelta);

  log("Migration Assessment:");
  if (absDelta <= 0.3) {
    log(`  Quality difference is minimal (Δoverall=${overallDelta >= 0 ? "+" : ""}${overallDelta.toFixed(1)}).`);
    log(`  RECOMMENDATION: fp8 is a viable replacement — saves 8.2GB disk (48%).`);
  } else if (overallDelta > 0) {
    log(`  fp8 scores HIGHER than fp16 (Δoverall=+${overallDelta.toFixed(1)}).`);
    log(`  RECOMMENDATION: fp8 is equal or better — migrate with confidence.`);
  } else {
    log(`  fp8 scores LOWER than fp16 (Δoverall=${overallDelta.toFixed(1)}).`);
    log(`  RECOMMENDATION: quality loss may be noticeable. Evaluate if disk savings (48%) outweigh the difference.`);
  }

  log("");
  log("Details:");

  // Aggregate issues and strengths
  const fp16Issues = (fp16.reviews || []).flatMap(r => r.issues || []);
  const fp8Issues = (fp8.reviews || []).flatMap(r => r.issues || []);
  const fp16Strengths = (fp16.reviews || []).flatMap(r => r.strengths || []);
  const fp8Strengths = (fp8.reviews || []).flatMap(r => r.strengths || []);

  if (fp16Issues.length) log(`  fp16 issues: ${fp16Issues.join("; ")}`);
  if (fp8Issues.length) log(`  fp8 issues: ${fp8Issues.join("; ")}`);
  if (fp16Strengths.length) log(`  fp16 strengths: ${fp16Strengths.slice(0, 5).join("; ")}`);
  if (fp8Strengths.length) log(`  fp8 strengths: ${fp8Strengths.slice(0, 5).join("; ")}`);

  log("");
  log(`  fp16 images: ${(fp16.images || []).join(", ")}`);
  log(`  fp8 images:  ${(fp8.images || []).join(", ")}`);
} else {
  const v = variantsToRun[0];
  const r = runResults[v];
  log(`${v} summary:`);
  log(`  Status: ${r.status || "unknown"}`);
  log(`  Wall time: ${r.wall_time || "?"}s`);
  log(`  Avg score: ${avgScore(r.reviews).toFixed(1)}/10`);
  log(`  Images: ${(r.images || []).join(", ")}`);
}

log("");
log("=== END REPORT ===");

markPhase("report", "completed")

// ── Phase: Report HTML ─────────────────────────────────────────────────────────

if (variantsToRun.length === 2) {
  phase("Report HTML");

  log("Generating HTML comparison report...");
  const seedsStr = `${comparisonSeeds.seed_front},${comparisonSeeds.seed_back},${comparisonSeeds.seed_side}`;

  await agent(
    `Run this command:\n${PYTHON} ${COMPARE_HTML_SCRIPT} --run-dir "${BENCH_RESULTS_DIR}/${runTag}" --seeds "${seedsStr}"`,
    { label: "generate-html", phase: "Report HTML" }
  );

  log(`HTML report: ${BENCH_RESULTS_DIR}/${runTag}/comparison.html`);
  log(`Open with:  open "${BENCH_RESULTS_DIR}/${runTag}/comparison.html"`);
}

// ── Return structured result ──────────────────────────────────────────────────

const returnResult = { mode: "compare", runTag, seeds: comparisonSeeds, params: userParams };

for (const v of variantsToRun) {
  const r = runResults[v];
  returnResult[v === "fp16" ? "fp16" : "fp8"] = {
    status: r.status,
    wallTime: r.wall_time,
    peakRss: r.peak_rss,
    images: r.images,
    scores: r.scores,
    avgOverall: avgScore(r.reviews),
  };
}

if (variantsToRun.length === 2) {
  returnResult.deltas = {
    quality: qualityDeltas,
    performance: performanceDeltas,
    modelSize: { fp16_gb: 17, fp8_gb: 8.8, savings_gb: 8.2, savings_pct: 48 },
  };
}

// ── Persist — write run history ──────────────────────────────────────────────
markPhase("reportHtml", "completed")
phase("Persist")
const _bench_RUN_TS = (resolvedTimestamp || "unknown").trim()
const _bench_HIST_DIR = _BENCH_HIST_DIR_ROOT

const fp8AvgScore = returnResult.fp8?.avgOverall ?? null
const fp16AvgScore = returnResult.fp16?.avgOverall ?? null

const benchDelta = benchReflection?.fp8_baseline
  ? {
      fp8_delta: +((fp8AvgScore || 0) - (benchReflection.fp8_baseline.overall || 0)).toFixed(2),
      fp16_delta: +((fp16AvgScore || 0) - (benchReflection.fp16_baseline?.overall || 0)).toFixed(2),
      regression: (fp8AvgScore || 0) < (benchReflection.fp8_baseline.overall || 0) - 0.5,
    }
  : null

const benchSignals = {
  run_quality: phasesFailed.length === 0 ? "good" : "degraded",
  key_metric: fp8AvgScore ?? fp16AvgScore,
  delta_from_last: null,
  highlights: variantsToRun.length === 2
    ? [
        `fp16=${fp16AvgScore?.toFixed(1) ?? "?"} fp8=${fp8AvgScore?.toFixed(1) ?? "?"} Δoverall=${qualityDeltas.overall != null ? qualityDeltas.overall.toFixed(1) : "N/A"}`,
        `Wall time: fp16=${returnResult.fp16?.wallTime ?? "?"}s fp8=${returnResult.fp8?.wallTime ?? "?"}s`,
      ]
    : [`${variantsToRun[0]} score=${(returnResult[variantsToRun[0]]?.avgOverall ?? 0).toFixed(1)}`],
  warnings: qualityDeltas.overall != null && qualityDeltas.overall < -0.5
    ? [`fp8 quality regression: Δoverall=${qualityDeltas.overall.toFixed(1)}`]
    : [],
}

const _bench_histEntry = {
  schema_version: 1, run_id: _bench_RUN_TS, workflow: meta.name, started_at: _bench_RUN_TS,
  args: args,
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  result: {
    mode: returnResult.mode || "compare",
    runTag: returnResult.runTag || "",
    fp16AvgScore,
    fp8AvgScore,
    qualityDeltas: returnResult.deltas?.quality || null,
    score_delta_from_last: benchDelta,
  },
}

await saveHistory(_bench_HIST_DIR, BENCH_INDEX_FILE, _bench_histEntry, benchSignals)

// ── Synthesize benchmark reflection ─────────────────────────────────────────

const BENCH_REFLECT_SCHEMA = {
  type: "object",
  properties: {
    fp16_baseline: { type: "object", properties: { overall: { type: "number" }, runs: { type: "number" } }, required: ["overall", "runs"] },
    fp8_baseline: { type: "object", properties: { overall: { type: "number" }, runs: { type: "number" } }, required: ["overall", "runs"] },
    fp8_degradation_pct: { type: "number" },
    regression_alerts: { type: "array", items: { type: "string" } },
    runs_analyzed: { type: "number" },
    updated_at: { type: "string" },
  },
  required: ["regression_alerts", "runs_analyzed", "updated_at"],
}

const benchReflectResult = await agent(
  `Synthesize a benchmark reflection from run history.
1. Bash("ls -t '${_bench_HIST_DIR}'/*.json 2>/dev/null | head -10")
2. Read up to 5 most recent files.
3. Compute rolling average fp16AvgScore and fp8AvgScore across runs (ignore nulls).
4. Compute fp8_degradation_pct = ((fp16_avg - fp8_avg) / fp16_avg * 100) if both available.
5. Flag regression_alerts: if current fp8AvgScore dropped > 0.5 vs fp8 rolling average.
6. Return with updated_at = "${_bench_RUN_TS}".`,
  { label: "synthesize-bench-reflection", phase: "Persist", model: "haiku", schema: BENCH_REFLECT_SCHEMA },
)

if (benchReflectResult) {
  await agent(
    `Write the benchmark reflection JSON.
Write({ file_path: '${BENCH_REFLECTION_FILE}', content: <json> })
Content: ${JSON.stringify(benchReflectResult, null, 2)}
Return { written: true }.`,
    { label: "write-bench-reflection", phase: "Persist", model: "haiku" },
  )
  log(`Reflection: updated ${BENCH_REFLECTION_FILE} (${benchReflectResult.runs_analyzed} run(s))`)
}

markPhase("persist", "completed")
log(`History: ${_bench_HIST_DIR}/${_bench_RUN_TS}.json`)

returnResult.history = { runId: _bench_RUN_TS, path: `${_bench_HIST_DIR}/${_bench_RUN_TS}.json` }
return returnResult;
