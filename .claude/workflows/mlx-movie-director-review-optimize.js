// MLX Movie Director Review & Optimize — Python code review + argparse integrity + self-regression
//
// A dynamic workflow that reviews the Python MLX Movie Director CLI for bugs,
// argparse conflicts, type safety, error handling, and import hygiene — then
// optionally applies verified fixes and runs pytest + argparse smoke tests.
//
// Features:
//   - Multi-dimensional parallel review (correctness, argparse-integrity, type-safety, error-handling, import-hygiene)
//   - Specialized argparse-integrity dimension that traces add_*_args() call chains across unified commands
//   - Adversarial verification to filter false positives
//   - Git stash checkpoint + automatic restore on regression detection
//   - Re-verify runs pytest + argparse smoke tests (run.py <command> --help for every command)
//   - Run history persistence for trend analysis and incremental improvement
//   - Resume from interrupted runs (skip completed phases)
//   - Cross-run finding deduplication (suppress previously-upheld findings)
//
// Modes (selected by args):
//
//   FULL REVIEW (default):
//     Workflow({ name: "mlx-movie-director-review-optimize" })
//       → full review, medium effort, fix=true, resume=auto
//
//   TARGETED:
//     Workflow({ name: "...", args: { files: ["app/commands/video.py", "run.py"] } })
//       → review only the listed files
//
//   SINGLE DIMENSION:
//     Workflow({ name: "...", args: { focus: "argparse-integrity" } })
//       → only argparse-integrity dimension
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
// Dimensions: correctness, argparse-integrity, type-safety, error-handling, import-hygiene
// Effort levels: low (fast, high confidence), medium (default), high (exhaustive)

export const meta = {
  name: "mlx-movie-director-review-optimize",
  description: "Multi-dimensional code review + adversarial verification + auto-fix for the MLX Movie Director Python CLI",
  whenToUse: "Before committing to python/mlx-movie-director/, after adding new commands/subcommands, or periodic code health review",
  phases: [
    { title: "Resolve",            detail: "Detect project root, normalize args, check for prior run to resume" },
    { title: "Scan",               detail: "File inventory, line counts, Python layer classification" },
    { title: "Review",             detail: "Parallel agents: correctness, argparse integrity, type safety, error handling, import hygiene" },
    { title: "Adversarial Verify", detail: "Skeptical agents refute findings, filter false positives" },
    { title: "Checkpoint",         detail: "Git stash backup before applying fixes (enables rollback)" },
    { title: "Resolve Fix",        detail: "Apply verified fixes to codebase" },
    { title: "Re-verify",          detail: "Argparse smoke tests + pytest + code review on changed files" },
    { title: "Restore",            detail: "Conditional: rollback fixes if re-verify detects regressions" },
    { title: "Persist",            detail: "Write run history to disk for trend analysis and incremental improvement" },
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

const VALID_DIMENSIONS = ["correctness", "argparse-integrity", "type-safety", "error-handling", "import-hygiene"]

// Dimension config: which model to use per effort level
const DIMENSION_CONFIG = {
  correctness:         { label: "Correctness bugs",      model: "sonnet" },
  "argparse-integrity": { label: "Argparse integrity",  model: "sonnet" },
  "type-safety":       { label: "Type safety",           model: "sonnet" },
  "error-handling":    { label: "Error handling",        model: "sonnet" },
  "import-hygiene":    { label: "Import hygiene",        model: effort === "low" ? "haiku" : "sonnet" },
}

// Effort depth controls
const EFFORT_CONFIG = {
  low: {
    dimensions: ["correctness", "argparse-integrity"],
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
    reVerify: "smoke-and-changed",  // argparse smoke + pytest + changed file review
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
          path: { type: "string", description: "Relative path from PYTHON_DIR" },
          absPath: { type: "string", description: "Absolute path on disk" },
          lines: { type: "number", description: "Line count" },
          layer: { type: "string", enum: ["entry", "commands", "core", "scripts", "tests"], description: "Code layer" },
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
          file:         { type: "string", description: "Relative path from PYTHON_DIR" },
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

const REVERIFY_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:           { type: "string" },
          dimension:    { type: "string", enum: VALID_DIMENSIONS },
          severity:     { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          confidence:   { type: "number" },
          file:         { type: "string" },
          line:         { type: "number" },
          title:        { type: "string" },
          description:  { type: "string" },
          source:       { type: "string", enum: ["argparse-smoke", "pytest", "code-review"] },
          rawOutput:    { type: "string", description: "Raw command output for failures" },
        },
        required: ["id", "severity", "title", "source"],
      },
    },
    smokeTestResults: {
      type: "object",
      properties: {
        mainHelp:        { type: "string", enum: ["pass", "fail"] },
        commandsPassed:  { type: "number" },
        commandsFailed:  { type: "number" },
        failedCommands:  { type: "array", items: { type: "string" } },
        pytestResult:    { type: "string", enum: ["pass", "fail", "error", "skipped"] },
        pytestOutput:    { type: "string" },
        pytestPassed:    { type: "number" },
        pytestFailed:    { type: "number" },
      },
    },
  },
  required: ["findings", "smokeTestResults"],
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

const WORKFLOW_NAME = "mlx-movie-director-review-optimize"
const PYTHON_DIR = `${PROJECT_ROOT}/python/mlx-movie-director`
const VENV_PYTHON = `${PROJECT_ROOT}/python/venv/bin/python`
const HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${WORKFLOW_NAME}`

// All registered commands for argparse smoke testing
const SMOKE_COMMANDS = [
  "t2i", "image", "refine", "upscale", "caption", "replay",
  "video", "animate", "import-lora-image", "import-workflow",
  "check-model", "schema-defaults",
]
const SMOKE_ALIASES = ["generate", "check-manifests"]

log(`Resolved: PROJECT_ROOT=${PROJECT_ROOT}`)
log(`  PYTHON_DIR: ${PYTHON_DIR}`)
log(`  VENV_PYTHON: ${VENV_PYTHON}`)
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

markPhase("resolve", "completed")

// ══════════════════════════════════════════════════════════════════════════════
// Phase 1: Scan — file inventory
// ══════════════════════════════════════════════════════════════════════════════

let fileList = []
let totalFiles = 0
let totalLines = 0
let layers = { entry: 0, commands: 0, core: 0, scripts: 0, tests: 0 }

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
    ? `Only scan these specific files (relative to ${PYTHON_DIR}):\n${targetFiles.map((f) => `- ${f}`).join("\n")}`
    : effort === "low"
      ? `Only scan these high-priority paths:\n- run.py\n- app/commands/*.py\n- app/commands/_shared.py`
      : effort === "medium"
        ? `Scan ALL .py files under ${PYTHON_DIR} (excluding __pycache__, venv, .cache, .pytest_cache, output, models, docs).`
        : `Scan ALL .py files under ${PYTHON_DIR} (excluding __pycache__, venv, .cache, .pytest_cache, output, models, docs). Include app/tests/ as well.`

  const scanResult = await agent(
    `Inventory Python source files in the MLX Movie Director CLI tool.

  ${scanScope}

  For each file:
  1. Run: Bash("find '${PYTHON_DIR}' -name '*.py' -not -path '*__pycache__*' -not -path '*/venv/*' -not -path '*/.cache/*' -not -path '*/.pytest_cache/*' -not -path '*/output/*' -not -path '*/models/*' -not -path '*/docs/*' | sort")
  2. For each file found, get its line count: Bash("wc -l <file>")
  3. Classify the layer based on path:
     - "entry" for run.py and convert.py (top-level scripts)
     - "commands" for app/commands/*.py (argparse command modules)
     - "core" for app/*.py (pipeline, config, manifest, model_registry, etc.)
     - "scripts" for scripts/*.py
     - "tests" for app/tests/*.py
  4. Skip __pycache__, venv/, .cache/, .pytest_cache/, output/, models/, docs/
  ${effort === "low" ? "5. SKIP app/tests/ — not needed for low effort" : ""}
  ${effort === "medium" ? "5. SKIP app/tests/ — not needed for medium effort" : ""}

  Return the complete file inventory as structured JSON.`,
    { label: "scan-files", phase: "Scan", model: "haiku", schema: SCAN_SCHEMA },
  )

  fileList = (scanResult?.files || []).filter(Boolean)
  totalFiles = scanResult?.totalFiles || fileList.length
  totalLines = scanResult?.totalLines || fileList.reduce((n, f) => n + (f.lines || 0), 0)

  fileList.forEach((f) => { if (layers[f.layer] != null) layers[f.layer]++ })

  // Track all scanned files
  fileList.forEach((f) => filesTouched.add(`python/mlx-movie-director/${f.path}`))
}

log(`Scan: ${totalFiles} files, ${totalLines} lines — entry=${layers.entry} commands=${layers.commands} core=${layers.core} scripts=${layers.scripts} tests=${layers.tests}`)

if (fileList.length === 0) {
  log("ERROR: No files found to review. Check PYTHON_DIR path or targetFiles arg.")
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
  "argparse-integrity": `Review these Python command modules for ARGPARSE INTEGRITY issues in an MLX video generation CLI tool.

The project uses a dynamic argparse architecture:
- run.py's build_parser() registers subcommands via importlib.import_module()
- Unified commands (e.g. video.py, image.py) call multiple add_*_args() functions from sibling modules ON THE SAME PARSER
- Sibling modules register arguments via parser.add_argument() — some WITHOUT _arg_registered() or _option_registered() guards
- The _shared.py module provides _arg_registered() and _option_registered() guards, but they are OPTIONAL

THIS IS THE CRITICAL PATTERN TO CHECK:
1. Read run.py to find all registered subcommands (COMMAND_NAMES list, COMMAND_ALIASES dict)
2. For each unified command (video.py, image.py), trace the add_args() function
3. In add_args(), note every add_*_args() call from imported sibling modules
4. For EACH sibling module's add_*_args() function, extract every add_argument() call
5. Build a map of {option_string -> registering_module} for each unified command
6. Flag any option string that appears in MORE THAN ONE module's add_argument() calls WITHOUT a _option_registered() guard

Specifically check for:
- Duplicate --option registrations: Two different add_*_args() functions call parser.add_argument("--same-option", ...) without _option_registered() guard
- Conflicting dest names: Two add_argument() calls with different option strings but same dest= parameter
- Missing _arg_registered() / _option_registered() guards in shared arg functions
- Mismatched choices= lists: Same --option registered in two modules with different choices= values
- Mismatched default= values: Same --option with different defaults across modules
- PARSER_META dict: Every command module must export PARSER_META dict with "help" key
- Missing module contract: Every command module must export add_args(parser) and run(args) functions
- importlib.import_module() calls: Check that the module name string matches the actual filename

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}

For each finding:
- Provide EXACT file path (relative to ${PYTHON_DIR}), line number, and a short code snippet
- Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber}
  If multiple findings on the same line: append a letter (argparse-integrity-video-compare.py-137b)
- Rate confidence 0-100
- Rate severity: critical (argparse crash at startup), high (broken subcommand), medium (degraded UX), low (cosmetic)
- Provide a concrete suggestedFix (actual code or clear description)

Return structured findings matching the schema.`,

  correctness: `Review these Python source files for CORRECTNESS BUGS in an MLX-based image/video generation CLI tool on Apple Silicon.

Focus on:
- Logic errors: wrong conditions in image/video processing pipelines, off-by-one in frame calculations
- The 8k+1 frame constraint: frames must satisfy (frames-1) % 8 == 0 (i.e. 9, 17, 25, 33, 41, 49...). Check frame validation logic in video-generate.py
- Race conditions in GPU monitor (gpu_monitor.py), concurrent Metal memory management
- State management: RunConfig mutation across batch iterations, pipeline state leaking between runs
- subprocess.run / subprocess.Popen calls without proper error handling or timeout
- File I/O: missing os.makedirs(exist_ok=True), file handle leaks, missing context managers
- Mutable default arguments (a common Python pitfall): def func(items=[]) or def func(config={})
- argparse dest= mismatches: dest="test_prompt" but code accesses args.test_prompt

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}
${effort === "low" ? "Only report findings with confidence >= 80 (high-confidence only)." : ""}
${effort === "high" ? "Also check subtle edge cases in MLX tensor operations, MPS fallback paths, and error recovery." : ""}

For each finding:
- Provide EXACT file path (relative to ${PYTHON_DIR}), line number, and a short code snippet
- Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber}
- Rate confidence 0-100
- Rate severity: critical (crash/data-loss), high (broken feature), medium (degraded UX), low (cosmetic), info (style)
- Provide a concrete suggestedFix

Return structured findings matching the schema.`,

  "type-safety": `Review these Python source files for TYPE SAFETY issues.

Focus on:
- Missing type hints on public functions (def run(args) vs def run(args: argparse.Namespace) -> None)
- Any usage that should be typed: RunConfig dataclass fields, pipeline method signatures, manifest structures
- str | None union syntax (Python 3.10+): ensure the project consistently uses this or Optional[str]
- Incorrect type narrowing: isinstance checks that don't cover all cases
- bare except: clauses that catch BaseException instead of Exception
- getattr() calls without default: getattr(args, "caption_style", None) is safe; getattr(args, "caption_style") is not
- Dict/List without generic types: Dict[str, Any] should be Dict[str, str] when the value type is known

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}
${effort === "low" ? "Only report findings with confidence >= 80." : ""}

For each finding provide exact file, line, code snippet, confidence (0-100), severity, and a suggested fix.
Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber}.
Return structured findings matching the schema.`,

  "error-handling": `Review these Python source files for ERROR HANDLING gaps in this CLI tool.

Focus on:
- sys.exit(1) calls in library code (app/*.py) — should raise exceptions instead, let the CLI layer handle exit
- Missing try/except around importlib.import_module() in run.py and unified commands
- subprocess calls without checking returncode or stderr
- File operations without FileNotFoundError handling
- Image.open() without handling corrupt/missing files
- MLX operations without MemoryError handling (Metal allocation failures on Apple Silicon)
- bare except: pass patterns that silently swallow errors
- Missing cleanup in finally blocks: GPU memory, temp files, loaded models

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}
${effort === "low" ? "Only report findings with confidence >= 80." : ""}

For each finding provide exact file, line, code snippet, confidence (0-100), severity, and a suggested fix.
Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber}.
Return structured findings matching the schema.`,

  "import-hygiene": `Review these Python source files for IMPORT HYGIENE issues.

Focus on:
- importlib.import_module() calls with incorrect module paths (e.g. "app.commands.video_generate" vs "app.commands.video-generate")
- Circular import risk: run.py imports app.commands.*, but _shared.py imports app.config
- Unused imports at module top level
- Missing __init__.py or empty __init__.py that should re-export
- sys.path manipulation: run.py does sys.path.insert(0, ...) — is this safe?
- Late imports inside functions (from app.pipeline import ...) — are they necessary or should they be top-level?
- Import ordering: stdlib, third-party, local should be separated by blank lines (PEP 8)

Files to review (read each one fully):
${fileListing}

EFFORT: ${effort}

For each finding provide exact file, line, code snippet, confidence (0-100), severity, and a suggested fix.
Use STABLE finding ID format: {dimension}-{fileBasename}-{lineNumber}.
Return structured findings matching the schema.`,
}

// Run review agents in parallel (one per active dimension)
log(`Running ${dimensions.length} review dimension(s) in parallel...`)

const reviewResults = await parallel(
  dimensions.map((dim) => () => {
    const dimCfg = DIMENSION_CONFIG[dim]
    return agent(
      DIMENSION_PROMPTS[dim],
      { label: `review-${dim}`, phase: "Review", model: dimCfg.model, schema: REVIEW_FINDING_SCHEMA },
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
} else if (activeFindings.length === 0) {
  log(`All ${suppressedFromPrior.length} findings were suppressed from prior run. No new issues found.`)
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
${filesToRead.map((f) => `- ${PYTHON_DIR}/${f}`).join("\n")}

For EACH finding:
1. Read the file: Bash("cat '${PYTHON_DIR}/<finding.file>'") or with line range for large files
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
log(`Filter: ${verifiedFindings.length}/${activeFindings.length} findings survived (adversarial + confidence >= ${confidenceThreshold}%)`)
if (rejected > 0) {
  log(`  Rejected: ${rejected} (false positives or low confidence)`)
  activeFindings.filter((f) => !verifiedFindings.includes(f)).forEach((f) => {
    const v = verdictMap[f.id]
    log(`    ✗ ${f.id}: ${v ? v.reason : `confidence ${f.confidence}% < ${confidenceThreshold}%`}`)
  })
}

// ── Pure JS: compute stats ──────────────────────────────────────────────────

const byDimension = {}
const bySeverity = {}
verifiedFindings.forEach((f) => {
  byDimension[f.dimension] = (byDimension[f.dimension] || 0) + 1
  bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1
})

markPhase("adversarialVerify", "completed")

// ══════════════════════════════════════════════════════════════════════════════
// Phase 4: Checkpoint — git stash backup before fixes
// ══════════════════════════════════════════════════════════════════════════════

let checkpointResult = { stashCreated: false, stashRef: "", headSha: "", dirtyBefore: [] }
let fixResults = { fixes: [], filesChanged: [] }
let reVerifyFindings = []
let smokeTestResults = null
let restoreResult = { triggered: false, reason: null, stashRestored: false, filesReverted: [] }

if (doFix && verifiedFindings.length > 0) {
  phase("Checkpoint")

  checkpointResult = await agent(
    `Create a git stash backup before applying code review fixes. This enables rollback if fixes cause regressions.

  Steps:
  1. Run: Bash("cd '${PROJECT_ROOT}' && git rev-parse HEAD")
     Capture the HEAD SHA.
  2. Run: Bash("cd '${PROJECT_ROOT}' && git status --short 'python/mlx-movie-director/'")
     Capture the list of dirty files (if any).
  3. Run: Bash("cd '${PROJECT_ROOT}' && git stash push -m 'mlx-movie-director-review-checkpoint-${RUN_ID}' -- 'python/mlx-movie-director/'")
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
1. Read the file FIRST before editing: Bash("cat '${PYTHON_DIR}/${file}'")
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
    fixResults.filesChanged.forEach((f) => filesTouched.add(`python/mlx-movie-director/${f}`))

    const applied = fixResults.fixes.filter((f) => f.status === "applied").length
    const skipped = fixResults.fixes.filter((f) => f.status === "skipped").length
    const failed = fixResults.fixes.filter((f) => f.status === "failed").length
    log(`Fix results: ${applied} applied, ${skipped} skipped, ${failed} failed, ${fixResults.filesChanged.length} file(s) changed`)
    fixResults.fixes.forEach((f) => {
      log(`  ${f.status === "applied" ? "✓" : f.status === "skipped" ? "⊘" : "✗"} ${f.findingId}: ${f.change || f.error || ""}`)
    })

    // ══════════════════════════════════════════════════════════════════════════════
    // Phase 6: Re-verify — argparse smoke tests + pytest + code review
    // ══════════════════════════════════════════════════════════════════════════════

    if (config.reVerify !== "skip" && fixResults.filesChanged.length > 0) {
      phase("Re-verify")

      const reVerifyFiles = config.reVerify === "full"
        ? fileList.map((f) => f.absPath)
        : fixResults.filesChanged.map((f) => `${PYTHON_DIR}/${f}`)

      log(`Re-verifying ${reVerifyFiles.length} file(s) after fixes...`)

      // Build the argparse smoke test commands
      const smokeCommands = ["--help", ...SMOKE_COMMANDS.map((c) => `${c} --help`), ...SMOKE_ALIASES.map((c) => `${c} --help`)]

      const reVerifyResult = await agent(
        `Re-verify the Python codebase after applying code review fixes. Run THREE levels of verification:

LEVEL 1 — Argparse smoke tests (catches the exact class of bug: ArgumentError: conflicting option string):
Run each of these commands and check the exit code. If any exit non-zero or print "ArgumentError" to stderr, that is a CRITICAL regression.

Commands (run each one separately):
${smokeCommands.map((cmd) => `Bash("${VENV_PYTHON} ${PYTHON_DIR}/run.py ${cmd} 2>&1; echo EXIT_CODE=$?")`).join("\n")}

Count: ${smokeCommands.length} total (1 main --help + ${SMOKE_COMMANDS.length} commands + ${SMOKE_ALIASES.length} aliases).
For each failed command, capture the stderr output.

LEVEL 2 — Pytest (functional regression testing):
Bash("${VENV_PYTHON} -m pytest ${PYTHON_DIR}/app/tests/ -x -q 2>&1; echo EXIT_CODE=$?")
If any test FAILS or ERRORs, report each as a regression.

LEVEL 3 — Quick code review on changed files:
Read each changed file and look for syntax errors, broken imports, or logic regressions introduced by edits.

Changed files:
${reVerifyFiles.map((f) => `- ${f}`).join("\n")}

ORIGINAL APPLIED FIXES (for context):
${JSON.stringify(fixResults.fixes.filter((f) => f.status === "applied"), null, 2)}

Return ALL regressions found across all 3 levels as structured findings with the "source" field indicating which level caught it.`,
        { label: "re-verify", phase: "Re-verify", model: "sonnet", schema: REVERIFY_SCHEMA },
      )

      reVerifyFindings = (reVerifyResult?.findings || []).filter(Boolean)
      smokeTestResults = reVerifyResult?.smokeTestResults || null

      if (reVerifyFindings.length > 0) {
        log(`WARNING: ${reVerifyFindings.length} regression(s) detected after fixes!`)
        reVerifyFindings.forEach((f) => log(`  ⚠ [${f.source}] ${f.title} (${f.file || "N/A"}:${f.line || "?"})`))
      } else {
        log("Re-verify: no regressions detected ✓")
      }
      if (smokeTestResults) {
        log(`  Smoke: ${smokeTestResults.commandsPassed || 0}/${(smokeTestResults.commandsPassed || 0) + (smokeTestResults.commandsFailed || 0)} commands passed, pytest=${smokeTestResults.pytestResult || "unknown"}`)
      }

      markPhase("reVerify", "completed")
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // Phase 7: Restore — conditional rollback if regressions detected
    // ══════════════════════════════════════════════════════════════════════════════

    const hasCriticalRegression = reVerifyFindings.some((f) => f.severity === "critical")
    const hasArgparseCrash = reVerifyFindings.some((f) => f.source === "argparse-smoke")
    const hasPytestFailure = reVerifyFindings.some((f) => f.source === "pytest" && f.severity !== "low")
    const hasMultipleRegressions = reVerifyFindings.length > 2

    if (reVerifyFindings.length > 0 && (hasCriticalRegression || hasArgparseCrash || hasPytestFailure || hasMultipleRegressions)) {
      phase("Restore")

      const restoreReason = hasArgparseCrash ? "argparse-crash" : hasCriticalRegression ? "critical-regression" : hasPytestFailure ? "pytest-failure" : "multiple-regressions"
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
   Bash("cd '${PROJECT_ROOT}' && git checkout ${stashRef} -- 'python/mlx-movie-director/'")
   Then drop the stash:
   Bash("cd '${PROJECT_ROOT}' && git stash drop ${stashRef}")
` : `
1. No stash was created (tree was clean before fixes).
   Restore individual files using git checkout:
   ${fixResults.filesChanged.map((f) => `Bash("cd '${PROJECT_ROOT}' && git checkout HEAD -- 'python/mlx-movie-director/${f}'")`).join("\n   ")}
`}

After restore:
2. Verify files are restored: Bash("cd '${PROJECT_ROOT}' && git status --short 'python/mlx-movie-director/'")

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
  tags: ["code-review", "python", "mlx", ...dimensions],
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
    reverify: {
      smokeTests: smokeTestResults,
      regressions: reVerifyFindings.length,
    },
    restore: restoreResult,
    git: {
      headBefore: checkpointResult?.headSha || "",
      stashRef: checkpointResult?.stashRef || "",
      dirtyFilesBefore: checkpointResult?.dirtyBefore || [],
    },
  },
}

// Write history via agent (scripts can't use fs directly)
const historyJson = JSON.stringify(historyEntry, null, 2)

await agent(
  `Persist the workflow run history to disk.

Steps:
1. Ensure directory exists: Bash("mkdir -p '${HISTORY_DIR}'")
2. Write the history JSON file using a heredoc:
   Bash("cat > '${HISTORY_DIR}/${RUN_ID}.json' <<'HISTORY_EOF'
${historyJson}
HISTORY_EOF")
3. Verify it was written: Bash("wc -c '${HISTORY_DIR}/${RUN_ID}.json'")
4. Prune old runs — keep only the 15 most recent:
   Bash("cd '${HISTORY_DIR}' && ls -t *.json 2>/dev/null | tail -n +16 | xargs rm -f")

Return { written: true, path: "${HISTORY_DIR}/${RUN_ID}.json" }.`,
  { label: "persist-history", phase: "Persist", model: "haiku" },
)

log(`History: persisted to ${HISTORY_DIR}/${RUN_ID}.json`)
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
  `Generate a concise code review report for the MLX Movie Director Python CLI.

## Scan Summary
- Files reviewed: ${totalFiles} (${totalLines} lines)
- Layers: entry=${layers.entry}, commands=${layers.commands}, core=${layers.core}, scripts=${layers.scripts}, tests=${layers.tests}
- Effort: ${effort}, Dimensions: ${dimensions.join(", ")}

## All Findings (${allFindings.length + suppressedFromPrior.length} raw -> ${verifiedFindings.length} verified, ${suppressedFromPrior.length} suppressed from prior)
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
${smokeTestResults ? `- Argparse smoke: ${smokeTestResults.commandsPassed || 0}/${(smokeTestResults.commandsPassed || 0) + (smokeTestResults.commandsFailed || 0)} commands passed` : ""}
${smokeTestResults ? `- Pytest: ${smokeTestResults.pytestResult || "unknown"}` : ""}
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
log("=== MLX Movie Director Review & Optimize Complete ===")
log(`Run: ${RUN_ID} | Files: ${totalFiles} (${totalLines} lines) | Findings: ${allFindings.length + suppressedFromPrior.length} raw -> ${verifiedFindings.length} verified`)
log(`Dimensions: ${dimensions.join(", ")} | Effort: ${effort}`)
log(`Adversarial: ${allVerdicts.length} verdicts (${allVerdicts.filter((v) => v.upheld).length} upheld)`)
if (suppressedFromPrior.length > 0) log(`Incremental: ${suppressedFromPrior.length} suppressed from prior run`)
if (doFix) {
  log(`Fixes: ${appliedCount} applied, ${skippedCount} skipped, ${failedCount} failed across ${fixResults.filesChanged.length} file(s)`)
  if (smokeTestResults) log(`Smoke: ${smokeTestResults.commandsPassed || 0} passed, ${smokeTestResults.commandsFailed || 0} failed | Pytest: ${smokeTestResults.pytestResult || "unknown"}`)
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
  reverify: {
    smokeTests: smokeTestResults,
    regressions: reVerifyFindings.length,
  },
  restore: restoreResult,
  history: {
    runId: RUN_ID,
    path: `${HISTORY_DIR}/${RUN_ID}.json`,
    phasesCompleted,
    phasesFailed,
  },
  report: reportResult,
}
