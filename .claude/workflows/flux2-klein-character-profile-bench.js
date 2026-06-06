// Flux 2 Klein 9B Character Profile — Benchmark & Self-Reflection Workflow
// Runs the character profile sheet workflow (front/back/side/stitched views)
// in fp16 and/or fp8, collects metrics, uses VLM to review outputs,
// compares variants, and generates improvement recommendations.
//
// Usage:
//   /flux2-klein-character-profile-bench                         — fp16 baseline + VLM review
//   /flux2-klein-character-profile-bench --variant fp8           — fp8 variant only
//   /flux2-klein-character-profile-bench --variant both          — run both and compare
//   /flux2-klein-character-profile-bench --port 8189             — custom ComfyUI port
//   /flux2-klein-character-profile-bench --tag experiment1       — custom tag for this run
//   /flux2-klein-character-profile-bench --skip-review           — metrics only, no VLM

export const meta = {
  name: "flux2-klein-character-profile-bench",
  description: "Benchmark Flux 2 Klein 9B character profile workflow (fp16/fp8), VLM review, self-reflect",
  whenToUse: "Run and evaluate the Flux 2 Klein character profile sheet workflow with metrics and VLM quality review",
  phases: [
    { title: "Setup", detail: "Ensure ComfyUI is running, validate environment" },
    { title: "Run", detail: "Execute workflow variants and collect metrics" },
    { title: "Review", detail: "VLM analysis of generated images" },
    { title: "Compare", detail: "Cross-variant metrics and quality comparison" },
    { title: "Reflect", detail: "Self-reflection and improvement recommendations" },
  ],
};

const PYTHON = "ComfyUI/.venv/bin/python";
const BENCH_SCRIPT = "scripts/comfy_bench.py";

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseBenchOutput(text) {
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

// ── Phase 1: Setup ───────────────────────────────────────────────────────────

phase("Setup");

const port = args?.port || 8188;
const tag = args?.tag || "";
const variant = args?.variant || "fp16";
const skipReview = args?.skipReview || false;
const now = args?.timestamp || "2026-06-06";

log(`Flux 2 Klein Character Profile Bench — variant=${variant}, port=${port}, tag=${tag || "(auto)"}`);

// Check ComfyUI status
const statusResult = await agent(
  `Run this command and report the output: ${PYTHON} ${BENCH_SCRIPT} status --port ${port}`,
  { label: "check-comfyui", schema: {
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
    { label: "start-comfyui" }
  );
  log("ComfyUI started");
} else {
  log("ComfyUI already running — reusing existing instance");
}

// ── Phase 2: Run ─────────────────────────────────────────────────────────────

phase("Run");

const runTag = tag || `run-${now}`;
const results = {};
const forceRestart = args?.force_restart || false;

const variantsToRun = variant === "both" ? ["fp16", "fp8"] : [variant];

for (const v of variantsToRun) {
  const vTag = `${runTag}/${v}`;
  log(`Running ${v} workflow via Playwright (tag: ${vTag})...`);

  // Primary: Playwright web UI mode (tests the real UI path)
  const runOutput = await agent(
    `Run this exact command and return ALL of its stdout output verbatim:\n${PYTHON} ${BENCH_SCRIPT} run-ui --workflow ${v} --tag "${vTag}" --port ${port}${forceRestart ? " --force-restart" : ""}`,
    { label: `run-ui-${v}`, phase: "Run" }
  );

  const parsed = parseBenchOutput(runOutput);

  // If Playwright failed, fall back to API mode
  if (parsed.status === "error" && parsed.error?.includes("playwright")) {
    log(`Playwright failed for ${v}, falling back to API mode...`);
    const fallbackOutput = await agent(
      `Run this exact command and return ALL of its stdout output verbatim:\n${PYTHON} ${BENCH_SCRIPT} run --workflow ${v} --tag "${vTag}" --port ${port}`,
      { label: `run-api-${v}`, phase: "Run" }
    );
    const fallbackParsed = parseBenchOutput(fallbackOutput);
    results[v] = fallbackParsed;
    log(`${v} (API fallback): ${fallbackParsed.status} in ${fallbackParsed.wall_time}, peak RSS ${fallbackParsed.peak_rss}`);
  } else {
    results[v] = parsed;
    log(`${v} complete: ${parsed.status} in ${parsed.wall_time}, peak RSS ${parsed.peak_rss}, ${parsed.images?.length || 0} images`);
  }

  if (results[v].status === "error") {
    log(`⚠️ ${v} failed: ${results[v].error}`);
  }
}

// ── Phase 3: Review ──────────────────────────────────────────────────────────

if (skipReview) {
  log("Skipping VLM review (--skip-review)");
} else {
  phase("Review");

  for (const v of variantsToRun) {
    const r = results[v];
    if (!r.images?.length) {
      log(`No images to review for ${v}`);
      continue;
    }

    log(`Reviewing ${v} images with VLM...`);

    const reviews = await parallel(r.images.map((imgPath, i) => () =>
      agent(
        `Analyze this AI-generated character image for quality. Evaluate:
1. **Anatomical correctness** — proportions, limb placement, face symmetry
2. **Consistency** — does the character look the same across views?
3. **Image quality** — sharpness, artifacts, color accuracy
4. **Background** — is the white background clean?
5. **Clothing/detail** — are clothing details consistent and clear?
6. **Overall score** — rate 1-10

Image: ${imgPath}

Return a structured assessment.`,
        { label: `review-${v}-${i}`, phase: "Review", schema: {
          type: "object",
          properties: {
            anatomy: { type: "number", description: "Anatomical correctness 1-10" },
            consistency: { type: "number", description: "Character consistency 1-10" },
            quality: { type: "number", description: "Image quality 1-10" },
            background: { type: "number", description: "Background cleanliness 1-10" },
            clothing: { type: "number", description: "Clothing detail 1-10" },
            overall: { type: "number", description: "Overall score 1-10" },
            issues: { type: "array", items: { type: "string" }, description: "List of issues found" },
            strengths: { type: "array", items: { type: "string" }, description: "Strengths observed" },
            summary: { type: "string", description: "Brief summary" },
          },
          required: ["anatomy", "consistency", "quality", "background", "clothing", "overall", "issues", "strengths", "summary"],
        }}
      )
    ));

    results[v].reviews = reviews.filter(Boolean);
    const avgScore = reviews.filter(Boolean).reduce((s, r) => s + (r.overall || 0), 0) / (reviews.filter(Boolean).length || 1);
    log(`${v} VLM review: avg score ${avgScore.toFixed(1)}/10`);
  }
}

// ── Phase 4: Compare ─────────────────────────────────────────────────────────

if (variantsToRun.length > 1) {
  phase("Compare");

  log("Cross-variant comparison...");

  const comparison = await agent(
    `Compare these ComfyUI benchmark results across fp16 vs fp8 variants. Analyze:

**FP16 Results:**
${JSON.stringify(results.fp16, null, 2)}

**FP8 Results:**
${JSON.stringify(results.fp8, null, 2)}

Compare:
1. **Performance**: wall time, memory usage
2. **Quality**: VLM review scores (if available)
3. **Reliability**: success/failure status
4. **Efficiency**: output quality per unit of compute time

Provide a recommendation on which variant to use and why.`,
    { label: "compare-variants", phase: "Compare", schema: {
      type: "object",
      properties: {
        winner: { type: "string", enum: ["fp16", "fp8", "tie"] },
        performance_diff_pct: { type: "number", description: "Wall time difference percentage" },
        memory_diff_pct: { type: "number", description: "Peak RSS difference percentage" },
        quality_diff: { type: "string", description: "Quality difference summary" },
        recommendation: { type: "string", description: "Final recommendation" },
        reasoning: { type: "string", description: "Detailed reasoning" },
      },
      required: ["winner", "recommendation", "reasoning"],
    }}
  );

  results.comparison = comparison;
  log(`Comparison: winner=${comparison.winner}, recommendation=${comparison.recommendation}`);
}

// ── Phase 5: Reflect ─────────────────────────────────────────────────────────

phase("Reflect");

log("Self-reflection and improvement analysis...");

const reflection = await agent(
  `You are a self-reflecting AI benchmark analyst. Given these ComfyUI workflow benchmark results, provide:

1. **Key Findings**: What did we learn?
2. **Issues Found**: Any problems with the workflow, metrics collection, or results?
3. **Improvement Suggestions**: Specific changes to try next:
   - Workflow parameter changes (steps, CFG, resolution, etc.)
   - Prompt engineering improvements
   - Model selection alternatives
   - Pipeline architecture changes
4. **Next Steps**: What should the next benchmark iteration test?

Results:
${JSON.stringify(results, null, 2)}

Context: This is a Flux 2 Klein 9B character profile sheet workflow running on Apple Silicon MPS.
It generates front/back/side views of a character from an input image.`,
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
      next_steps: { type: "array", items: { type: "string" } },
    },
    required: ["findings", "issues", "improvements", "next_steps"],
  }}
);

log("=== BENCHMARK COMPLETE ===");
log(`Findings: ${reflection.findings?.length || 0}`);
log(`Issues: ${reflection.issues?.length || 0}`);
log(`Improvements suggested: ${reflection.improvements?.length || 0}`);
log(`Next steps: ${reflection.next_steps?.length || 0}`);

return {
  results,
  reflection,
  runTag,
  variantsRun: variantsToRun,
};
