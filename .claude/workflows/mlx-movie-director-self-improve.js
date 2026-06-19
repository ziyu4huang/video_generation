// MLX Movie Director Self-Improve — UNIFIED orchestrator (parent → child co-work)
//
// One dynamic workflow to improve the MLX Python CLI (python/mlx-movie-director/)
// from every angle. Two lanes, merged into ONE health report with ONE persist:
//
//   • review  — structural code health (correctness/argparse-integrity/type-safety/
//               error-handling/import-hygiene): multi-dimension review + adversarial
//               verify + optional git-stash-backed auto-fix. Runs as a CHILD workflow
//               (mlx-movie-director-review-optimize). This is the parent-child co-work.
//   • lint    — MLX-specific structural integrity that review-optimize does NOT cover:
//               pyflakes real-bug hunt + run.py check-model manifest integrity +
//               self-test registry integrity (test_selftest_integrity.py). INLINED,
//               read-only — never edits code, so it is always safe to run in parallel.
//
// Independence: this is the MLX analog of gui-movie-director-self-improve, but shares
// NO code with it (no imports, no bun/ paths). GUI is a pattern reference only. The MLX
// side does not append to the Bun-only knowledge-base/code/ bucket.
//
// Why this exists (NOT run-self-improve-image): run-self-improve-image reviews IMAGE
// quality (VLM scoring); review-optimize reviews CODE. They are different domains and
// must not be parent-child. This orchestrator is the missing MLX code-health parent that
// GUI already had — review-optimize was child-ready but had no caller.
//
// Modes (selected by args):
//
//   ROUTINE SCAN (default — cheap, collision-safe, review-only):
//     Workflow({ name: "mlx-movie-director-self-improve" })
//       → review-optimize effort:low (review-only) + lint lane. No edits, no git stash
//         → safe to run anytime, even with concurrent WIP.
//
//   SINGLE LANE:
//     args: { lanes: ["review"] }   // structural code review only
//     args: { lanes: ["lint"] }     // pyflakes + check-model + self-test only
//
//   APPLY FIXES (needs a CLEAN git tree — refuses fix if dirty):
//     args: { effort: "medium", fix: true }
//       → review-optimize applies verified fixes (git-stash rollback on regression).
//         The dirty-tree guard downgrades to review-only if another session has WIP.
//
//   DEEP:
//     args: { effort: "high", fix: true }
//       → review-optimize scans ALL files (not just changed) + fixes everything.
//
//   FOCUS / TARGET:
//     args: { focus: "correctness" }          // single review dimension
//     args: { files: ["app/cli.py", ...] }    // review only these files

export const meta = {
  name: "mlx-movie-director-self-improve",
  description:
    "Unified self-improve loop for the MLX Python CLI — structural code review (correctness/argparse-integrity/type-safety/error-handling/import-hygiene) via a child workflow (mlx-movie-director-review-optimize) AND MLX-specific structural integrity (pyflakes real-bug hunt + check-model manifest + self-test registry), merged into ONE health report with ONE persist per run. Lane-selectable; review-only by default (collision-safe).",
  whenToUse:
    "One workflow to improve python/mlx-movie-director/ from every angle. Default = cheap routine scan: review-optimize effort:low (review-only) + lint lane (pyflakes/check-model/self-test). Escalate with effort:'medium'+fix:true to auto-apply verified fixes (refuses fix if the git tree is dirty, to avoid colliding with concurrent WIP). lanes:['review'|'lint'] picks one or both; lanes:'all' = both; focus/files narrow the review scope.",
  phases: [
    { title: "Resolve", detail: "Normalize args, dirty-tree guard (refuse fix if dirty), timestamp, load ONE knowledge base" },
    { title: "Run",     detail: "Lanes: structural review (child workflow) + MLX lint/integrity (inlined: pyflakes/check-model/self-test); run in parallel (lint is read-only, never collides with review's git-stash fix)" },
    { title: "Persist", detail: "ONE unified history entry + extractKnowledge (MLX does NOT append to the Bun-only knowledge-base/code/ bucket)" },
    { title: "Report",  detail: "Merged health report: review findings + lint issues + integrity gates + fix status + open-issues trend" },
  ],
}

// ── Args normalization ──────────────────────────────────────────────────────

let resolvedArgs = args
if (typeof resolvedArgs === "string") {
  try {
    const parsed = JSON.parse(resolvedArgs)
    if (typeof parsed === "object" && parsed !== null) resolvedArgs = parsed
  } catch {
    resolvedArgs = {}
  }
}
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x)
const A = isObj(resolvedArgs) ? resolvedArgs : {}

// Lanes: which sub-workflows to run. Default: review + lint. A bare string
// lanes:"review" is accepted for convenience. lanes:"all" expands to both.
const LANES_RAW_INPUT = Array.isArray(A.lanes) ? A.lanes
  : (A.lanes === "all" ? ["review", "lint"]
  : (A.lanes ? [A.lanes] : ["review", "lint"]))
let LANES = LANES_RAW_INPUT.filter((l) => ["review", "lint"].includes(l))
let DO_REVIEW = LANES.includes("review")
let DO_LINT    = LANES.includes("lint")

// Shared / forwarded knobs.
const EFFORT = ["low", "medium", "high"].includes(A.effort) ? A.effort : "low"
const FIX_REQ = A.fix === true                  // user REQUESTED fixes
const FOCUS   = A.focus || null                 // review dimension
const FILES   = Array.isArray(A.files) ? A.files : null  // review file scope
const RESUME  = A.resume || "auto"              // review resume mode

// ── Paths ────────────────────────────────────────────────────────────────────
// NOTE: the workflow runtime strips `export const meta` — top-level `meta.*`
// refs throw "meta is not defined". Mirror the name into a plain const instead.
const NAME         = "mlx-movie-director-self-improve"
const PROJECT_ROOT = "/Users/huangziyu/proj/video_generation"
const PYTHON       = `${PROJECT_ROOT}/python/venv/bin/python`
const RUN_PY       = `${PROJECT_ROOT}/python/mlx-movie-director/run.py`
const MLX_DIR      = `${PROJECT_ROOT}/python/mlx-movie-director`
const HISTORY_DIR  = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
const INDEX_FILE   = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`
const KB_FILE      = `${PROJECT_ROOT}/.claude/workflows/${NAME}.knowledge.jsonl`

// ── Phase tracking ───────────────────────────────────────────────────────────

const phaseStatus = {}
const phasesCompleted = []
const phasesFailed = []
function markPhase(name, status) {
  phaseStatus[name] = status
  if (status === "completed") phasesCompleted.push(name)
  if (status === "failed") phasesFailed.push(name)
}

// ── saveHistory — identical in every workflow; update _shared-patterns.md first ──
// (mirrors .claude/workflows/_shared-patterns.md verbatim — canonical reliable-bytes variant)
async function saveHistory(histDir, indexFile, entry, signals) {
  const histJson = JSON.stringify({ ...entry, signals }, null, 2)
  const runId = entry.run_id
  const targetPath = `${histDir}/${runId}.json`
  const persist = await agent(
    `Persist workflow history RELIABLY.
1. Bash("mkdir -p '${histDir}'")
2. Write the file: file_path='${targetPath}', content is the JSON below — paste VERBATIM:
${histJson}
3. Verify: Bash("test -s '${targetPath}' && echo OK || echo MISSING")
4. If MISSING, rewrite via heredoc: Bash("cat > '${targetPath}' <<'HIST_EOF'\n${histJson}\nHIST_EOF")
5. Bash("wc -c < '${targetPath}'")
6. Prune old (keep newest 15): Bash("cd '${histDir}' && ls -t *.json 2>/dev/null | tail -n +16 | xargs rm -f 2>/dev/null || true")
Return { written: true, bytes: <wc output> }.`,
    { label: "persist-history", phase: "Persist", model: "haiku",
      schema: { type: "object", properties: { written: { type: "boolean" }, bytes: { type: "number" } }, required: ["bytes"] } },
  )
  const histBytes = Number(persist?.bytes) || 0
  log(histBytes > 0
    ? `History: ${histBytes} bytes → ${targetPath}`
    : `WARNING: history write failed (0 bytes)`)

  await agent(
    `Update cross-workflow index at ${indexFile}.
1. Bash("cat '${indexFile}' 2>/dev/null || echo '[]'")
2. Parse JSON array. Append: ${JSON.stringify({ run_id: runId, workflow: entry.workflow, started_at: entry.started_at, run_quality: signals.run_quality, key_metric: signals.key_metric, highlights: signals.highlights })}
3. Keep latest 50 (sort by run_id desc).
4. Write({ file_path: '${indexFile}', content: <array 2-space indent> })
5. Verify: Bash("test -s '${indexFile}' && echo OK || echo MISSING")
6. If MISSING, rewrite via heredoc.
Return { updated: true }.`,
    { label: "update-index", phase: "Persist", model: "haiku" },
  )
}

// ── loadKnowledge — identical in every workflow; update _shared-patterns.md first ──
async function loadKnowledge(kbFile) {
  const load = await agent(
    `Load distilled workflow knowledge for injection into this run.
1. Bash("test -f '${kbFile}' && echo EXISTS || echo MISSING")
2. If MISSING → return { found: false, records: [], digest: "" }.
3. If EXISTS: Bash("cat '${kbFile}'")
4. Parse each non-empty line as JSON. Keep ONLY records where status === "active".
5. Build a compact digest (<= 1200 chars), grouped by type — skip empty groups:
   - AVOID/GOTCHA: "- AVOID: <title> — <detail>"   (highest-value injections)
   - PATTERN:      "- CHECK: <title>"
   - LEVER:        "- LEVER: <title> (x<evidence.occurrences>, last <evidence.last_seen>)"
   - FALSE_POSITIVE: list titles only under "SUPPRESS: <t1>; <t2>"
   - METRIC:       "- METRIC: <title>: <detail>"
   Truncate each detail to ~160 chars. Never invent records not in the file.
Return { found: true, records: <active records array>, digest: <the string> }.`,
    { label: "load-knowledge", phase: "Resolve", model: "haiku",
      schema: { type: "object", properties: {
        found: { type: "boolean" },
        records: { type: "array", items: { type: "object" } },
        digest: { type: "string", description: "Compact <=1200 char grouped digest of active records" },
      }, required: ["found", "digest"] } },
  )
  const n = Array.isArray(load?.records) ? load.records.length : 0
  log(`Knowledge: loaded ${n} active record(s)${load?.digest ? "" : " (empty/new)"} ← ${kbFile}`)
  return load
}

// ── extractKnowledge — identical in every workflow; update _shared-patterns.md first ──
async function extractKnowledge(kbFile, runId, runResult, runReflection, MAX_ACTIVE = 40) {
  const resultJson = JSON.stringify(runResult)
  const reflectJson = runReflection ? JSON.stringify(runReflection) : "null"
  const extract = await agent(
    `Distill durable knowledge from THIS run into the colocated knowledge file.
0. Bash("git status --porcelain '${kbFile}' 2>/dev/null || true"). If the porcelain
   output mentions this exact path (already modified by a concurrent run), return
   { updated: false, total_lines: 0, active: 0, new_ids: [] } WITHOUT writing.
CURRENT FILE (may not exist yet):
1. Bash("test -f '${kbFile}' && cat '${kbFile}' || echo '__EMPTY__'")
2. Parse each non-empty line. Existing records have stable "id" fields.
THIS RUN'S DATA:
- runId: ${runId}
- result: ${resultJson}
- reflection (optional): ${reflectJson}
YOUR JOB — produce the NEW file contents (FULL rewrite, one JSON object per line):
A. For each durable insight in this run (confirmed pattern, adopted lever, dead-end/
   regressor, false-positive class, metric ceiling), pick a stable id "<family>:<slug>".
   Set type to exactly ONE of: pattern | lever | avoid | gotcha | false_positive | metric
   (avoid/gotcha = dead-end/crash-class bug or latent trap; lever = an adopted move that
   helped; false_positive = a recurring flag that was rejected; metric = a measured
   ceiling/baseline; pattern = reusable check). loadKnowledge groups on type, so a NULL
   type makes the record invisible to the next run -- ALWAYS set it.
   Grep existing ids; if one matches:
     - evidence.occurrences += 1
     - append "${runId}" to evidence.run_ids (keep newest 8)
     - evidence.last_seen = "${runId}", extracted_at = "${runId}"
     - refine detail/confidence/tags if this run sharpens it
   else append a NEW record: evidence.occurrences=1, first_seen=last_seen="${runId}",
     extracted_at="${runId}", status="active", superseded_by=null.
B. SUPERSEDE: if a prior record is contradicted by this run, set status="superseded" — do NOT delete.
C. COMPACT: if active records exceed ${MAX_ACTIVE}, retire the lowest-confidence /
   lowest-occurrence ones to status="retired" until <= ${MAX_ACTIVE} active.
D. Emit ONLY records (one JSON object per line; no array wrapper, no trailing comma).
   Preserve every record you did NOT touch VERBATIM (same key order, same bytes).
WRITE RELIABLY:
1. Write({ file_path: "${kbFile}", content: <full new file: newline-separated JSON objects> })
2. Bash("test -s '${kbFile}' && echo OK || echo MISSING")
3. If MISSING, rewrite via quoted heredoc: Bash("cat > '${kbFile}' <<'KB_EOF'\\n<full content>\\nKB_EOF")
4. Validate every line parses: Bash("jq -c . '${kbFile}' >/dev/null && echo VALID || echo INVALID")
5. Bash("wc -l < '${kbFile}'")  → total_lines
6. Count active records (status="active"); optionally cross-check with a grep.
Return { updated: true, total_lines: <wc -l>, active: <active count>, new_ids: [<ids appended this run>] }.`,
    { label: "extract-knowledge", phase: "Persist", model: "sonnet",
      schema: { type: "object", properties: {
        updated: { type: "boolean" },
        total_lines: { type: "number", description: "Line count from wc -l" },
        active: { type: "number", description: "Approx count of active records" },
        new_ids: { type: "array", items: { type: "string" } },
      }, required: ["updated", "total_lines"] } },
  )
  const lines = Number(extract?.total_lines) || 0
  if (extract?.updated && lines > 0) {
    log(`Knowledge: ${lines} record(s) (active≈${extract.active ?? "?"}) → ${kbFile}`)
  } else {
    log(`WARNING: knowledge extract did not verify (lines=${lines}) — run continues.`)
  }
  return extract
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lane: LINT (inlined — MLX-specific structural integrity)
// Complementary to review-optimize's semantic review: pyflakes catches NameError-class
// latent bugs the LLM review misses; check-model + self-test guard the hardcoded-name
// reference chains (model manifest compatible_with, self-test registry + aliases).
// Read-only by design — never edits code, so always parallel-safe with the review lane.
// ═══════════════════════════════════════════════════════════════════════════════

async function runLintLane(opts) {
  const lint = await agent(
    `Run three READ-ONLY MLX structural-integrity checks and triage the results.
Repo root: ${PROJECT_ROOT}. MLX dir: ${MLX_DIR}. Python venv: ${PYTHON}.
Clear caches first to avoid stale-bytecode false failures.

STEP 0 — clear pytest bytecode cache:
  Bash("find '${MLX_DIR}/app' -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null; echo cleared")

STEP 1 — pyflakes real-bug hunt (NameError-class latent bugs semantic review misses):
  Bash("cd '${MLX_DIR}' && '${PYTHON}' -m pyflakes app/ 2>&1 || true")
  Triage the output. This repo's KNOWN FALSE-POSITIVES to DROP (do not report):
    - unused imports / 'imported but unused'  (noise)
    - f-string without placeholders / 'is' with literal  (noise)
    - string annotations referencing names defined later in TYPE-checking context
  KEEP only REAL latent bugs: undefined name (NameError), missing import (used but not
  imported — but NOT ones that are lazy-imported inside functions or closed-over), missing
  function/def referenced at call site, redefinition-generates runtime error. When unsure
  whether a name is a lazy import or closure var, treat as false-positive (drop it).
  Capture each real bug: { file (path under app/), line (number), msg, severity: "high"|"medium"|"low" }.

STEP 2 — model manifest integrity:
  Bash("'${PYTHON}' '${RUN_PY}' check-model 2>&1 | tail -40 || true")
  checkModelOk = true if the manifest validates (no missing/broken model references,
  compatible_with chains resolve); false if it reports missing models or broken references.
  Capture a short checkModelMsg (<=160 chars) — OK summary or the first failure line.

STEP 3 — self-test registry integrity (CPU-only pytest, guards hardcoded-name cascade):
  Bash("cd '${MLX_DIR}' && '${PYTHON}' -m pytest app/tests/test_selftest_integrity.py -q 2>&1 | tail -25 || true")
  selftestOk = true if all tests pass; false if any fail. Capture a short selftestMsg.

Then summarize in <=200 chars: how many pyflakes real bugs, whether the two gates passed.
Never EDIT anything — this lane is read-only. If a command is missing/nonexistent, report
that gate as ok:false with a clear msg rather than failing.
Return the structured object.`,
    { label: "lint-mlx-integrity", phase: "Run", model: "sonnet",
      schema: { type: "object", properties: {
        pyflakesIssues: {
          type: "array",
          items: { type: "object", properties: {
            file: { type: "string" }, line: { type: "number" },
            msg: { type: "string" }, severity: { type: "string", enum: ["high", "medium", "low"] },
          }, required: ["file", "msg", "severity"] },
        },
        pyflakesRealCount: { type: "number", description: "Count of real bugs (len of pyflakesIssues)" },
        checkModelOk: { type: "boolean" },
        checkModelMsg: { type: "string" },
        selftestOk: { type: "boolean" },
        selftestMsg: { type: "string" },
        summary: { type: "string", description: "<=200 char summary" },
      }, required: ["pyflakesRealCount", "checkModelOk", "selftestOk", "summary"] } },
  )
  const real = lint?.pyflakesRealCount ?? 0
  const cm = lint?.checkModelOk ? "ok" : "FAIL"
  const st = lint?.selftestOk ? "ok" : "FAIL"
  log(`Lint lane: pyflakes real bugs=${real} | check-model=${cm} | self-test=${st}`)
  return lint
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase: Resolve
// ═══════════════════════════════════════════════════════════════════════════════

phase("Resolve")

// Timestamp (no Date.now() in workflows).
const RUN_TIMESTAMP = await agent(
  `Return the current timestamp in ISO format with colons replaced by dashes for filename safety.
  Run: Bash("date -u +%Y-%m-%dT%H-%M-%S")
  Return { timestamp: "<the output>" }.`,
  { label: "timestamp", phase: "Resolve", model: "haiku",
    schema: { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] } },
)
const RUN_ID = RUN_TIMESTAMP?.timestamp || "unknown"

// ONE knowledge base for the whole run.
const knowledge = await loadKnowledge(KB_FILE)
const knowledgeDigest = knowledge?.digest || ""

// Dirty-tree guard: if the user requested fixes but the git working tree has
// uncommitted changes, DOWNGRADE to review-only. A concurrent session's WIP
// would otherwise be swept into the review-optimize git-stash/commit flow
// (see concurrent-session-sweeps-working-tree / verify-dirty-file-source-before-revert).
let fixEnabled = FIX_REQ
let dirtyTree = false
if (FIX_REQ) {
  const treeCheck = await agent(
    `Check whether the git working tree at ${PROJECT_ROOT} has uncommitted changes.
1. Bash("cd '${PROJECT_ROOT}' && git status --porcelain")
2. Ignore the ComfyUI submodule line if present (submodule noise, unrelated).
3. dirty = true if any OTHER tracked file shows as modified/staged.`,
    { label: "dirty-tree-check", phase: "Resolve", model: "haiku",
      schema: { type: "object", properties: {
        dirty: { type: "boolean", description: "true if git status has uncommitted tracked changes" },
        summary: { type: "string", description: "short git status --porcelain summary" },
      }, required: ["dirty"] } },
  )
  dirtyTree = treeCheck?.dirty === true
  if (dirtyTree) {
    fixEnabled = false
    log(`⚠ Dirty git tree (${treeCheck?.summary || "uncommitted changes"}). fix:true downgraded to review-only to avoid colliding with concurrent WIP. Commit/stash your work, then re-run with fix:true.`)
  }
}

if (LANES.length === 0) {
  LANES = ["review", "lint"]
  DO_REVIEW = true
  DO_LINT = true
  log(`No valid lanes parsed — defaulting to [review, lint].`)
}

log(`Unified MLX self-improve — lanes: [${LANES.join(", ")}] | effort: ${EFFORT} | fix: ${fixEnabled}`)

markPhase("resolve", "completed")

// ══ Phase: Run ════════════════════════════════════════════════════════════════

phase("Run")

let reviewResult = null
let lintResult   = null

// Both lanes run in parallel: the lint lane is strictly read-only (no edits, no
// git-stash), so it never collides with review-optimize's fix flow even when
// fix:true. Each lane is independently fault-tolerant (catch → null, run continues).
const thunks = []
if (DO_REVIEW) {
  thunks.push(() =>
    workflow("mlx-movie-director-review-optimize", {
      effort: EFFORT, fix: fixEnabled, resume: RESUME,
      ...(FOCUS ? { focus: FOCUS } : {}),
      ...(FILES ? { files: FILES } : {}),
    }).then((r) => {
      log(`  review lane done — verified findings: ${r?.findings?.verified ?? "?"}`)
      return r
    }).catch((e) => { log(`  review lane FAILED: ${e?.message || e}`); markPhase("run", "failed"); return null }),
  )
}
if (DO_LINT) {
  thunks.push(() =>
    runLintLane({ knowledgeDigest, runId: RUN_ID })
      .catch((e) => { log(`  lint lane FAILED: ${e?.message || e}`); markPhase("run", "failed"); return null }),
  )
}

if (thunks.length === 1) {
  const only = await thunks[0]()
  if (DO_REVIEW && !DO_LINT) reviewResult = only
  else lintResult = only
} else if (thunks.length > 1) {
  log(`▸ Lanes 1-${thunks.length}/${thunks.length}: review + lint in parallel`)
  const results = await parallel(thunks)
  let ri = 0
  if (DO_REVIEW) reviewResult = results[ri++]
  if (DO_LINT)   lintResult   = results[ri++]
}

markPhase("run", "completed")

// ══ Phase: Persist ════════════════════════════════════════════════════════════

phase("Persist")

// Merged signals for the unified history entry.
const reviewVerified = reviewResult?.findings?.verified ?? 0
const reviewNew      = reviewResult?.findings?.newFindings ?? reviewVerified
const reviewApplied  = reviewResult?.fixes?.applied ?? 0
const reviewRegress  = reviewResult?.fixes?.regressions ?? 0
const reviewOnly     = reviewResult?.fixes?.mode === "review-only" || !fixEnabled

const lintRealCount = lintResult?.pyflakesRealCount ?? 0
const checkModelOk  = lintResult?.checkModelOk ?? null
const selftestOk    = lintResult?.selftestOk ?? null

// Unified health scalar (lower = healthier) = ACTIONABLE code-health debt only:
// review verified findings (5 semantic dimensions) + pyflakes real bugs (NameError-class
// that semantic review misses). The two integrity gates (check-model / self-test) are
// pass/fail structural checks, tracked separately, NOT folded into openIssues.
const openIssues = reviewVerified + lintRealCount

// ── Delta from last run (openIssues trend) ──────────────────────────────────
let deltaStr = null
{
  const prevRun = await agent(
    `Read the most recent PRIOR MLX self-improve run (NOT this run) to get previous openIssues.
1. Bash("ls -t '${HISTORY_DIR}/' 2>/dev/null | grep '\\.json$' | grep -v '${RUN_ID}\\.json' | head -1")
   — this lists prior run files, EXCLUDING this run's own ${RUN_ID}.json.
2. If step 1 printed NOTHING (empty output) → this is the first run (no prior history). Return { found: false, openIssues: null }.
3. Otherwise Bash("cat '${HISTORY_DIR}/<the single filename printed by step 1>'")
4. Parse JSON. Compute prevOpenIssues = (result.review?.verified || 0) + (result.lint?.pyflakesRealCount || 0).
   If both components are absent, fall back to result.openIssues if present, else null.
Return { found: true, openIssues: <number> } or { found: false, openIssues: null }.`,
    { label: "prev-run-delta", phase: "Persist", model: "haiku",
      schema: { type: "object", properties: { found: { type: "boolean" }, openIssues: { type: "number" } }, required: ["found"] } },
  )
  if (prevRun?.found && prevRun.openIssues != null) {
    const d = openIssues - prevRun.openIssues
    deltaStr = d === 0 ? "=" : d < 0 ? `↓${Math.abs(d)}` : `↑${d}`
    log(`Delta: openIssues ${prevRun.openIssues} → ${openIssues} (${deltaStr})`)
  }
}

// Build annotated top findings (reused in Report).
const currentTopFindings = (reviewResult?.findings?.items || []).slice(0, 8).map((f) => ({
  id: f.id, severity: f.severity, dimension: f.dimension,
  file: f.file, line: f.line, title: f.title,
}))

const signals = {
  run_quality: phasesFailed.length === 0 ? (openIssues === 0 ? "clean" : "good") : "degraded",
  key_metric: `openIssues=${openIssues} [review:${reviewVerified} pyflakes:${lintRealCount}] gates: check-model=${checkModelOk === null ? "skip" : checkModelOk ? "ok" : "FAIL"}, self-test=${selftestOk === null ? "skip" : selftestOk ? "ok" : "FAIL"}`,
  delta_from_last: deltaStr,
  highlights: [
    DO_REVIEW ? `review: ${reviewVerified} verified finding(s)${fixEnabled ? ` → ${reviewApplied} fix(es) applied, ${reviewRegress} regression(s)` : " (review-only)"}` : null,
    DO_LINT ? `lint: ${lintRealCount} pyflakes real bug(s) | check-model=${checkModelOk === null ? "skip" : checkModelOk ? "ok" : "FAIL"} | self-test=${selftestOk === null ? "skip" : selftestOk ? "ok" : "FAIL"}` : null,
    FIX_REQ && dirtyTree ? "fix:true DOWNGRADED to review-only (dirty tree)" : null,
    deltaStr ? `trend: ${deltaStr} vs last run` : null,
  ].filter(Boolean),
  warnings: [
    ...(phasesFailed.length ? [`phases failed: ${phasesFailed.join(",")}`] : []),
    ...(FIX_REQ && dirtyTree ? ["concurrent WIP detected; fix deferred"] : []),
    ...(checkModelOk === false ? ["check-model manifest integrity FAILED"] : []),
    ...(selftestOk === false ? ["self-test registry integrity FAILED — hardcoded-name reference chain may be broken"] : []),
  ],
}

const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: NAME,
  started_at: RUN_ID,
  args: { lanes: LANES, effort: EFFORT, fix: fixEnabled, fixRequested: FIX_REQ, dirtyTree, focus: FOCUS, files: FILES },
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  tags: ["mlx", "python", "self-improve", "unified", ...(fixEnabled ? ["fix"] : ["review-only"])],
  result: {
    lanes: LANES,
    openIssues,
    review: reviewResult ? {
      verified: reviewVerified,
      newFindings: reviewNew,
      bySeverity: reviewResult.findings?.bySeverity || {},
      byDimension: reviewResult.findings?.byDimension || {},
      adversarialUpheld: reviewResult.adversarial?.upheld ?? null,
      fix: fixEnabled ? { applied: reviewApplied, regressions: reviewRegress } : { mode: "review-only" },
      topFindings: currentTopFindings,
    } : null,
    lint: lintResult ? {
      pyflakesRealCount: lintRealCount,
      pyflakesIssues: lintResult.pyflakesIssues || [],
      checkModelOk,
      selftestOk,
    } : null,
    reviewHistory: reviewResult?.history?.path || null,
  },
}

try {
  await saveHistory(HISTORY_DIR, INDEX_FILE, historyEntry, signals)
  log(`History: ${HISTORY_DIR}/${RUN_ID}.json`)
  await extractKnowledge(KB_FILE, RUN_ID, historyEntry.result, null)
  markPhase("persist", "completed")
} catch (e) {
  log(`Persist failed: ${e?.message || e}`)
  markPhase("persist", "failed")
}

// ══ Phase: Report ════════════════════════════════════════════════════════════

phase("Report")

const report = {
  workflow: NAME,
  runId: RUN_ID,
  lanes: LANES,
  effort: EFFORT,
  fixApplied: fixEnabled,
  fixDowngraded: FIX_REQ && dirtyTree,
  openIssues,
  deltaFromLast: deltaStr,
  review: reviewResult
    ? {
        filesScanned: reviewResult.scan?.totalFiles ?? null,
        verifiedFindings: reviewVerified,
        newFindings: reviewNew,
        suppressedFromPrior: reviewResult.findings?.suppressedFromPrior ?? 0,
        bySeverity: reviewResult.findings?.bySeverity || {},
        byDimension: reviewResult.findings?.byDimension || {},
        adversarialUpheld: reviewResult.adversarial?.upheld ?? null,
        adversarialRejected: reviewResult.adversarial?.rejected ?? null,
        fixes: fixEnabled
          ? { applied: reviewApplied, skipped: reviewResult.fixes?.skipped ?? 0, failed: reviewResult.fixes?.failed ?? 0, regressions: reviewRegress, restoreTriggered: reviewResult.restore?.triggered ?? false }
          : { mode: "review-only" },
        topFindings: currentTopFindings,
      }
    : null,
  lint: lintResult
    ? {
        pyflakesRealCount: lintRealCount,
        pyflakesIssues: lintResult.pyflakesIssues || [],
        checkModelOk,
        checkModelMsg: lintResult.checkModelMsg || null,
        selftestOk,
        selftestMsg: lintResult.selftestMsg || null,
        summary: lintResult.summary || null,
      }
    : null,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  phasesCompleted,
  phasesFailed,
}

log(`═ MLX self-improve ${RUN_ID} — openIssues=${openIssues}${deltaStr ? ` (${deltaStr})` : ""} | review:${reviewVerified}${fixEnabled ? `→${reviewApplied}fix` : ""} | pyflakes:${lintRealCount} | gates:${checkModelOk === null ? "-" : checkModelOk ? "cm✓" : "cm✗"}${selftestOk === null ? "" : selftestOk ? " st✓" : " st✗"}`)

return report
