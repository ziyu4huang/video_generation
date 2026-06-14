// mlx-movie-director-coverage-self-improve — Autonomous Python test-coverage
// improvement for python/mlx-movie-director.
//
// Ports the proven coverage lane from gui-movie-director-schema-self-improve.js
// to the Python suite. Loop: find the weakest-tested source module → an agent
// proposes new CPU-pure unit tests → run pytest --cov → ADOPT only if global
// coverage rose by ≥ margin AND the suite still passes, else REVERT. Learns
// dead-ends + good patterns run-over-run via a JSONL history.
//
// Composes existing infrastructure rather than reinventing it:
//   - Loop shape + phase skeleton + dead-end/margin/convergence: copied from
//     gui-movie-director-schema-self-improve.js (coverage lane).
//   - Python invocation + reliable saveHistory (Write→test -s→heredoc fallback):
//     copied from mlx-movie-director-ltx-self-improve.js.
//   - Flakiness fix (clear __pycache__ + -p no:cacheprovider before every pytest
//     run): from the pytest-stale-pycache-false-failures memory.
//   - Coverage measurement: pytest-cov --cov-report=json (machine-readable, far
//     more robust than regex-scraping the aligned term table the GUI workflow is
//     forced to scrape from `bun test`).
//
// Scope: CPU-pure tests ONLY. The suite runs plain `pytest app/tests` (no
// --run-gpu / --run-slow), so the loop targets argparse shapes, command dispatch,
// build_params, helpers, validation — not model-loading / GPU paths.
//
// Usage:
//   Workflow({ name: "mlx-movie-director-coverage-self-improve" })
//     → DRY-RUN (default): one baseline pytest run to find weakest modules, then
//       propose-only; zero files written, zero re-measure runs
//   Workflow({ name: "...", args: { dryRun: false } })
//     → execute the full autonomous loop (baseline + ≤budget iterations)
//   Workflow({ name: "...", args: { dryRun: false, budget: 3, target: "workflow" } })
//   Workflow({ name: "...", args: { margin: 0.5 } })  // looser adopt threshold

export const meta = {
  name: "mlx-movie-director-coverage-self-improve",
  description: "Self-improve python/mlx-movie-director test coverage: find weakest source module → propose CPU-pure unit tests → run pytest --cov → adopt/revert, learning dead-ends run-over-run",
  whenToUse: "Raise real pytest coverage for the mlx-movie-director Python CLI via an autonomous propose→measure→adopt/revert loop. Dry-run by default (one baseline pytest run to find weakest modules, then propose-only — no writes); set dryRun:false to actually write tests and re-measure each iteration. Targets CPU-pure paths only (no GPU).",
  phases: [
    { title: "Resolve",  detail: "Load history JSONL + reflection, derive runId, load dead-ends + good patterns" },
    { title: "Baseline", detail: "Run pytest --cov (clear __pycache__) → parse coverage.json → starting composite" },
    { title: "Improve",  detail: "Loop: propose tests for weakest module → write → measure → adopt/revert" },
    { title: "Persist",  detail: "Append iterations.jsonl + reflection.json + cross-workflow index (reliably)" },
    { title: "Report",   detail: "Coverage delta summary + weakest remaining" },
  ],
}

// ── Config ────────────────────────────────────────────────────────────────────

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x)
// `args` may arrive as an object or a JSON string depending on the caller.
const _rawArgs = typeof args === "string" ? (() => { try { return JSON.parse(args) } catch { return {} } })() : args
const A = isObj(_rawArgs) ? _rawArgs : {}
const BUDGET     = Number(A.budget) || 6           // max iterations
const DRY_RUN    = A.dryRun !== false              // default: dry-run (safe to demo)
const MARGIN     = Number(A.margin) || 0.5         // min global composite delta to adopt (pp)
const CONVERGE_K = Number(A.convergeK) || 2        // stop after K non-improving iters
const TARGET     = A.target || null                // optional: focus on one source path substring

// ── Paths ─────────────────────────────────────────────────────────────────────

const MLX_DIR      = "/Users/huangziyu/proj/video_generation/python/mlx-movie-director"
const PROJECT_ROOT = MLX_DIR.replace(/\/python\/mlx-movie-director$/, "")
const PYTHON_EXE   = `${PROJECT_ROOT}/python/venv/bin/python`
const HISTORY_DIR  = `${PROJECT_ROOT}/.claude/workflows/history/mlx-movie-director-coverage-self-improve`
const JSONL_PATH   = `${HISTORY_DIR}/iterations.jsonl`
const REFLECT_PATH = `${HISTORY_DIR}/reflection.json`
const INDEX_PATH   = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`

// The single pytest+coverage command used for baseline AND measure. Clears stale
// __pycache__ first (phantom-failure fix), emits machine-readable JSON, cwd=MLX_DIR
// so --cov=app resolves the package and pytest.ini's testpaths/conftest load.
const COV_REPORT = "coverage.json"
const COV_CMD = `cd '${MLX_DIR}' \
  && find app -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null \
  && '${PYTHON_EXE}' -m pytest app/tests \
       --cov=app --cov-report=json:${COV_REPORT} --cov-branch -q -p no:cacheprovider 2>&1`

// Python one-liner that reads coverage.json and prints a compact JSON summary of
// TARGET source files only (excludes tests, __init__, test_prompts data modules).
// Path key is relative to MLX_DIR, e.g. "app/commands/image-swap.py".
const COV_EXTRACT = `'${PYTHON_EXE}' -c "
import json
d = json.load(open('${COV_REPORT}'))
out = []
for p, s in sorted(d['files'].items()):
    if '/tests/' in p or p.endswith('__init__.py') or 'test_prompts' in p:
        continue
    sm = s['summary']
    out.append({'path': p, 'percentCovered': round(sm['percent_covered'], 2),
                'coveredLines': sm['covered_lines'], 'numStatements': sm['num_statements']})
print('COV_JSON=' + json.dumps(out))
"`

// ── Coverage math (pure JS) ───────────────────────────────────────────────────

// Global composite = Σ covered lines / Σ statements over TARGET files (weighted —
// reflects real TOTAL coverage better than a simple mean of per-file percentages).
function globalComposite(files) {
  let cov = 0, stmts = 0
  for (const f of files) { cov += f.coveredLines || 0; stmts += f.numStatements || 0 }
  return stmts > 0 ? (cov / stmts) * 100 : 0
}

function findWeakestFile(files, deadEnds) {
  const candidates = files
    .filter((f) => !deadEnds.has(f.path))
    .filter((f) => (TARGET ? f.path.includes(TARGET) : true))
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.percentCovered - b.percentCovered)
  return candidates[0].path
}

// Derive a *candidate* test path from a source path. Naming in app/tests/ is not
// fully regular (test_image_dispatch.py, test_image_i2i_selftest.py, …), so this
// is only a HINT — the propose agent reads the dir and decides whether to append
// to an existing related test or create a new one.
function candidateTestPath(srcPath) {
  // app/commands/image-swap.py → app/tests/test_image_swap.py
  const base = srcPath.replace(/^app\//, "").replace(/\.py$/, "").replace(/[/-]/g, "_")
  return `app/tests/test_${base}.py`
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    runId:             { type: "string" },
    totalPriorIters:   { type: "number" },
    deadEndFiles:      { type: "array", items: { type: "string" } },
    knownGoodPatterns: { type: "array", items: { type: "string" } },
  },
  required: ["runId", "totalPriorIters", "deadEndFiles", "knownGoodPatterns"],
}

// Shared by baseline + measure: pytest pass/fail counts + per-target-file coverage.
const COV_SCHEMA = {
  type: "object",
  properties: {
    output:     { type: "string", description: "Full pytest stdout" },
    passed:     { type: "number" },
    failed:     { type: "number" },
    errors:     { type: "number", description: "pytest collection/session errors" },
    files:      { type: "array", items: {
      type: "object",
      properties: {
        path:           { type: "string" },
        percentCovered: { type: "number" },
        coveredLines:   { type: "number" },
        numStatements:  { type: "number" },
      },
      required: ["path", "percentCovered", "coveredLines", "numStatements"],
    } },
  },
  required: ["output", "passed", "failed", "files"],
}

const PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    testClass:      { type: "string", description: "one-line description of what is tested" },
    targetTestFile: { type: "string", description: "Path RELATIVE to the mlx-movie-director dir, e.g. 'app/tests/test_ltx_downloader.py' — NEVER absolute" },
    newTestCode:    { type: "string", description: "Python test code to APPEND (imports + def test_*); empty string if no CPU-pure path is testable" },
    estimatedLines: { type: "number" },
    reasoning:      { type: "string" },
  },
  required: ["testClass", "targetTestFile", "newTestCode", "reasoning"],
}

// ── Phase: Resolve ────────────────────────────────────────────────────────────

phase("Resolve")

const resolveResult = await agent(
  `You are a file reader agent. Do the following in order:
1. If it does not exist, create the directory: Bash("mkdir -p '${HISTORY_DIR}'")
2. Read ${JSONL_PATH} if it exists. Parse each line as JSON. Extract: iter, targetFile, adopted, testClass, skipped.
3. Read ${REFLECT_PATH} if it exists. Extract dead-end / good-pattern lists if present.
4. Count total lines in the JSONL to derive runId = "run-<N+1>" (or "run-1" if empty/missing).
5. Return JSON.

Rules for the derived lists (CRITICAL: an entry with dryRun === true NEVER actually
ran tests — ignore ALL dryRun=true entries when computing these lists, otherwise
dry-run targets get falsely marked as dead-ends and real runs skip them):
- deadEndFiles: source paths that appear in >= 2 consecutive REAL non-adopted
  iterations (dryRun absent/false AND adopted=false), OR were skipped in a REAL
  run (skipped=true AND dryRun absent=false).
- knownGoodPatterns: testClass strings from REAL adopted iterations (adopted=true
  AND dryRun absent=false).
- totalPriorIters: count of REAL iterations only (dryRun absent=false).

If JSONL is empty or missing, return defaults with runId "run-1".`,
  { label: "resolve-history", phase: "Resolve", schema: RESOLVE_SCHEMA },
)

const runId    = resolveResult?.runId || "run-1"
const deadEnds = new Set(resolveResult?.deadEndFiles || [])
const goodPats = resolveResult?.knownGoodPatterns || []

log(`Run: ${runId} | Prior iters: ${resolveResult?.totalPriorIters || 0} | Dead-ends: ${deadEnds.size} | Good patterns: ${goodPats.length} | dryRun=${DRY_RUN}`)

// ── Phase: Baseline ───────────────────────────────────────────────────────────

phase("Baseline")

const baselineResult = await agent(
  `Establish the coverage BASELINE for the mlx-movie-director Python suite.

STEP 1 — run the suite with coverage (clears stale __pycache__ first to avoid phantom failures):
  Bash("""${COV_CMD}""")

STEP 2 — extract the per-target-file coverage summary from the JSON report:
  Bash("""${COV_EXTRACT}""")
  Parse the single line beginning "COV_JSON=" (it is a JSON array).

STEP 3 — from the pytest stdout in STEP 1, read the summary line, e.g.
  "268 passed, 12 skipped in 30.2s" → passed=268, failed=0
  "265 passed, 1 failed, 12 skipped" → passed=265, failed=1
  "=== short test summary info ===ERRORS" → errors>0 (count distinct ERROR lines)

Return: output=full stdout, passed, failed, errors, files=<the COV_JSON array>.
If pytest exited non-zero due to a collection error, still return what you parsed (errors>0).`,
  { label: "baseline-run", phase: "Baseline", schema: COV_SCHEMA },
)

const baselineFiles = baselineResult?.files || []
const baselineComposite = globalComposite(baselineFiles)
let currentBest = baselineComposite
let currentFiles = baselineFiles.slice()

const baselinePassed = Number(baselineResult?.passed) || 0
const baselineFailed = Number(baselineResult?.failed) || 0
if (baselineFailed > 0 || Number(baselineResult?.errors) > 0) {
  log(`⚠️  baseline suite is NOT green (passed=${baselinePassed} failed=${baselineFailed} errors=${baselineResult?.errors || 0}) — adoption checks still require failed=0`)
}

log(`Baseline: ${baselineComposite.toFixed(2)}% global (${baselineFiles.length} target files) | suite passed=${baselinePassed} failed=${baselineFailed}`)

const weakest = baselineFiles.slice().sort((a, b) => a.percentCovered - b.percentCovered).slice(0, 5)
log(`Weakest: ${weakest.map((x) => `${x.path}(${x.percentCovered.toFixed(0)}%)`).join(", ")}`)

// ── Phase: Improve ────────────────────────────────────────────────────────────

phase("Improve")

const iterations = []
let noImprove = 0

for (let iter = 0; iter < BUDGET; iter++) {
  const targetFile = findWeakestFile(currentFiles, deadEnds)
  if (!targetFile) {
    log("No candidates left (all in dead-ends). Stopping.")
    break
  }

  const testHint = candidateTestPath(targetFile)
  const cur = currentFiles.find((f) => f.path === targetFile)
  log(`Iter ${iter + 1}/${BUDGET}: targeting ${targetFile} (${(cur?.percentCovered || 0).toFixed(1)}% covered)`)

  // --- Propose new CPU-pure tests for the weakest module ---
  const proposeResult = await agent(
    `You are a test-writing agent for a Python pytest project. Propose NEW unit
tests to improve coverage of ONE source file.

Project: ${MLX_DIR} (run with venv '${PYTHON_EXE}')
Source file: ${MLX_DIR}/${targetFile}
Candidate test file (path RELATIVE to the mlx-movie-director dir): ${testHint} (may already exist with related tests — check app/tests/ first; append, never clobber)
Coverage baseline for this file: ${cur?.percentCovered || 0}% (${cur?.coveredLines || 0}/${cur?.numStatements || 0} statements)
Known-good test patterns from prior runs: ${goodPats.slice(0, 5).join("; ") || "none yet"}

STEPS:
1. Read the source file: ${MLX_DIR}/${targetFile}
2. Read the coverage gaps. Run:
   Bash("'${PYTHON_EXE}' -c \\"import json; d=json.load(open('${COV_REPORT}')); e=d['files'].get('${targetFile}'); print('covered', e['summary']['percent_covered']); print('missing_lines', e['missing_lines'][:80]); print('missing_branches', e.get('missing_branches',[])[:40])\\"")
3. Check app/tests/ for an existing related test (ls app/tests/) and read it if present.
4. Identify CPU-PURE branches that are uncovered AND testable WITHOUT MLX/GPU/model-loading:
   - argparse add_argument shapes / choices / defaults
   - command dispatch / routing logic
   - build_params / arg construction
   - pure helper functions, validation, parsing, IO that doesn't load weights
5. Draft 3-6 new test functions (def test_*) as a code STRING to return in
   newTestCode — do NOT write them to disk (a later agent does, after measurement).
   Use the repo's existing patterns
   (import pytest; from app.... import ...; fixtures as seen in conftest.py / sibling tests).

HARD RULES:
- DO NOT use Write or Edit to create or modify ANY file. You are PROPOSING tests as
  a code STRING in the newTestCode field — a SEPARATE agent writes them later, behind
  the measure/adopt gate. Writing files yourself bypasses that gate and corrupts the
  run (the write agent then sees the file "already exists" and skips). You MAY use
  Read (source + existing tests) and Bash (coverage queries) ONLY.
- Tests MUST pass under plain "pytest" with NO --run-gpu / --run-slow and NO network.
- Do NOT import heavy pipelines (ltx_pipeline, flux2_*, seedvr2/*, sam3_predictor) at
  module load unless you are testing a pure helper that does not touch MLX.
- If the file is almost ENTIRELY GPU/model logic with no testable CPU-pure branch,
  return newTestCode="" with reasoning explaining why (it will be marked a dead-end).

Return the proposal.`,
    { label: `propose-${targetFile.replace(/[^a-z0-9]/gi, "-")}`, phase: "Improve", schema: PROPOSE_SCHEMA },
  )

  if (!proposeResult) {
    log(`Iter ${iter + 1}: proposal agent failed, skipping`)
    noImprove++
    if (noImprove >= CONVERGE_K) { log("Converged (agent failures). Stopping."); break }
    continue
  }

  const noCode = !proposeResult.newTestCode || !proposeResult.newTestCode.trim()
  log(`Proposed: "${proposeResult.testClass}" ${noCode ? "(NO CPU-pure path — skip)" : `→ ${proposeResult.targetTestFile}`}`)

  let adopted = false
  let delta = 0

  if (noCode) {
    // GPU-heavy / untestable module — record as dead-end, no write.
    deadEnds.add(targetFile)
    noImprove++
    iterations.push({ runId, iter: iter + 1, targetFile, testClass: proposeResult.testClass, adopted: false, skipped: true, delta: 0, reason: "no CPU-pure testable branch", dryRun: DRY_RUN })
    if (noImprove >= CONVERGE_K) { log("Converged (no testable targets). Stopping."); break }
    continue
  }

  if (DRY_RUN) {
    log(`  [DRY RUN] would append ${proposeResult.estimatedLines || "?"} lines to ${proposeResult.targetTestFile}`)
    log(`  preview: ${proposeResult.newTestCode.slice(0, 140).replace(/\n/g, " ")}...`)
    iterations.push({ runId, iter: iter + 1, targetFile, testClass: proposeResult.testClass, adopted: false, dryRun: true, delta: 0 })
    // Dry-run does NOT advance dead-ends (we never actually tested the proposal).
    continue
  }

  // --- Write (append) the tests ---
  const writeResult = await agent(
    `Append the following Python test code to the file ${MLX_DIR}/${proposeResult.targetTestFile}.

The file may already contain tests — DO NOT replace existing content. Append AFTER
the last line. Ensure imports needed by the new code are present at the top (merge,
do not duplicate existing imports).

Code to append:
${proposeResult.newTestCode}

After writing, confirm by returning { written: true, filePath: "${proposeResult.targetTestFile}" }.`,
    { label: `write-${targetFile.replace(/[^a-z0-9]/gi, "-")}`, phase: "Improve",
      schema: { type: "object", properties: { written: { type: "boolean" }, filePath: { type: "string" } }, required: ["written"] } },
  )

  if (!writeResult?.written) {
    log(`Iter ${iter + 1}: write failed (or already-present no-op), skipping`)
    iterations.push({ runId, iter: iter + 1, targetFile, testClass: proposeResult.testClass, targetTestFile: proposeResult.targetTestFile, adopted: false, delta: 0, reason: "write failed or no-op", dryRun: DRY_RUN })
    noImprove++
    continue
  }

  // --- Measure (re-run the exact baseline command) ---
  const measureResult = await agent(
    `Re-measure coverage after adding tests.

STEP 1: Bash("""${COV_CMD}""")
STEP 2: Bash("""${COV_EXTRACT}""")  → parse the "COV_JSON=" line.
STEP 3: read passed/failed/errors from the STEP 1 summary line.

Return output, passed, failed, errors, files=<COV_JSON array>.`,
    { label: `measure-${targetFile.replace(/[^a-z0-9]/gi, "-")}`, phase: "Improve", schema: COV_SCHEMA },
  )

  const newFiles = measureResult?.files || []
  const newComposite = globalComposite(newFiles)
  const newFailed = Number(measureResult?.failed) || 0
  const newErrors = Number(measureResult?.errors) || 0
  delta = newComposite - currentBest

  const testsOk = newFailed === 0 && newErrors === 0

  if (testsOk && delta >= MARGIN) {
    adopted = true
    currentBest = newComposite
    currentFiles = newFiles
    log(`✓ Adopted! +${delta.toFixed(2)}pp → ${newComposite.toFixed(2)}% total (suite passed=${measureResult?.passed})`)
  } else {
    // Revert
    await agent(
      `Revert the failed/regressing test addition.
Run: cd '${MLX_DIR}' && git checkout -- "${proposeResult.targetTestFile}" 2>&1 || true
If git checkout fails (file was newly created), delete it:
  rm -f '${MLX_DIR}/${proposeResult.targetTestFile}'
Return { reverted: true }.`,
      { label: `revert-${targetFile.replace(/[^a-z0-9]/gi, "-")}`, phase: "Improve",
        schema: { type: "object", properties: { reverted: { type: "boolean" } }, required: ["reverted"] } },
    )
    const reason = !testsOk ? `suite failed (failed=${newFailed} errors=${newErrors})` : `delta ${delta.toFixed(2)} < margin ${MARGIN}`
    log(`✗ Reverted (${reason})`)
  }

  iterations.push({ runId, iter: iter + 1, targetFile, testClass: proposeResult.testClass, targetTestFile: proposeResult.targetTestFile, adopted, delta, prevScore: currentBest - (adopted ? delta : 0), newScore: adopted ? currentBest : currentBest - delta, dryRun: DRY_RUN })

  if (adopted) {
    noImprove = 0
    deadEnds.delete(targetFile)
    goodPats.push(proposeResult.testClass)
  } else {
    noImprove++
    deadEnds.add(targetFile)
  }

  if (noImprove >= CONVERGE_K) { log(`Converged (${CONVERGE_K} non-improving iters). Stopping.`); break }
}

// ── Phase: Persist ────────────────────────────────────────────────────────────

phase("Persist")

// Dry-run must NOT write history: its iterations never ran real tests, so writing
// them would poison the resume/dead-end store (resolve would later mark dry-run
// targets as dead-ends and real runs would skip them). Guarded here AND resolve
// ignores dryRun=true entries, so it's belt-and-suspenders.
if (!DRY_RUN && iterations.length > 0) {
  await agent(
    `Persist this run's history RELIABLY (Write tool can silently produce nothing).

1. Bash("mkdir -p '${HISTORY_DIR}'")
2. Append each iteration as one JSON line to ${JSONL_PATH} (create if missing).
   Lines (verbatim, one per line, do NOT reformat):
${iterations.map((e) => JSON.stringify(e)).join("\n")}
   Use a quoted heredoc to append safely:
   Bash("cat >> '${JSONL_PATH}' <<'ITER_EOF'
${iterations.map((e) => JSON.stringify(e)).join("\n")}
ITER_EOF")
3. Verify: Bash("test -s '${JSONL_PATH}' && echo OK || echo MISSING")
4. Write reflection.json (overwrite) with dead-ends + good patterns so the next
   run's Resolve phase can read them. Use the Write tool:
   file_path='${REFLECT_PATH}', content = this JSON verbatim:
${JSON.stringify({ runId, deadEnds: [...deadEnds], goodPatterns: goodPats.slice(-25), updatedAt: runId }, null, 2)}
5. Verify reflection: Bash("test -s '${REFLECT_PATH}' && echo OK || echo MISSING")

Return { written: true }.`,
    { label: "persist-history", phase: "Persist",
      schema: { type: "object", properties: { written: { type: "boolean" } }, required: ["written"] } },
  )
}

// Update the cross-workflow index (dry-run skips it — no real progress to record).
const adoptedCount = iterations.filter((e) => e.adopted).length
if (DRY_RUN) {
  log("[DRY RUN] skipping cross-workflow index update")
} else await agent(
  `Update the cross-workflow index at ${INDEX_PATH}.
1. Bash("cat '${INDEX_PATH}' 2>/dev/null || echo '[]'")
2. Parse the JSON array. Add (or update for this runId) an entry:
   { "workflow": "mlx-movie-director-coverage-self-improve", "runId": "${runId}", "dryRun": ${DRY_RUN}, "iters": ${iterations.length}, "adopted": ${adoptedCount}, "baselineCoverage": ${baselineComposite.toFixed(2)}, "finalCoverage": ${currentBest.toFixed(2)} }
3. Keep only the 50 most recent entries (newest first).
4. Write the updated array with the Write tool (2-space indent), file_path='${INDEX_PATH}'.
5. Verify: Bash("test -s '${INDEX_PATH}' && echo OK || echo MISSING")
6. If MISSING, rewrite via a quoted heredoc with the same array content.
Return { done: true }.`,
  { label: "update-index", phase: "Persist",
    schema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } },
)

// ── Phase: Report ─────────────────────────────────────────────────────────────

phase("Report")

const totalDelta = currentBest - baselineComposite
const finalWeakest = currentFiles.slice().sort((a, b) => a.percentCovered - b.percentCovered).slice(0, 5)

log("════════════════════════════════════════")
log(`DONE · runId=${runId} | ${DRY_RUN ? "DRY-RUN" : "LIVE"}`)
log(`coverage ${baselineComposite.toFixed(2)}% → ${currentBest.toFixed(2)}% (${totalDelta >= 0 ? "+" : ""}${totalDelta.toFixed(2)}pp) | ${adoptedCount}/${iterations.length} adopted`)

return {
  runId,
  dryRun: DRY_RUN,
  baseline: baselineComposite.toFixed(2),
  final: currentBest.toFixed(2),
  delta: totalDelta.toFixed(2),
  iters: iterations.length,
  adopted: adoptedCount,
  rejected: iterations.length - adoptedCount,
  baselineSuite: { passed: baselinePassed, failed: baselineFailed },
  summary: `Coverage: ${baselineComposite.toFixed(1)}% → ${currentBest.toFixed(1)}% (${totalDelta >= 0 ? "+" : ""}${totalDelta.toFixed(1)}pp) | ${adoptedCount}/${iterations.length} adopted`,
  weakestRemaining: finalWeakest.map((x) => ({ file: x.path, pct: x.percentCovered })),
  iterations,
}
