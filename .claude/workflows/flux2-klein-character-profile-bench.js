// Flux 2 Klein 9B Character Profile — FP8 vs FP16 Quality Comparison
//
// Runs both fp16 and fp8 variants with identical parameters (fixed seeds),
// collects VLM quality reviews, and produces a side-by-side comparison report
// to help decide whether to migrate to fp8 for disk/runtime savings.
//
// Phases:
//   Resolve   → detect absolute project root, derive all paths
//   Plan      → resolve args, set fixed comparison seeds
//   Setup     → ensure ComfyUI running
//   Run FP16  → run fp16 variant with fixed seeds
//   Run FP8   → run fp8 variant with same fixed seeds
//   Review    → parallel VLM review of all images
//   Compare   → quality/performance/disk deltas
//   Report    → structured comparison + migration recommendation
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
    { title: "Resolve", detail: "Detect absolute project root to eliminate CWD-dependent paths" },
    { title: "Plan", detail: "Set fixed comparison seeds, resolve args" },
    { title: "Setup", detail: "Ensure ComfyUI is running" },
    { title: "Run FP16", detail: "Run fp16 variant with fixed seeds" },
    { title: "Run FP8", detail: "Run fp8 variant with same fixed seeds" },
    { title: "Review", detail: "VLM analysis of all generated images" },
    { title: "Compare", detail: "Compute quality/performance/disk deltas" },
    { title: "Report", detail: "Structured comparison + migration recommendation" },
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
const BENCH_RESULTS_DIR = PROJECT_ROOT ? `${PROJECT_ROOT}/comfyui_data/output/bench_results` : "comfyui_data/output/bench_results"

log("Resolved paths:")
log(`  PROJECT_ROOT: ${PROJECT_ROOT || "(fallback: relative)"}`)
log(`  PYTHON:       ${PYTHON}`)
log(`  BENCH_SCRIPT: ${BENCH_SCRIPT}`)

// ── Review schema (shared across all VLM calls) ───────────────────────────────

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    anatomy: { type: "number", description: "Anatomical correctness 1-10" },
    consistency: { type: "number", description: "Character consistency 1-10" },
    quality: { type: "number", description: "Image quality 1-10" },
    background: { type: "number", description: "Background cleanliness 1-10" },
    clothing: { type: "number", description: "Clothing detail 1-10" },
    overall: { type: "number", description: "Overall score 1-10" },
    issues: { type: "array", items: { type: "string" }, description: "Issues found" },
    strengths: { type: "array", items: { type: "string" }, description: "Strengths observed" },
    summary: { type: "string", description: "Brief summary" },
  },
  required: ["anatomy", "consistency", "quality", "background", "clothing", "overall", "issues", "strengths", "summary"],
};

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

const now = args?.timestamp || "2026-06-06";
const runTag = tag || `compare-${now}`;
const variantsToRun = variant === "both" ? ["fp16", "fp8"] : [variant];

const paramFlags = buildParamFlags({ ...comparisonSeeds, ...userParams });

log(`Mode: ${mode}`);
log(`Variants: ${variantsToRun.join(" + ")}`);
log(`Fixed seeds: ${JSON.stringify(comparisonSeeds)}`);
log(`Extra params: ${userParams ? JSON.stringify(userParams) : "none"}`);

// ── Phase 2: Setup ────────────────────────────────────────────────────────────

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
}

// ── Phase: Review ─────────────────────────────────────────────────────────────

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

    log(`Reviewing ${v} (${r.images.length} images) with VLM...`);

    const reviews = await parallel(r.images.map((imgPath, i) => () =>
      agent(
        `Analyze this AI-generated character profile image. This was generated using the ${v === "fp16" ? "fp16 (bf16)" : "fp8"} model precision variant of Flux 2 Klein 9B.

Evaluate on a 1-10 scale:

1. **Anatomical correctness** — proportions, limb placement, face symmetry, hand detail
2. **Consistency** — does the character look coherent across the sheet? Any contradictions?
3. **Image quality** — sharpness, artifacts, color accuracy, skin texture
4. **Background** — is the white background clean and uniform?
5. **Clothing/detail** — are clothing details consistent and clear? Shoes consistent?
6. **Overall score** — rate 1-10

Image: ${imgPath}

Return a structured assessment.`,
        { label: `review-${v}-${i}`, phase: "Review", schema: REVIEW_SCHEMA }
      )
    ));

    r.reviews = reviews.filter(Boolean);
    const score = avgScore(r.reviews);
    log(`${v} VLM review: avg score ${score.toFixed(1)}/10`);

    // Save reviews.json alongside metrics
    const metricsDir = r.metrics_json ? r.metrics_json.replace(/\/metrics\.json$/, "") : null;
    if (metricsDir) {
      await agent(
        `Write the following JSON content to the file ${metricsDir}/reviews.json. Use the Write tool with file_path="${metricsDir}/reviews.json" and content set to the JSON below:\n\n${JSON.stringify(r.reviews, null, 2)}`,
        { label: `save-reviews-${v}`, phase: "Review" }
      );
    }
  }
}

// ── Phase: Compare ────────────────────────────────────────────────────────────

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

return returnResult;
