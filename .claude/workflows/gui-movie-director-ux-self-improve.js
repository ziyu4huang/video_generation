// GUI Movie Director UX Self-Improve — Autonomous UX improvement loop
//
// Screenshots every view via playwright-cli, analyzes each with the local VLM
// (--style playwright), builds a priority queue of UX issues, then iterates:
//   fix → bun test → re-screenshot → VLM rescore → keep-or-revert
//
// This complements the existing code-quality workflow (gui-movie-director-review-optimize)
// by focusing exclusively on USER-FACING UX: field clarity, loading feedback,
// visual consistency, empty states, required-field indicators, and interaction patterns.
//
// Usage:
//   Workflow({ name: "gui-movie-director-ux-self-improve" })
//     → survey all 23 routes, auto-apply fixes, max 5 iterations
//   Workflow({ name: "...", args: { dryRun: true } })
//     → survey only (UX audit report, no edits)
//   Workflow({ name: "...", args: { views: ["t2i", "gallery", "knowledge"] } })
//     → target specific views
//   Workflow({ name: "...", args: { maxIters: 10 } })
//     → more fix iterations
//
// Prerequisite: GUI dev server running at http://localhost:3099 (bun run dev)

export const meta = {
  name: "gui-movie-director-ux-self-improve",
  description: "Autonomous UX improvement loop for the Bun GUI Movie Director — screenshots all views via playwright-cli, VLM-analyzes each for UX issues, then iterates fix → bun test → rescore → keep-or-revert",
  whenToUse: "Improve user-facing UX of gui-movie-director: field clarity, loading states, required-field indicators, visual consistency, empty states. Complements gui-movie-director-review-optimize (code quality) — this workflow targets what the user actually sees and interacts with. Requires GUI server at localhost:3099. Default = dryRun:false (auto-apply); use dryRun:true for an audit-only pass.",
  phases: [
    { title: "Resolve",    detail: "Detect project root, check GUI server at :3099, load prior history" },
    { title: "Survey",     detail: "Navigate + screenshot all 23 routes, VLM analyze each for UX issues" },
    { title: "Prioritize", detail: "Flatten, deduplicate, and sort issues by severity (global-file fixes first)" },
    { title: "Fix Loop",   detail: "N iterations: pick top issue → edit TSX/CSS → bun test → rescore → keep or revert" },
    { title: "Report",     detail: "Avg UX score before/after, issues fixed vs skipped, per-view breakdown" },
    { title: "Persist",    detail: "Write run history + cross-workflow index" },
  ],
}

// ── Args normalization ────────────────────────────────────────────────────────

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

const dryRun   = A.dryRun === true             // survey only, no edits
const maxIters = typeof A.maxIters === "number" ? A.maxIters : 5
const viewFilter = Array.isArray(A.views) ? A.views : null  // null = all views

log(`Config: dryRun=${dryRun}, maxIters=${maxIters}, viewFilter=${viewFilter ? viewFilter.join(",") : "all"}`)

// ── Phase tracking ────────────────────────────────────────────────────────────

const phaseStatus = {
  resolve:    "pending",
  survey:     "pending",
  prioritize: "pending",
  fixLoop:    "pending",
  report:     "pending",
  persist:    "pending",
}

const phasesCompleted = []

function markPhase(name, status) {
  phaseStatus[name] = status
  if (status === "completed" || status === "skipped") phasesCompleted.push(name)
}

// ── View registry (all 20 cmd + 3 special = 23 routes) ───────────────────────

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

const VIEWS = viewFilter ? ALL_VIEWS.filter((v) => viewFilter.includes(v.id)) : ALL_VIEWS

// ── Schemas ───────────────────────────────────────────────────────────────────

const PATH_SCHEMA = {
  type: "object",
  properties: { projectRoot: { type: "string" } },
  required: ["projectRoot"],
}

const TIMESTAMP_SCHEMA = {
  type: "object",
  properties: { timestamp: { type: "string" } },
  required: ["timestamp"],
}

const SERVER_CHECK_SCHEMA = {
  type: "object",
  properties: {
    running: { type: "boolean" },
    pid:     { type: "string" },
  },
  required: ["running"],
}

const SCREENSHOT_SCHEMA = {
  type: "object",
  properties: {
    ok:       { type: "boolean" },
    shotPath: { type: "string" },
    error:    { type: "string" },
  },
  required: ["ok"],
}

const UX_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    viewId:  { type: "string" },
    uxScore: { type: "number" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:           { type: "string" },
          severity:     { type: "string" },
          category:     { type: "string" },
          title:        { type: "string" },
          description:  { type: "string" },
          affectedFile: { type: "string" },
          fixHint:      { type: "string" },
        },
        required: ["id", "severity", "category", "title", "affectedFile"],
      },
    },
  },
  required: ["viewId", "uxScore", "issues"],
}

const FIX_RESULT_SCHEMA = {
  type: "object",
  properties: {
    issueId:      { type: "string" },
    applied:      { type: "boolean" },
    testsPassed:  { type: "boolean" },
    scoreBefore:  { type: "number" },
    scoreAfter:   { type: "number" },
    revertReason: { type: "string" },
    description:  { type: "string" },
    fileHash:     { type: "string", description: "git hash-object of the file right after the edit, so a later revert can detect a concurrent edit landing on top of it" },
  },
  required: ["issueId", "applied", "testsPassed"],
}

const TEST_SCHEMA = {
  type: "object",
  properties: {
    ok:   { type: "boolean" },
    pass: { type: "number" },
    fail: { type: "number" },
    output: { type: "string" },
  },
  required: ["ok"],
}

const RESCORE_SCHEMA = {
  type: "object",
  properties: {
    uxScore: { type: "number" },
    ok:      { type: "boolean" },
  },
  required: ["ok"],
}

// ── saveHistory (canonical pattern) ───────────────────────────────────────────

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

// ── Phase 0: Resolve ──────────────────────────────────────────────────────────

phase("Resolve")

const pathResolution = await agent(
  `Detect the git project root.
Run: Bash("git rev-parse --show-toplevel")
Return { projectRoot: "<path>" }. Normalize backslashes to forward slashes.`,
  { label: "resolve-paths", phase: "Resolve", model: "haiku", schema: PATH_SCHEMA },
)

const PROJECT_ROOT = (pathResolution?.projectRoot || "").replace(/\\/g, "/")
if (!PROJECT_ROOT) log("ERROR: Could not resolve project root.")

const PYTHON   = `${PROJECT_ROOT}/python/venv/bin/python`
const RUN_PY   = `${PROJECT_ROOT}/python/mlx-movie-director/run.py`
const GUI_DIR  = `${PROJECT_ROOT}/bun/gui-movie-director`
const WORKFLOW_NAME = "gui-movie-director-ux-self-improve"
const HISTORY_DIR   = `${PROJECT_ROOT}/.claude/workflows/history/${WORKFLOW_NAME}`
const INDEX_FILE    = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`
const SHOT_DIR      = `/tmp/gui-ux`

log(`PROJECT_ROOT=${PROJECT_ROOT}`)
log(`GUI_DIR=${GUI_DIR}`)

// Check GUI server
const serverCheck = await agent(
  `Check if the GUI dev server is running at port 3099.
Run: Bash("lsof -ti :3099 2>/dev/null | head -1")
If output is non-empty → { running: true, pid: "<output>" }
If empty → { running: false, pid: "" }`,
  { label: "server-check", phase: "Resolve", model: "haiku", schema: SERVER_CHECK_SCHEMA },
)

const serverRunning = serverCheck?.running === true
if (!serverRunning) {
  log("ERROR: GUI server not running at localhost:3099. Please run: cd bun/gui-movie-director && bun run dev")
  markPhase("resolve", "failed")
  return { error: "GUI server not running at localhost:3099. Start with: cd bun/gui-movie-director && bun run dev", phaseStatus }
}
log(`GUI server running (pid=${serverCheck?.pid || "?"})`)

// Timestamp + run ID
const tsResult = await agent(
  `Get current timestamp: Bash("date -u '+%Y-%m-%dT%H-%M-%S'"). Return { timestamp: "<output>" }.`,
  { label: "get-timestamp", phase: "Resolve", model: "haiku", schema: TIMESTAMP_SCHEMA },
)
const RUN_ID = (tsResult?.timestamp || "unknown").trim()

// Ensure screenshot dir
await agent(
  `Bash("mkdir -p '${SHOT_DIR}'"). Return nothing.`,
  { label: "mkdir-shots", phase: "Resolve", model: "haiku" },
)

markPhase("resolve", "completed")
log(`Run ID: ${RUN_ID}, Views: ${VIEWS.length}, dryRun: ${dryRun}`)

// ── Phase 1: Survey (screenshot + VLM analyze all views) ──────────────────────

phase("Survey")
log(`Surveying ${VIEWS.length} views...`)

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
      { label: `screenshot:${v.id}`, phase: "Survey", model: "haiku", schema: SCREENSHOT_SCHEMA },
    )
    return { v, shotPath: shot?.ok ? shotPath : null, screenshotOk: shot?.ok === true }
  },

  // Stage 2: VLM analyze screenshot → UX issues
  async ({ v, shotPath, screenshotOk }) => {
    if (!shotPath || !screenshotOk) {
      log(`[survey] ${v.id}: screenshot failed — skipping VLM analysis`)
      return { ...v, uxScore: null, issues: [], shotPath: null, screenshotOk: false }
    }

    const captionOutPath = shotPath.replace(/\.png$/, ".caption.json")
    const analysis = await agent(
      `Analyze the GUI screenshot of view "${v.label}" (id: ${v.id}) for UX quality.

Screenshot path: ${shotPath}
View source file (for context): ${v.file ? `${GUI_DIR}/${v.file}` : "N/A (config/gallery special view)"}

Steps:
1. Run VLM caption: Bash("${PYTHON} ${RUN_PY} caption '${shotPath}' --style playwright --lang en 2>&1")
2. Read caption output: Bash("cat '${captionOutPath}' 2>/dev/null || echo '{}'")
3. If the source file is given, Read("${GUI_DIR}/${v.file || "frontend/styles.css"}") for code context.
4. Based on the playwright-style caption (LAYOUT, INTERACTIVE ELEMENTS, STATE, PRIMARY ACTION)
   AND the source code, identify UX issues. For each issue assign:
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

uxScore: 1-10 overall UX quality of this view (10 = excellent, 1 = very poor).
Return UX_ANALYSIS_SCHEMA with viewId="${v.id}".`,
      { label: `analyze:${v.id}`, phase: "Survey", model: "sonnet", schema: UX_ANALYSIS_SCHEMA },
    )

    const result = analysis || { viewId: v.id, uxScore: null, issues: [] }
    log(`[survey] ${v.id}: score=${result.uxScore ?? "?"}, issues=${result.issues?.length ?? 0}`)
    return { ...v, ...result, shotPath }
  },
)

const surveyed = analyses.filter(Boolean)
const totalIssues = surveyed.reduce((n, a) => n + (a.issues?.length || 0), 0)
const avgScoreBefore = (() => {
  const scored = surveyed.filter((a) => a.uxScore != null)
  return scored.length ? scored.reduce((s, a) => s + a.uxScore, 0) / scored.length : null
})()

log(`Survey complete: ${surveyed.length}/${VIEWS.length} views analyzed, ${totalIssues} issues found, avg UX score=${avgScoreBefore?.toFixed(1) ?? "?"}`)
markPhase("survey", "completed")

// ── Phase 2: Prioritize ───────────────────────────────────────────────────────

phase("Prioritize")

// Flatten all issues, tag with source view score
const allIssues = []
surveyed.forEach((v) => {
  ;(v.issues || []).forEach((issue) => {
    allIssues.push({
      ...issue,
      viewId: v.id,
      viewLabel: v.label,
      uxScoreBefore: v.uxScore,
      shotPath: v.shotPath,
      route: v.route,
    })
  })
})

// Severity weight for sorting
const SEV_WEIGHT = { high: 3, medium: 2, low: 1 }

// Sort: severity desc, then by lowest view uxScore (worst view first)
const prioritized = allIssues
  .filter((i) => i.severity !== "low")  // skip low in fix loop; they stay in report
  .sort((a, b) => {
    const sw = (SEV_WEIGHT[b.severity] || 0) - (SEV_WEIGHT[a.severity] || 0)
    if (sw !== 0) return sw
    return (a.uxScoreBefore ?? 10) - (b.uxScoreBefore ?? 10)
  })

// Deduplicate: if same affectedFile appears multiple times, keep highest-severity per file
// (global files like CommandView.tsx / styles.css would flood the queue otherwise)
const seenFiles = {}
const fixQueue = []
for (const issue of prioritized) {
  const key = `${issue.affectedFile}::${issue.category}`
  if (!seenFiles[key]) {
    seenFiles[key] = true
    fixQueue.push(issue)
  }
}

log(`Prioritized: ${fixQueue.length} unique high/medium issues ready for fix loop`)
markPhase("prioritize", "completed")

// ── Phase 3: Fix Loop ─────────────────────────────────────────────────────────

phase("Fix Loop")

const fixResults = []
let fixIter = 0

// Dirty-tree guard: every revert below is a bare `git checkout -- <file>`, which
// discards ALL uncommitted changes to that file, not just our own edit. If the
// file already had uncommitted user WIP before this loop started, a revert
// would silently destroy it. Refuse to mutate when the tree is dirty in scope —
// mirrors the Checkpoint guard in gui-movie-director-review-optimize.js.
let treeDirty = false
if (!dryRun) {
  const dirtyCheck = await agent(
    `Check whether the git working tree has uncommitted changes in scope.
Bash("cd '${PROJECT_ROOT}' && git status --short -- 'bun/gui-movie-director/frontend/' 'bun/gui-movie-director/api/' 'bun/gui-movie-director/lib/' | grep -v '^??' || true")
dirty = true if that printed any non-empty line (tracked-modified files). Untracked ('??') files don't count.
Return { dirty, files: [<the printed file paths, if any>] }.`,
    { label: "dirty-tree-check", phase: "Fix Loop", model: "haiku",
      schema: { type: "object", properties: { dirty: { type: "boolean" }, files: { type: "array", items: { type: "string" } } }, required: ["dirty"] } },
  )
  treeDirty = dirtyCheck?.dirty === true
  if (treeDirty) {
    log(`⚠ Working tree is DIRTY in scope (${(dirtyCheck?.files || []).join(", ")}) — skipping fix loop to avoid a revert clobbering your WIP. Commit/stash, then re-run.`)
  }
}

if (dryRun) {
  log(`Dry run mode — skipping fix loop. ${fixQueue.length} issues identified.`)
  markPhase("fixLoop", "skipped")
} else if (treeDirty) {
  markPhase("fixLoop", "skipped")
} else {
  const itersToRun = Math.min(maxIters, fixQueue.length)
  log(`Fix loop: ${itersToRun} iteration(s) planned (queue=${fixQueue.length}, cap=${maxIters})`)

  for (let i = 0; i < itersToRun; i++) {
    const issue = fixQueue[i]
    fixIter = i + 1
    log(`[fix ${fixIter}/${itersToRun}] ${issue.id}: "${issue.title}" [${issue.severity}] → ${issue.affectedFile}`)

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
or { applied: false, description: "<why you skipped this>" }.`,
      { label: `fix:${issue.id}`, phase: "Fix Loop", model: "sonnet", schema: FIX_RESULT_SCHEMA },
    )

    if (!fixResult?.applied) {
      log(`[fix ${fixIter}] SKIPPED: ${fixResult?.description || "no reason given"}`)
      fixResults.push({
        issueId: issue.id, applied: false, testsPassed: false,
        scoreBefore: issue.uxScoreBefore, scoreAfter: null,
        revertReason: fixResult?.description || "agent chose not to apply",
      })
      continue
    }

    // ── Verify: bun test ──
    const testResult = await agent(
      `Run bun tests for the GUI Movie Director and report pass/fail.
Bash("cd '${GUI_DIR}' && bun test 2>&1 | tail -30")
Return { ok: <true if fail count is 0>, pass: <number>, fail: <number>, output: "<last 5 lines>" }.`,
      { label: `test:iter${fixIter}`, phase: "Fix Loop", model: "haiku", schema: TEST_SCHEMA },
    )

    if (!testResult?.ok) {
      log(`[fix ${fixIter}] TESTS FAILED (pass=${testResult?.pass}, fail=${testResult?.fail}) — reverting`)
      await agent(
        `Revert the change to ${issue.affectedFile} — but only if nobody else touched it since our fix.
Bash("cd '${GUI_DIR}' && git hash-object '${issue.affectedFile}'") → currentHash
Expected hash (captured right after our fix): ${fixResult?.fileHash || "(none captured — proceed with revert)"}
If currentHash differs from the expected hash, someone edited the file concurrently — do NOT revert it, just report skipped.
Otherwise: Bash("cd '${GUI_DIR}' && git checkout -- '${issue.affectedFile}' 2>&1 || echo REVERT_FAILED")
If the affected file was frontend/styles.css AND another file was also changed, apply the same hash check before reverting it too.
Return nothing.`,
        { label: `revert:iter${fixIter}`, phase: "Fix Loop", model: "haiku" },
      )
      fixResults.push({
        issueId: issue.id, applied: false, testsPassed: false,
        scoreBefore: issue.uxScoreBefore, scoreAfter: null,
        revertReason: `bun test failed (pass=${testResult?.pass}, fail=${testResult?.fail})`,
      })
      continue
    }

    log(`[fix ${fixIter}] Tests passed (pass=${testResult?.pass})`)

    // ── Re-screenshot + VLM rescore ──
    const afterShotPath = `${SHOT_DIR}/${issue.viewId}-iter${fixIter}-after.png`
    const rescore = await agent(
      `Re-screenshot the view "${issue.viewLabel}" and rescore UX quality after the fix.

1. Use playwright-cli tools to navigate to http://localhost:3099/${issue.route}
   and screenshot to ${afterShotPath}.
2. Bash("${PYTHON} ${RUN_PY} caption '${afterShotPath}' --style playwright --lang en 2>&1")
3. Read caption: Bash("cat '${afterShotPath.replace(/\.png$/, ".caption.json")}' 2>/dev/null || echo '{}'")
4. Compare the before screenshot (${issue.shotPath || "N/A"}) with the after screenshot to
   assess whether the UX issue "${issue.title}" was actually improved.
5. Return { ok: true, uxScore: <1-10 overall UX score of the view after the fix> }
   or { ok: false, uxScore: null } if screenshot failed.`,
      { label: `rescore:iter${fixIter}`, phase: "Fix Loop", model: "haiku", schema: RESCORE_SCHEMA },
    )

    const scoreBefore = issue.uxScoreBefore ?? 5
    const scoreAfter  = rescore?.uxScore ?? null
    const improved    = scoreAfter != null && scoreAfter >= scoreBefore

    if (!improved && scoreAfter != null) {
      log(`[fix ${fixIter}] UX score did not improve (before=${scoreBefore}, after=${scoreAfter}) — reverting`)
      await agent(
        `Revert ${issue.affectedFile} — but only if nobody else touched it since our fix.
Bash("cd '${GUI_DIR}' && git hash-object '${issue.affectedFile}'") → currentHash
Expected hash (captured right after our fix): ${fixResult?.fileHash || "(none captured — proceed with revert)"}
If currentHash differs, someone edited the file concurrently — do NOT revert, just report skipped.
Otherwise: Bash("cd '${GUI_DIR}' && git checkout -- '${issue.affectedFile}'"). Return nothing.`,
        { label: `revert-score:iter${fixIter}`, phase: "Fix Loop", model: "haiku" },
      )
      fixResults.push({
        issueId: issue.id, applied: false, testsPassed: true,
        scoreBefore, scoreAfter,
        revertReason: `UX score unchanged or worse (${scoreBefore} → ${scoreAfter})`,
      })
      continue
    }

    log(`[fix ${fixIter}] KEPT ✓ (score: ${scoreBefore} → ${scoreAfter ?? "??"})`)
    fixResults.push({
      issueId: issue.id, applied: true, testsPassed: true,
      scoreBefore, scoreAfter,
      description: fixResult?.description,
    })
  }

  markPhase("fixLoop", "completed")
}

// ── Phase 4: Report ───────────────────────────────────────────────────────────

phase("Report")

const issuesFixed   = fixResults.filter((r) => r.applied).length
const issuesSkipped = fixResults.filter((r) => !r.applied).length
const avgScoreAfter = (() => {
  const gains = fixResults.filter((r) => r.applied && r.scoreAfter != null)
  if (!gains.length) return avgScoreBefore
  const improvementSum = gains.reduce((s, r) => s + (r.scoreAfter - r.scoreBefore), 0)
  return avgScoreBefore != null ? avgScoreBefore + improvementSum / surveyed.filter((v) => v.uxScore != null).length : null
})()

const reportAgent = await agent(
  `Generate a UX Self-Improve summary report for the GUI Movie Director.

## Run Overview
- Views surveyed: ${surveyed.length}/${VIEWS.length}
- Total issues found: ${totalIssues}
- Avg UX score before: ${avgScoreBefore?.toFixed(2) ?? "N/A"}
- Avg UX score after:  ${avgScoreAfter?.toFixed(2) ?? "N/A"}
- dry run: ${dryRun}
- Fix iterations: ${fixIter}
- Issues fixed: ${issuesFixed}
- Issues skipped/reverted: ${issuesSkipped}

## Per-View UX Scores
${surveyed.map((v) => `- [${v.uxScore ?? "?"}] ${v.viewLabel} (${v.id}): ${(v.issues || []).length} issue(s)`).join("\n")}

## Issues Found (high/medium severity)
${prioritized.slice(0, 20).map((i) => `- [${i.severity}] ${i.id} "${i.title}" → ${i.affectedFile}`).join("\n")}

## Fix Results
${fixResults.map((r) => `- ${r.issueId}: applied=${r.applied} tests=${r.testsPassed} score=${r.scoreBefore}→${r.scoreAfter ?? "?"} ${r.revertReason ? `(${r.revertReason})` : r.description || ""}`).join("\n")}

Write a concise Markdown report with:
1. Executive summary (what was found and improved)
2. Top UX issues by view (table: view | score | top issue)
3. Fix results (what changed, what was reverted and why)
4. Recommendations for next run (which issues remain, suggested maxIters)

Keep it under 400 words. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)

log(`\n${reportAgent || "(no report generated)"}`)
markPhase("report", "completed")

// ── Phase 5: Persist ──────────────────────────────────────────────────────────

phase("Persist")

const histEntry = {
  run_id:           RUN_ID,
  workflow:         WORKFLOW_NAME,
  started_at:       RUN_ID,
  status:           "complete",
  args:             { dryRun, maxIters, viewFilter },
  views_surveyed:   surveyed.length,
  total_issues:     totalIssues,
  issues_fixed:     issuesFixed,
  issues_reverted:  issuesSkipped,
  avgUxScoreBefore: avgScoreBefore,
  avgUxScoreAfter:  avgScoreAfter,
  fixResults,
  phasesCompleted,
  result: {
    analyses: surveyed.map((v) => ({ id: v.id, uxScore: v.uxScore, issueCount: (v.issues || []).length })),
    topIssues: prioritized.slice(0, 10),
    fixResults,
    report: reportAgent || "",
  },
}

const signals = {
  run_quality: issuesFixed > 0 ? "improved" : dryRun ? "audit" : "no-change",
  key_metric: `uxScore:${avgScoreBefore?.toFixed(1) ?? "?"}→${avgScoreAfter?.toFixed(1) ?? "?"}`,
  highlights: [
    `${surveyed.length} views surveyed`,
    `${totalIssues} issues found`,
    `${issuesFixed} fixed`,
  ],
}

await saveHistory(HISTORY_DIR, INDEX_FILE, histEntry, signals)
markPhase("persist", "completed")

log(`\n── UX Self-Improve complete ─────────────────────────────`)
log(`Views surveyed:   ${surveyed.length}`)
log(`Issues found:     ${totalIssues}`)
log(`Issues fixed:     ${issuesFixed}`)
log(`Issues skipped:   ${issuesSkipped}`)
log(`Avg score:        ${avgScoreBefore?.toFixed(1) ?? "?"} → ${avgScoreAfter?.toFixed(1) ?? "?"}`)
log(`Run ID:           ${RUN_ID}`)
log(`History:          ${HISTORY_DIR}/${RUN_ID}.json`)

return {
  runId: RUN_ID,
  viewsSurveyed: surveyed.length,
  totalIssues,
  issuesFixed,
  issuesSkipped,
  avgUxScoreBefore: avgScoreBefore,
  avgUxScoreAfter: avgScoreAfter,
  phaseStatus,
  analyses: surveyed.map((v) => ({ id: v.id, uxScore: v.uxScore, issues: v.issues })),
  fixResults,
}
