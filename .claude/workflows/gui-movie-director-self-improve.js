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
    "Unified self-improve loop for the Bun GUI Movie Director app — sequences structural code review (correctness/types/error-handling/quality/security) AND schema→CLI boundary validation (buildCliArgs→run.py, drift, coverage) via two sub-workflows, merging both into one health report. Lane-selectable; review-only by default (collision-safe).",
  whenToUse:
    "One workflow to improve gui-movie-director from every angle. Default = cheap routine scan: review-optimize effort:low (review-only) + schema-self-improve objective:runtime (buildCliArgs→run.py boundary). Escalate with effort:'medium'+fix:true to auto-apply verified fixes (refuses fix if the git tree is dirty, to avoid colliding with concurrent WIP). lanes:['review'|'schema'] picks one; focus/files/target narrow scope.",
  phases: [
    { title: "Resolve", detail: "Normalize args, dirty-tree guard (refuse fix if dirty), timestamp" },
    { title: "Run",     detail: "Sequential lanes via sub-workflows: structural review → schema/boundary validation" },
    { title: "Persist", detail: "Unified history entry + cross-workflow index" },
    { title: "Report",  detail: "Merged health report: review findings + drift + coverage + fix status" },
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

// Lanes: which sub-workflows to run. Default both. A bare string lanes:"review"
// is accepted for convenience.
const LANES_RAW = Array.isArray(A.lanes) ? A.lanes : (A.lanes ? [A.lanes] : ["review", "schema"])
const LANES = LANES_RAW.filter((l) => l === "review" || l === "schema")
const DO_REVIEW = LANES.includes("review")
const DO_SCHEMA  = LANES.includes("schema")

// Shared / forwarded knobs.
const EFFORT    = ["low", "medium", "high"].includes(A.effort) ? A.effort : "low"
const FIX_REQ   = A.fix === true                       // user REQUESTED fixes
const OBJECTIVE = String(A.objective || "runtime")     // schema lane objective
const FOCUS     = A.focus || null                       // review dimension
const FILES     = Array.isArray(A.files) ? A.files : null   // review file scope
const TARGET    = A.target || null                      // schema single-file focus
const RESUME    = A.resume || "auto"                    // review resume mode

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

log(`Unified GUI self-improve — lanes: [${LANES.join(", ")}] | effort: ${EFFORT} | fix: ${fixEnabled} | objective: ${OBJECTIVE}`)

markPhase("resolve", "completed")

// ══ Phase: Run ════════════════════════════════════════════════════════════════

phase("Run")

let reviewResult = null
let schemaResult = null

// Lane 1: structural code review. Sequential with the schema lane — both spawn
// many agents and review-optimize's git-stash (when fix) would collide with
// schema edits if run in parallel.
if (DO_REVIEW) {
  log("▸ Lane 1/2: structural code review (gui-movie-director-review-optimize)")
  try {
    reviewResult = await workflow(
      "gui-movie-director-review-optimize",
      {
        effort: EFFORT,
        fix: fixEnabled,
        resume: RESUME,
        ...(FOCUS ? { focus: FOCUS } : {}),
        ...(FILES ? { files: FILES } : {}),
      },
    )
    log(`  review lane done — verified findings: ${reviewResult?.findings?.verified ?? "?"}`)
  } catch (e) {
    log(`  review lane FAILED: ${e?.message || e}`)
    markPhase("run", "failed")
  }
}

// Lane 2: schema→CLI boundary + drift + coverage.
if (DO_SCHEMA) {
  log("▸ Lane 2/2: schema→CLI boundary (gui-movie-director-schema-self-improve)")
  try {
    schemaResult = await workflow(
      "gui-movie-director-schema-self-improve",
      {
        objective: OBJECTIVE,
        ...(TARGET ? { target: TARGET } : {}),
      },
    )
    log(`  schema lane done — ${schemaResult?.summary ?? "(no summary)"}`)
  } catch (e) {
    log(`  schema lane FAILED: ${e?.message || e}`)
    markPhase("run", "failed")
  }
}

if (!DO_REVIEW && !DO_SCHEMA) {
  log("⚠ No valid lanes selected (must include 'review' and/or 'schema'). Nothing to run.")
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

// Unified health scalar for trend tracking: count of open issues across both
// surfaces (lower = healthier). review verified findings + schema runtime
// errors + remaining drift. Fix runs should drive this down.
const openIssues = reviewVerified + schemaRuntimeErr + schemaDriftRem

const signals = {
  run_quality: phasesFailed.length === 0 ? (openIssues === 0 ? "clean" : "good") : "degraded",
  key_metric: `openIssues=${openIssues} (review:${reviewVerified} schemaErr:${schemaRuntimeErr} drift:${schemaDriftRem})`,
  delta_from_last: null,
  highlights: [
    DO_REVIEW  ? `review: ${reviewVerified} verified finding(s)${fixEnabled ? ` → ${reviewApplied} fix(es) applied, ${reviewRegress} regression(s)` : " (review-only)"}` : null,
    DO_SCHEMA  ? `schema: ${schemaRuntimeFind} runtime finding(s), ${schemaRuntimeErr} error(s), drift→${schemaDriftRem}, coverage Δ=${schemaCovDelta}` : null,
    FIX_REQ && dirtyTree ? "fix:true DOWNGRADED to review-only (dirty tree)" : null,
  ].filter(Boolean),
  warnings: [
    ...(phasesFailed.length ? [`phases failed: ${phasesFailed.join(",")}`] : []),
    ...(FIX_REQ && dirtyTree ? ["concurrent WIP detected; fix deferred"] : []),
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
        topFindings: (reviewResult.findings?.items || []).slice(0, 8).map((f) => ({
          id: f.id, severity: f.severity, dimension: f.dimension, file: f.file, line: f.line, title: f.title,
        })),
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
  signals,
  knowledgeContribution: knowledgeAppended
    ? { appended: true, openIssues, kbPath: "knowledge-base/code/records.jsonl" }
    : { appended: false },
  nextStep:
    fixEnabled
      ? (reviewRegress > 0 ? "Regressions detected — review-optimize should have auto-reverted the offending files via git checkout/rm. Inspect the tree." : "Fixes applied. Re-run routine scan to confirm openIssues dropped.")
      : FIX_REQ && dirtyTree
        ? "Tree was dirty so fixes were skipped. Commit/stash concurrent WIP, then re-run with fix:true to apply the verified findings above."
        : "Review-only scan complete. To apply verified fixes, re-run with args { effort:'medium', fix:true } on a clean git tree.",
}

return report
