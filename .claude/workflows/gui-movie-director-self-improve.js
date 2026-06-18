// GUI Movie Director Self-Improve — UNIFIED orchestrator
//
// One dynamic workflow to improve the Bun GUI Movie Director app from every
// angle. It sequences two complementary, already-tested sub-workflows and
// merges their results into a single health report:
//
//   1. gui-movie-director-review-optimize
//      Structural code health: correctness, type-safety, error-handling,
//      code-quality, security — multi-dimension review + adversarial verify +
//      optional git-stash-backed auto-fix.
//
//   2. gui-movie-director-schema-self-improve
//      Schema→CLI boundary: runtime-validates buildCliArgs() output against
//      run.py (the bug-prone surface check:schema can't see), aligns GUI
//      schemas to run.py (drift-fix), and raises test coverage.
//
// Why an orchestrator instead of merging the files: both children are large
// (84KB / 31KB), independently tested, each with its own persist/resume logic.
// `workflow()` reuses them untouched — this file stays thin (~200 lines) and
// the unification is the single entry point + merged report.
//
// Modes (selected by args):
//
//   ROUTINE SCAN (default — cheap, collision-safe, review-only):
//     Workflow({ scriptPath: ".../gui-movie-director-self-improve.js" })
//       → effort:low review-only scan + schema runtime validation.
//         No edits, no git stash → safe to run anytime, even with concurrent WIP.
//
//   SINGLE LANE:
//     args: { lanes: ["review"] }    // structural code review only
//     args: { lanes: ["schema"] }    // schema→CLI boundary only
//
//   APPLY FIXES (needs a CLEAN git tree — refuses fix if dirty):
//     args: { effort: "medium", fix: true }
//       → review-optimize applies verified fixes (git-stash rollback on
//         regression). The dirty-tree guard downgrades to review-only if
//         another session has WIP, to avoid sweeping concurrent work.
//
//   DEEP:
//     args: { effort: "high", fix: true }
//       → review-optimize scans ALL files (not just changed) + fixes everything;
//         schema-self-improve runs runtime+drift+coverage.
//
//   FOCUS / TARGET:
//     args: { focus: "security" }              // review dimension
//     args: { files: ["api/ws.ts", ...] }      // review only these files
//     args: { target: "t2i" }                  // schema: focus one schema file
//     args: { objective: "both" }              // schema: runtime+drift+coverage

export const meta = {
  name: "gui-movie-director-self-improve",
  description:
    "Unified self-improve loop for the Bun GUI Movie Director app — sequences structural code review (correctness/types/error-handling/quality/security) AND schema→CLI boundary validation (buildCliArgs→run.py, drift, coverage) AND UX screenshot analysis (playwright→VLM→fix loop) via three sub-workflows, merging all into one health report. Lane-selectable; review-only by default (collision-safe).",
  whenToUse:
    "One workflow to improve gui-movie-director from every angle. Default = cheap routine scan: review-optimize effort:low (review-only) + schema-self-improve objective:runtime (buildCliArgs→run.py boundary). Escalate with effort:'medium'+fix:true to auto-apply verified fixes (refuses fix if the git tree is dirty, to avoid colliding with concurrent WIP). lanes:['review'|'schema'|'ux'] picks one or more; lanes:'all' runs all three; focus/files/target narrow scope. UX lane requires GUI server at localhost:3099 + LM Studio; fails gracefully if server is down.",
  phases: [
    { title: "Resolve", detail: "Normalize args, dirty-tree guard (refuse fix if dirty), timestamp" },
    { title: "Run",     detail: "Sequential lanes via sub-workflows: structural review → schema/boundary validation → UX screenshot analysis" },
    { title: "Persist", detail: "Unified history entry + cross-workflow index" },
    { title: "Report",  detail: "Merged health report: review findings + drift + coverage + UX scores + fix status" },
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

// Lanes: which sub-workflows to run. Default: review + schema. A bare string
// lanes:"review" is accepted for convenience. lanes:"all" expands to all three.
const LANES_RAW_INPUT = Array.isArray(A.lanes) ? A.lanes
  : (A.lanes === "all" ? ["review", "schema", "ux"]
  : (A.lanes ? [A.lanes] : ["review", "schema"]))
// UX_EXPLICIT: user passed a lanes arg → respect it exactly, no auto-detect.
const UX_EXPLICIT = A.lanes !== undefined
let LANES = LANES_RAW_INPUT.filter((l) => ["review", "schema", "ux"].includes(l))
let DO_REVIEW = LANES.includes("review")
let DO_SCHEMA  = LANES.includes("schema")
let DO_UX      = LANES.includes("ux")

// Shared / forwarded knobs.
const EFFORT    = ["low", "medium", "high"].includes(A.effort) ? A.effort : "low"
const FIX_REQ   = A.fix === true                       // user REQUESTED fixes
const OBJECTIVE = String(A.objective || "runtime")     // schema lane objective
const FOCUS     = A.focus || null                       // review dimension
const FILES     = Array.isArray(A.files) ? A.files : null   // review file scope
const TARGET    = A.target || null                      // schema single-file focus
const RESUME    = A.resume || "auto"                    // review resume mode

// UX-lane-specific knobs (only used when DO_UX).
const UX_DRY_RUN   = A.uxDryRun  !== undefined ? A.uxDryRun  : (A.dryRun ?? false)
const UX_MAX_ITERS = typeof A.uxMaxIters === "number" ? A.uxMaxIters : 3
const UX_VIEWS     = Array.isArray(A.uxViews) ? A.uxViews : null

// ── Paths ────────────────────────────────────────────────────────────────────
// NOTE: the workflow runtime strips `export const meta` — top-level `meta.*`
// refs throw "meta is not defined". Mirror the name into a plain const instead.
const NAME         = "gui-movie-director-self-improve"
const PROJECT_ROOT = "/Users/huangziyu/proj/video_generation"
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
// (mirrors .claude/workflows/_shared-patterns.md verbatim)
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

// ══ Phase: Resolve ════════════════════════════════════════════════════════════

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

// Load this orchestrator's own committed knowledge (meta-lessons: effort/429
// gotchas, fix-on-dirty-tree, openIssues trend). Sub-workflows load their own.
const knowledge = await loadKnowledge(KB_FILE)
const knowledgeDigest = knowledge?.digest || ""

// Dirty-tree guard: if the user requested fixes but the git working tree has
// uncommitted changes, DOWNGRADE to review-only. A concurrent session's WIP
// would otherwise be swept into the review-optimize git-stash/commit flow
// (see concurrent-session-sweeps-working-tree / verify-dirty-file-source-before-revert).
let fixEnabled = FIX_REQ
let dirtyTree = false
if (FIX_REQ) {
  const TREE_CHECK_SCHEMA = {
    type: "object",
    properties: {
      dirty: { type: "boolean", description: "true if git status has uncommitted tracked changes" },
      summary: { type: "string", description: "short git status --porcelain summary" },
    },
    required: ["dirty"],
  }
  const treeCheck = await agent(
    `Check whether the git working tree at ${PROJECT_ROOT} has uncommitted changes.
1. Bash("cd '${PROJECT_ROOT}' && git status --porcelain")
2. Ignore the ComfyUI submodule line if present (submodule noise, unrelated).
3. dirty = true if any OTHER tracked file shows as modified/staged.`,
    { label: "dirty-tree-check", phase: "Resolve", model: "haiku", schema: TREE_CHECK_SCHEMA },
  )
  dirtyTree = treeCheck?.dirty === true
  if (dirtyTree) {
    fixEnabled = false
    log(`⚠ Dirty git tree (${treeCheck?.summary || "uncommitted changes"}). fix:true downgraded to review-only to avoid colliding with concurrent WIP. Commit/stash your work, then re-run with fix:true.`)
  }
}

// Auto-detect GUI server → opportunistically add UX lane when server is up
// and the user didn't explicitly specify lanes (so we don't override their intent).
if (!UX_EXPLICIT && !DO_UX) {
  const srvDetect = await agent(
    `Check if the GUI dev server is running at port 3099.
Bash("lsof -ti :3099 2>/dev/null | head -1")
Return { running: <true if output is non-empty>, pid: "<trimmed output>" }.`,
    { label: "server-auto-detect", phase: "Resolve", model: "haiku",
      schema: { type: "object", properties: { running: { type: "boolean" }, pid: { type: "string" } }, required: ["running"] } },
  )
  if (srvDetect?.running) {
    LANES = [...LANES, "ux"]
    DO_UX = true
    log(`Auto-detected GUI server at :3099 (pid=${srvDetect.pid || "?"}) → UX lane added (dryRun=${UX_DRY_RUN}, maxIters=${UX_MAX_ITERS})`)
  }
}

log(`Unified GUI self-improve — lanes: [${LANES.join(", ")}] | effort: ${EFFORT} | fix: ${fixEnabled} | objective: ${OBJECTIVE}${DO_UX ? ` | ux: dryRun=${UX_DRY_RUN} maxIters=${UX_MAX_ITERS}` : ""}`)

markPhase("resolve", "completed")

// ══ Phase: Run ════════════════════════════════════════════════════════════════

phase("Run")

let reviewResult = null
let schemaResult = null
let uxResult     = null

const TOTAL_LANES = LANES.length
let laneIdx = 0

// Review + schema can run in parallel when fix is disabled — both are purely
// read-only in that mode (no git-stash, no file edits). When fix:true, run
// sequentially: review-optimize uses git-stash which would collide with
// concurrent schema edits to the same working tree.
if (!fixEnabled && DO_REVIEW && DO_SCHEMA) {
  log(`▸ Lanes 1-2/${TOTAL_LANES}: review + schema in parallel (review-only — safe to fan out)`)
  const [rr, sr] = await parallel([
    () => workflow("gui-movie-director-review-optimize", {
      effort: EFFORT, fix: false, resume: RESUME,
      ...(FOCUS ? { focus: FOCUS } : {}),
      ...(FILES ? { files: FILES } : {}),
    }).catch((e) => { log(`  review lane FAILED: ${e?.message || e}`); markPhase("run", "failed"); return null }),
    () => workflow("gui-movie-director-schema-self-improve", {
      objective: OBJECTIVE,
      ...(TARGET ? { target: TARGET } : {}),
    }).catch((e) => { log(`  schema lane FAILED: ${e?.message || e}`); markPhase("run", "failed"); return null }),
  ])
  reviewResult = rr
  schemaResult = sr
  laneIdx = 2
  log(`  review done — verified: ${reviewResult?.findings?.verified ?? "?"}`)
  log(`  schema done — ${schemaResult?.summary ?? "(no summary)"}`)
} else {
  // Sequential: fix:true, or only one of the two lanes is active.
  if (DO_REVIEW) {
    log(`▸ Lane ${++laneIdx}/${TOTAL_LANES}: structural code review (gui-movie-director-review-optimize)`)
    try {
      reviewResult = await workflow("gui-movie-director-review-optimize", {
        effort: EFFORT, fix: fixEnabled, resume: RESUME,
        ...(FOCUS ? { focus: FOCUS } : {}),
        ...(FILES ? { files: FILES } : {}),
      })
      log(`  review lane done — verified findings: ${reviewResult?.findings?.verified ?? "?"}`)
    } catch (e) {
      log(`  review lane FAILED: ${e?.message || e}`)
      markPhase("run", "failed")
    }
  }

  if (DO_SCHEMA) {
    log(`▸ Lane ${++laneIdx}/${TOTAL_LANES}: schema→CLI boundary (gui-movie-director-schema-self-improve)`)
    try {
      schemaResult = await workflow("gui-movie-director-schema-self-improve", {
        objective: OBJECTIVE,
        ...(TARGET ? { target: TARGET } : {}),
      })
      log(`  schema lane done — ${schemaResult?.summary ?? "(no summary)"}`)
    } catch (e) {
      log(`  schema lane FAILED: ${e?.message || e}`)
      markPhase("run", "failed")
    }
  }
}

// Lane: UX screenshot analysis + VLM scoring + fix loop.
// Non-fatal — gracefully skipped if the GUI server is not running.
if (DO_UX) {
  log(`▸ Lane ${++laneIdx}/${TOTAL_LANES}: UX screenshot analysis (gui-movie-director-ux-self-improve)`)
  try {
    uxResult = await workflow(
      "gui-movie-director-ux-self-improve",
      {
        dryRun:   UX_DRY_RUN,
        maxIters: UX_MAX_ITERS,
        ...(UX_VIEWS ? { views: UX_VIEWS } : {}),
      },
    )
    log(`  ux lane done — ${uxResult?.totalIssues ?? "?"} issue(s), ${uxResult?.issuesFixed ?? "?"} fixed, score: ${uxResult?.avgUxScoreBefore?.toFixed(1) ?? "?"}→${uxResult?.avgUxScoreAfter?.toFixed(1) ?? "?"}`)
  } catch (e) {
    log(`  ux lane FAILED (non-fatal — GUI server may not be running): ${e?.message || e}`)
    // uxResult stays null; run continues
  }
}

if (LANES.length === 0) {
  log("⚠ No valid lanes selected (must include 'review', 'schema', and/or 'ux'). Nothing to run.")
}

markPhase("run", "completed")

// ══ Phase: Persist ════════════════════════════════════════════════════════════

phase("Persist")

// Merged signals for the unified history entry.
const reviewVerified = reviewResult?.findings?.verified ?? 0
const reviewNew      = reviewResult?.findings?.newFindings ?? reviewVerified
const reviewApplied  = reviewResult?.fixes?.applied ?? 0
const reviewRegress  = reviewResult?.fixes?.regressions ?? 0
const reviewOnly     = reviewResult?.fixes?.mode === "review-only"

const schemaRuntimeErr   = schemaResult?.runtimeErrors ?? 0
const schemaRuntimeFind  = schemaResult?.runtimeFindings ?? 0
const schemaDriftRem     = schemaResult?.driftRemaining ?? 0
const schemaCovDelta     = schemaResult?.delta ?? "n/a"

const uxTotalIssues = uxResult?.totalIssues ?? 0
const uxIssuesFixed = uxResult?.issuesFixed ?? 0
const uxScoreBefore = uxResult?.avgUxScoreBefore ?? null
const uxScoreAfter  = uxResult?.avgUxScoreAfter ?? null

// Unified health scalar for trend tracking: count of open issues across all
// surfaces (lower = healthier). review verified findings + schema runtime
// errors + remaining drift + ux open issues. Fix runs should drive this down.
const openIssues = reviewVerified + schemaRuntimeErr + schemaDriftRem + uxTotalIssues

// ── Delta from last run ─────────────────────────────────────────────────────
// Read the most recent prior history entry to compute openIssues trend (↑/↓/=).
let deltaStr = null
{
  const prevRun = await agent(
    `Read the most recent prior self-improve run from history to get previous openIssues.
1. Bash("ls -t '${HISTORY_DIR}/' 2>/dev/null | grep '\\.json$'")
2. Find the FIRST filename that is NOT '${RUN_ID}.json'. If none → { found: false, openIssues: null }.
3. Bash("cat '${HISTORY_DIR}/<that filename>'")
4. Parse JSON. Try result.openIssues first; if missing, parse signals.key_metric
   (format: "openIssues=N (...)") to extract N.
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

// ── Chronic issue annotation ────────────────────────────────────────────────
// Tag findings that also appeared in the previous run (same file + title).
// Chronic issues have survived at least one review cycle without being fixed.
let chronicKeys = new Set()
{
  const prevFindings = await agent(
    `Load topFindings from the most recent prior self-improve run.
1. Bash("ls -t '${HISTORY_DIR}/' 2>/dev/null | grep '\\.json$'")
2. Find the FIRST filename that is NOT '${RUN_ID}.json'. If none → { findings: [] }.
3. Bash("cat '${HISTORY_DIR}/<that filename>'")
4. Parse JSON. Extract the topFindings array — it may be at result.topFindings or
   at the root topFindings field; look inside result.review.topFindings too.
5. Return { findings: [{ file: "...", title: "..." }, ...] } — only file and title per entry.`,
    { label: "prev-findings-for-chronic", phase: "Persist", model: "haiku",
      schema: { type: "object", properties: {
        findings: { type: "array", items: { type: "object",
          properties: { file: { type: "string" }, title: { type: "string" } } } },
      }, required: ["findings"] } },
  )
  for (const f of (prevFindings?.findings || [])) {
    if (f.file && f.title) chronicKeys.add(`${f.file}:${f.title}`)
  }
  if (chronicKeys.size > 0) log(`Chronic keys from prior run: ${chronicKeys.size}`)
}

// Build annotated topFindings (reused in Report phase below).
const currentTopFindings = (reviewResult?.findings?.items || []).slice(0, 8).map((f) => ({
  id: f.id, severity: f.severity, dimension: f.dimension,
  file: f.file, line: f.line, title: f.title,
  chronic: chronicKeys.has(`${f.file}:${f.title}`),
}))
const chronicCount = currentTopFindings.filter((f) => f.chronic).length

const signals = {
  run_quality: phasesFailed.length === 0 ? (openIssues === 0 ? "clean" : "good") : "degraded",
  key_metric: `openIssues=${openIssues} (review:${reviewVerified} schemaErr:${schemaRuntimeErr} drift:${schemaDriftRem} ux:${uxTotalIssues})`,
  delta_from_last: deltaStr,
  highlights: [
    DO_REVIEW  ? `review: ${reviewVerified} verified finding(s)${fixEnabled ? ` → ${reviewApplied} fix(es) applied, ${reviewRegress} regression(s)` : " (review-only)"}` : null,
    DO_SCHEMA  ? `schema: ${schemaRuntimeFind} runtime finding(s), ${schemaRuntimeErr} error(s), drift→${schemaDriftRem}, coverage Δ=${schemaCovDelta}` : null,
    DO_UX && uxResult  ? `ux: ${uxTotalIssues} issue(s), ${uxIssuesFixed} fixed, score: ${uxScoreBefore?.toFixed(1) ?? "?"}→${uxScoreAfter?.toFixed(1) ?? "?"}` : null,
    DO_UX && !uxResult ? "ux: lane failed (server may be down) — skipped" : null,
    FIX_REQ && dirtyTree ? "fix:true DOWNGRADED to review-only (dirty tree)" : null,
    chronicCount > 0 ? `chronic: ${chronicCount} finding(s) recurring from prior run (unfixed)` : null,
    deltaStr ? `trend: ${deltaStr} vs last run` : null,
  ].filter(Boolean),
  warnings: [
    ...(phasesFailed.length ? [`phases failed: ${phasesFailed.join(",")}`] : []),
    ...(FIX_REQ && dirtyTree ? ["concurrent WIP detected; fix deferred"] : []),
    ...(DO_UX && !uxResult ? ["ux lane did not complete (server down or crash)"] : []),
    ...(chronicCount > 0 ? [`${chronicCount} chronic finding(s) — consider fix:true to clear backlog`] : []),
  ],
}

const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: NAME,
  started_at: RUN_ID,
  args: { lanes: LANES, effort: EFFORT, fix: fixEnabled, objective: OBJECTIVE, fixRequested: FIX_REQ, dirtyTree },
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  tags: ["gui", "bun", "self-improve", "unified", ...(fixEnabled ? ["fix"] : ["review-only"])],
  result: {
    lanes: LANES,
    openIssues,
    review: reviewResult ? {
      verified: reviewVerified,
      newFindings: reviewNew,
      bySeverity: reviewResult.findings?.bySeverity || {},
      fix: fixEnabled ? { applied: reviewApplied, regressions: reviewRegress } : { mode: "review-only" },
    } : null,
    schema: schemaResult ? {
      runtimeFindings: schemaRuntimeFind,
      runtimeErrors: schemaRuntimeErr,
      driftRemaining: schemaDriftRem,
      coverageDelta: schemaCovDelta,
    } : null,
    ux: uxResult ? {
      viewsSurveyed:  uxResult.viewsSurveyed,
      totalIssues:    uxTotalIssues,
      issuesFixed:    uxIssuesFixed,
      avgScoreBefore: uxScoreBefore,
      avgScoreAfter:  uxScoreAfter,
    } : null,
    reviewHistory: reviewResult?.history?.path || null,
    schemaHistory: "gui-movie-director-schema-self-improve/iterations.jsonl",
  },
}

// Code-knowledge record — feeds the shared KB's code-health surface
// (knowledge-base/code/), the producer side of the integration with the
// generation knowledge base. Built from the already-computed lane results.
const codeRecord = {
  runId: RUN_ID,
  workflow: NAME,
  lanes: LANES,
  effort: EFFORT,
  fixApplied: fixEnabled,
  openIssues,
  findings: {
    verified: reviewVerified,
    newFindings: reviewNew,
    bySeverity: reviewResult?.findings?.bySeverity || {},
    byDimension: reviewResult?.findings?.byDimension || {},
  },
  fixes: fixEnabled
    ? { applied: reviewApplied, regressions: reviewRegress }
    : { mode: "review-only" },
  schema: {
    runtimeErrors: schemaRuntimeErr,
    runtimeFindings: schemaRuntimeFind,
    driftRemaining: schemaDriftRem,
  },
  ux: uxResult ? { totalIssues: uxTotalIssues, issuesFixed: uxIssuesFixed } : null,
  // Files with verified findings this run — drives the "most bug-prone" trend
  // across runs (independent of whether they were fixed).
  filesTouched: reviewResult?.findings?.items
    ? [...new Set(reviewResult.findings.items.map((f) => f.file).filter(Boolean))]
    : [],
  timestamp: RUN_ID,
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

// Code-knowledge contribution — independent of history persist: a KB append
// failure must not fail the run. The workflow can't import TS (sandboxed JS),
// so it writes the record to a temp file + runs the canonical append script
// (single source of truth for the record shape + index in lib/code-knowledge).
let knowledgeAppended = false
try {
  const codeRecordJson = JSON.stringify(codeRecord)
  await agent(
    `Append this self-improve run as a code-knowledge record to the shared knowledge base.
1. Write the record JSON to a temp file:
   Write({ file_path: "/tmp/code-knowledge-record.json", content: <JSON below> })
   ${codeRecordJson}
2. Append it via the canonical module (updates records.jsonl + index.json):
   Bash("bun run '${PROJECT_ROOT}/bun/gui-movie-director/scripts/code-knowledge-append.ts' /tmp/code-knowledge-record.json")
Return { appended: true }.`,
    { label: "code-knowledge-append", phase: "Persist", model: "haiku" },
  )
  log(`Code-knowledge: record appended to knowledge-base/code/ (openIssues=${openIssues})`)
  knowledgeAppended = true
} catch (e) {
  log(`Code-knowledge append failed (non-fatal): ${e?.message || e}`)
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
  review: reviewResult
    ? {
        filesScanned: reviewResult.scan?.totalFiles ?? null,
        verifiedFindings: reviewVerified,
        newFindings: reviewNew,
        suppressedFromPrior: reviewResult.findings?.suppressedFromPrior ?? 0,
        bySeverity: reviewResult.findings?.bySeverity || {},
        byDimension: reviewResult.findings?.byDimension || {},
        adversarialUpheld: reviewResult.adversarial?.upheld ?? null,
        fixes: fixEnabled
          ? { applied: reviewApplied, skipped: reviewResult.fixes?.skipped ?? 0, failed: reviewResult.fixes?.failed ?? 0, regressions: reviewRegress }
          : { mode: "review-only" },
        topFindings: currentTopFindings,
      }
    : null,
  schema: schemaResult
    ? {
        objective: schemaResult.objective,
        runtimeFindings: schemaRuntimeFind,
        runtimeErrors: schemaRuntimeErr,
        driftBaseline: schemaResult.baselineDrift ?? null,
        driftRemaining: schemaDriftRem,
        coverageBaseline: schemaResult.baseline ?? null,
        coverageFinal: schemaResult.final ?? null,
        coverageDelta: schemaCovDelta,
        summary: schemaResult.summary,
      }
    : null,
  ux: uxResult
    ? {
        viewsSurveyed:  uxResult.viewsSurveyed,
        totalIssues:    uxTotalIssues,
        issuesFixed:    uxIssuesFixed,
        issuesSkipped:  uxResult.issuesSkipped,
        avgScoreBefore: uxScoreBefore,
        avgScoreAfter:  uxScoreAfter,
        topIssues: (uxResult.analyses || [])
          .flatMap((a) => a.issues || [])
          .filter((i) => i.severity === "high")
          .slice(0, 5)
          .map((i) => ({ id: i.id, severity: i.severity, title: i.title, affectedFile: i.affectedFile })),
      }
    : DO_UX
      ? { skipped: true, reason: "server not running or crash" }
      : null,
  signals,
  knowledgeContribution: knowledgeAppended
    ? { appended: true, openIssues, kbPath: "knowledge-base/code/records.jsonl" }
    : { appended: false },
  nextStep:
    fixEnabled
      ? (reviewRegress > 0 ? "Regressions detected — review-optimize should have auto-reverted the offending files via git checkout/rm. Inspect the tree." : "Fixes applied. Re-run routine scan to confirm openIssues dropped.")
      : FIX_REQ && dirtyTree
        ? "Tree was dirty so fixes were skipped. Commit/stash concurrent WIP, then re-run with fix:true to apply the verified findings above."
        : DO_UX && !uxResult
          ? "UX lane did not run (GUI server may be down). Start the server with `cd bun/gui-movie-director && bun run dev`, then re-run with lanes:'all'."
          : "Review-only scan complete. To apply verified fixes, re-run with args { effort:'medium', fix:true } on a clean git tree.",
}

return report
