// GUI Movie Director Self-Improve — UNIFIED (full consolidation)
//
// One dynamic workflow to improve the Bun GUI Movie Director app from every
// angle. Three lanes, merged into this single file:
//
//   • review  — structural code health (correctness/types/error-handling/quality/
//               security): multi-dimension review + adversarial verify + optional
//               git-stash-backed auto-fix. Runs as a child workflow
//               (gui-movie-director-review-optimize).
//   • schema  — schema→CLI boundary: runtime-validates buildCliArgs() output
//               against run.py (the bug-prone surface check:schema can't see),
//               aligns GUI schemas to run.py (drift-fix), raises test coverage.
//               INLINED (was gui-movie-director-schema-self-improve).
//   • ux      — UX screenshot analysis: playwright→VLM→fix loop over every view.
//               INLINED (was gui-movie-director-ux-self-improve).
//
// History: this file was previously a thin orchestrator that called schema + ux
// as separate `workflow()` children. Those children shared identical harness
// infrastructure (saveHistory/loadKnowledge/extractKnowledge, args/phase tracking)
// and were already sequenced as lanes here, so they were INLINED (2026-06-19) per
// the full-consolidation decision: ONE knowledge base, ONE history, ONE persist
// per run (previously 4). review-optimize stays a separate child workflow.
//
// Modes (selected by args):
//
//   ROUTINE SCAN (default — cheap, collision-safe, review-only fix):
//     Workflow({ name: "gui-movie-director-self-improve" })
//       → effort:low review-only scan + schema runtime validation.
//         No edits, no git stash → safe to run anytime, even with concurrent WIP.
//         UX lane is NOT auto-added (it costs ~50 agents for 0 fixes in review-only) —
//         pass uxAuto:true, or lanes:["ux"]/"all", to survey the UI.
//
//   SINGLE LANE:
//     args: { lanes: ["review"] }    // structural code review only
//     args: { lanes: ["schema"] }    // schema→CLI boundary only
//     args: { lanes: ["ux"] }        // UX screenshot analysis only (needs GUI server)
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
//         schema lane runs runtime+drift+coverage.
//
//   FOCUS / TARGET:
//     args: { focus: "security" }              // review dimension
//     args: { files: ["api/ws.ts", ...] }      // review only these files
//     args: { target: "t2i" }                  // schema: focus one schema file
//     args: { objective: "both" }              // schema: runtime+drift+coverage

export const meta = {
  name: "gui-movie-director-self-improve",
  description:
    "Unified self-improve loop for the Bun GUI Movie Director app — structural code review (correctness/types/error-handling/quality/security) via a child workflow AND schema→CLI boundary validation (buildCliArgs→run.py, drift, coverage) AND UX screenshot analysis (playwright→VLM→fix loop) AND a deterministic ESLint lint gate (no-shadow/unused-vars — catches the FileUpload-style shadowing defect the other lanes structurally cannot), all inlined as lanes, merging into one health report with ONE persist per run. Lane-selectable; review-only by default (collision-safe).",
  whenToUse:
    "One workflow to improve gui-movie-director from every angle. Default = cheap routine scan: review-optimize effort:low (review-only) + schema lane objective:runtime (buildCliArgs→run.py boundary) + lint gate (eslint no-shadow/unused-vars). Escalate with effort:'medium'+fix:true to auto-apply verified fixes (refuses fix if the git tree is dirty, to avoid colliding with concurrent WIP). lanes:['review'|'schema'|'ux'|'lint'] picks one or more; lanes:'all' runs all four; focus/files/target/objective narrow scope. UX lane requires GUI server at localhost:3099 + LM Studio; fails gracefully if server is down.",
  phases: [
    { title: "Resolve", detail: "Normalize args, dirty-tree guard (refuse fix if dirty), timestamp, load ONE knowledge base" },
    { title: "Run",     detail: "Lanes: structural review (child workflow) + schema→CLI boundary (inlined: runtime/drift/coverage) + UX screenshot analysis (inlined: survey/fix-loop) + ESLint lint gate (inlined: no-shadow/unused); parallel when review-only" },
    { title: "Persist", detail: "ONE unified history entry + extractKnowledge + code-knowledge append (full consolidation — no per-lane persists)" },
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
  : (A.lanes === "all" ? ["review", "schema", "ux", "lint"]
  : (A.lanes ? [A.lanes] : ["review", "schema", "lint"]))
// UX_EXPLICIT: user passed a lanes arg → respect it exactly, no auto-detect.
const UX_EXPLICIT = A.lanes !== undefined
let LANES = LANES_RAW_INPUT.filter((l) => ["review", "schema", "ux", "lint"].includes(l))
let DO_REVIEW = LANES.includes("review")
let DO_SCHEMA  = LANES.includes("schema")
let DO_UX      = LANES.includes("ux")
let DO_LINT    = LANES.includes("lint")

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
// UX auto-detect: when true, a BARE invocation (no lanes arg) opportunistically
// appends the UX lane if the GUI server is up. Default false — the documented
// default is a CHEAP review+schema scan, and the UX survey (23 views) costs ~50
// agents + VLM calls for zero fixes in review-only mode. Opt in with uxAuto:true
// (or just pass lanes:["ux"]/"all"). See reflection 2026-06-19 run.
const UX_AUTO      = A.uxAuto === true

// ── Paths ────────────────────────────────────────────────────────────────────
// NOTE: the workflow runtime strips `export const meta` — top-level `meta.*`
// refs throw "meta is not defined". Mirror the name into a plain const instead.
const NAME         = "gui-movie-director-self-improve"
// PROJECT_ROOT is resolved DYNAMICALLY in the Resolve phase (git rev-parse
// --show-toplevel) so this workflow is worktree-correct: it edits the tree it
// runs from, not a hardcoded sibling repo. `let` because Resolve reassigns them
// once the real root is known; the values below are a fallback only.
let PROJECT_ROOT = "/Users/huangziyu/proj/video_generation"
let GUI_DIR      = `${PROJECT_ROOT}/bun-apps/gui-movie-director`
let PYTHON       = `${PROJECT_ROOT}/python/venv/bin/python`
let RUN_PY       = `${PROJECT_ROOT}/python/mlx-movie-director/run.py`
let HISTORY_DIR  = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
let INDEX_FILE   = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`
let KB_FILE      = `${PROJECT_ROOT}/.claude/workflows/${NAME}.knowledge.jsonl`
// operation-lessons: curated, high-trust workflow-operation rules (fix|restore|review|report).
// OP_FILE = the APPROVED store (human-curated, loaded + injected into inlined fix agents).
// OP_INBOX = the staging queue the propose step WRITES candidates to (never auto-merged;
// human reviews + promotes). See _shared-patterns.md ("Operation-lessons").
let OP_FILE       = `${PROJECT_ROOT}/.claude/workflows/${NAME}.operation-lessons.jsonl`
let OP_INBOX      = `${PROJECT_ROOT}/.claude/workflows/${NAME}.operation-lessons.proposed.jsonl`
const SHOT_DIR     = `/tmp/gui-ux`

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
RECORD SCHEMA — every record MUST contain ONLY these 12 top-level keys; any extra key
triggers check-workflow-patterns.mjs schema drift (HARD exit 1):
  schema_version(=1) | id | type | title | detail | tags | dimension | confidence |
  status | superseded_by | evidence{occurrences,first_seen,last_seen,run_ids[<=8]} | extracted_at
Review-finding fields NOT in this schema MUST be folded, never emitted as top-level keys:
  severity → prepend "sev:<level>" to tags;  files / file:line → fold into detail
  (line numbers go stale — name the module/locus instead).
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

// ── pruneKnowledge — DETECT stale active records whose referenced SOURCE file is gone ──
// The 12-key lifecycle (status: active|superseded|retired) is WRITE-ONLY: extractKnowledge
// supersedes on contradiction and retires on cap-overflow, but NEVER on code-deletion — so
// records about deleted/renamed source files linger as "active", polluting loadKnowledge
// injections and crowding the 40-active cap during active GUI development. This step
// surfaces them every Persist: it scans ACTIVE records, extracts literal SOURCE-code path
// tokens, and flags those whose referenced file is verifiably absent (test -e). It is
// DETECT-ONLY — it NEVER writes/retires (an earlier auto-retire variant mis-tokenized a
// .jsonl log path and retired a high-value occ-17 record on a false positive; auto-retire
// via free-form agent path extraction is not trustworthy, so v1 reports only and the
// operator manually retires confirmed-stale records). Source-only extraction (frontend/...
// .ts/.tsx/.py) excludes data/log/config paths (.jsonl/.json/.md/iterations/records), whose
// absence does not imply the knowledge is stale. Identical-in-every-workflow; update
// _shared-patterns.md first.
async function pruneKnowledge(kbFile, runId) {
  const prune = await agent(
    `DETECT-ONLY (never write/modify the file) active knowledge records whose referenced
SOURCE file no longer exists in the tree, so the operator can manually retire stale ones.
1. Bash("test -f '${kbFile}' && echo EXISTS || echo MISSING")
2. If MISSING -> return { scanned: 0, candidates: [] }.
3. Bash("cat '${kbFile}'"). Parse each non-empty line as JSON.
4. Keep ONLY records where status === "active" (scanned = that count).
5. For each active record, scan title + detail + tags for LITERAL SOURCE-CODE file tokens
   ONLY — paths matching (frontend|api|lib|scripts|python|bun)/<dirs>/<name>.<ext> where ext
   in ts|tsx|py (e.g. "frontend/views/gallery/GalleryView.tsx", "api/config.ts"). Strip any
   ":<line>" suffix. Use ONLY paths that LITERALLY appear — do NOT invent or guess.
   EXCLUDE data/log/config files: .jsonl, .json, .md, .log, .txt, and ANY path under
   history/, records, iterations, manifest, knowledge-base/, models/ — those are not source
   code and their absence does NOT mean the knowledge is stale. A record with no SOURCE
   token is KEPT (not a candidate).
6. For each SOURCE token test existence (GUI app dir first, then repo root):
   Bash("test -e '${PROJECT_ROOT}/bun-apps/gui-movie-director/<path>' || test -e '${PROJECT_ROOT}/<path>' && echo PRESENT || echo ABSENT")
   A token is PRESENT if EITHER resolution exists.
7. STALE CANDIDATE = a record with >=1 SOURCE token AND EVERY token ABSENT. Collect
   { id, paths: [<absent tokens>], reason: "source locus absent" }. Records with no source
   token, or any PRESENT token, are KEPT.
8. Do NOT write or modify the file. Detect-only.
Return { scanned, candidates: [...] }.`,
    { label: "prune-knowledge", phase: "Persist", model: "sonnet",
      schema: { type: "object", properties: {
        scanned: { type: "number" },
        candidates: { type: "array", items: { type: "object", properties: {
          id: { type: "string" }, paths: { type: "array", items: { type: "string" } },
          reason: { type: "string" } } } },
      }, required: ["scanned", "candidates"] } },
  )
  const candidates = Array.isArray(prune?.candidates) ? prune.candidates : []
  if (candidates.length) log(`Prune (detect-only): ${candidates.length} stale-active candidate(s) — source locus absent (review; manually retire confirmed ones)`)
  return { scanned: Number(prune?.scanned) || 0, candidates }
}

// ── loadOperationLessons — curated, high-trust rules about how this workflow operates ──
// Returns rule text VERBATIM grouped by phase (no summarization, no drift). Records
// are {id, phase, severity, rule, why, source}; phase ∈ fix|restore|review|report.
// The APPROVED store (OP_FILE) is loaded + injected into the inlined code-fix agents so
// the workflow's operating posture persists across runs independently of project-memory.
// Identical to the review-optimize child + _shared-patterns.md ("Operation-lessons").
// NOTE: the staging inbox (OP_INBOX) is NEVER loaded here — proposed lessons are not
// trusted until a human promotes them; only the approved store feeds the prompts.
async function loadOperationLessons(opFile) {
  const load = await agent(
    `Read the workflow operation-lessons file and return its rules grouped by phase.
1. Bash("test -f '${opFile}' && echo EXISTS || echo MISSING")
2. If MISSING → return { found: false, byPhase: {} }.
3. If EXISTS: Bash("cat '${opFile}'")
4. Parse each non-empty line as JSON. Keep records where status is absent or "active".
5. Group by the "phase" field (fix|restore|review|report). For each record output
   ONLY {id, severity, rule} — copy "rule" VERBATIM (do not rephrase/truncate/invent).
   Drop any record whose phase is not one of the four above.
Return { found: true, byPhase: { "<phase>": [{id,severity,rule}, ...], ... } }.`,
    { label: "load-operation-lessons", phase: "Resolve", model: "haiku",
      schema: { type: "object", properties: {
        found: { type: "boolean" },
        byPhase: { type: "object", description: "phase -> array of {id,severity,rule}",
          additionalProperties: { type: "array", items: { type: "object",
            properties: { id: { type: "string" }, severity: { type: "string" }, rule: { type: "string" } },
            required: ["id", "rule"] } } },
      }, required: ["found", "byPhase"] } },
  )
  const counts = load?.byPhase || {}
  const total = Object.values(counts).reduce((a, arr) => a + (Array.isArray(arr) ? arr.length : 0), 0)
  const phSummary = Object.entries(counts).map(([p, arr]) => `${p}:${arr.length}`).join(" ") || "(empty)"
  log(`Operation-lessons: loaded ${total} rule(s) [${phSummary}] ← ${opFile}`)
  return load
}

// Render a phase's rules as an injection block (hard rules first). Empty -> "".
function operationRulesBlock(byPhase, phase) {
  const rules = (byPhase && byPhase[phase]) || []
  if (!rules.length) return ""
  const sorted = [...rules].sort((a, b) => (a.severity === "hard" ? 0 : 1) - (b.severity === "hard" ? 0 : 1))
  return `\n## OPERATION RULES (${phase} phase) — follow exactly, these are hard-won workflow truths:\n` +
    sorted.map((r) => `- [${r.severity || "soft"}] ${r.rule}`).join("\n")
}

// ── proposeOperationLessons — SELF-LEARNING (propose → human-gate) ──
// Distills THIS run's failures (a regression that fired a restore, an adversarial-verify
// that upheld a fabricated/wrong-location finding, a recurring schema runtime-error
// pattern, a fix that skipped/crashed) into ≤2 NEW operation-lesson CANDIDATES, written
// to the staging inbox (OP_INBOX). The APPROVED store (opFile) is NEVER written here — a
// human reviews the inbox and promotes winners (mirrors the "fixes left in the tree"
// trust model; see mlx iter-8→9 where each new lesson was hand-curated post-mortem).
// Modeled on extractKnowledge: gather existing ids (dedup) → sonnet agent → enforce
// dedup in JS → append + jq-validate. Empty result on no instructive failure.
async function proposeOperationLessons(inboxFile, opFile, runId, runResult) {
  const resultJson = JSON.stringify(runResult)
  // Gather existing ids (approved + inbox) for dedup; best-effort busy check.
  const guard = await agent(
    `Gather existing operation-lesson ids for dedup, and check the inbox isn't mid-write.
1. Bash("git status --porcelain '${inboxFile}' 2>/dev/null || true") → busy=true ONLY if the
   output shows this path as a MODIFIED tracked file (leading " M"/"MM"); an untracked "??"
   or absent entry is NOT busy (the inbox is new or gitignored).
2. Approved ids: Bash("test -f '${opFile}' && cat '${opFile}' || echo __EMPTY__"); parse each
   non-empty line as JSON, collect "id".
3. Inbox ids: Bash("test -f '${inboxFile}' && cat '${inboxFile}' || echo __EMPTY__"); parse each
   non-empty line as JSON, collect "id".
Return { busy: <bool>, existingIds: [<deduped ids from both files>] }.`,
    { label: "propose-lessons-guard", phase: "Persist", model: "haiku",
      schema: { type: "object", properties: {
        busy: { type: "boolean" },
        existingIds: { type: "array", items: { type: "string" } },
      }, required: ["busy", "existingIds"] } },
  )
  if (guard?.busy) {
    log(`propose-lessons: inbox busy (concurrent run) → skipping write`)
    return []
  }
  const existingIds = new Set(guard?.existingIds || [])
  const existingIdsBlock = existingIds.size ? `[${[...existingIds].join(", ")}]` : "(none yet)"

  const propose = await agent(
    `Propose NEW operation-lesson candidates distilled from THIS run's failures.
THIS RUN'S RESULT (json):
${resultJson}
EXISTING lesson ids (do NOT re-propose any): ${existingIdsBlock}

An operation-lesson is a CURATED, high-trust rule about HOW this workflow operates — the
kind a human hand-writes after a post-mortem (e.g. "when a fix moves a statement, move its
lazy import too", "restoreTriggered is not a success signal"). Phase ∈ fix|restore|review|report;
severity hard|soft.

Find at MOST 2 candidates THIS run genuinely surfaced:
- A regression that fired a restore / a fix that skipped or crashed → "fix" lesson.
- An adversarial verify that UPHELD a fabricated or wrong-location finding → "review" lesson.
- A restore/report that mis-stated the reverted files → "restore"/"report" lesson.
- A recurring runtime-error pattern (e.g. schema lane) → "fix"/"gotcha" lesson.
For EACH candidate:
  - id: stable "gui-selfimprove:<slug>"; MUST differ from every existing id above.
  - phase, severity (default "soft" — stays conservative until a human promotes to hard).
  - rule: ONE imperative sentence — the actionable rule, not the story.
  - why: 1-2 sentences naming the CONCRETE signal in THIS run (cite the finding/restore/regression).
  - source: "${runId}".
  - signal: short trigger tag (e.g. "regression+restore", "adversarial-upheld-fabricated").
  - target_hint: which file a human should promote into — "self-improve" or "review-optimize" — + phase.
Do NOT invent a failure not present in THIS run's result. If the run had no instructive failure,
return proposed:0, candidates:[].
Return { proposed: <count>, candidates: [{id, phase, severity, rule, why, source, signal, target_hint}, ...] }.`,
    { label: "propose-operation-lessons", phase: "Persist", model: "sonnet",
      schema: { type: "object", properties: {
        proposed: { type: "number" },
        candidates: { type: "array", items: { type: "object", properties: {
          id: { type: "string" }, phase: { type: "string" }, severity: { type: "string" },
          rule: { type: "string" }, why: { type: "string" }, source: { type: "string" },
          signal: { type: "string" }, target_hint: { type: "string" },
        }, required: ["id", "phase", "severity", "rule", "why"] } },
      }, required: ["proposed", "candidates"] } },
  )

  // Enforce dedup in JS (the agent is told, but never trust it). Cap at 2.
  const fresh = (propose?.candidates || [])
    .filter((c) => c && c.id && !existingIds.has(c.id))
    .slice(0, 2)
  if (!fresh.length) {
    log(`propose-lessons: no new candidates (run had no instructive failure, or all deduped)`)
    return []
  }

  // Append survivors to the inbox with provenance + status:"proposed".
  const newLines = fresh
    .map((c) => JSON.stringify({ ...c, status: "proposed", proposed_from_run: runId }))
    .join("\n")
  const append = await agent(
    `Append ${fresh.length} proposed operation-lesson candidate(s) to the staging inbox.
1. Read current inbox (may not exist): Bash("test -f '${inboxFile}' && cat '${inboxFile}' || echo __EMPTY__")
2. Build the NEW full inbox = existing lines VERBATIM + the ${fresh.length} new JSON lines below
   (one JSON object per line; no array wrapper; no trailing comma):
${newLines}
3. Write({ file_path: "${inboxFile}", content: <the full new inbox, newline-separated JSON> })
4. Validate EVERY line parses: Bash("jq -c . '${inboxFile}' >/dev/null && echo VALID || echo INVALID")
5. Bash("wc -l < '${inboxFile}'") → total
Return { appended: <true iff VALID>, total: <wc -l>, newIds: [${fresh.map((c) => `"${c.id}"`).join(", ")}] }.`,
    { label: "propose-lessons-write", phase: "Persist", model: "sonnet",
      schema: { type: "object", properties: {
        appended: { type: "boolean" }, total: { type: "number" },
        newIds: { type: "array", items: { type: "string" } },
      }, required: ["appended"] } },
  )

  if (append?.appended) {
    log(`propose-lessons: appended ${fresh.length} candidate(s) → ${inboxFile} (total ${append.total ?? "?"}; HUMAN-GATED, not auto-merged)`)
    return fresh
  }
  log(`propose-lessons: write did not verify (appended=${append?.appended}) — candidates not persisted`)
  return []
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lane: SCHEMA (inlined from gui-movie-director-schema-self-improve)
// Hardens the GUI→run.py integration three ways: (runtime) exercise buildCliArgs()
// with synthesized params and assert run.py accepts the output; (drift) align GUI
// schemas to run.py via check:schema; (coverage) add unit tests propose→test→adopt.
// Full consolidation: NO per-lane persist. Cross-run resume (iterations.jsonl +
// reflection.json) is replaced by the merged KB digest; runId comes from the caller.
// ═══════════════════════════════════════════════════════════════════════════════

// Source schema files that tests should cover (excludes helpers, adapters, registry)
const COMMAND_SCHEMA_FILES = [
  'schemas/t2i.ts', 'schemas/i2i.ts', 'schemas/anime2real.ts', 'schemas/expansion.ts',
  'schemas/faceswap.ts', 'schemas/swap.ts', 'schemas/controlnet.ts', 'schemas/angle.ts',
  'schemas/profile.ts', 'schemas/quality.ts', 'schemas/workflow.ts',
  'schemas/video-generate.ts', 'schemas/video-relay.ts', 'schemas/video-restore.ts',
  'schemas/image-restore.ts', 'lib/args.ts',
]

// ── Coverage parsing ──────────────────────────────────────────────────────────
function parseCoverageTable(output) {
  const files = {}
  // Isolate the coverage table: everything before the "All files" summary line.
  // This prevents a stray "|" in an it() description (e.g. an arg-parsing test
  // case) from being mis-read as a coverage row.
  const allIdx = output.indexOf('All files')
  const tableRegion = allIdx >= 0 ? output.slice(0, allIdx) : output
  // Format: " schemas/angle.ts |   0.00 |   72.22 | 14-18" (4th col ignored)
  const re = /^\s+(\S+\.ts)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/gm
  let m
  while ((m = re.exec(tableRegion)) !== null) {
    const [, file, funcs, lines] = m
    const f = parseFloat(funcs), l = parseFloat(lines)
    files[file] = { funcs: f, lines: l, composite: 0.4 * f + 0.6 * l }
  }
  if (Object.keys(files).length === 0 && output.includes('All files')) {
    log('⚠ parseCoverageTable: "All files" present but 0 rows parsed — coverage measurements unreliable')
  }
  return files
}

function globalComposite(fileCoverage) {
  const relevant = COMMAND_SCHEMA_FILES.map(f => fileCoverage[f]).filter(Boolean)
  // NaN (not 0) when nothing was measured: an unmeasurable baseline must NOT be
  // treated as 0% — otherwise every test proposal would "improve" it and get
  // falsely adopted. NaN propagates through delta comparisons as always-false.
  if (relevant.length === 0) return NaN
  return relevant.reduce((s, f) => s + f.composite, 0) / relevant.length
}

async function runSchemaLane(opts) {
  const OBJECTIVE       = String(opts.objective || "runtime")
  const TARGET          = opts.target || null
  const knowledgeDigest = opts.knowledgeDigest || ""
  const runId           = opts.runId || "run-1"
  const DO_RUNTIME  = ["runtime", "both", "all"].includes(OBJECTIVE)
  const DO_DRIFT    = ["drift", "both", "all"].includes(OBJECTIVE)
  const DO_COVERAGE = ["coverage", "both", "all"].includes(OBJECTIVE)
  const BUDGET     = 6
  const MARGIN     = 1.5
  const CONVERGE_K = 2
  // Schema runs dry-run by default via the orchestrator (no dryRun passed); drift-fix
  // and coverage edits only apply when dryRun:false is explicitly requested.
  const DRY_RUN = opts.dryRun !== false
  // Cross-run dead-end/good-pattern seeding used to come from iterations.jsonl +
  // reflection.json; under full consolidation the merged KB digest replaces them
  // (its avoid/gotcha + lever records are injected into the proposal prompt below).
  const deadEnds = new Set()
  const goodPats = []

  function findWeakestFile(fileCoverage) {
    const candidates = TARGET
      ? COMMAND_SCHEMA_FILES.filter(f => f.includes(TARGET))
      : COMMAND_SCHEMA_FILES
    return candidates
      .map(f => ({ file: f, cov: fileCoverage[f] || { composite: 0 } }))
      .filter(({ file }) => !deadEnds.has(file))
      .sort((a, b) => a.cov.composite - b.cov.composite)[0]?.file || null
  }

  // ── Baseline ──
  // Coverage baseline only when the coverage lane will run — bun test --coverage is
  // the slowest baseline step and otherwise wasted (objective=runtime default).
  let baselineCoverage = {}
  let baselineComposite = NaN
  let currentBest = baselineComposite
  if (DO_COVERAGE) {
    const baselineResult = await agent(
      `Run this exact command and return the full stdout output:
cd "${GUI_DIR}" && bun test --coverage 2>&1

Return the complete terminal output as a JSON string in the field "output". Include the coverage table lines.`,
      { label: "schema-baseline-run", phase: "Schema",
        schema: { type: "object", properties: { output: { type: "string" } }, required: ["output"] } },
    )
    baselineCoverage = parseCoverageTable(baselineResult?.output || "")
    baselineComposite = globalComposite(baselineCoverage)
    currentBest = baselineComposite
  }

  // Drift baseline (when objective includes drift). run.py is the CLI source of
  // truth; check:schema --json lists GUI↔run.py drift.
  let baselineDriftCount = 0
  let driftWorkList = []
  if (DO_DRIFT) {
    const driftBase = await agent(
      `Run this exact command and return the parsed JSON object verbatim:
cd "${GUI_DIR}" && bun run check:schema --json 2>/dev/null

It prints one JSON object: { warningCount, errorCount, warnings: [...], errors: [...] }.
Return that object under the field "schema".`,
      { label: "schema-drift-baseline", phase: "Schema",
        schema: { type: "object", properties: { schema: { type: "object" } }, required: ["schema"] } },
    )
    const allFindings = (driftBase?.schema?.warnings || [])
    baselineDriftCount = Number(driftBase?.schema?.warningCount) || allFindings.length
    // Dedupe to one fix per flag (choices) or per action:flag (default). --pipeline
    // appears across 6 actions but is a single shared fix via schemas/shared.ts.
    const seen = new Set()
    driftWorkList = allFindings.filter(f => {
      const key = f.kind === "choices" ? `choice:${f.flag}` : `default:${f.action}:${f.flag}`
      if (seen.has(key)) return false
      seen.add(key); return true
    })
    log(`[schema] drift baseline: ${baselineDriftCount} warning(s) → ${driftWorkList.length} unique fix target(s)`)
  }

  if (DO_COVERAGE) {
    log(`[schema] baseline composite: ${baselineComposite.toFixed(2)}pp across ${COMMAND_SCHEMA_FILES.length} files`)
    const sorted = COMMAND_SCHEMA_FILES
      .map(f => ({ f, c: (baselineCoverage[f] || { composite: 0 }).composite }))
      .sort((a, b) => a.c - b.c)
    log(`[schema] weakest: ${sorted.slice(0, 3).map(x => `${x.f}(${x.c.toFixed(0)}%)`).join(", ")}`)
  }

  // ── Improve ──
  // Dirty-tree guard (scoped to schema's edit surface): both sub-loops revert via
  // bare `git checkout -- <path>` (or `rm -f` for newly-created files), which
  // discards ALL uncommitted changes to that path. Refuse to mutate when the scope
  // is already dirty — mirrors the Checkpoint guard in review-optimize.
  let EFFECTIVE_DRY_RUN = DRY_RUN
  if (!DRY_RUN) {
    const dirtyCheck = await agent(
      `Check whether the git working tree has uncommitted changes in scope.
Bash("cd '${PROJECT_ROOT}' && git status --short -- 'bun-apps/gui-movie-director/schemas/' 'bun-apps/gui-movie-director/scripts/' 'python/mlx-movie-director/app/commands/' | grep -v '^??' || true")
dirty = true if that printed any non-empty line (tracked-modified files). Untracked ('??') files don't count.
Return { dirty, files: [<the printed file paths, if any>] }.`,
      { label: "schema-dirty-tree-check", phase: "Schema", model: "haiku",
        schema: { type: "object", properties: { dirty: { type: "boolean" }, files: { type: "array", items: { type: "string" } } }, required: ["dirty"] } },
    )
    if (dirtyCheck?.dirty === true) {
      EFFECTIVE_DRY_RUN = true
      log(`⚠ [schema] Working tree is DIRTY in scope (${(dirtyCheck?.files || []).join(", ")}) — forcing dry-run to avoid a revert clobbering your WIP. Commit/stash, then re-run.`)
    }
  }

  const iterations = []
  let noImprove = 0

  // ── Drift-fix sub-loop (runs before coverage when objective includes drift) ──
  // run.py is the source of truth; align GUI → run.py. Where the GUI legitimately
  // has MORE than run.py's argparse (runpy_narrow), widen run.py instead.
  let driftFixed = 0
  let driftRemaining = baselineDriftCount
  const driftIterations = []

  if (DO_DRIFT && driftWorkList.length > 0) {
    for (const f of driftWorkList) {
      log(`[schema] drift: ${f.flag} [${f.action}] (${f.category}) — GUI:${JSON.stringify(f.guiValue)} run.py:${JSON.stringify(f.runValue)}`)

      if (EFFECTIVE_DRY_RUN) {
        log(`  [DRY RUN] would apply policy fix for ${f.flag} (${f.category})`)
        driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: false, dryRun: true })
        continue
      }

      // Conservative guard: findings that need human judgment — auto-applying
      // could clobber intentional GUI divergence. (choices mismatches where GUI ≠
      // run.py; NUMERIC default_mismatch where the GUI default may be intentional
      // UX tuning, not stale drift. Non-numeric default_mismatch stays auto-applicable.)
      if (
        f.category === "runpy_narrow" ||
        f.category === "mixed_choices" ||
        (f.category === "default_mismatch" && typeof f.runValue === "number")
      ) {
        const why = f.category === "default_mismatch" ? "numeric default may be intentional tuning" : "GUI/run.py choice sets differ"
        log(`  ⚠ needs human review (${why}) — skip`)
        driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: false, skipped: "needs-review" })
        continue
      }

      // Apply the fix per policy
      const applyResult = await agent(
        `Apply ONE schema-drift fix to align the GUI with run.py (run.py is the source of truth).
Repo root: ${PROJECT_ROOT}. GUI dir: ${GUI_DIR}.

Finding (from \`bun run check:schema --json\`):
${JSON.stringify(f, null, 2)}

Apply exactly ONE branch based on category:
- "gui_missing_choice": run.py offers choice value(s) the GUI lacks → add them to the GUI field.
    • If flag is "--pipeline": choices come from PIPELINE_OPTIONS in bun-apps/gui-movie-director/schemas/shared.ts (one edit fixes all schemas). Each entry is { value, label }. Add the missing value(s) with a sensible label.
    • Otherwise edit the field's choices array in bun-apps/gui-movie-director/schemas/<file>.ts (action→file map: t2i→t2i.ts, i2i→i2i.ts, workflow→workflow.ts, controlnet→controlnet.ts, profile→profile.ts, faceswap→faceswap.ts, restore→image-restore.ts, video-relay→video-relay.ts). Add { value, label } entries for run.py's extra value(s).
- "runpy_narrow": GUI offers value(s) run.py's argparse rejects → widen run.py. grep for the flag in python/mlx-movie-director/app/commands/*.py, find add_argument(..., choices=[...]), add the GUI's missing value(s) to choices.
- "default_mismatch": set the GUI field's default to run.py's default (run.py wins). Edit the field in bun-apps/gui-movie-director/schemas/<file>.ts (same action→file map). ONLY if the field has no choices, OR run.py's default value is already among the field's choice values — otherwise make NO edit and set notes="default not in choices" (a default outside the choice list would be inconsistent).
- "mixed_choices": add run.py's extra value(s) to the GUI choices (align toward run.py); do NOT remove GUI-only values.

Rules: make the MINIMAL edit, do not reformat, preserve existing entries. Return absolute paths of files modified.${opFixBlock}`,
        { label: `schema-drift-apply-${f.flag.replace(/^--/, "")}`, phase: "Schema",
          schema: { type: "object", properties: { touchedFiles: { type: "array", items: { type: "string" } }, notes: { type: "string" } }, required: ["touchedFiles"] } },
      )

      const touchedFiles = (applyResult?.touchedFiles || []).filter(Boolean)
      const touchedRunpy = touchedFiles.some(p => p.includes("/python/mlx-movie-director/"))

      if (touchedFiles.length === 0) {
        const note = applyResult?.notes ? ` — ${applyResult.notes}` : " (no reason returned)"
        log(`  no edit made (skip)${note}`)
        driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: false })
        continue
      }

      // Verify: check:schema warning count down + bun test pass (+ pytest if run.py touched)
      const verifyResult = await agent(
        `Verify a schema-drift fix broke nothing. Run each, capture the numbers:
1. cd "${GUI_DIR}" && bun run check:schema 2>&1            → the "⚠  N warning(s)" count, and whether it printed "drift error(s)" / exited nonzero (errored=true)
2. cd "${GUI_DIR}" && bun test 2>&1                         → count of failing tests (the "N fail" number)
${touchedRunpy ? `3. cd "${PROJECT_ROOT}/python/mlx-movie-director" && ../../python/venv/bin/python -m pytest app/tests/test_schema.py -q 2>&1  → schemaPytestPass true iff "failed" not in summary` : `3. (run.py not touched — schemaPytestPass=true)`}
Return { warningCount, errored, bunFail, schemaPytestPass }.`,
        { label: `schema-drift-verify-${f.flag.replace(/^--/, "")}`, phase: "Schema",
          schema: { type: "object", properties: { warningCount: { type: "number" }, errored: { type: "boolean" }, bunFail: { type: "number" }, schemaPytestPass: { type: "boolean" } }, required: ["warningCount", "bunFail"] } },
      )

      const warnCount = Number(verifyResult?.warningCount)
      const testsOk = (verifyResult?.bunFail === 0) && (touchedRunpy ? verifyResult?.schemaPytestPass !== false : true)
      const countImproved = Number.isFinite(warnCount) && warnCount < driftRemaining && !verifyResult?.errored

      if (countImproved && testsOk) {
        driftFixed++
        driftRemaining = warnCount
        log(`  ✓ adopted → ${driftRemaining} drift warning(s) remain`)
        driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: true })
      } else {
        await agent(
          `Revert the failed drift fix. For each path run: git checkout -- "<path>"
Paths: ${touchedFiles.map(p => `"${p}"`).join(" ")}
Return { reverted: true }.`,
          { label: `schema-drift-revert-${f.flag.replace(/^--/, "")}`, phase: "Schema",
            schema: { type: "object", properties: { reverted: { type: "boolean" } }, required: ["reverted"] } },
        )
        log(`  ✗ reverted (warnCount=${warnCount}, bunFail=${verifyResult?.bunFail})`)
        driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: false })
      }
    }
  }

  // ── Runtime-validation sub-loop (the highest-value lane) ─────────────────────
  // Exercise buildCliArgs() with synthesized params and assert run.py accepts the
  // output (scripts/check-runtime.ts). Catches the schema→CLI integration bugs
  // check:schema CANNOT see. Read-only by design: it only SURFACES findings.
  let runtimeFindings = []
  let runtimeErrors = 0
  const runtimeIterations = []

  if (DO_RUNTIME) {
    const runtimeResult = await agent(
      `Run this exact command and return the parsed JSON object verbatim:
cd "${GUI_DIR}" && bun run check:runtime --json 2>/dev/null

It prints one JSON object: { findingCount, errorCount, findings: [...] }.
Return that object under the field "runtime".`,
      { label: "schema-runtime-check", phase: "Schema",
        schema: { type: "object", properties: { runtime: { type: "object" } }, required: ["runtime"] } },
    )
    runtimeFindings = (runtimeResult?.runtime?.findings || [])
    runtimeErrors = Number(runtimeResult?.runtime?.errorCount) || 0
    const runtimeTotal = Number(runtimeResult?.runtime?.findingCount) || runtimeFindings.length

    log(`[schema] runtime: ${runtimeTotal} finding(s) — ${runtimeErrors} error(s), ${runtimeTotal - runtimeErrors} warning(s) (none visible to check:schema)`)
    for (const f of runtimeFindings) {
      const exp = Array.isArray(f.expected) ? `[${f.expected.join(",")}]` : JSON.stringify(f.expected)
      log(`  [${f.action}] ${f.flag} (${f.violation}, set=${f.set}) — emitted:${JSON.stringify(f.emitted)} expected:${exp}`)
      runtimeIterations.push({ action: f.action, flag: f.flag, violation: f.violation, set: f.set, isHard: f.violation !== "choice-valid" })
    }
  }

  // ── Coverage sub-loop (runs when objective includes coverage) ───────────────
  for (let iter = 0; DO_COVERAGE && iter < BUDGET; iter++) {
    const targetFile = findWeakestFile(baselineCoverage)
    if (!targetFile) {
      log(`[schema] no candidates left (all in dead-ends). Stopping.`)
      break
    }

    const testFile = targetFile.replace(/\.ts$/, ".test.ts")
    const baseName = targetFile.replace(/^(schemas|lib)\//, "").replace(/\.ts$/, "")

    log(`[schema] iter ${iter + 1}/${BUDGET}: targeting ${targetFile} (${(baselineCoverage[targetFile]?.composite || 0).toFixed(1)}% composite)`)

    const proposeResult = await agent(
      `You are a test-writing agent for a Bun TypeScript project. Your task: propose NEW unit tests to improve coverage of ${targetFile}.

Context:
- Project: ${GUI_DIR}
- Source file: ${GUI_DIR}/${targetFile}
- Current test file: ${GUI_DIR}/${testFile} (may not exist yet — check)
- Test framework: bun:test (import { describe, it, expect } from "bun:test")
- Helper: schemas/test-helpers.ts exports invariants(cmd) for boilerplate tests
- Coverage baseline: funcs=${(baselineCoverage[targetFile]?.funcs || 0).toFixed(1)}% lines=${(baselineCoverage[targetFile]?.lines || 0).toFixed(1)}%
- Known good patterns from prior runs: ${goodPats.length > 0 ? goodPats.slice(0, 5).join("; ") : "none yet"}
- Colocated knowledge base (committed): ${knowledgeDigest || "(empty — no committed knowledge yet)"}

Steps:
1. Read the source file at ${GUI_DIR}/${targetFile}
2. Read the current test file at ${GUI_DIR}/${testFile} (note what's already tested)
3. Identify the specific functions/branches NOT yet covered (check Uncovered Line #s from baseline)
4. Write 3-6 new it() test cases that exercise those uncovered paths
5. Focus on: buildParams() edge cases, isDisabled() boundary values, or field validation

Return JSON:
{
  "testClass": "one-line description of what you're testing (e.g. 'swap isDisabled with empty inputs')",
  "targetTestFile": "${testFile}",
  "newTestCode": "the TypeScript test code to APPEND to the test file (just the describe block, no imports needed)",
  "estimatedLines": <number of uncovered lines this should cover>,
  "reasoning": "why these tests will improve coverage"
}`,
      { label: `schema-propose-${baseName}`, phase: "Schema",
        schema: {
          type: "object",
          properties: {
            testClass:      { type: "string" },
            targetTestFile: { type: "string" },
            newTestCode:    { type: "string" },
            estimatedLines: { type: "number" },
            reasoning:      { type: "string" },
          },
          required: ["testClass", "targetTestFile", "newTestCode"],
        } },
    )

    if (!proposeResult) {
      log(`[schema] iter ${iter + 1}: proposal agent failed, skipping`)
      noImprove++
      if (noImprove >= CONVERGE_K) { log("[schema] converged (agent failures). Stopping."); break }
      continue
    }

    log(`[schema] proposed: "${proposeResult.testClass}"`)
    log(`[schema] code preview: ${proposeResult.newTestCode.slice(0, 120).replace(/\n/g, " ")}...`)

    let adopted = false
    let delta = 0

    if (EFFECTIVE_DRY_RUN) {
      log(`[schema] [DRY RUN] Would append to ${proposeResult.targetTestFile}`)
      adopted = false
      delta = 0
    } else {
      const writeResult = await agent(
        `Append the following TypeScript test code to the file ${GUI_DIR}/${proposeResult.targetTestFile}.

The file may already have content. DO NOT replace existing content. Append AFTER the last line.

Code to append:
${proposeResult.newTestCode}

After appending, confirm by returning: { "written": true, "filePath": "${proposeResult.targetTestFile}" }`,
        { label: `schema-write-${baseName}`, phase: "Schema",
          schema: { type: "object", properties: { written: { type: "boolean" }, filePath: { type: "string" } }, required: ["written"] } },
      )

      if (!writeResult?.written) {
        log(`[schema] iter ${iter + 1}: write failed, skipping (result=${JSON.stringify(writeResult).slice(0, 200)})`)
        noImprove++
        continue
      }

      const measureResult = await agent(
        `Run this exact command and return full stdout:
cd "${GUI_DIR}" && bun test --coverage 2>&1

Return JSON: { "output": "<full stdout>" }`,
        { label: `schema-measure-${baseName}`, phase: "Schema",
          schema: { type: "object", properties: { output: { type: "string" } }, required: ["output"] } },
      )

      const newCoverage = parseCoverageTable(measureResult?.output || "")
      const newComposite = globalComposite(newCoverage)
      delta = newComposite - currentBest

      // Parse the real fail count from bun test's summary line ("  N fail"),
      // instead of fragile substring sniffing. Fail-closed if unparseable.
      const rawMeasureOut = measureResult?.output || ""
      const failMatch = rawMeasureOut.match(/(\d+)\s+fail\b/)
      const failCount = failMatch ? parseInt(failMatch[1], 10) : null
      const testsPassed = failCount !== null ? failCount === 0 : false
      if (failCount === null && rawMeasureOut.trim() !== "") {
        log(`⚠ [schema] could not parse fail count from bun test output — fail-closed (treating as failed)`)
      }

      if (testsPassed && delta >= MARGIN) {
        adopted = true
        currentBest = newComposite
        Object.assign(baselineCoverage, newCoverage)
        log(`[schema] ✓ adopted! +${delta.toFixed(2)}pp → ${newComposite.toFixed(2)}pp total`)
      } else {
        await agent(
          `Revert the test file to its previous state. Run:
cd "${GUI_DIR}" && git checkout -- "${proposeResult.targetTestFile}" 2>&1 || true

If git checkout fails (file was newly created), delete it:
rm -f "${GUI_DIR}/${proposeResult.targetTestFile}"

Return: { "reverted": true }`,
          { label: `schema-revert-${baseName}`, phase: "Schema",
            schema: { type: "object", properties: { reverted: { type: "boolean" } }, required: ["reverted"] } },
        )
        const reason = !testsPassed ? "tests failed" : `delta ${delta.toFixed(2)} < margin ${MARGIN}`
        log(`[schema] ✗ reverted (${reason})`)
      }
    }

    const entry = { runId, iter: iter + 1, targetFile, testClass: proposeResult.testClass, adopted, delta, prevScore: currentBest - (adopted ? delta : 0), newScore: adopted ? currentBest : currentBest - delta, dryRun: DRY_RUN }
    iterations.push(entry)

    if (!adopted) {
      noImprove++
      deadEnds.add(targetFile)
    } else {
      noImprove = 0
      deadEnds.delete(targetFile)
      goodPats.push(proposeResult.testClass)
    }

    if (noImprove >= CONVERGE_K) {
      log(`[schema] converged (${CONVERGE_K} non-improving iters). Stopping.`)
      break
    }
  }

  // ── Return (no per-lane persist — the orchestrator handles all disk writes) ──
  const totalDelta = currentBest - baselineComposite
  const adopted = iterations.filter(e => e.adopted).length

  return {
    runId,
    objective: OBJECTIVE,
    dryRun: DRY_RUN,
    baseline: DO_COVERAGE ? baselineComposite.toFixed(2) : null,
    final:    DO_COVERAGE ? currentBest.toFixed(2) : null,
    delta:    DO_COVERAGE ? totalDelta.toFixed(2) : null,
    iters:    iterations.length,
    adopted,
    rejected: iterations.length - adopted,
    baselineDrift: baselineDriftCount,
    driftFixed,
    driftRemaining,
    driftIterations,
    runtimeFindings: runtimeFindings.length,
    runtimeErrors,
    runtimeIterations,
    summary: [
      DO_RUNTIME  ? `Runtime: ${runtimeFindings.length} finding(s) — ${runtimeErrors} error(s), ${runtimeFindings.length - runtimeErrors} warning(s) [buildCliArgs→run.py boundary]` : null,
      DO_DRIFT    ? `Drift: ${baselineDriftCount} → ${driftRemaining} (${driftFixed} fixed)` : null,
      DO_COVERAGE ? `Coverage: ${baselineComposite.toFixed(1)}% → ${currentBest.toFixed(1)}% (+${totalDelta.toFixed(1)}pp) | ${adopted}/${iterations.length} adopted` : null,
    ].filter(Boolean).join(" | "),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lane: UX (inlined from gui-movie-director-ux-self-improve)
// Screenshots every view via playwright-cli, analyzes each with the local VLM
// (--style playwright), builds a priority queue of UX issues, then iterates:
//   fix → bun test → re-screenshot → VLM rescore → keep-or-revert.
// Full consolidation: NO per-lane persist. Returns null if the GUI server is down
// (the orchestrator's DO_UX && !uxResult path reports it as skipped).
// ═══════════════════════════════════════════════════════════════════════════════

const ALL_VIEWS = [
  { id: "gallery",        route: "#/gallery",              label: "Gallery",           file: "frontend/views/gallery/GalleryView.tsx" },
  { id: "jobs",           route: "#/jobs",                 label: "Jobs",              file: "frontend/views/jobs/JobHistoryView.tsx" },
  { id: "config",         route: "#/config",               label: "Config",            file: null },
  { id: "t2i",            route: "#/cmd/t2i",              label: "Text→Image",        file: "frontend/views/generate/T2iView.tsx" },
  { id: "image-pipeline", route: "#/cmd/image-pipeline",   label: "Image Pipeline",    file: "frontend/views/workflow/ImagePipelineView.tsx" },
  { id: "video-generate", route: "#/cmd/video-generate",   label: "Video Generate",    file: "frontend/views/workflow/VideoGenerateView.tsx" },
  { id: "video-relay",    route: "#/cmd/video-relay",      label: "Video Relay",       file: "frontend/views/workflow/VideoRelayView.tsx" },
  { id: "video-restore",  route: "#/cmd/video-restore",    label: "Video Restore",     file: "frontend/views/workflow/VideoRestoreView.tsx" },
  { id: "video-compare",  route: "#/cmd/video-compare",    label: "Video Compare",     file: "frontend/views/workflow/VideoCompareView.tsx" },
  { id: "video-quality",  route: "#/cmd/video-quality",    label: "Video Quality",     file: "frontend/views/workflow/VideoQualityView.tsx" },
  { id: "video-vbvr",     route: "#/cmd/video-vbvr",       label: "Video VBVR",        file: "frontend/views/workflow/VideoVbvrView.tsx" },
  { id: "i2i",            route: "#/cmd/i2i",              label: "Image→Image",       file: "frontend/views/transform/I2iView.tsx" },
  { id: "image-restore",  route: "#/cmd/image-restore",    label: "Image Restore",     file: "frontend/views/transform/ImageRestoreView.tsx" },
  { id: "anime2real",     route: "#/cmd/anime2real",       label: "Anime→Real",        file: "frontend/views/transform/Anime2realView.tsx" },
  { id: "expansion",      route: "#/cmd/expansion",        label: "Expansion",         file: "frontend/views/transform/ExpansionView.tsx" },
  { id: "faceswap",       route: "#/cmd/faceswap",         label: "Face Swap",         file: "frontend/views/edit/FaceswapView.tsx" },
  { id: "swap",           route: "#/cmd/swap",             label: "Swap",              file: "frontend/views/edit/SwapView.tsx" },
  { id: "controlnet",     route: "#/cmd/controlnet",       label: "ControlNet",        file: "frontend/views/edit/ControlnetView.tsx" },
  { id: "angle",          route: "#/cmd/angle",            label: "Angle",             file: "frontend/views/edit/AngleView.tsx" },
  { id: "profile",        route: "#/cmd/profile",          label: "Profile",           file: "frontend/views/analyze/ProfileView.tsx" },
  { id: "quality",        route: "#/cmd/quality",          label: "Quality",           file: "frontend/views/analyze/QualityView.tsx" },
  { id: "model-check",    route: "#/cmd/model-check",      label: "Model Check",       file: "frontend/views/tools/ModelCheckView.tsx" },
  { id: "knowledge",      route: "#/cmd/knowledge",        label: "Knowledge",         file: "frontend/views/tools/KnowledgeView.tsx" },
]

async function runUxLane(opts) {
  const dryRun   = opts.dryRun === true
  const maxIters = typeof opts.maxIters === "number" ? opts.maxIters : 5
  const viewFilter = Array.isArray(opts.views) ? opts.views : null
  const knowledgeDigest = opts.knowledgeDigest || ""
  const runId    = opts.runId || "unknown"
  const VIEWS = viewFilter ? ALL_VIEWS.filter((v) => viewFilter.includes(v.id)) : ALL_VIEWS

  log(`[ux] config: dryRun=${dryRun}, maxIters=${maxIters}, views=${viewFilter ? viewFilter.join(",") : "all"}`)

  // ── Check GUI server (non-fatal: return null → orchestrator reports skipped) ──
  const serverCheck = await agent(
    `Check if the GUI dev server is running at port 3099.
Run: Bash("lsof -ti :3099 2>/dev/null | head -1")
If output is non-empty → { running: true, pid: "<output>" }
If empty → { running: false, pid: "" }`,
    { label: "ux-server-check", phase: "UX", model: "haiku",
      schema: { type: "object", properties: { running: { type: "boolean" }, pid: { type: "string" } }, required: ["running"] } },
  )
  if (!serverCheck?.running) {
    log("[ux] GUI server not running at localhost:3099 — lane skipped (non-fatal). Start with: cd bun-apps/gui-movie-director && bun run dev")
    return null
  }
  log(`[ux] GUI server running (pid=${serverCheck?.pid || "?"})`)

  await agent(
    `Bash("mkdir -p '${SHOT_DIR}'"). Return nothing.`,
    { label: "ux-mkdir-shots", phase: "UX", model: "haiku" },
  )

  // ── Survey: screenshot + VLM analyze all views ──
  log(`[ux] surveying ${VIEWS.length} views...`)

  const analyses = await pipeline(
    VIEWS,

    // Stage 1: Navigate + screenshot each view
    async (v) => {
      const shotPath = `${SHOT_DIR}/${v.id}-before.png`
      const shot = await agent(
        `Screenshot the GUI view "${v.label}" at http://localhost:3099/${v.route}.

Steps:
1. Use playwright-cli tools (find via ToolSearch "playwright screenshot navigate"):
   a. Navigate to: http://localhost:3099/${v.route}
   b. Wait ~1 second for the view to render
   c. Take a screenshot and save to: ${shotPath}

2. Verify the screenshot exists: Bash("test -f '${shotPath}' && echo OK || echo MISSING")

Return { ok: true, shotPath: "${shotPath}" } if screenshot succeeded,
or { ok: false, error: "<reason>" } if playwright is unavailable or the file is missing.`,
        { label: `ux-screenshot:${v.id}`, phase: "UX", model: "haiku",
          schema: { type: "object", properties: { ok: { type: "boolean" }, shotPath: { type: "string" }, error: { type: "string" } }, required: ["ok"] } },
      )
      return { v, shotPath: shot?.ok ? shotPath : null, screenshotOk: shot?.ok === true }
    },

    // Stage 2: VLM analyze screenshot → UX issues
    async ({ v, shotPath, screenshotOk }) => {
      if (!shotPath || !screenshotOk) {
        log(`[ux][survey] ${v.id}: screenshot failed — skipping VLM analysis`)
        return { ...v, uxScore: null, issues: [], shotPath: null, screenshotOk: false }
      }

      const captionOutPath = shotPath.replace(/\.png$/, ".caption.json")
      const analysis = await agent(
        `Analyze the GUI view "${v.label}" (id: ${v.id}) for UX quality using the local VLM caption.

⚠ TOKEN RULE: Do NOT Read() or attach the PNG file. Do NOT use built-in vision.
  Process ONLY the text output from run.py caption (steps 1–2 below).

Steps:
1. Run local VLM caption: Bash("${PYTHON} ${RUN_PY} caption '${shotPath}' --style playwright --lang en 2>&1")
   (This calls LM Studio locally — no cloud tokens spent on the image.)
2. Read the caption JSON: Bash("cat '${captionOutPath}' 2>/dev/null || echo '{}'")
   The JSON has a "caption" field with LAYOUT, INTERACTIVE ELEMENTS, STATE, PRIMARY ACTION sections.
3. If the source file is given (not N/A), Read("${GUI_DIR}/${v.file || "frontend/styles.css"}") for code context.
4. Based SOLELY on the caption text (step 2) AND the source code (step 3), identify UX issues.
   For each issue assign:
   - id: "${v.id}-NN" (e.g. "${v.id}-01")
   - severity: "high" (blocks user) | "medium" (friction) | "low" (polish)
   - category: "layout" | "feedback" | "clarity" | "consistency" | "accessibility"
   - title: short title (max 60 chars)
   - description: what is wrong and why it hurts UX
   - affectedFile: relative path from GUI_DIR (e.g. "frontend/styles.css" or "frontend/views/generate/T2iView.tsx"
                   or "frontend/components/CommandView.tsx" for shared issues)
   - fixHint: concrete 1-sentence suggestion for the code fix

Focus on finding REAL issues (not style opinions):
   - Field labels showing raw API names (cfg_scale, lora_scale, denoising_strength) → clarity
   - No loading state / submit button stays active during generation → feedback
   - Missing required-field indicators before form submit → feedback
   - Empty or blank views with no guidance message → feedback
   - Icon-only buttons with no title/aria-label → accessibility
   - Sections with inconsistent vertical padding vs other views → consistency

Prior-run knowledge digest (avoid re-flagging known false-positives, reuse known levers):
${knowledgeDigest || "(empty — first run)"}

Source file: ${v.file ? `${GUI_DIR}/${v.file}` : "N/A (config/gallery special view)"}
uxScore: 1-10 overall UX quality of this view (10 = excellent, 1 = very poor).
Return JSON: { viewId: "${v.id}", uxScore: <number>, issues: [<each issue as above, required: id,severity,category,title,affectedFile>] }.`,
        { label: `ux-analyze:${v.id}`, phase: "UX", model: "sonnet",
          schema: { type: "object", properties: {
            viewId: { type: "string" },
            uxScore: { type: "number" },
            issues: { type: "array", items: { type: "object", properties: {
              id: { type: "string" }, severity: { type: "string" }, category: { type: "string" },
              title: { type: "string" }, description: { type: "string" },
              affectedFile: { type: "string" }, fixHint: { type: "string" },
            }, required: ["id", "severity", "category", "title", "affectedFile"] } },
          }, required: ["viewId", "uxScore", "issues"] } },
      )

      const result = analysis || { viewId: v.id, uxScore: null, issues: [] }
      log(`[ux][survey] ${v.id}: score=${result.uxScore ?? "?"}, issues=${result.issues?.length ?? 0}`)
      return { ...v, ...result, shotPath }
    },
  )

  const surveyed = analyses.filter(Boolean)
  const totalIssues = surveyed.reduce((n, a) => n + (a.issues?.length || 0), 0)
  const avgScoreBefore = (() => {
    const scored = surveyed.filter((a) => a.uxScore != null)
    return scored.length ? scored.reduce((s, a) => s + a.uxScore, 0) / scored.length : null
  })()

  log(`[ux] survey complete: ${surveyed.length}/${VIEWS.length} views analyzed, ${totalIssues} issues found, avg UX score=${avgScoreBefore?.toFixed(1) ?? "?"}`)

  // ── Prioritize ──
  const allIssues = []
  surveyed.forEach((v) => {
    ;(v.issues || []).forEach((issue) => {
      allIssues.push({ ...issue, viewId: v.id, viewLabel: v.label, uxScoreBefore: v.uxScore, shotPath: v.shotPath, route: v.route })
    })
  })

  const SEV_WEIGHT = { high: 3, medium: 2, low: 1 }
  const prioritized = allIssues
    .filter((i) => i.severity !== "low")  // skip low in fix loop; they stay in report
    .sort((a, b) => {
      const sw = (SEV_WEIGHT[b.severity] || 0) - (SEV_WEIGHT[a.severity] || 0)
      if (sw !== 0) return sw
      return (a.uxScoreBefore ?? 10) - (b.uxScoreBefore ?? 10)
    })

  // Deduplicate: if same affectedFile appears multiple times, keep highest-severity per file
  const seenFiles = {}
  const fixQueue = []
  for (const issue of prioritized) {
    const key = `${issue.affectedFile}::${issue.category}`
    if (!seenFiles[key]) {
      seenFiles[key] = true
      fixQueue.push(issue)
    }
  }

  log(`[ux] prioritized: ${fixQueue.length} unique high/medium issues ready for fix loop`)

  // ── Fix Loop ──
  const fixResults = []
  let fixIter = 0

  // Dirty-tree guard (scoped to the GUI frontend surface): every revert below is a
  // bare `git checkout -- <file>`, which discards ALL uncommitted changes to that
  // file. Refuse to mutate when the scope is dirty to avoid clobbering WIP.
  let treeDirty = false
  if (!dryRun) {
    const dirtyCheck = await agent(
      `Check whether the git working tree has uncommitted changes in scope.
Bash("cd '${PROJECT_ROOT}' && git status --short -- 'bun-apps/gui-movie-director/frontend/' 'bun-apps/gui-movie-director/api/' 'bun-apps/gui-movie-director/lib/' | grep -v '^??' || true")
dirty = true if that printed any non-empty line (tracked-modified files). Untracked ('??') files don't count.
Return { dirty, files: [<the printed file paths, if any>] }.`,
      { label: "ux-dirty-tree-check", phase: "UX", model: "haiku",
        schema: { type: "object", properties: { dirty: { type: "boolean" }, files: { type: "array", items: { type: "string" } } }, required: ["dirty"] } },
    )
    treeDirty = dirtyCheck?.dirty === true
    if (treeDirty) {
      log(`⚠ [ux] Working tree is DIRTY in scope (${(dirtyCheck?.files || []).join(", ")}) — skipping fix loop to avoid a revert clobbering your WIP. Commit/stash, then re-run.`)
    }
  }

  if (dryRun) {
    log(`[ux] dry run mode — skipping fix loop. ${fixQueue.length} issues identified.`)
  } else if (treeDirty) {
    // fix loop skipped
  } else {
    const itersToRun = Math.min(maxIters, fixQueue.length)
    log(`[ux] fix loop: ${itersToRun} iteration(s) planned (queue=${fixQueue.length}, cap=${maxIters})`)

    for (let i = 0; i < itersToRun; i++) {
      const issue = fixQueue[i]
      fixIter = i + 1
      log(`[ux][fix ${fixIter}/${itersToRun}] ${issue.id}: "${issue.title}" [${issue.severity}] → ${issue.affectedFile}`)

      // ── Apply fix ──
      const fixResult = await agent(
        `Fix this UX issue in the GUI Movie Director codebase.

GUI directory: ${GUI_DIR}
Target file: ${GUI_DIR}/${issue.affectedFile}

Issue:
  ID: ${issue.id}
  View: ${issue.viewLabel} (${issue.viewId})
  Severity: ${issue.severity}
  Category: ${issue.category}
  Title: ${issue.title}
  Description: ${issue.description}
  Fix hint: ${issue.fixHint || "(none — use judgment)"}

Prior-run knowledge (reuse known levers, avoid known dead-ends):
${knowledgeDigest || "(empty — first run)"}

Rules:
1. Read("${GUI_DIR}/${issue.affectedFile}") first to understand the current code
2. Apply the MINIMUM necessary change (target 1–15 lines changed)
3. Keep existing CSS variable names (--bg-surface, --accent, --text-dim, --text-bright, etc.)
4. Do NOT change CLI arg logic, schema mappings, or buildCliArgs() functions
5. Do NOT add new npm dependencies
6. If the fix requires adding a CSS class, add it to frontend/styles.css AND reference it in the TSX
7. Use the Edit tool to apply the change
8. If applied, capture: Bash("cd '${GUI_DIR}' && git hash-object '${issue.affectedFile}'") → fileHash

Return { applied: true, description: "<one sentence describing what you changed>", fileHash: "<the hash from step 8>" }
or { applied: false, description: "<why you skipped this>" }.${opFixBlock}`,
        { label: `ux-fix:${issue.id}`, phase: "UX", model: "sonnet",
          schema: { type: "object", properties: {
            issueId: { type: "string" }, applied: { type: "boolean" }, testsPassed: { type: "boolean" },
            scoreBefore: { type: "number" }, scoreAfter: { type: "number" },
            revertReason: { type: "string" }, description: { type: "string" },
            fileHash: { type: "string", description: "git hash-object of the file right after the edit, so a later revert can detect a concurrent edit landing on top of it" },
          }, required: ["issueId", "applied", "testsPassed"] } },
      )

      if (!fixResult?.applied) {
        log(`[ux][fix ${fixIter}] SKIPPED: ${fixResult?.description || "no reason given"}`)
        fixResults.push({ issueId: issue.id, applied: false, testsPassed: false, scoreBefore: issue.uxScoreBefore, scoreAfter: null, revertReason: fixResult?.description || "agent chose not to apply" })
        continue
      }

      // ── Verify: bun test ──
      const testResult = await agent(
        `Run bun tests for the GUI Movie Director and report pass/fail.
Bash("cd '${GUI_DIR}' && bun test 2>&1 | tail -30")
Return { ok: <true if fail count is 0>, pass: <number>, fail: <number>, output: "<last 5 lines>" }.`,
        { label: `ux-test:iter${fixIter}`, phase: "UX", model: "haiku",
          schema: { type: "object", properties: { ok: { type: "boolean" }, pass: { type: "number" }, fail: { type: "number" }, output: { type: "string" } }, required: ["ok"] } },
      )

      if (!testResult?.ok) {
        log(`[ux][fix ${fixIter}] TESTS FAILED (pass=${testResult?.pass}, fail=${testResult?.fail}) — reverting`)
        await agent(
          `Revert the change to ${issue.affectedFile} — but only if nobody else touched it since our fix.
Bash("cd '${GUI_DIR}' && git hash-object '${issue.affectedFile}'") → currentHash
Expected hash (captured right after our fix): ${fixResult?.fileHash || "(none captured — proceed with revert)"}
If currentHash differs from the expected hash, someone edited the file concurrently — do NOT revert it, just report skipped.
Otherwise: Bash("cd '${GUI_DIR}' && git checkout -- '${issue.affectedFile}' 2>&1 || echo REVERT_FAILED")
If the affected file was frontend/styles.css AND another file was also changed, apply the same hash check before reverting it too.
Return nothing.`,
          { label: `ux-revert:iter${fixIter}`, phase: "UX", model: "haiku" },
        )
        fixResults.push({ issueId: issue.id, applied: false, testsPassed: false, scoreBefore: issue.uxScoreBefore, scoreAfter: null, revertReason: `bun test failed (pass=${testResult?.pass}, fail=${testResult?.fail})` })
        continue
      }

      log(`[ux][fix ${fixIter}] tests passed (pass=${testResult?.pass})`)

      // ── Re-screenshot + VLM rescore ──
      const afterShotPath = `${SHOT_DIR}/${issue.viewId}-iter${fixIter}-after.png`
      const beforeCaptionPath = issue.shotPath ? issue.shotPath.replace(/\.png$/, ".caption.json") : null
      const afterCaptionPath  = afterShotPath.replace(/\.png$/, ".caption.json")
      const rescore = await agent(
        `Re-screenshot the view "${issue.viewLabel}" and rescore UX quality after the fix.

⚠ TOKEN RULE: Do NOT Read() or attach any PNG file. Do NOT use built-in vision.
  Compare ONLY the text captions from run.py caption (steps 2–4 below).

1. Use playwright-cli tools to navigate to http://localhost:3099/${issue.route}
   and screenshot to ${afterShotPath}.
2. Run local VLM caption on the AFTER shot:
   Bash("${PYTHON} ${RUN_PY} caption '${afterShotPath}' --style playwright --lang en 2>&1")
3. Read AFTER caption text: Bash("cat '${afterCaptionPath}' 2>/dev/null || echo '{}'")
4. Read BEFORE caption text (from the survey pass):
   Bash("cat '${beforeCaptionPath || "/dev/null"}' 2>/dev/null || echo '{}'")
5. Compare the BEFORE caption vs AFTER caption (both are text JSON with "caption" field).
   Assess whether the issue "${issue.title}" (category: ${issue.category}) is visibly improved
   based on the INTERACTIVE ELEMENTS, STATE, and PRIMARY ACTION sections of both captions.
6. Return { ok: true, uxScore: <1-10 overall UX score of the view AFTER the fix> }
   or { ok: false, uxScore: null } if screenshot failed.`,
        { label: `ux-rescore:iter${fixIter}`, phase: "UX", model: "haiku",
          schema: { type: "object", properties: { uxScore: { type: "number" }, ok: { type: "boolean" } }, required: ["ok"] } },
      )

      const scoreBefore = issue.uxScoreBefore ?? 5
      const scoreAfter  = rescore?.uxScore ?? null
      const improved    = scoreAfter != null && scoreAfter >= scoreBefore

      if (!improved && scoreAfter != null) {
        log(`[ux][fix ${fixIter}] UX score did not improve (before=${scoreBefore}, after=${scoreAfter}) — reverting`)
        await agent(
          `Revert ${issue.affectedFile} — but only if nobody else touched it since our fix.
Bash("cd '${GUI_DIR}' && git hash-object '${issue.affectedFile}'") → currentHash
Expected hash (captured right after our fix): ${fixResult?.fileHash || "(none captured — proceed with revert)"}
If currentHash differs, someone edited the file concurrently — do NOT revert, just report skipped.
Otherwise: Bash("cd '${GUI_DIR}' && git checkout -- '${issue.affectedFile}'"). Return nothing.`,
          { label: `ux-revert-score:iter${fixIter}`, phase: "UX", model: "haiku" },
        )
        fixResults.push({ issueId: issue.id, applied: false, testsPassed: true, scoreBefore, scoreAfter, revertReason: `UX score unchanged or worse (${scoreBefore} → ${scoreAfter})` })
        continue
      }

      log(`[ux][fix ${fixIter}] KEPT ✓ (score: ${scoreBefore} → ${scoreAfter ?? "??"})`)
      fixResults.push({ issueId: issue.id, applied: true, testsPassed: true, scoreBefore, scoreAfter, description: fixResult?.description })
    }
  }

  // ── Aggregate (no per-lane persist — orchestrator handles disk writes) ──
  const issuesFixed   = fixResults.filter((r) => r.applied).length
  const issuesSkipped = fixResults.filter((r) => !r.applied).length
  const avgScoreAfter = (() => {
    const gains = fixResults.filter((r) => r.applied && r.scoreAfter != null)
    if (!gains.length) return avgScoreBefore
    const improvementSum = gains.reduce((s, r) => s + (r.scoreAfter - r.scoreBefore), 0)
    return avgScoreBefore != null ? avgScoreBefore + improvementSum / surveyed.filter((v) => v.uxScore != null).length : null
  })()

  log(`[ux] complete: ${issuesFixed} fixed, ${issuesSkipped} skipped, score: ${avgScoreBefore?.toFixed(1) ?? "?"} → ${avgScoreAfter?.toFixed(1) ?? "?"}`)

  return {
    runId,
    viewsSurveyed: surveyed.length,
    totalIssues,
    issuesFixed,
    issuesSkipped,
    avgUxScoreBefore: avgScoreBefore,
    avgUxScoreAfter:  avgScoreAfter,
    analyses: surveyed.map((v) => ({ id: v.id, uxScore: v.uxScore, issues: v.issues })),
    fixResults,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lane: LINT (deterministic static-analysis gate)
//
// Runs `bun run check:lint` (ESLint: @typescript-eslint/no-shadow=error +
// no-unused-vars=warn). This is the ONLY lane that deterministically catches the
// FileUpload-style defect — a local binding SHADOWING an imported name — which the
// other three lanes structurally cannot: LLM review misses it (subtle, "looks
// fine"), the schema lane has zero frontend visibility, and the UX lane only
// screenshots (the upload error only manifests on real interaction, never in a
// static shot). Adding this lane is the direct fix for "the workflow can't catch
// these command problems in the webui".
//
// Always read-only: eslint --fix cannot resolve no-shadow / no-unused-vars (those
// need a rename/removal judgment), so this lane SURFACES regressions for the review
// lane or a human to fix. Its value is detection + gating openIssues — the
// "incremental resolve, avoid again" loop. errorCount feeds openIssues so any new
// shadowing bug shows up as an openIssues ↑ in the trend.
// ═══════════════════════════════════════════════════════════════════════════════

async function runLintLane(opts) {
  const runId   = opts.runId || "run-1"
  const fixMode = opts.fix === true // accepted for symmetry; lint is always read-only

  const lintRun = await agent(
    `Run the GUI ESLint gate and parse the result.
Run: Bash("cd '${GUI_DIR}' && bun run check:lint 2>&1; echo EXIT=$?")
ESLint prints one line per finding ("<file>" then "  <line>:<col>  <error|warning>  <message>  <rule>")
then a summary "✖ N problems (E errors, W warnings)" when there are any, or nothing on success.
Exit: 0 = clean, 1 = findings present, 2 = config/install error.

Parse and return:
- clean: true iff exit 0 (zero findings)
- errorCount / warningCount: the numbers from the summary line (0 if absent)
- findings: one entry per finding line → { file, line(number|null), severity, message, rule }
  (skip the "✖ … problems" summary line and the trailing "EXIT=" line)
- configError: true iff exit was 2 (eslint not installed / config broken)`,
    { label: "lint-run", phase: "Lint", model: "haiku",
      schema: { type: "object", properties: {
        clean:        { type: "boolean" },
        errorCount:   { type: "number" },
        warningCount: { type: "number" },
        configError:  { type: "boolean" },
        findings: { type: "array", items: { type: "object", properties: {
          file: { type: "string" }, line: { type: "number" },
          severity: { type: "string" }, message: { type: "string" }, rule: { type: "string" },
        }, required: ["file", "severity", "message"] } },
      }, required: ["clean", "errorCount", "warningCount"] } },
  )

  const clean        = lintRun?.clean === true
  const errorCount   = Number(lintRun?.errorCount) || 0
  const warningCount = Number(lintRun?.warningCount) || 0
  const configError  = lintRun?.configError === true
  const findings     = (lintRun?.findings || []).filter((f) => f && f.file)
  const errors       = findings.filter((f) => f.severity === "error")
  const shadowing    = errors.filter((f) => (f.rule || "").includes("no-shadow"))

  if (configError) {
    log(`⚠ [lint] config/install error — is eslint installed in ${GUI_DIR}? (bun add -d eslint typescript-eslint)`)
  } else if (clean) {
    log(`[lint] clean — 0 errors, 0 warnings (gate holds)`)
  } else {
    const files = new Set(findings.map((f) => f.file))
    log(`[lint] ${errorCount} error(s) [${shadowing.length} shadowing], ${warningCount} warning(s) across ${files.size} file(s)`)
    for (const f of errors.slice(0, 12)) {
      log(`  [${f.severity}] ${f.file}:${f.line ?? "?"} ${f.message} [${f.rule || "?"}]`)
    }
  }

  return {
    runId,
    clean,
    configError,
    errorCount,
    warningCount,
    findings,
    shadowingErrors: shadowing.length,
    summary: configError
      ? `Lint: CONFIG ERROR (eslint missing/broken)`
      : clean
        ? `Lint: clean (0 errors / 0 warnings)`
        : `Lint: ${errorCount} error(s) [${shadowing.length} shadowing], ${warningCount} warning(s)`,
  }
}

// ══ Phase: Resolve ════════════════════════════════════════════════════════════

phase("Resolve")

// ── Resolve PROJECT_ROOT dynamically (worktree-correct) ──────────────────────
// A hardcoded root made this workflow edit a SIBLING repo when run from a
// worktree (e.g. feat/gui worktree vs main) — fixes/paths landed on the wrong
// branch. Resolve the actual tree we are in and re-derive every path from it.
{
  const rootResolve = await agent(
    `Resolve the git repository root of the working tree we are running in.
Bash("git rev-parse --show-toplevel")
Return { root: "<the absolute path, whitespace-trimmed>" }.`,
    { label: "resolve-project-root", phase: "Resolve", model: "haiku",
      schema: { type: "object", properties: { root: { type: "string" } }, required: ["root"] } },
  )
  const resolved = (rootResolve?.root || "").trim()
  if (resolved && resolved.includes("video_generation")) {
    PROJECT_ROOT = resolved
    GUI_DIR      = `${PROJECT_ROOT}/bun-apps/gui-movie-director`
    PYTHON       = `${PROJECT_ROOT}/python/venv/bin/python`
    RUN_PY       = `${PROJECT_ROOT}/python/mlx-movie-director/run.py`
    HISTORY_DIR  = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
    INDEX_FILE   = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`
    KB_FILE      = `${PROJECT_ROOT}/.claude/workflows/${NAME}.knowledge.jsonl`
    OP_FILE      = `${PROJECT_ROOT}/.claude/workflows/${NAME}.operation-lessons.jsonl`
    OP_INBOX     = `${PROJECT_ROOT}/.claude/workflows/${NAME}.operation-lessons.proposed.jsonl`
    log(`Resolved PROJECT_ROOT → ${PROJECT_ROOT} (worktree-correct)`)
  } else {
    log(`⚠ could not resolve repo root (got "${resolved}"); keeping fallback ${PROJECT_ROOT}`)
  }
}

// Timestamp (no Date.now() in workflows).
const RUN_TIMESTAMP = await agent(
  `Return the current timestamp in ISO format with colons replaced by dashes for filename safety.
  Run: Bash("date -u +%Y-%m-%dT%H-%M-%S")
  Return { timestamp: "<the output>" }.`,
  { label: "timestamp", phase: "Resolve", model: "haiku",
    schema: { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] } },
)
const RUN_ID = RUN_TIMESTAMP?.timestamp || "unknown"

// ONE knowledge base for the whole run (full consolidation: the merged KB carries
// review/schema/ux meta-lessons + ux patterns folded in from the former ux lane).
const knowledge = await loadKnowledge(KB_FILE)
const knowledgeDigest = knowledge?.digest || ""

// Operation-lessons (approved store) — injected into the inlined code-fix agents
// (schema-drift-apply, ux-fix). The review lane gets its own via the child workflow.
// Proposed lessons (OP_INBOX) are NOT loaded — never inject untrusted rules.
const operationLessons = await loadOperationLessons(OP_FILE)
const _opByPhase = operationLessons?.byPhase || {}
const opFixBlock = operationRulesBlock(_opByPhase, "fix")

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

// Auto-detect GUI server → opportunistically add UX lane when server is up
// and the user didn't explicitly specify lanes (so we don't override their intent).
if (!UX_EXPLICIT && !DO_UX && UX_AUTO) {
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
let lintResult   = null
let uxResult     = null

const TOTAL_LANES = LANES.length
let laneIdx = 0

// Resolve review-optimize by scriptPath, NOT by name. The nested workflow(name)
// call resolves from a registry that can serve a STALE cached parse of the
// script — so edits to review-optimize.js (W3 USAGE_AWARE dimension prompts,
// W4 consolidated low-effort verify gate) silently did NOT take effect in
// routine scans. Validated 2026-06-20: the same 5 files at effort:low produced
// 10 findings / ~5 FP via the name-call (stale, pre-W3/W4) but 2 findings / 0
// FP via scriptPath (current file, gate ran). scriptPath always reads the file
// on disk. (See memory: workflow-name-caches-stale-script.)
const REVIEW_OPTIMIZE = { scriptPath: `${PROJECT_ROOT}/.claude/workflows/gui-movie-director-review-optimize.js` }

// Lint is read-only and NEVER edits (eslint --fix can't resolve no-shadow/unused —
// those need a rename/removal judgment), so it always parallelizes safely, even in
// fix mode. Fanned out alongside review/schema below.
const runLint = () => runLintLane({ runId: RUN_ID, fix: fixEnabled })
  .catch((e) => { log(`  lint lane FAILED: ${e?.message || e}`); return null })

// Review + schema run in parallel when fix is disabled — both are purely read-only
// in that mode (no git-stash, no file edits). When fix:true, run sequentially:
// review-optimize uses git-stash which would collide with concurrent schema edits
// to the same working tree. Lint joins the parallel fan-out (or runs standalone).
if (!fixEnabled && (DO_REVIEW || DO_SCHEMA || DO_LINT)) {
  const names = [DO_REVIEW && "review", DO_SCHEMA && "schema", DO_LINT && "lint"].filter(Boolean)
  log(`▸ Lanes (review-only — fanning out): ${names.join(" + ")}`)
  const thunks = []
  if (DO_REVIEW) thunks.push(() => workflow(REVIEW_OPTIMIZE, {
    effort: EFFORT, fix: false, resume: RESUME,
    ...(FOCUS ? { focus: FOCUS } : {}),
    ...(FILES ? { files: FILES } : {}),
  }).catch((e) => { log(`  review lane FAILED: ${e?.message || e}`); markPhase("run", "failed"); return null }))
  if (DO_SCHEMA) thunks.push(() => runSchemaLane({
    objective: OBJECTIVE,
    ...(TARGET ? { target: TARGET } : {}),
    knowledgeDigest, runId: RUN_ID,
  }).catch((e) => { log(`  schema lane FAILED: ${e?.message || e}`); markPhase("run", "failed"); return null }))
  if (DO_LINT) thunks.push(runLint)
  const results = await parallel(thunks)
  let ri = 0
  if (DO_REVIEW) { reviewResult = results[ri++]; log(`  review done — verified: ${reviewResult?.findings?.verified ?? "?"}`) }
  if (DO_SCHEMA)  { schemaResult = results[ri++]; log(`  schema done — ${schemaResult?.summary ?? "(no summary)"}`) }
  if (DO_LINT)    { lintResult = results[ri++];   log(`  lint done — ${lintResult?.summary ?? "(no summary)"}`) }
  laneIdx = thunks.length
} else {
  // Sequential: fix:true, or a single lane is active.
  if (DO_REVIEW) {
    log(`▸ Lane ${++laneIdx}/${TOTAL_LANES}: structural code review (gui-movie-director-review-optimize)`)
    try {
      reviewResult = await workflow(REVIEW_OPTIMIZE, {
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
    log(`▸ Lane ${++laneIdx}/${TOTAL_LANES}: schema→CLI boundary (inlined schema lane)`)
    try {
      schemaResult = await runSchemaLane({
        objective: OBJECTIVE,
        ...(TARGET ? { target: TARGET } : {}),
        knowledgeDigest, runId: RUN_ID,
      })
      log(`  schema lane done — ${schemaResult?.summary ?? "(no summary)"}`)
    } catch (e) {
      log(`  schema lane FAILED: ${e?.message || e}`)
      markPhase("run", "failed")
    }
  }

  if (DO_LINT) {
    log(`▸ Lane ${++laneIdx}/${TOTAL_LANES}: lint (deterministic static-analysis gate)`)
    try {
      lintResult = await runLintLane({ runId: RUN_ID, fix: fixEnabled })
      log(`  lint lane done — ${lintResult?.summary ?? "(no summary)"}`)
    } catch (e) {
      log(`  lint lane FAILED: ${e?.message || e}`)
    }
  }
}

// Lane: UX screenshot analysis + VLM scoring + fix loop.
// Non-fatal — gracefully skipped if the GUI server is not running (returns null).
if (DO_UX) {
  log(`▸ Lane ${++laneIdx}/${TOTAL_LANES}: UX screenshot analysis (inlined ux lane)`)
  try {
    uxResult = await runUxLane({
      // Collision-safe contract: when the orchestrator is review-only (fix not
      // enabled), the UX lane must NOT edit either — force dry-run. UX_DRY_RUN
      // is honored only when fixes are actually enabled.
      dryRun:   fixEnabled ? UX_DRY_RUN : true,
      maxIters: UX_MAX_ITERS,
      ...(UX_VIEWS ? { views: UX_VIEWS } : {}),
      knowledgeDigest, runId: RUN_ID,
    })
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
// Report honesty: when fix:true actually ran but applied 0 of N>0 verified findings
// with NO explicit skip/fail/regress reason, the only explanation is the fix severity
// threshold gating everything out (no high/critical -> adversarialVerify skipped,
// totalVerdicts:0). Surface this so openIssues=N doesn't read as "N things to fix"
// when none were eligible. (Code action for the lesson the self-learning propose
// step surfaced in iter-1; the report-honesty gap it flagged.)
const fixSkipReason  = (fixEnabled && reviewApplied === 0 && reviewVerified > 0
                        && (reviewResult?.fixes?.skipped ?? 0) === 0
                        && (reviewResult?.fixes?.failed ?? 0) === 0
                        && reviewRegress === 0)
  ? `0 of ${reviewVerified} verified finding(s) eligible to fix — all below the fix severity threshold (no high/critical), so adversarialVerify was skipped (totalVerdicts:0). Triage the medium/low backlog manually, or re-run fix:true once a high-severity finding appears.`
  : null

const schemaRuntimeErr   = schemaResult?.runtimeErrors ?? 0
const schemaRuntimeFind  = schemaResult?.runtimeFindings ?? 0
const schemaDriftRem     = schemaResult?.driftRemaining ?? 0
const schemaCovDelta     = schemaResult?.delta ?? "n/a"

const uxTotalIssues = uxResult?.totalIssues ?? 0
const uxIssuesFixed = uxResult?.issuesFixed ?? 0
const uxScoreBefore = uxResult?.avgUxScoreBefore ?? null
const uxScoreAfter  = uxResult?.avgUxScoreAfter ?? null

const lintErrors    = lintResult?.errorCount ?? 0
const lintWarnings  = lintResult?.warningCount ?? 0
const lintShadowing = lintResult?.shadowingErrors ?? 0
const lintConfigErr = lintResult?.configError === true

// Unified health scalar for trend tracking: ACTIONABLE code-health debt only
// (lower = healthier) = review verified findings + schema runtime errors + remaining
// drift. UX totalIssues is intentionally EXCLUDED: in the default review-only/dryRun
// mode the UX lane surfaces issues but fixes none, so counting them made this scalar
// (and its run-over-run trend) reflect UX screenshot variance instead of code health
// (a prior 158-score was ~95% unfixed UX noise). UX debt is tracked separately as
// uxOpenIssues + avgUxScore. Lint errors (shadowing = the FileUpload bug class) ARE
// counted — they are deterministic, actionable, and the whole point of the lint gate.
// Fix runs (review + schema drift) drive openIssues down.
const uxOpenIssues = Math.max(0, uxTotalIssues - uxIssuesFixed)
const openIssues = reviewVerified + schemaRuntimeErr + schemaDriftRem + lintErrors

// ── Delta from last run ─────────────────────────────────────────────────────
// Read the most recent prior history entry to compute openIssues trend (↑/↓/=).
let deltaStr = null
{
  const prevRun = await agent(
    `Read the most recent prior self-improve run from history to get previous openIssues.
1. Bash("ls -t '${HISTORY_DIR}/' 2>/dev/null | grep '\\.json$'")
2. Find the FIRST filename that is NOT '${RUN_ID}.json'. If none → { found: false, openIssues: null }.
3. Bash("cat '${HISTORY_DIR}/<that filename>'")
4. Parse JSON. Compute prevOpenIssues with the CURRENT (code-only) definition so the
   trend stays comparable across the formula change: sum result.review.verified +
   result.schema.runtimeErrors + result.schema.driftRemaining + result.lint.errorCount
   (each defaults to 0 if absent). ONLY if all those components are absent, fall back
   to result.openIssues or
   parse signals.key_metric (format: "openIssues=N ...") for the leading N.
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
  key_metric: `openIssues=${openIssues} [code: review:${reviewVerified} schemaErr:${schemaRuntimeErr} drift:${schemaDriftRem} lint:${lintErrors}]${DO_UX ? ` + uxOpen:${uxOpenIssues}/${uxTotalIssues}` : ""}`,
  delta_from_last: deltaStr,
  highlights: [
    DO_REVIEW  ? `review: ${reviewVerified} verified finding(s)${fixEnabled ? ` → ${reviewApplied} fix(es) applied, ${reviewRegress} regression(s)` : " (review-only)"}` : null,
    DO_SCHEMA  ? `schema: ${schemaRuntimeFind} runtime finding(s), ${schemaRuntimeErr} error(s), drift→${schemaDriftRem}${["coverage","both","all"].includes(OBJECTIVE) ? `, coverage Δ=${schemaCovDelta}` : ""}` : null,
    DO_LINT    ? `lint: ${lintErrors} error(s) [${lintShadowing} shadowing], ${lintWarnings} warning(s)${lintConfigErr ? " — CONFIG ERROR" : ""}` : null,
    DO_UX && uxResult  ? `ux: ${uxTotalIssues} issue(s), ${uxIssuesFixed} fixed, score: ${uxScoreBefore?.toFixed(1) ?? "?"}→${uxScoreAfter?.toFixed(1) ?? "?"}` : null,
    DO_UX && !uxResult ? "ux: lane failed (server may be down) — skipped" : null,
    FIX_REQ && dirtyTree ? "fix:true DOWNGRADED to review-only (dirty tree)" : null,
    fixSkipReason ? `fix: 0 of ${reviewVerified} eligible — severity threshold gated all (no high/critical); adversarialVerify skipped, 0 regressions` : null,
    chronicCount > 0 ? `chronic: ${chronicCount} finding(s) recurring from prior run (unfixed)` : null,
    deltaStr ? `trend: ${deltaStr} vs last run` : null,
  ].filter(Boolean),
  warnings: [
    ...(phasesFailed.length ? [`phases failed: ${phasesFailed.join(",")}`] : []),
    ...(FIX_REQ && dirtyTree ? ["concurrent WIP detected; fix deferred"] : []),
    ...(DO_LINT && lintConfigErr ? ["lint: eslint config/install error — run `bun add -d eslint typescript-eslint` in bun-apps/gui-movie-director"] : []),
    ...(DO_LINT && lintErrors > 0 ? [`${lintErrors} lint error(s) [${lintShadowing} shadowing] — fix to clear the gate`] : []),
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
    lint: lintResult ? {
      errorCount: lintErrors,
      warningCount: lintWarnings,
      shadowingErrors: lintShadowing,
      configError: lintConfigErr,
    } : null,
    reviewHistory: reviewResult?.history?.path || null,
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
  lint: lintResult ? { errors: lintErrors, shadowing: lintShadowing, warnings: lintWarnings } : null,
  // Files with verified findings this run — drives the "most bug-prone" trend
  // across runs (independent of whether they were fixed).
  filesTouched: reviewResult?.findings?.items
    ? [...new Set(reviewResult.findings.items.map((f) => f.file).filter(Boolean))]
    : [],
  timestamp: RUN_ID,
}

let proposedLessons = []
let pruneResult = null
try {
  await saveHistory(HISTORY_DIR, INDEX_FILE, historyEntry, signals)
  log(`History: ${HISTORY_DIR}/${RUN_ID}.json`)
  await extractKnowledge(KB_FILE, RUN_ID, historyEntry.result, null)
  // Prune stale-active knowledge (DETECT-ONLY): flag records whose referenced source file
  // is gone, every run. Never writes/retires — operator manually retires confirmed ones.
  try {
    pruneResult = await pruneKnowledge(KB_FILE, RUN_ID)
  } catch (e) { log(`prune-knowledge failed (non-fatal): ${e?.message || e}`) }
  // Self-learning: propose operation-lesson candidates from this run's failures →
  // staging inbox (OP_INBOX). NEVER writes the approved store. Non-fatal.
  try {
    proposedLessons = await proposeOperationLessons(OP_INBOX, OP_FILE, RUN_ID, historyEntry.result)
  } catch (e) { log(`propose-lessons failed (non-fatal): ${e?.message || e}`) }
  // Auto-refresh the workflow knowledge coverage matrix (MANIFEST.md) so the self-kb
  // dashboard stays current. The generator resolves paths from its own __dirname, so
  // invoke by absolute path from any cwd. Non-fatal.
  try {
    const mf = await agent(
      `Refresh the workflow knowledge coverage matrix (MANIFEST.md), then report whether it succeeded.
Bash("node '${PROJECT_ROOT}/scripts/workflow-knowledge-manifest.mjs' 2>&1 | tail -4; echo EXIT=$?")
refreshed = true iff the EXIT marker is 0.
Return { refreshed: <bool>, tail: "<the last few output lines>" }.`,
      { label: "manifest-refresh", phase: "Persist", model: "haiku",
        schema: { type: "object", properties: { refreshed: { type: "boolean" }, tail: { type: "string" } }, required: ["refreshed"] } })
    if (mf?.refreshed) log("MANIFEST.md coverage matrix refreshed")
    else log(`⚠ MANIFEST refresh not confirmed (refreshed=${mf?.refreshed}): ${(mf?.tail || "").slice(0, 160)}`)
  } catch (e) { log(`manifest refresh failed (non-fatal): ${e?.message || e}`) }
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
  const kbAppend = await agent(
    `Append this self-improve run as a code-knowledge record to the shared knowledge base, then VERIFY it landed.
1. Write the record JSON to a temp file:
   Write({ file_path: "/tmp/code-knowledge-record.json", content: <JSON below> })
   ${codeRecordJson}
2. Append it via the canonical module (capture combined output + exit marker):
   Bash("bun run '${PROJECT_ROOT}/bun-apps/gui-movie-director/scripts/code-knowledge-append.ts' /tmp/code-knowledge-record.json 2>&1; echo EXIT=$?")
3. VERIFY the record actually landed — count this run's runId in records.jsonl:
   Bash("grep -c '${RUN_ID}' '${PROJECT_ROOT}/knowledge-base/code/records.jsonl' 2>/dev/null || echo 0")
   present = (the count from step 3 is >= 1). If the bun command in step 2 failed (non-zero EXIT), present is false.
Return { appended: <present>, verified: <present>, output: "<the step 2 output>" }.`,
    { label: "code-knowledge-append", phase: "Persist", model: "haiku",
      schema: { type: "object", properties: { appended: { type: "boolean" }, verified: { type: "boolean" }, output: { type: "string" } }, required: ["appended", "verified"] } },
  )
  knowledgeAppended = kbAppend?.verified === true
  if (knowledgeAppended) {
    log(`Code-knowledge: record appended + verified in knowledge-base/code/ (openIssues=${openIssues})`)
  } else {
    log(`⚠ Code-knowledge append NOT verified (appended=${kbAppend?.appended}) — record may be missing. Output: ${(kbAppend?.output || "").slice(0, 200)}`)
  }
} catch (e) {
  log(`Code-knowledge append failed (non-fatal): ${e?.message || e}`)
}

// ══ Phase: Report ════════════════════════════════════════════════════════════

phase("Report")

const _opLoaded = Object.values(_opByPhase).reduce((a, arr) => a + (Array.isArray(arr) ? arr.length : 0), 0)
const proposedNote = proposedLessons.length
  ? ` Review ${proposedLessons.length} proposed operation-lesson(s) in the staging inbox (${OP_INBOX}); promote approved ones into the matching *.operation-lessons.jsonl (human-gated).`
  : ""
const pruneNote = pruneResult?.candidates?.length
  ? ` ${pruneResult.candidates.length} stale-active knowledge candidate(s) flagged for review (referenced source file absent) — manually retire confirmed ones in ${KB_FILE}.`
  : ""

const report = {
  workflow: NAME,
  runId: RUN_ID,
  lanes: LANES,
  effort: EFFORT,
  fixApplied: fixEnabled,
  fixDowngraded: FIX_REQ && dirtyTree,
  fixSkipReason,
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
        // Coverage is only measured when objective includes "coverage"/"both"/"all".
        // Otherwise schemaResult.baseline/final/delta are "NaN" (toFixed of NaN) —
        // omit them so the report doesn't show broken NaN fields for the runtime default.
        ...(["coverage", "both", "all"].includes(OBJECTIVE) ? {
          coverageBaseline: schemaResult.baseline ?? null,
          coverageFinal: schemaResult.final ?? null,
          coverageDelta: schemaCovDelta,
        } : { coverageMeasured: false }),
        summary: schemaResult.summary,
      }
    : null,
  ux: uxResult
    ? {
        viewsSurveyed:  uxResult.viewsSurveyed,
        totalIssues:    uxTotalIssues,
        openIssues:     uxOpenIssues,
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
  lint: lintResult
    ? {
        clean: lintResult.clean,
        errorCount: lintErrors,
        shadowingErrors: lintShadowing,
        warningCount: lintWarnings,
        configError: lintConfigErr,
        topErrors: (lintResult.findings || []).filter((f) => f.severity === "error").slice(0, 8)
          .map((f) => ({ file: f.file, line: f.line, message: f.message, rule: f.rule })),
      }
    : DO_LINT
      ? { skipped: true, reason: "lint lane did not complete" }
      : null,
  signals,
  knowledgeContribution: knowledgeAppended
    ? { appended: true, openIssues, kbPath: "knowledge-base/code/records.jsonl" }
    : { appended: false },
  operationRules: {
    loaded: _opLoaded,
    byPhase: Object.fromEntries(Object.entries(_opByPhase).map(([p, arr]) => [p, Array.isArray(arr) ? arr.length : 0])),
  },
  prune: pruneResult
    ? {
        scanned: pruneResult.scanned,
        candidates: (pruneResult.candidates || []).slice(0, 8).map((c) => ({ id: c.id, reason: c.reason })),
      }
    : null,
  proposedLessons: proposedLessons.length
    ? proposedLessons.map((l) => ({ id: l.id, phase: l.phase, severity: l.severity, target: l.target_hint || null, why: l.why }))
    : [],
  proposedInbox: OP_INBOX,
  nextStep:
    (fixEnabled
      ? (reviewRegress > 0 ? "Regressions detected — review-optimize should have auto-reverted the offending files via git checkout/rm. Inspect the tree."
        : reviewApplied === 0 && reviewVerified > 0 ? `fix:true applied 0 of ${reviewVerified} verified finding(s) — all below the fix severity threshold (no high/critical), so none were eligible. Triage the medium/low backlog manually, or re-run fix:true once a high-severity finding appears.`
        : "Fixes applied. Re-run routine scan to confirm openIssues dropped.")
      : FIX_REQ && dirtyTree
        ? "Tree was dirty so fixes were skipped. Commit/stash concurrent WIP, then re-run with fix:true to apply the verified findings above."
        : DO_UX && !uxResult
          ? "UX lane did not run (GUI server may be down). Start the server with `cd bun-apps/gui-movie-director && bun run dev`, then re-run with lanes:'all'."
          : "Review-only scan complete. To apply verified fixes, re-run with args { effort:'medium', fix:true } on a clean git tree.") + proposedNote + pruneNote,
}

return report
