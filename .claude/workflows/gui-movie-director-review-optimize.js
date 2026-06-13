// GUI Movie Director Review & Optimize — Multi-dimensional code review + adversarial verify + auto-fix
//
// A dynamic workflow that reviews the GUI Movie Director Bun app for bugs, type safety,
// error handling, code quality, and security issues — then optionally applies verified fixes.
//
// Features:
//   - Multi-dimensional parallel review (correctness, type-safety, error-handling, code-quality, security)
//   - Adversarial verification to filter false positives
//   - Git stash checkpoint + automatic restore on regression detection
//   - Run history persistence for trend analysis and incremental improvement
//   - Resume from interrupted runs (skip completed phases)
//   - Cross-run finding deduplication (suppress previously-upheld findings)
//
// Modes (selected by args):
//
//   FULL REVIEW (default):
//     Workflow({ name: "gui-movie-director-review-optimize" })
//       → full review, medium effort, fix=true, resume=auto
//
//   TARGETED:
//     Workflow({ name: "...", args: { files: ["api/ws.ts", "lib/subprocess.ts"] } })
//       → review only the listed files
//
//   SINGLE DIMENSION:
//     Workflow({ name: "...", args: { focus: "security" } })
//       → only security dimension
//
//   REVIEW-ONLY (no edits):
//     Workflow({ name: "...", args: { fix: false } })
//       → skip Checkpoint, Resolve Fix, Re-verify, and Restore phases
//
//   DEEP:
//     Workflow({ name: "...", args: { effort: "high" } })
//       → lower confidence threshold, all dimensions, full adversarial + re-verify
//
//   FRESH (ignore prior history):
//     Workflow({ name: "...", args: { resume: "fresh" } })
//       → ignore any prior run history, start from scratch
//
// Dimensions: correctness, type-safety, error-handling, code-quality, security
// Effort levels: low (fast, high confidence), medium (default), high (exhaustive)

export const meta = {
  name: "gui-movie-director-review-optimize",
  description: "Multi-dimensional code review + adversarial verification + auto-fix for the GUI Movie Director Bun app",
  whenToUse: "Before committing to gui-movie-director/, after adding new views/APIs, or periodic code health review",
  phases: [
    { title: "Resolve",            detail: "Detect project root, normalize args, check for prior run to resume" },
    { title: "Scan",               detail: "File inventory, line counts, layer classification" },
    { title: "Review",             detail: "Parallel agents: correctness, type safety, error handling, code quality, security" },
    { title: "Adversarial Verify", detail: "Skeptical agents refute findings, filter false positives" },
    { title: "Checkpoint",         detail: "Git stash backup before applying fixes (enables rollback)" },
    { title: "Resolve Fix",        detail: "Apply verified fixes to codebase" },
    { title: "Re-verify",          detail: "Quick correctness + type-safety check on changed files" },
    { title: "Restore",            detail: "Conditional: rollback fixes if re-verify detects regressions" },
    { title: "Persist",            detail: "Write run history + synthesize reflection.json (patterns for future runs) + update cross-workflow index" },
    { title: "Report",             detail: "Synthesize prioritized findings with fix status and prior-run comparison" },
  ],
}

// ── Args normalization ──────────────────────────────────────────────────────

let resolvedArgs = args
if (typeof resolvedArgs === "string") {
  try {
    const parsed = JSON.parse(resolvedArgs)
    if (typeof parsed === "object" && parsed !== null) resolvedArgs = parsed
  } catch {
    // Not JSON — treat as a focus dimension string
    resolvedArgs = { focus: resolvedArgs }
  }
}

const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x)

let targetFiles = null          // null = all files; array of relative paths = targeted
let focus = null                // null = all dimensions; string = single dimension
let doFix = true                // true = apply fixes; false = review-only
let effort = "medium"           // "low" | "medium" | "high"
let resumeMode = "auto"         // "auto" | "fresh" | "continue"

if (isObj(resolvedArgs)) {
  if (Array.isArray(resolvedArgs.files)) targetFiles = resolvedArgs.files
  if (typeof resolvedArgs.focus === "string") focus = resolvedArgs.focus
  if (resolvedArgs.fix === false) doFix = false
  if (["low", "medium", "high"].includes(resolvedArgs.effort)) effort = resolvedArgs.effort
  if (["auto", "fresh", "continue"].includes(resolvedArgs.resume)) resumeMode = resolvedArgs.resume
}

const VALID_DIMENSIONS = ["correctness", "type-safety", "error-handling", "code-quality", "security"]

// Dimension config: which model to use per effort level
const DIMENSION_CONFIG = {
  correctness:     { label: "Correctness bugs",     model: "sonnet" },
  "type-safety":   { label: "Type safety",          model: "sonnet" },
  "error-handling":{ label: "Error handling",       model: "sonnet" },
  "code-quality":  { label: "Code quality",         model: effort === "low" ? "haiku" : "sonnet" },
  security:        { label: "Security",             model: "sonnet" },
}

// Effort depth controls
const EFFORT_CONFIG = {
  low: {
    dimensions: ["correctness", "security"],
    confidenceThreshold: 80,
    adversarial: "skip",
    fix: "skip",
    reVerify: "skip",
  },
  medium: {
    dimensions: VALID_DIMENSIONS,
    confidenceThreshold: 60,
    adversarial: "high-critical",   // only verify high/critical findings
    fix: "high-critical",           // only fix high/critical findings
    reVerify: "changed-files",
  },
  high: {
    dimensions: VALID_DIMENSIONS,
    confidenceThreshold: 40,
    adversarial: "all",
    fix: "all",
    reVerify: "full",
  },
}

// Resolve which dimensions to run
const dimensions = focus
  ? (VALID_DIMENSIONS.includes(focus) ? [focus] : [VALID_DIMENSIONS[0]])
  : EFFORT_CONFIG[effort].dimensions

const config = EFFORT_CONFIG[effort]

log(`Config: effort=${effort}, dimensions=${dimensions.join(",")}, fix=${doFix}, focus=${focus || "all"}, resume=${resumeMode}`)

// ── Phase tracking (in-memory) ──────────────────────────────────────────────

const phaseStatus = {
  resolve: "pending",
  scan: "pending",
  review: "pending",
  adversarialVerify: "pending",
  checkpoint: "pending",
  resolveFix: "pending",
  reVerify: "pending",
  restore: "pending",
  persist: "pending",
  report: "pending",
}

const phasesCompleted = []
const phasesFailed = []
const filesTouched = new Set()

function markPhase(name, status) {
  phaseStatus[name] = status
  if (status === "completed") phasesCompleted.push(name)
  if (status === "failed") phasesFailed.push(name)
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const PATH_SCHEMA = {
  type: "object",
  properties: {
    projectRoot: { type: "string", description: "Absolute path to the git project root" },
  },
  required: ["projectRoot"],
}

const TIMESTAMP_SCHEMA = {
  type: "object",
  properties: {
    timestamp: { type: "string", description: "ISO-8601 timestamp like 2026-06-13T14-30-52" },
  },
  required: ["timestamp"],
}

const SCAN_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from GUI_DIR" },
          absPath: { type: "string", description: "Absolute path on disk" },
          lines: { type: "number", description: "Line count" },
          layer: { type: "string", enum: ["server", "api", "lib", "frontend"], description: "Code layer" },
        },
        required: ["path", "absPath", "lines", "layer"],
      },
    },
    totalFiles: { type: "number" },
    totalLines: { type: "number" },
  },
  required: ["files", "totalFiles", "totalLines"],
}

const REVIEW_FINDING_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:           { type: "string", description: "Stable ID: {dimension}-{fileBasename}-{line}" },
          dimension:    { type: "string", enum: VALID_DIMENSIONS },
          severity:     { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          confidence:   { type: "number", description: "0-100 confidence score" },
          file:         { type: "string", description: "Relative path from GUI_DIR" },
          line:         { type: "number", description: "Line number (1-based), 0 if file-wide" },
          title:        { type: "string", description: "Short human-readable summary" },
          description:  { type: "string", description: "What is wrong and why it matters" },
          suggestedFix: { type: "string", description: "Code change or approach to fix" },
          codeSnippet:  { type: "string", description: "Problematic code excerpt (3-10 lines)" },
        },
        required: ["id", "dimension", "severity", "confidence", "file", "title", "description"],
      },
    },
    dimensionSummary: { type: "string", description: "2-3 sentence summary of findings in this dimension" },
  },
  required: ["findings", "dimensionSummary"],
}

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          upheld:    { type: "boolean", description: "True if the finding is valid after re-examination" },
          reason:    { type: "string", description: "Why upheld or rejected" },
        },
        required: ["findingId", "upheld", "reason"],
      },
    },
  },
  required: ["verdicts"],
}

const FIX_RESULT_SCHEMA = {
  type: "object",
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          file:      { type: "string" },
          status:    { type: "string", enum: ["applied", "skipped", "failed", "partial"] },
          change:    { type: "string", description: "Description of what was changed" },
          error:     { type: "string", description: "Error if status is failed" },
        },
        required: ["findingId", "file", "status"],
      },
    },
    filesChanged: { type: "array", items: { type: "string" } },
  },
  required: ["fixes", "filesChanged"],
}

const CHECKPOINT_SCHEMA = {
  type: "object",
  properties: {
    stashCreated: { type: "boolean" },
    stashRef:     { type: "string" },
    headSha:      { type: "string" },
    dirtyBefore:  { type: "array", items: { type: "string" } },
  },
  required: ["stashCreated", "headSha"],
}

const RESTORE_SCHEMA = {
  type: "object",
  properties: {
    restored:      { type: "boolean" },
    method:        { type: "string", enum: ["stash-pop", "checkout", "none"] },
    filesReverted: { type: "array", items: { type: "string" } },
  },
  required: ["restored", "method"],
}

const RESUME_CHECK_SCHEMA = {
  type: "object",
  properties: {
    action:            { type: "string", enum: ["fresh", "resume", "compare"] },
    previousRunId:     { type: "string" },
    previousTimestamp: { type: "string" },
    resumeFromPhase:   { type: "string" },
    previousArgs:      { type: "object" },
    previousStatus:    { type: "string" },
    previousPhasesCompleted: { type: "array", items: { type: "string" } },
  },
  required: ["action"],
}

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    summary:         { type: "string" },
    byDimension:     { type: "object", additionalProperties: { type: "number" } },
    bySeverity:      { type: "object", additionalProperties: { type: "number" } },
    topFindings:     { type: "array", items: { type: "object" } },
    fixSummary:      { type: "object" },
    recommendations: { type: "array", items: { type: "string" } },
    trendComparison: { type: "string" },
  },
  required: ["summary", "byDimension", "bySeverity", "topFindings"],
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 0: Resolve — absolute paths + timestamp + resume check
// ══════════════════════════════════════════════════════════════════════════════

phase("Resolve")

const pathResolution = await agent(
  `Detect the absolute path of the git project root for the video_generation project.

  Run: Bash("git rev-parse --show-toplevel")

  Return it as { projectRoot: "<the-path>" }.
  IMPORTANT: Return ONLY the JSON object. Normalize backslashes to forward slashes.`,
  { label: "resolve-paths", phase: "Resolve", model: "haiku", schema: PATH_SCHEMA },
)

const PROJECT_ROOT = (pathResolution?.projectRoot || "").replace(/\\/g, "/")
if (!PROJECT_ROOT) {
  log("ERROR: Could not resolve project root. Absolute paths unavailable — CWD drift may cause failures.")
}

const WORKFLOW_NAME = "gui-movie-director-review-optimize"
const GUI_DIR = `${PROJECT_ROOT}/bun/gui-movie-director`
const HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${WORKFLOW_NAME}`
const REFLECTION_FILE = `${HISTORY_DIR}/reflection.json`
const INDEX_FILE = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`

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

log(`Resolved: PROJECT_ROOT=${PROJECT_ROOT}`)
log(`  GUI_DIR: ${GUI_DIR}`)
log(`  HISTORY_DIR: ${HISTORY_DIR}`)

// Get timestamp for this run
const timestampResult = await agent(
  `Get the current timestamp in ISO-8601 basic format (no colons, suitable for filenames).

  Run: Bash("date -u '+%Y-%m-%dT%H-%M-%S'")

  Return { timestamp: "<the-output>" }. Use the exact output from date.`,
  { label: "get-timestamp", phase: "Resolve", model: "haiku", schema: TIMESTAMP_SCHEMA },
)

const RUN_TIMESTAMP = (timestampResult?.timestamp || "unknown").trim()
const RUN_ID = RUN_TIMESTAMP

// ── Resume check: look for prior run history ─────────────────────────────────

let priorHistory = null
let isResume = false
let resumeFromPhase = null

if (resumeMode === "fresh") {
  log("Resume: fresh mode — ignoring prior history.")
} else {
  const resumeCheck = await agent(
    `Check for a previous run history file for the workflow "${WORKFLOW_NAME}".

  Steps:
  1. Run: Bash("mkdir -p '${HISTORY_DIR}'")
  2. Run: Bash("ls -t '${HISTORY_DIR}'/*.json 2>/dev/null | head -1")
  3. If a file path was returned, read it: Bash("cat '<path>'")
  4. Examine the JSON:
     - Check "status": is it "complete", "partial", or "error"?
     - Check "phases_completed": which phases finished?
     - Check "args": do they match the current invocation?
     - Check "phases_failed": did any phases fail?

  Current invocation args: ${JSON.stringify({ files: targetFiles, focus, fix: doFix, effort, resume: resumeMode })}

  Decide:
  - If no file found: action = "fresh"
  - If file found and status = "complete": action = "compare" (prior run finished, use for trend)
  - If file found and status = "partial" or "error": action = "resume", set resumeFromPhase to the phase AFTER the last completed phase
  - If file found but args differ significantly: action = "fresh" (different scope)

  Return your decision.`,
    { label: "resume-check", phase: "Resolve", model: "haiku", schema: RESUME_CHECK_SCHEMA },
  )

  if (resumeCheck) {
    if (resumeCheck.action === "resume") {
      isResume = true
      resumeFromPhase = resumeCheck.resumeFromPhase
      log(`Resume: picking up from phase "${resumeFromPhase}" (prior run: ${resumeCheck.previousRunId})`)
    } else if (resumeCheck.action === "compare") {
      log(`Resume: prior run ${resumeCheck.previousRunId} completed — loading for trend comparison.`)
      // Load the full prior history for dedup
      const priorLoad = await agent(
        `Read the prior run history file and return its "result" field (the workflow-specific payload).

      Run: Bash("cat '${HISTORY_DIR}/${resumeCheck.previousRunId}.json'")
      Extract the "result" object and return it as { result: <payload> }.
      If the file cannot be read, return { result: null }.`,
        { label: "load-prior", phase: "Resolve", model: "haiku" },
      )
      priorHistory = priorLoad?.result || null
      if (priorHistory) {
        log(`  Prior run: ${priorHistory.findings?.total || 0} raw findings, ${priorHistory.findings?.verified || 0} verified, ${priorHistory.fixes?.applied || 0} fixes applied`)
      }
    } else {
      log("Resume: no prior history found — starting fresh.")
    }
  }

  // "continue" mode requires a prior run to exist
  if (resumeMode === "continue" && !isResume && resumeCheck?.action !== "compare") {
    log("WARNING: resume=continue but no prior run found. Starting fresh.")
  }
}

// ── Load reflection.json (accumulated patterns from all prior runs) ───────────
let priorReflection = null
if (resumeMode !== "fresh") {
  const reflectLoad = await agent(
    `Read the reflection file if it exists.
    Run: Bash("cat '${REFLECTION_FILE}' 2>/dev/null || echo '{}'")
    Parse the JSON output. If it is '{}' or invalid, return { reflection: null }.
    Otherwise return { reflection: <the parsed object> }.`,
    { label: "load-reflection", phase: "Resolve", model: "haiku" },
  )
  priorReflection = reflectLoad?.reflection || null
  if (priorReflection?.patterns) {
    const patCount = Object.values(priorReflection.patterns).flat().length
    log(`Reflection: loaded ${patCount} pattern(s) from ${priorReflection.runs_analyzed || 0} prior run(s)`)
  } else {
    log("Reflection: no prior reflection.json found — will create after this run")
  }
}

// Build prior-patterns injection string for Review prompts
const priorPatternsCtx = priorReflection?.patterns
  ? `\n## KNOWN PATTERNS FROM PRIOR RUNS — check these proactively (confirmed real bugs in this codebase):\n` +
    Object.entries(priorReflection.patterns)
      .flatMap(([dim, pats]) => (pats || []).map((p) => `- [${dim}] ${p}`))
      .join("\n") +
    (priorReflection.false_positives?.length
      ? `\n\n## FALSE POSITIVE PATTERNS TO AVOID (do NOT flag these):\n` +
        priorReflection.false_positives.map((p) => `- ${p}`).join("\n")
      : "") +
    (priorReflection.recurring_findings?.length
      ? `\n\n## RECURRING FINDINGS (appeared in 2+ prior runs — CHECK FIRST, high priority):\n` +
        priorReflection.recurring_findings
          .map((r) => `- [${r.dimension}] ${r.file}: "${r.title_fragment}" (${r.seen_in_runs} runs, last fix: ${r.last_fix_status || "none"})`)
          .join("\n")
      : "") +
    (priorReflection.dimension_calibration
      ? (() => {
          const nonOk = Object.entries(priorReflection.dimension_calibration)
            .filter(([, v]) => v.action !== "ok")
          return nonOk.length
            ? `\n\n## DIMENSION CALIBRATION ALERTS:\n` +
              nonOk.map(([dim, v]) => `- ${dim}: fp_rate=${v.avg_fp_rate?.toFixed(2)} → ${v.action}`).join("\n")
            : ""
        })()
      : "") +
    "\n"
  : ""

markPhase("resolve", "completed")

// ══════════════════════════════════════════════════════════════════════════════
// Phase 1: Scan — file inventory
// ══════════════════════════════════════════════════════════════════════════════

let fileList = []
let totalFiles = 0
let totalLines = 0
let layers = { server: 0, api: 0, lib: 0, frontend: 0 }

// Skip scan if resuming and prior scan covers the same scope
const shouldSkipScan = isResume && resumeFromPhase && phasesCompleted.includes("Resolve") && !resumeFromPhase.includes("Scan")

if (shouldSkipScan && priorHistory?.scan) {
  log("RESUME: Skipping Scan phase (prior scan available)")
  fileList = priorHistory.scan.fileList || []
  totalFiles = priorHistory.scan.totalFiles || 0
  totalLines = priorHistory.scan.totalLines || 0
  layers = priorHistory.scan.layers || layers
} else {
  phase("Scan")

  // Build the file list for the scan agent
  const scanScope = targetFiles
    ? `Only scan these specific files (relative to ${GUI_DIR}):\n${targetFiles.map((f) => `- ${f}`).join("\n")}`
    : effort === "low"
      ? `First run: Bash("cd '${GUI_DIR}' && git diff --name-only HEAD~5 -- 'api/' 'lib/' 'server.ts'")\nOnly inventory the changed files from that output. If no git diff output, fall back to all .ts/.tsx files.`
      : `Scan ALL .ts and .tsx files under ${GUI_DIR} (excluding node_modules and .playwright-cli).`

  const scanResult = await agent(
    `Inventory TypeScript source files in the Bun GUI Movie Director app.

  ${scanScope}

  For each file:
  1. Run: Bash("find '${GUI_DIR}' -name '*.ts' -o -name '*.tsx' | grep -v node_modules | grep -v .playwright-cli | sort")
  2. For each file found, get its line count: Bash("wc -l <file>")
  3. Classify the layer based on path:
     - "server" for server.ts
     - "api" for api/*.ts
     - "lib" for lib/*.ts and lib/schemas/*.ts
     - "frontend" for frontend/**/*.ts and frontend/**/*.tsx
  4. Skip node_modules, .playwright-cli, and .d.ts files

  Return the complete file inventory as structured JSON.`,
    { label: "scan-files", phase: "Scan", model: "haiku", schema: SCAN_SCHEMA },
  )

  fileList = (scanResult?.files || []).filter(Boolean)
  totalFiles = scanResult?.totalFiles || fileList.length
  totalLines = scanResult?.totalLines || fileList.reduce((n, f) => n + (f.lines || 0), 0)

  fileList.forEach((f) => { if (layers[f.layer] != null) layers[f.layer]++ })

  // Track all scanned files
  fileList.forEach((f) => filesTouched.add(`bun/gui-movie-director/${f.path}`))
}

log(`Scan: ${totalFiles} files, ${totalLines} lines — server=${layers.server} api=${layers.api} lib=${layers.lib} frontend=${layers.frontend}`)

if (fileList.length === 0) {
  log("ERROR: No files found to review. Check GUI_DIR path or targetFiles arg.")
  return { scan: { totalFiles: 0, totalLines: 0, layers, targetScope: targetFiles ? "targeted" : "full" }, findings: { total: 0, verified: 0, filtered: 0, items: [] }, report: "No files to review." }
}

// Build file list string for review agent prompts
const fileListing = fileList.map((f) => `- ${f.absPath} (${f.lines} lines, ${f.layer})`).join("\n")

markPhase("scan", "completed")

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2: Review — multi-dimensional parallel agents
// ══════════════════════════════════════════════════════════════════════════════

// Build set of prior upheld finding keys for incremental dedup
const priorUpheldKeys = new Set()
let suppressedCount = 0
if (priorHistory?.findings?.items) {
  priorHistory.findings.items.forEach((f) => {
    if (f.file && f.line && f.dimension) {
      priorUpheldKeys.add(`${f.file}:${f.line}:${f.dimension}`)
    }
  })
  if (priorUpheldKeys.size > 0) {
    log(`Incremental: ${priorUpheldKeys.size} prior upheld finding key(s) loaded for dedup`)
  }
}

phase("Review")

// Dimension-specific review prompts
const DIMENSION_PROMPTS = {
  correctness: `Review these TypeScript source files for CORRECTNESS BUGS in a Bun HTTP server + React SPA app.
${priorPatternsCtx}
Focus on:
- Logic errors, off-by-one, wrong conditions (e.g. pathname matching in routes.ts)
- Null/undefined dereferences: Map.get() without null check, optional chaining gaps
- Race conditions: async stream reading in subprocess.ts (stdout/stderr drains), WebSocket broadcast during concurrent mutations
- State management bugs: stale closures in React hooks (useCallback/useEffect missing deps), Set/Map mutations not creating new references
- Data flow errors: API request body parsing without validation, response shaping inconsistencies

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}
${effort === "low" ? "Only report findings with confidence >= 80 (high-confidence only)." : ""}
${effort === "high" ? "Also check subtle edge cases, boundary conditions, error recovery paths, and interaction between components." : ""}

For each finding:
- Provide EXACT file path (relative to ${GUI_DIR}), line number, and a short code snippet
- Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber} (e.g. correctness-subprocess.ts-88)
  If multiple findings on the same line: append a letter (correctness-subprocess.ts-88b)
- Rate confidence 0-100 (how certain this is a real bug)
- Rate severity: critical (crash/data-loss), high (broken feature), medium (degraded UX), low (cosmetic), info (style)
- Provide a concrete suggestedFix (actual code or clear description)

Return structured findings matching the schema.`,

  "type-safety": `Review these TypeScript source files for TYPE SAFETY issues.
${priorPatternsCtx}
Focus on:
- \`any\` types that should be concrete types: server.ts Bun.serve callback params, ws.ts WebSocket objects, subprocess.ts reader types, gallery.ts response data
- Missing interfaces or incomplete type definitions: API request/response shapes, Job fields, config types
- Unsafe type assertions (as X) that could fail at runtime
- Union types that should be discriminated (job status, view types, stream names)
- Missing null/undefined checks that TypeScript strict mode would catch but Bun's lax defaults allow

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}
${effort === "low" ? "Only report findings with confidence >= 80." : ""}

For each finding provide exact file, line, code snippet, confidence (0-100), severity, and a suggested fix.
Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber}.
Return structured findings matching the schema.`,

  "error-handling": `Review these TypeScript source files for ERROR HANDLING gaps.
${priorPatternsCtx}
Focus on:
- Uncaught promise rejections: ws.ts message handler, subprocess.ts readStream and proc.exited, bundle build in routes.ts
- Missing try/catch: JSON.parse on incoming requests, fs operations in serveFile/gallery, Bun.spawn failures
- Silent failures: catch blocks that swallow errors without logging (subprocess.ts stream catch, killJob catch)
- Missing error responses in API handlers: what happens if handleRunJob gets malformed JSON?
- Process cleanup: what happens to Bun.spawn child when the server crashes? Are zombie processes possible?
- Unhandled edge cases: empty file reads, missing directories, permission errors

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}
${effort === "low" ? "Only report findings with confidence >= 80." : ""}

For each finding provide exact file, line, code snippet, confidence (0-100), severity, and a suggested fix.
Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber}.
Return structured findings matching the schema.`,

  "code-quality": `Review these TypeScript source files for CODE QUALITY improvements.
${priorPatternsCtx}
Focus on:
- Duplicated patterns: API handler boilerplate in routes.ts, config loading patterns, response construction
- Complex functions that should be decomposed: handleApi routing (long if-else chain), buildCliArgs in args.ts
- Dead code or unused exports
- Naming inconsistencies across files
- Magic numbers and hardcoded values: port 3099, timeout values, debounce durations, regex patterns
- Code that could use existing utilities but doesn't (e.g. path.join vs string concatenation)

IMPORTANT: Only suggest changes that clearly improve readability or maintainability.
Do NOT flag intentional patterns or code that is already clear.

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}
${effort === "low" ? "Only report findings with confidence >= 80." : ""}

For each finding provide exact file, line, code snippet, confidence (0-100), severity, and a suggested fix.
Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber}.
Return structured findings matching the schema.`,

  security: `Review these TypeScript source files for SECURITY vulnerabilities in this Bun HTTP server app.
${priorPatternsCtx}
Focus on:
- Input validation gaps: API endpoints that accept POST bodies without schema validation (handleRunJob, handleUpload, handlePutConfig)
- Path traversal: handleGalleryImage filename handling in gallery.ts, serveFile in routes.ts — can a crafted URL escape the output directory?
- Command injection: subprocess.ts Bun.spawn receives command string + cliArgs from user — is there proper sanitization? Check args.ts buildCliArgs for shell-special chars
- SSRF: VLM proxy in vlm.ts fetches URLs from config, caption.ts forwards to external API
- Information disclosure: error responses exposing internals, stack traces in API responses
- CORS/CSRF: WebSocket accepts any origin, no auth on API endpoints
- File upload: upload.ts — are there size limits, content-type validation, or filename sanitization?
- Response headers: missing security headers (X-Content-Type-Options, etc.)

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}
${effort === "low" ? "Only report findings with confidence >= 80." : ""}

For each finding provide exact file, line, code snippet, confidence (0-100), severity, and a suggested fix.
Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber}.
Return structured findings matching the schema.`,
}

// Run review agents in parallel (one per active dimension)
log(`Running ${dimensions.length} review dimension(s) in parallel...`)

const reviewResults = await parallel(
  dimensions.map((dim) => () => {
    const cfg = DIMENSION_CONFIG[dim]
    return agent(
      DIMENSION_PROMPTS[dim],
      { label: `review-${dim}`, phase: "Review", model: cfg.model, schema: REVIEW_FINDING_SCHEMA },
    )
  }),
)

// Collect all findings
const allFindings = reviewResults
  .filter(Boolean)
  .flatMap((r) => r.findings || [])

const dimensionSummaries = {}
reviewResults.forEach((r, i) => {
  if (r) dimensionSummaries[dimensions[i]] = r.dimensionSummary || ""
})

log(`Review complete: ${allFindings.length} finding(s) across ${dimensions.length} dimension(s)`)

// ── Pattern-matched confidence boost ─────────────────────────────────────────
// Confirmed cross-run patterns get +20 confidence to ensure they survive the threshold filter
const confirmedPatterns = priorReflection?.confirmed_patterns || []
if (confirmedPatterns.length > 0) {
  let boosted = 0
  allFindings.forEach((f) => {
    const match = confirmedPatterns.find((p) =>
      p.keyword && (f.description || "").toLowerCase().includes(p.keyword.toLowerCase()),
    )
    if (match) {
      f.confidence = Math.min(100, (f.confidence || 60) + 20)
      f._patternMatch = match.pattern
      boosted++
    }
  })
  if (boosted > 0) log(`Pattern boost: ${boosted} finding(s) matched confirmed patterns → confidence +20`)
}

// ── Incremental dedup: suppress findings already upheld in prior run ─────────
const newFindings = []
const suppressedFromPrior = []

allFindings.forEach((f) => {
  const key = `${f.file}:${f.line}:${f.dimension}`
  if (priorUpheldKeys.has(key)) {
    suppressedFromPrior.push(f)
  } else {
    newFindings.push(f)
  }
})

if (suppressedFromPrior.length > 0) {
  log(`Incremental: ${suppressedFromPrior.length} finding(s) suppressed (previously upheld in prior run)`)
  suppressedFromPrior.forEach((f) => {
    log(`  ⊘ ${f.id}: ${f.title} (${f.file}:${f.line || "?"})`)
  })
}

// Use newFindings for all downstream processing
const activeFindings = newFindings

activeFindings.forEach((f) => {
  log(`  [${f.severity}] ${f.dimension}: ${f.title} (${f.file}:${f.line || "?"}) [${f.confidence}%]`)
})

if (activeFindings.length === 0 && suppressedFromPrior.length === 0) {
  log("No findings — codebase looks clean!")
  markPhase("review", "completed")
  // Fall through to Persist + Report
} else if (activeFindings.length === 0) {
  log(`All ${suppressedFromPrior.length} findings were suppressed from prior run. No new issues found.`)
  markPhase("review", "completed")
}

markPhase("review", "completed")

// ══════════════════════════════════════════════════════════════════════════════
// Phase 3: Adversarial Verify — skeptical agents refute findings
// ══════════════════════════════════════════════════════════════════════════════

// Determine which findings to adversarially verify
let findingsToVerify = activeFindings
if (config.adversarial === "skip") {
  log("Adversarial verify: SKIPPED (low effort)")
  findingsToVerify = []
} else if (config.adversarial === "high-critical") {
  findingsToVerify = activeFindings.filter((f) => f.severity === "critical" || f.severity === "high")
  log(`Adversarial verify: ${findingsToVerify.length}/${activeFindings.length} findings (high/critical only)`)
} else {
  log(`Adversarial verify: all ${activeFindings.length} findings`)
}

let allVerdicts = []

if (findingsToVerify.length > 0) {
  phase("Adversarial Verify")

  // Group findings to verify by dimension for targeted verification
  const byDim = {}
  findingsToVerify.forEach((f) => {
    if (!byDim[f.dimension]) byDim[f.dimension] = []
    byDim[f.dimension].push(f)
  })

  const adversarialResults = await parallel(
    Object.entries(byDim).map(([dim, findings]) => () => {
      const filesToRead = [...new Set(findings.map((f) => f.file))]

      return agent(
        `You are a SKEPTICAL code reviewer. Your job is to REFUTE findings, not confirm them.

For each finding below, re-read the ACTUAL source file and determine if the finding is:
- A REAL issue that should be fixed
- A FALSE POSITIVE (incorrect line number, misunderstood context, intentional design, or wrong severity)

Be STRICT. Default to rejecting if:
- The code works correctly in practice and the "bug" is a misunderstanding
- The finding describes a pattern that is intentional (e.g. a catch block that intentionally swallows non-critical errors)
- The suggested fix would change behavior or break existing callers
- The line number is wrong or the code snippet doesn't match the actual file
- The severity is inflated (e.g. "critical" for something that's actually "low")

FINDINGS TO VERIFY (${dim} dimension):
${JSON.stringify(findings, null, 2)}

FILES TO READ (read each one to verify):
${filesToRead.map((f) => `- ${GUI_DIR}/${f}`).join("\n")}

For EACH finding:
1. Read the file: Bash("cat '${GUI_DIR}/<finding.file>'") or with line range for large files
2. Check the exact line numbers and surrounding context
3. Determine if the finding is accurate and the severity is appropriate

Return a verdict for EACH finding with findingId, upheld (true/false), and reason.`,
        { label: `adversarial-${dim}`, phase: "Adversarial Verify", model: "sonnet", schema: VERIFY_SCHEMA },
      )
    }),
  )

  allVerdicts = adversarialResults.filter(Boolean).flatMap((r) => r.verdicts || [])
}

// Build verdict lookup
const verdictMap = {}
allVerdicts.forEach((v) => { verdictMap[v.findingId] = v })

// Filter findings: upheld by adversarial AND meets confidence threshold
const confidenceThreshold = config.confidenceThreshold
const verifiedFindings = activeFindings.filter((f) => {
  const verdict = verdictMap[f.id]
  const upheld = !verdict || verdict.upheld !== false   // keep if no verdict or upheld
  const confidence = f.confidence || 0
  return upheld && confidence >= confidenceThreshold
})

const rejected = activeFindings.length - verifiedFindings.length
log(`Filter: ${verifiedFindings.length}/${activeFindings.length} findings survived (adversarial + confidence ≥ ${confidenceThreshold}%)`)
if (rejected > 0) {
  log(`  Rejected: ${rejected} (false positives or low confidence)`)
  // Log rejected findings briefly
  activeFindings.filter((f) => !verifiedFindings.includes(f)).forEach((f) => {
    const v = verdictMap[f.id]
    log(`    ✗ ${f.id}: ${v ? v.reason : `confidence ${f.confidence}% < ${confidenceThreshold}%`}`)
  })
}

// ── Pure JS: compute stats + collect rejected findings ──────────────────────

const byDimension = {}
const bySeverity = {}
verifiedFindings.forEach((f) => {
  byDimension[f.dimension] = (byDimension[f.dimension] || 0) + 1
  bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1
})

const rejectedFindings = activeFindings
  .filter((f) => !verifiedFindings.includes(f))
  .map((f) => {
    const v = verdictMap[f.id]
    return {
      id: f.id,
      dimension: f.dimension,
      file: f.file,
      line: f.line,
      title: f.title,
      rejection_reason: v ? v.reason : `low confidence (${f.confidence}%)`,
      confidence: f.confidence,
    }
  })

const rejectedByDimension = rejectedFindings.reduce((acc, f) => {
  acc[f.dimension] = (acc[f.dimension] || 0) + 1; return acc
}, {})

markPhase("adversarialVerify", "completed")

// ══════════════════════════════════════════════════════════════════════════════
// Phase 4: Checkpoint — git stash backup before fixes
// ══════════════════════════════════════════════════════════════════════════════

let checkpointResult = { stashCreated: false, stashRef: "", headSha: "", dirtyBefore: [] }
let fixResults = { fixes: [], filesChanged: [] }
let reVerifyFindings = []
let restoreResult = { triggered: false, reason: null, stashRestored: false, filesReverted: [] }

if (doFix && verifiedFindings.length > 0) {
  phase("Checkpoint")

  checkpointResult = await agent(
    `Create a git stash backup before applying code review fixes. This enables rollback if fixes cause regressions.

  Steps:
  1. Run: Bash("cd '${PROJECT_ROOT}' && git rev-parse HEAD")
     Capture the HEAD SHA.
  2. Run: Bash("cd '${PROJECT_ROOT}' && git status --short 'bun/gui-movie-director/'")
     Capture the list of dirty files (if any).
  3. Run: Bash("cd '${PROJECT_ROOT}' && git stash push -m 'gui-movie-director-review-checkpoint-${RUN_ID}' -- 'bun/gui-movie-director/'")
     If output contains "No local changes to save": stashCreated=false (tree was clean).
     Otherwise: stashCreated=true.
  4. Run: Bash("cd '${PROJECT_ROOT}' && git stash list | head -1")
     If stash was created, capture the stash ref (e.g. "stash@{0}").

  Return the checkpoint info.`,
    { label: "checkpoint", phase: "Checkpoint", model: "haiku", schema: CHECKPOINT_SCHEMA },
  )

  if (checkpointResult?.stashCreated) {
    log(`Checkpoint: stash created (${checkpointResult.stashRef}, HEAD=${(checkpointResult.headSha || "").slice(0, 8)})`)
  } else {
    log(`Checkpoint: tree was clean, no stash needed (HEAD=${(checkpointResult.headSha || "").slice(0, 8)})`)
  }

  markPhase("checkpoint", "completed")

  // ══════════════════════════════════════════════════════════════════════════════
  // Phase 5: Resolve Fix — apply verified fixes
  // ══════════════════════════════════════════════════════════════════════════════

  phase("Resolve Fix")

  // Determine which findings to fix based on effort config
  let findingsToFix = verifiedFindings
  if (config.fix === "high-critical") {
    findingsToFix = verifiedFindings.filter((f) => f.severity === "critical" || f.severity === "high")
  } else if (config.fix === "skip") {
    findingsToFix = []
  }

  if (findingsToFix.length === 0) {
    log(`No findings to fix (${config.fix} filter removed all candidates).`)
  } else {
    // Group findings by file (bottom-to-top order within each file)
    const grouped = {}
    findingsToFix.forEach((f) => {
      if (!grouped[f.file]) grouped[f.file] = []
      grouped[f.file].push(f)
    })

    // Sort findings within each file by line number descending (bottom-to-top)
    Object.values(grouped).forEach((arr) => {
      arr.sort((a, b) => (b.line || 0) - (a.line || 0))
    })

    const filesWithFixes = Object.keys(grouped)
    log(`Fixing ${findingsToFix.length} finding(s) across ${filesWithFixes.length} file(s)...`)

    // Apply fixes per file (sequential to avoid conflicts within a file)
    const fileFixResults = await pipeline(
      filesWithFixes,
      (file) => {
        const fileFindings = grouped[file]

        return agent(
          `You are a code fixer. Apply the following verified findings to the codebase.

RULES:
1. Read the file FIRST before editing: Bash("cat '${GUI_DIR}/${file}'")
2. Apply fixes ONE AT A TIME, from bottom to top (highest line first) so line numbers stay valid
3. Use the Edit tool for each fix — match the old_string exactly as it appears in the file
4. Preserve existing behavior — only change what the finding identifies
5. If a fix would change the public API surface or break existing callers, mark it "skipped"
6. If two fixes conflict, apply the first and mark the second "skipped"
7. After ALL fixes for a file, read the file back to verify it still looks syntactically valid

FINDINGS FOR ${file} (apply from bottom to top):
${JSON.stringify(fileFindings, null, 2)}

For each finding:
- If the suggestedFix is clear and safe: apply it, status="applied"
- If it would break callers or change API: status="skipped", explain in error
- If the edit fails (old_string not found): status="failed", note the issue

Return structured results.`,
          { label: `fix-${file.replace(/[/\\\\]/g, "-")}`, phase: "Resolve Fix", model: "sonnet", schema: FIX_RESULT_SCHEMA },
        )
      },
    )

    // Collect fix results
    fileFixResults.filter(Boolean).forEach((r) => {
      fixResults.fixes.push(...(r.fixes || []))
      fixResults.filesChanged.push(...(r.filesChanged || []))
    })
    fixResults.filesChanged = [...new Set(fixResults.filesChanged)]  // deduplicate

    // Track touched files
    fixResults.filesChanged.forEach((f) => filesTouched.add(`bun/gui-movie-director/${f}`))

    const applied = fixResults.fixes.filter((f) => f.status === "applied").length
    const skipped = fixResults.fixes.filter((f) => f.status === "skipped").length
    const failed = fixResults.fixes.filter((f) => f.status === "failed").length
    log(`Fix results: ${applied} applied, ${skipped} skipped, ${failed} failed, ${fixResults.filesChanged.length} file(s) changed`)
    fixResults.fixes.forEach((f) => {
      log(`  ${f.status === "applied" ? "✓" : f.status === "skipped" ? "⊘" : "✗"} ${f.findingId}: ${f.change || f.error || ""}`)
    })

    // ══════════════════════════════════════════════════════════════════════════════
    // Phase 6: Re-verify — quick scan of changed files
    // ══════════════════════════════════════════════════════════════════════════════

    if (config.reVerify !== "skip" && fixResults.filesChanged.length > 0) {
      phase("Re-verify")

      const reVerifyFiles = config.reVerify === "full"
        ? fileList.map((f) => f.absPath)
        : fixResults.filesChanged.map((f) => `${GUI_DIR}/${f}`)

      log(`Re-verifying ${reVerifyFiles.length} file(s) after fixes...`)

      const reVerifyResult = await agent(
        `Quick correctness + type-safety check on recently-edited files.

Read each file and look for REGRESSIONS introduced by recent edits:
- Syntax errors (unclosed braces, missing imports, broken TypeScript)
- Type errors that the edit may have introduced
- Logic changes that don't match the original intent

Files to check:
${reVerifyFiles.map((f) => `- ${f}`).join("\n")}

ORIGINAL FINDINGS THAT WERE APPLIED (for context):
${JSON.stringify(fixResults.fixes.filter((f) => f.status === "applied"), null, 2)}

If you find any regressions, report them. If the files look clean, return an empty findings array.`,
        { label: "re-verify", phase: "Re-verify", model: "haiku", schema: REVIEW_FINDING_SCHEMA },
      )

      reVerifyFindings = (reVerifyResult?.findings || []).filter(Boolean)
      if (reVerifyFindings.length > 0) {
        log(`WARNING: ${reVerifyFindings.length} regression(s) detected after fixes!`)
        reVerifyFindings.forEach((f) => log(`  ⚠ ${f.title} (${f.file}:${f.line || "?"})`))
      } else {
        log("Re-verify: no regressions detected ✓")
      }

      markPhase("reVerify", "completed")
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // Phase 7: Restore — conditional rollback if regressions detected
    // ══════════════════════════════════════════════════════════════════════════════

    const hasCriticalRegression = reVerifyFindings.some((f) => f.severity === "critical")
    const hasMultipleRegressions = reVerifyFindings.length > 2

    if (reVerifyFindings.length > 0 && (hasCriticalRegression || hasMultipleRegressions)) {
      phase("Restore")

      const restoreReason = hasCriticalRegression ? "critical-regression" : "multiple-regressions"
      log(`RESTORE: ${restoreReason} — ${reVerifyFindings.length} regression(s) detected. Rolling back fixes...`)

      const stashRef = checkpointResult?.stashRef || ""
      const stashCreated = checkpointResult?.stashCreated || false

      restoreResult = await agent(
        `A code review fix introduced regressions. Restore the pre-fix state.

Stash ref from checkpoint: ${stashRef || "none"}
Stash was created: ${stashCreated}
Files that were changed: ${fixResults.filesChanged.join(", ")}

STEPS:
${stashCreated ? `
1. Restore from stash:
   Bash("cd '${PROJECT_ROOT}' && git stash pop ${stashRef}")
   If pop fails (conflict), use the safe fallback:
   Bash("cd '${PROJECT_ROOT}' && git checkout ${stashRef} -- 'bun/gui-movie-director/'")
   Then drop the stash:
   Bash("cd '${PROJECT_ROOT}' && git stash drop ${stashRef}")
` : `
1. No stash was created (tree was clean before fixes).
   Restore individual files using git checkout:
   ${fixResults.filesChanged.map((f) => `Bash("cd '${PROJECT_ROOT}' && git checkout HEAD -- 'bun/gui-movie-director/${f}'")`).join("\n   ")}
`}

After restore:
2. Verify files are restored: Bash("cd '${PROJECT_ROOT}' && git status --short 'bun/gui-movie-director/'")

Return { restored: bool, method: "stash-pop"|"checkout"|"none", filesReverted: [...] }.`,
        { label: "restore", phase: "Restore", model: "haiku", schema: RESTORE_SCHEMA },
      )

      if (restoreResult?.restored) {
        log(`Restore: SUCCESS — ${restoreResult.filesReverted?.length || 0} file(s) reverted via ${restoreResult.method}`)
        restoreResult = { triggered: true, reason: restoreReason, stashRestored: stashCreated, filesReverted: restoreResult.filesReverted || [], method: restoreResult.method }
      } else {
        log(`Restore: FAILED — could not revert changes. Manual review needed.`)
        restoreResult = { triggered: true, reason: restoreReason, stashRestored: false, filesReverted: [] }
      }

      markPhase("restore", restoreResult.triggered && restoreResult.filesReverted?.length > 0 ? "completed" : "failed")
    } else if (reVerifyFindings.length > 0) {
      log(`Restore: skipped — ${reVerifyFindings.length} non-critical regression(s) (below threshold)`)
      restoreResult = { triggered: false, reason: null, stashRestored: false, filesReverted: [] }
      markPhase("restore", "skipped")
    } else {
      markPhase("restore", "skipped")
    }
  }

  markPhase("resolveFix", "completed")
} else if (!doFix) {
  log("Review-only mode — skipping Checkpoint, Resolve Fix, Re-verify, and Restore phases.")
  markPhase("checkpoint", "skipped")
  markPhase("resolveFix", "skipped")
  markPhase("reVerify", "skipped")
  markPhase("restore", "skipped")
} else {
  log("No verified findings to fix.")
  markPhase("checkpoint", "skipped")
  markPhase("resolveFix", "skipped")
  markPhase("reVerify", "skipped")
  markPhase("restore", "skipped")
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 8: Persist — write run history to disk
// ══════════════════════════════════════════════════════════════════════════════

phase("Persist")

const appliedCount = fixResults.fixes.filter((f) => f.status === "applied").length
const skippedCount = fixResults.fixes.filter((f) => f.status === "skipped").length
const failedCount  = fixResults.fixes.filter((f) => f.status === "failed").length

// Build diagnostic aggregates for enhanced history
const hotspotFiles = verifiedFindings.reduce((acc, f) => {
  acc[f.file] = (acc[f.file] || 0) + 1; return acc
}, {})
const adversarialRejectionRate = allVerdicts.length
  ? +(allVerdicts.filter((v) => !v.upheld).length / allVerdicts.length).toFixed(2)
  : null
const fixFailureReasons = fixResults.fixes
  .filter((f) => f.status === "failed")
  .reduce((acc, f) => {
    const r = (f.error || "").includes("context") ? "context_mismatch" : "other"
    acc[r] = (acc[r] || 0) + 1; return acc
  }, {})

// Build signals for cross-workflow health index
const signals = {
  run_quality: phasesFailed.length === 0 ? "good" : "degraded",
  key_metric: verifiedFindings.length,
  delta_from_last: null,
  highlights: [
    `${verifiedFindings.length} verified finding(s) across ${dimensions.length} dimension(s)`,
    doFix ? `${appliedCount} fix(es) applied` : "review-only mode",
    allVerdicts.length > 0 ? `adversarial: ${allVerdicts.filter((v) => v.upheld).length}/${allVerdicts.length} upheld` : "no adversarial run",
  ],
  warnings: reVerifyFindings.length > 0 ? [`${reVerifyFindings.length} regression(s) detected`] : [],
}

// Build the history envelope
const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: WORKFLOW_NAME,
  started_at: RUN_TIMESTAMP,
  args: { files: targetFiles, focus, fix: doFix, effort, resume: resumeMode },
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: "complete",
  files_touched: [...filesTouched],
  tags: ["code-review", ...dimensions],
  result: {
    scan: {
      totalFiles,
      totalLines,
      layers,
      targetScope: targetFiles ? "targeted" : "full",
    },
    findings: {
      total: allFindings.length + suppressedFromPrior.length,
      verified: verifiedFindings.length,
      filtered: verifiedFindings.length,
      newFindings: activeFindings.length,
      suppressedFromPrior: suppressedFromPrior.length,
      byDimension,
      bySeverity,
      items: verifiedFindings,
    },
    adversarial: {
      totalVerdicts: allVerdicts.length,
      upheld: allVerdicts.filter((v) => v.upheld).length,
      rejected: allVerdicts.filter((v) => !v.upheld).length,
    },
    fixes: doFix
      ? {
          applied: appliedCount,
          skipped: skippedCount,
          failed: failedCount,
          filesChanged: fixResults.filesChanged,
          regressions: reVerifyFindings.length,
          items: fixResults.fixes,
        }
      : { mode: "review-only", applied: 0, skipped: 0, failed: 0, filesChanged: [], regressions: 0 },
    restore: restoreResult,
    git: {
      headBefore: checkpointResult?.headSha || "",
      stashRef: checkpointResult?.stashRef || "",
      dirtyFilesBefore: checkpointResult?.dirtyBefore || [],
    },
    hotspot_files: hotspotFiles,
    adversarial_rejection_rate: adversarialRejectionRate,
    fix_failure_reasons: fixFailureReasons,
  },
}

await saveHistory(HISTORY_DIR, INDEX_FILE, historyEntry, signals)
log(`History: ${HISTORY_DIR}/${RUN_ID}.json`)

// ── Reflect: synthesize patterns across all prior runs ────────────────────────
const REFLECT_SCHEMA = {
  type: "object",
  properties: {
    patterns: {
      type: "object",
      description: "dimension → array of pattern strings (max 5 per dimension)",
      additionalProperties: { type: "array", items: { type: "string" } },
    },
    false_positives: {
      type: "array",
      items: { type: "string" },
      description: "Patterns that were repeatedly flagged but rejected as false positives",
    },
    confirmed_patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pattern:     { type: "string", description: "Human-readable pattern name" },
          keyword:     { type: "string", description: "Keyword to match against finding descriptions" },
          dimension:   { type: "string" },
          occurrences: { type: "number" },
          last_seen:   { type: "string" },
        },
        required: ["pattern", "keyword", "dimension"],
      },
    },
    recurring_findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title_fragment:  { type: "string" },
          file:            { type: "string" },
          dimension:       { type: "string" },
          seen_in_runs:    { type: "number" },
          last_fix_status: { type: "string" },
        },
        required: ["title_fragment", "file", "dimension", "seen_in_runs"],
      },
      description: "Findings that appear in 2+ history runs — prioritize in next review",
    },
    dimension_calibration: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          avg_fp_rate: { type: "number" },
          avg_per_run: { type: "number" },
          action:      { type: "string" },
        },
        required: ["avg_fp_rate", "action"],
      },
      description: "Per-dimension FP rate — action: ok | increase_threshold | reduce_effort",
    },
    unstable_fixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title_fragment: { type: "string" },
          file:           { type: "string" },
          note:           { type: "string" },
        },
        required: ["title_fragment", "file"],
      },
      description: "Fixes that were applied but the finding recurred, or fix repeatedly failed",
    },
    runs_analyzed: { type: "number" },
    updated_at:    { type: "string" },
  },
  required: ["patterns", "false_positives", "confirmed_patterns", "runs_analyzed"],
}

const reflectResult = await agent(
  `Synthesize code review patterns from all history runs. This builds reflection.json that future runs use to find bugs faster.

Step 1 — List history files (exclude reflection.json):
Bash("ls -t '${HISTORY_DIR}'/*.json 2>/dev/null | grep -v reflection | head -10")

Step 2 — Read each history file and extract findings.items[], findings.rejected[], fixes.items[]:
For CONFIRMED patterns: findings in fixes.items[] with status="applied" (real bugs we fixed)
For TRENDING issues: dimensions with many medium/high findings across runs

Step 2b — Analyze rejected findings across runs:
For each run's result.findings.rejected[] (array of {id, dimension, file, title, rejection_reason}):
- Group by dimension to compute per-dimension rejection count
- Findings with similar title in rejected[] across ≥2 runs → add to false_positives
- avg_fp_rate per dimension = sum(rejected_by_dimension[dim]) / sum(byDimension[dim] + rejected_by_dimension[dim]) across runs
Note: older history files may not have rejected[] — skip gracefully

Step 2c — Identify recurring_findings:
A finding is "recurring" if a similar (file + title_fragment match) appears in findings.items[]
across ≥2 separate runs.
For each recurring finding, check fixes.items[] — if it was ever status="applied" and still
recurs in a later run → flag it as unstable_fix.

Step 2d — Build dimension_calibration:
avg_fp_rate > 0.5 → action = "increase_threshold"
avg_fp_rate < 0.1 AND avg_per_run < 3 → action = "reduce_effort"
otherwise → action = "ok"

Step 3 — Include THIS run's data:
- Applied fixes this run: ${JSON.stringify(fixResults.fixes.filter((f) => f.status === "applied").map((f) => ({ id: f.findingId, change: f.change })))}
- Rejected this run: ${JSON.stringify(rejectedFindings.slice(0, 8).map((f) => ({ dim: f.dimension, title: f.title.slice(0, 60), reason: f.rejection_reason.slice(0, 80) })))}
- Sample verified findings: ${JSON.stringify(verifiedFindings.slice(0, 8).map((f) => ({ dim: f.dimension, sev: f.severity, title: f.title, desc: (f.description || "").slice(0, 80) })))}

Build output:
- patterns: { "correctness": ["<1 sentence actionable checker>", ...max 5], "type-safety": [...], ... }
  CRITICAL: Patterns must be SPECIFIC to this codebase (Bun HTTP server, React SPA, TypeScript).
  Examples: "type-safety: Bun.serve request.json() returns unknown — cast result before field access"
- false_positives: patterns recurring in review but always rejected
- confirmed_patterns: findings confirmed across ≥2 runs OR fixed, with keyword for matching
- recurring_findings: findings in ≥2 runs (by file+title similarity)
- dimension_calibration: per-dimension {avg_fp_rate, avg_per_run, action}
- unstable_fixes: fixes applied but finding recurred or fix repeatedly failed/skipped
- runs_analyzed: how many history files you read
- updated_at: "${RUN_TIMESTAMP}"

Max 5 patterns per dimension. Keep each pattern to 1 sentence. Return the reflection object.`,
  { label: "reflect", phase: "Persist", model: "sonnet", schema: REFLECT_SCHEMA },
)

if (reflectResult) {
  const reflectJson = JSON.stringify({ ...reflectResult, schema_version: 1 }, null, 2)
  await agent(
    `Write the updated reflection to '${REFLECTION_FILE}'. Use the Write tool (NOT heredoc).
    Write({ file_path: "${REFLECTION_FILE}", content: <JSON below> })
    JSON:
${reflectJson}
    Then verify: Bash("wc -c '${REFLECTION_FILE}' && echo REFLECT_OK")`,
    { label: "write-reflection", phase: "Persist", model: "haiku" },
  )
  const patCount = Object.values(reflectResult.patterns || {}).flat().length
  log(`Reflect: ${patCount} pattern(s), ${reflectResult.confirmed_patterns?.length || 0} confirmed, ${reflectResult.false_positives?.length || 0} false-positives → ${REFLECTION_FILE}`)
}

markPhase("persist", "completed")

// ══════════════════════════════════════════════════════════════════════════════
// Phase 9: Report — synthesize prioritized findings with prior-run comparison
// ══════════════════════════════════════════════════════════════════════════════

phase("Report")

// Build prior-run comparison context
const priorRunContext = priorHistory
  ? `
## Prior Run Comparison
- Previous run: ${RUN_ID !== priorHistory.runId ? "available" : "same run"}
- Previous findings: ${priorHistory.findings?.total || 0} raw, ${priorHistory.findings?.verified || 0} verified
- Previous fixes: ${priorHistory.fixes?.applied || 0} applied
- Delta (raw findings): ${allFindings.length - (priorHistory.findings?.total || 0)} (+/-)
- New findings this run: ${activeFindings.length}
- Suppressed (unchanged from prior): ${suppressedFromPrior.length}
`
  : "\n## Prior Run Comparison: No prior history available (first run or fresh mode).\n"

const reportResult = await agent(
  `Generate a concise code review report for the GUI Movie Director Bun app.

## Scan Summary
- Files reviewed: ${totalFiles} (${totalLines} lines)
- Layers: server=${layers.server}, api=${layers.api}, lib=${layers.lib}, frontend=${layers.frontend}
- Effort: ${effort}, Dimensions: ${dimensions.join(", ")}

## All Findings (${allFindings.length + suppressedFromPrior.length} raw → ${verifiedFindings.length} verified, ${suppressedFromPrior.length} suppressed from prior)
${JSON.stringify(verifiedFindings, null, 2)}

## Adversarial Verification
- Total verdicts: ${allVerdicts.length}
- Upheld: ${allVerdicts.filter((v) => v.upheld).length}
- Rejected: ${allVerdicts.filter((v) => !v.upheld).length}
- Confidence threshold: ${confidenceThreshold}%

${doFix ? `## Fix Results
- Applied: ${appliedCount}
- Skipped: ${skippedCount}
- Failed: ${failedCount}
- Files changed: ${fixResults.filesChanged.join(", ") || "none"}
${reVerifyFindings.length > 0 ? `- Regressions: ${reVerifyFindings.length}` : "- Regressions: none"}
${restoreResult.triggered ? `- RESTORE triggered: ${restoreResult.reason}, ${restoreResult.filesReverted?.length || 0} file(s) reverted` : ""}
` : "## Fix Phase: SKIPPED (review-only mode)"}
${priorRunContext}

## Your Task

**1. Executive summary** — 2-3 sentences: overall code health, top concern areas.

**2. Findings by dimension** — count per dimension, most critical finding in each.

**3. Findings by severity** — count per severity level.

**4. Top 5 findings** — the most important issues to address, with file:line and one-line fix description.

**5. Fix summary** — what was fixed, what was skipped and why. If restore was triggered, explain what happened.

**6. Trend comparison** (if prior run data available) — how findings changed vs prior run, improvement areas, new issues.

**7. Recommendations** — 3-5 specific, actionable next steps.

Keep the report concise and actionable. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)

markPhase("report", "completed")

// ── Final output ─────────────────────────────────────────────────────────────

log("")
log("=== GUI Movie Director Review & Optimize Complete ===")
log(`Run: ${RUN_ID} | Files: ${totalFiles} (${totalLines} lines) | Findings: ${allFindings.length + suppressedFromPrior.length} raw → ${verifiedFindings.length} verified`)
log(`Dimensions: ${dimensions.join(", ")} | Effort: ${effort}`)
log(`Adversarial: ${allVerdicts.length} verdicts (${allVerdicts.filter((v) => v.upheld).length} upheld)`)
if (suppressedFromPrior.length > 0) log(`Incremental: ${suppressedFromPrior.length} suppressed from prior run`)
if (doFix) {
  log(`Fixes: ${appliedCount} applied, ${skippedCount} skipped, ${failedCount} failed across ${fixResults.filesChanged.length} file(s)`)
  if (reVerifyFindings.length > 0) log(`Regressions: ${reVerifyFindings.length}`)
  if (restoreResult.triggered) log(`RESTORE: ${restoreResult.reason} — ${restoreResult.filesReverted?.length || 0} file(s) reverted`)
}
log(`History: ${HISTORY_DIR}/${RUN_ID}.json`)
log(reportResult || "(no report)")

return {
  runId: RUN_ID,
  scan: {
    totalFiles,
    totalLines,
    layers,
    targetScope: targetFiles ? "targeted" : "full",
  },
  findings: {
    total: allFindings.length + suppressedFromPrior.length,
    verified: verifiedFindings.length,
    filtered: verifiedFindings.length,
    newFindings: activeFindings.length,
    suppressedFromPrior: suppressedFromPrior.length,
    byDimension,
    bySeverity,
    items: verifiedFindings,
    rejected: rejectedFindings,
    rejected_by_dimension: rejectedByDimension,
  },
  adversarial: {
    totalVerdicts: allVerdicts.length,
    upheld: allVerdicts.filter((v) => v.upheld).length,
    rejected: allVerdicts.filter((v) => !v.upheld).length,
  },
  fixes: doFix
    ? {
        applied: appliedCount,
        skipped: skippedCount,
        failed: failedCount,
        filesChanged: fixResults.filesChanged,
        regressions: reVerifyFindings.length,
        items: fixResults.fixes,
      }
    : { mode: "review-only", applied: 0, skipped: 0, failed: 0, filesChanged: [], regressions: 0 },
  restore: restoreResult,
  history: {
    runId: RUN_ID,
    path: `${HISTORY_DIR}/${RUN_ID}.json`,
    phasesCompleted,
    phasesFailed,
  },
  report: reportResult,
}
