// Flux 2 Klein 9B Character Profile — Dynamic Benchmark & Self-Improvement Workflow
//
// Dynamic parameter sweep, baseline comparison, iterative self-improvement,
// and budget-aware scaling.
//
// Phases:
//   Resolve  → detect absolute project root, derive all paths (eliminates CWD drift)
//   Plan     → resolve args, load baseline, compute iteration plan from budget
//   Setup    → ensure ComfyUI running
//   Run Sweep → iterate over parameter combinations, run benchmarks
//   Review   → parallel VLM review of all generated images
//   Compare  → delta scoring against baseline + cross-combo ranking
//   Reflect  → analyze results, generate next param grid
//   Decide   → check quality target; iterate or finish
//
// Usage:
//   /flux2-klein-character-profile-bench                         — fp8 sweep + baseline compare (default)
//   /flux2-klein-character-profile-bench --variant fp16          — fp16 sweep
//   /flux2-klein-character-profile-bench --variant both          — both variants
//   /flux2-klein-character-profile-bench --quality-target 8.5    — stop when score >= 8.5
//   /flux2-klein-character-profile-bench --max-iterations 1      — single iteration
//   /flux2-klein-character-profile-bench --skip-review           — metrics only, no VLM
//   /flux2-klein-character-profile-bench --tag experiment1       — custom tag

export const meta = {
  name: "flux2-klein-character-profile-bench",
  description: "Dynamic parameter sweep, baseline comparison, iterative self-improvement for Flux 2 Klein character profile workflow",
  whenToUse: "Run parameter sweep benchmarks with VLM review and auto-improvement loop",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root to eliminate PWD-dependent relative paths" },
    { title: "Plan", detail: "Build parameter grid, load baseline, plan iterations" },
    { title: "Setup", detail: "Ensure ComfyUI is running" },
    { title: "Run Sweep", detail: "Execute parameter combinations and collect metrics" },
    { title: "Review", detail: "VLM analysis of all generated images" },
    { title: "Compare", detail: "Delta scoring against baseline" },
    { title: "Reflect", detail: "Self-reflection and improvement analysis" },
    { title: "Decide", detail: "Check quality target; iterate or finish" },
  ],
};

// ── Default parameter grid (iteration 0) ──────────────────────────────────────
// Derived from previous benchmark reflection: top improvements are steps increase,
// unique seeds, and character description.

// ── Resolve phase: absolute paths (avoids agent CWD drift) ────────────────────
//
// The workflow JS runs in a sandbox. Agents spawned by agent() may have a
// different CWD than expected. We resolve the project root ONCE via a cheap
// haiku agent, then derive ALL paths as absolute.

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
const WORKFLOW_FILE = PROJECT_ROOT ? `${PROJECT_ROOT}/.claude/workflows/flux2-klein-character-profile-bench.js` : ".claude/workflows/flux2-klein-character-profile-bench.js"

log("Resolved paths:")
log(`  PROJECT_ROOT: ${PROJECT_ROOT || "(fallback: relative)"}`)
log(`  PYTHON:       ${PYTHON}`)
log(`  BENCH_SCRIPT: ${BENCH_SCRIPT}`)

const DEFAULT_PARAM_GRID = [
  {
    name: "steps-12-unique-seeds",
    params: { steps: 12, seed_front: 100000001, seed_back: 100000002, seed_side: 100000003 },
  },
  {
    name: "steps-12-with-desc",
    params: {
      steps: 12,
      seed_front: 100000001, seed_back: 100000002, seed_side: 100000003,
      desc: "detailed hands with separated fingers, natural skin pores, black closed-toe heels",
    },
  },
  {
    name: "baseline-control",
    params: {},
  },
];

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

function planFromBudget(budgetObj, maxIter) {
  if (!budgetObj || !budgetObj.total) {
    return { iterations: maxIter, combosPerIter: 3 };
  }
  const totalSlots = Math.floor(budgetObj.total / 100_000) * 3;
  const slotsPerCombo = 5;
  const overheadPerIter = 3;
  const iterations = Math.min(maxIter, Math.max(1, Math.floor(totalSlots / (overheadPerIter + slotsPerCombo * 3))));
  const combosPerIter = Math.min(5, Math.max(1, 3));
  return { iterations, combosPerIter };
}

// ── Phase 0: Plan ─────────────────────────────────────────────────────────────

phase("Plan");

// Parse args — supports both string ("fp16") and object ({ variant, ... })
const port = args?.port || 8188;
const tag = args?.tag || "";
const variant = typeof args === "string" ? args : (args?.variant || "fp8");
const skipReview = args?.skip_review || args?.skipReview || false;
const now = args?.timestamp || "2026-06-06";
const qualityTarget = args?.quality_target || args?.qualityTarget || 8.0;
const maxIterations = args?.max_iterations || args?.maxIterations || 3;
const forceRestart = args?.force_restart || args?.forceRestart || false;
const userParamGrid = args?.params || null;

const { iterations, combosPerIter } = planFromBudget(budget, maxIterations);

log(`Plan: ${iterations} iterations × ${combosPerIter} combos, variant=${variant}, quality_target=${qualityTarget}`);

// Load baseline
const baselineResult = await agent(
  `Run this command and return its full stdout output verbatim:\n${PYTHON} ${BENCH_SCRIPT} baseline load`,
  { label: "load-baseline", phase: "Plan", schema: {
    type: "object",
    properties: {
      version: { type: "number" },
      source_run_dir: { type: "string" },
      metrics: { type: "object" },
      parameters: { type: "object" },
      images: { type: "object" },
    },
    required: ["version", "metrics"],
  }}
);

const baseline = baselineResult || {};
log(`Baseline loaded: ${baseline.source_run_dir || "none"}, wall_time=${baseline.metrics?.wall_time_sec || "?"}s`);

// ── Phase 1: Setup ────────────────────────────────────────────────────────────

phase("Setup");

const statusResult = await agent(
  `Run this command and report the output: ${PYTHON} ${BENCH_SCRIPT} status --port ${port}`,
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
    `Run this command and wait for it to complete: ${PYTHON} ${BENCH_SCRIPT} start --port ${port}`,
    { label: "start-comfyui", phase: "Setup" }
  );
  log("ComfyUI started");
} else {
  log("ComfyUI already running — reusing existing instance");
}

// ── Iterative loop: Run Sweep → Review → Compare → Reflect → Decide ──────────

const runTag = tag || `run-${now}`;
const variantsToRun = variant === "both" ? ["fp16", "fp8"] : [variant];
const allRunResults = [];
let bestScore = 0;
let currentIteration = 0;
let grid = userParamGrid || DEFAULT_PARAM_GRID;

while (currentIteration < iterations && bestScore < qualityTarget) {
  const iterTag = `${runTag}/iter${currentIteration}`;

  // ── Phase 2: Run Sweep ────────────────────────────────────────────────────
  phase("Run Sweep");

  log(`Iteration ${currentIteration + 1}/${iterations}: running ${Math.min(grid.length, combosPerIter)} combos`);

  for (const v of variantsToRun) {
    const combosToRun = grid.slice(0, combosPerIter);

    for (const combo of combosToRun) {
      const comboName = combo.name || `combo-${allRunResults.length}`;
      const paramFlags = Object.entries(combo.params || {})
        .map(([k, val]) => `--param ${k}=${val}`)
        .join(" ");
      const comboTag = `${iterTag}/${v}/${comboName}`;

      log(`Running ${v}/${comboName} with params: ${JSON.stringify(combo.params || {})}`);

      const runOutput = await agent(
        `Run this exact command and return ALL of its stdout output verbatim:\n` +
        `${PYTHON} ${BENCH_SCRIPT} run --workflow ${v} --tag "${comboTag}" --port ${port} --json${forceRestart ? " --force-restart" : ""}${paramFlags ? " " + paramFlags : ""}`,
        { label: `run-${v}-${comboName}`, phase: "Run Sweep" }
      );

      const parsed = parseBenchOutput(runOutput);

      allRunResults.push({
        iteration: currentIteration,
        variant: v,
        comboName,
        comboParams: combo.params || {},
        ...parsed,
      });

      const status = parsed.status || "unknown";
      const wt = parsed.wall_time || "?";
      log(`${v}/${comboName}: ${status} in ${wt}s, ${parsed.images?.length || 0} images`);
    }
  }

  // ── Phase 3: Review ───────────────────────────────────────────────────────
  if (skipReview) {
    log("Skipping VLM review (--skip-review)");
  } else {
    phase("Review");

    // Review only the current iteration's results
    const iterResults = allRunResults.filter(r => r.iteration === currentIteration);

    for (const r of iterResults) {
      if (!r.images?.length) {
        log(`No images to review for ${r.comboName}`);
        r.reviews = [];
        continue;
      }

      log(`Reviewing ${r.comboName} (${r.images.length} images) with VLM...`);

      const reviews = await parallel(r.images.map((imgPath, i) => () =>
        agent(
          `Analyze this AI-generated character profile image for quality.
Evaluate on a 1-10 scale:

1. **Anatomical correctness** — proportions, limb placement, face symmetry, hand detail
2. **Consistency** — does the character look coherent? Any contradictions?
3. **Image quality** — sharpness, artifacts, color accuracy, skin texture
4. **Background** — is the white background clean and uniform?
5. **Clothing/detail** — are clothing details consistent and clear? Shoes consistent?
6. **Overall score** — rate 1-10

${baseline.images ? `Also compare against the baseline image where possible. Baseline images: ${JSON.stringify(baseline.images)}` : ""}

Image: ${imgPath}

Return a structured assessment.`,
          { label: `review-${r.comboName}-${i}`, phase: "Review", schema: REVIEW_SCHEMA }
        )
      ));

      r.reviews = reviews.filter(Boolean);
      const score = avgScore(r.reviews);
      log(`${r.comboName} VLM review: avg score ${score.toFixed(1)}/10`);

      // Save reviews.json alongside metrics
      const metricsDir = r.metrics_json ? r.metrics_json.replace(/\/metrics\.json$/, "") : null;
      if (metricsDir) {
        await agent(
          `Write the following JSON content to the file ${metricsDir}/reviews.json. Use the Write tool with file_path="${metricsDir}/reviews.json" and content set to the JSON below:\n\n${JSON.stringify(r.reviews, null, 2)}`,
          { label: `save-reviews-${r.comboName}`, phase: "Review" }
        );
      }
    }
  }

  // ── Phase 4: Compare ──────────────────────────────────────────────────────
  phase("Compare");

  const iterResultsForCompare = allRunResults.filter(r => r.iteration === currentIteration);

  // Cross-combo ranking
  log("Cross-combo comparison...");

  const comparisonData = iterResultsForCompare.map(r => ({
    comboName: r.comboName,
    params: r.comboParams,
    wallTime: r.wall_time,
    peakRss: r.peak_rss,
    status: r.status,
    avgOverall: avgScore(r.reviews),
    scores: avgScoresByDim(r.reviews),
  }));

  // Delta vs baseline
  if (baseline.metrics) {
    const blMetrics = baseline.metrics;
    for (const r of iterResultsForCompare) {
      if (typeof r.wall_time === "string") r.wall_time = parseFloat(r.wall_time);
      if (typeof r.peak_rss === "string") r.peak_rss = parseFloat(r.peak_rss);
      const deltaWall = (typeof r.wall_time === "number" ? r.wall_time : 0) - (blMetrics.wall_time_sec || 0);
      const deltaRss = (typeof r.peak_rss === "number" ? r.peak_rss : 0) - (blMetrics.peak_rss_mb || 0);
      r.deltaWall = Math.round(deltaWall * 100) / 100;
      r.deltaRss = Math.round(deltaRss);
    }
  }

  // Sort by score descending
  comparisonData.sort((a, b) => (b.avgOverall || 0) - (a.avgOverall || 0));

  log("Combo ranking:");
  for (const c of comparisonData) {
    const deltaStr = c.wallTime !== undefined ? ` | Δwall ${(typeof c.wallTime === "number" ? c.wallTime - (baseline.metrics?.wall_time_sec || 0) : 0).toFixed(1)}s` : "";
    log(`  #${comparisonData.indexOf(c) + 1} ${c.comboName}: ${c.avgOverall.toFixed(1)}/10${deltaStr} | ${JSON.stringify(c.params)}`);
  }

  // ── Phase 5: Reflect ──────────────────────────────────────────────────────
  phase("Reflect");

  log("Self-reflection and improvement analysis...");

  const reflection = await agent(
    `You are a self-reflecting AI benchmark analyst. Given these ComfyUI workflow benchmark results, provide a thorough analysis.

**Baseline:**
${JSON.stringify({ metrics: baseline.metrics, parameters: baseline.parameters }, null, 2)}

**Current Iteration Results:**
${JSON.stringify(comparisonData, null, 2)}

**All Run Results (detailed):**
${JSON.stringify(iterResultsForCompare.map(r => ({
  comboName: r.comboName,
  params: r.comboParams,
  status: r.status,
  wallTime: r.wall_time,
  peakRss: r.peak_rss,
  deltaWall: r.deltaWall,
  deltaRss: r.deltaRss,
  avgScore: avgScore(r.reviews),
  scores: avgScoresByDim(r.reviews),
  issues: (r.reviews || []).flatMap(rv => rv.issues || []),
  strengths: (r.reviews || []).flatMap(rv => rv.strengths || []),
})), null, 2)}

Analyze:
1. **Key Findings**: What did we learn? Which parameter changes helped most?
2. **Issues Found**: Problems with the workflow, metrics, or results?
3. **Improvement Suggestions**: Specific changes to try:
   - Workflow parameter changes (steps, CFG, resolution, seeds)
   - Prompt engineering improvements
   - Model selection alternatives
   - Pipeline architecture changes
4. **Next Parameter Grid**: Propose ${combosPerIter} specific parameter combinations to try next.
   Each must use these alias names: steps (int, 4-50), seed_front/seed_back/seed_side (int), cfg_front/cfg_back/cfg_side (float, 0.5-5.0), desc (string).
   Base suggestions on what improved scores and what didn't. Be specific with concrete values.
5. **Next Steps**: What should the next iteration test?

Context: This is a Flux 2 Klein 9B character profile sheet workflow on Apple Silicon MPS.
It generates front/back/side views of a character from an input image.
The quality target is ${qualityTarget}/10. Current best score is ${bestScore.toFixed(1)}.`,
    { label: "reflect", phase: "Reflect", schema: {
      type: "object",
      properties: {
        findings: { type: "array", items: { type: "string" } },
        issues: { type: "array", items: { type: "string" } },
        improvements: { type: "array", items: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["parameter", "prompt", "model", "architecture", "metrics"] },
            change: { type: "string" },
            expected_impact: { type: "string" },
          },
          required: ["category", "change", "expected_impact"],
        }},
        next_param_grid: { type: "array", items: {
          type: "object",
          properties: {
            name: { type: "string" },
            params: { type: "object" },
            rationale: { type: "string" },
          },
          required: ["name", "params", "rationale"],
        }},
        next_steps: { type: "array", items: { type: "string" } },
      },
      required: ["findings", "issues", "improvements", "next_param_grid", "next_steps"],
    }}
  );

  // ── Phase 6: Decide ───────────────────────────────────────────────────────
  phase("Decide");

  // Update best score
  const iterBest = Math.max(...iterResultsForCompare.map(r => avgScore(r.reviews)));
  if (iterBest > bestScore) {
    bestScore = iterBest;
  }

  const bestRun = allRunResults.reduce((best, r) => {
    const score = avgScore(r.reviews);
    return score > best.score ? { comboName: r.comboName, score, params: r.comboParams } : best;
  }, { comboName: "none", score: 0, params: {} });

  log(`Iteration ${currentIteration + 1} complete. Iter best: ${iterBest.toFixed(1)}, Overall best: ${bestScore.toFixed(1)}/${qualityTarget}`);
  log(`Best combo so far: ${bestRun.comboName} (${bestRun.score.toFixed(1)}/10) with ${JSON.stringify(bestRun.params)}`);

  if (bestScore >= qualityTarget) {
    log(`Quality target met! Score ${bestScore.toFixed(1)} >= ${qualityTarget}`);
    break;
  }

  if (currentIteration + 1 >= iterations) {
    log(`Max iterations reached (${iterations}). Best score: ${bestScore.toFixed(1)}`);
    break;
  }

  // Prepare next iteration
  const nextGrid = reflection?.next_param_grid || [];
  if (!nextGrid.length) {
    log("No next parameter grid from reflection — stopping iteration");
    break;
  }
  grid = nextGrid;
  currentIteration++;
  log(`Next iteration ${currentIteration + 1}: trying ${nextGrid.map(g => g.name).join(", ")}`);
}

// ── Final Report ──────────────────────────────────────────────────────────────

log("=== DYNAMIC BENCH COMPLETE ===");
log(`Iterations run: ${currentIteration + 1}/${iterations}`);
log(`Variants tested: ${variantsToRun.join(", ")}`);
log(`Total combos run: ${allRunResults.length}`);

const bestRun = allRunResults.reduce((best, r) => {
  const score = avgScore(r.reviews);
  return score > best.score ? { ...r, score } : best;
}, { score: 0 });

log(`Best result: ${bestRun.comboName || "none"}, score: ${bestRun.score?.toFixed(1) || "?"}/10`);
if (bestRun.comboParams) {
  log(`Best params: ${JSON.stringify(bestRun.comboParams)}`);
}
if (bestRun.images?.length) {
  log(`Best images: ${bestRun.images.join(", ")}`);
}

if (reflection) {
  log(`Findings: ${reflection.findings?.length || 0}`);
  log(`Issues: ${reflection.issues?.length || 0}`);
  log(`Improvements suggested: ${reflection.improvements?.length || 0}`);
  log(`Next steps: ${reflection.next_steps?.length || 0}`);
}

return {
  results: allRunResults,
  reflection: reflection || null,
  baseline: {
    source: baseline.source_run_dir,
    wallTime: baseline.metrics?.wall_time_sec,
    parameters: baseline.parameters,
  },
  bestRun: {
    comboName: bestRun.comboName,
    score: bestRun.score,
    params: bestRun.comboParams,
    images: bestRun.images,
  },
  runTag,
  variantsRun: variantsToRun,
  iterationsCompleted: currentIteration + 1,
};
