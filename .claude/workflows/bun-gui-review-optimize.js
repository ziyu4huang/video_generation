// Bun GUI Review & Optimize — Multi-dimensional code review + adversarial verify + auto-fix
//
// A dynamic workflow that reviews the Bun GUI Movie Director app for bugs, type safety,
// error handling, code quality, and security issues — then optionally applies verified fixes.
//
// Unlike read-only review workflows, this one includes a Resolve Fix phase that actually
// edits the codebase, then re-verifies the changed files to catch regressions.
//
// Modes (selected by args):
//
//   FULL REVIEW (default):
//     Workflow({ name: "bun-gui-review-optimize" })
//       → full review, medium effort, fix=true
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
//       → skip Resolve Fix phase entirely
//
//   DEEP:
//     Workflow({ name: "...", args: { effort: "high" } })
//       → lower confidence threshold, all dimensions, full adversarial + re-verify
//
// Dimensions: correctness, type-safety, error-handling, code-quality, security
// Effort levels: low (fast, high confidence), medium (default), high (exhaustive)

export const meta = {
  name: "bun-gui-review-optimize",
  description: "Multi-dimensional code review + adversarial verification + auto-fix for the Bun GUI Movie Director app",
  whenToUse: "Before committing to bun/gui-movie-director/, after adding new views/APIs, or periodic code health review",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root, normalize args, derive paths" },
    { title: "Scan", detail: "File inventory, line counts, layer classification" },
    { title: "Review", detail: "Parallel agents: correctness, type safety, error handling, code quality, security" },
    { title: "Adversarial Verify", detail: "Skeptical agents refute findings, filter false positives" },
    { title: "Resolve Fix", detail: "Apply verified fixes to codebase, re-verify changed files" },
    { title: "Report", detail: "Synthesize prioritized findings with fix status" },
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

if (isObj(resolvedArgs)) {
  if (Array.isArray(resolvedArgs.files)) targetFiles = resolvedArgs.files
  if (typeof resolvedArgs.focus === "string") focus = resolvedArgs.focus
  if (resolvedArgs.fix === false) doFix = false
  if (["low", "medium", "high"].includes(resolvedArgs.effort)) effort = resolvedArgs.effort
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

log(`Config: effort=${effort}, dimensions=${dimensions.join(",")}, fix=${doFix}, focus=${focus || "all"}`)

// ── Schemas ──────────────────────────────────────────────────────────────────

const PATH_SCHEMA = {
  type: "object",
  properties: {
    projectRoot: { type: "string", description: "Absolute path to the git project root" },
  },
  required: ["projectRoot"],
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
          id:           { type: "string", description: "Unique ID: dimension-severity-N" },
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

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    summary:         { type: "string" },
    byDimension:     { type: "object", additionalProperties: { type: "number" } },
    bySeverity:      { type: "object", additionalProperties: { type: "number" } },
    topFindings:     { type: "array", items: { type: "object" } },
    fixSummary:      { type: "object" },
    recommendations: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "byDimension", "bySeverity", "topFindings"],
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 0: Resolve — absolute paths
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

const GUI_DIR = `${PROJECT_ROOT}/bun/gui-movie-director`

log(`Resolved: PROJECT_ROOT=${PROJECT_ROOT}`)
log(`  GUI_DIR: ${GUI_DIR}`)

// ══════════════════════════════════════════════════════════════════════════════
// Phase 1: Scan — file inventory
// ══════════════════════════════════════════════════════════════════════════════

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

const fileList = (scanResult?.files || []).filter(Boolean)
const totalFiles = scanResult?.totalFiles || fileList.length
const totalLines = scanResult?.totalLines || fileList.reduce((n, f) => n + (f.lines || 0), 0)

const layers = { server: 0, api: 0, lib: 0, frontend: 0 }
fileList.forEach((f) => { if (layers[f.layer] != null) layers[f.layer]++ })

log(`Scan: ${totalFiles} files, ${totalLines} lines — server=${layers.server} api=${layers.api} lib=${layers.lib} frontend=${layers.frontend}`)

if (fileList.length === 0) {
  log("ERROR: No files found to review. Check GUI_DIR path or targetFiles arg.")
  return { scan: { totalFiles: 0, totalLines: 0, layers, targetScope: targetFiles ? "targeted" : "full" }, findings: { total: 0, verified: 0, filtered: 0, items: [] }, report: "No files to review." }
}

// Build file list string for review agent prompts
const fileListing = fileList.map((f) => `- ${f.absPath} (${f.lines} lines, ${f.layer})`).join("\n")

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2: Review — multi-dimensional parallel agents
// ══════════════════════════════════════════════════════════════════════════════

phase("Review")

// Dimension-specific review prompts
const DIMENSION_PROMPTS = {
  correctness: `Review these TypeScript source files for CORRECTNESS BUGS in a Bun HTTP server + React SPA app.

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
- Rate confidence 0-100 (how certain this is a real bug)
- Rate severity: critical (crash/data-loss), high (broken feature), medium (degraded UX), low (cosmetic), info (style)
- Provide a concrete suggestedFix (actual code or clear description)

Return structured findings matching the schema.`,

  "type-safety": `Review these TypeScript source files for TYPE SAFETY issues.

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
Return structured findings matching the schema.`,

  "error-handling": `Review these TypeScript source files for ERROR HANDLING gaps.

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
Return structured findings matching the schema.`,

  "code-quality": `Review these TypeScript source files for CODE QUALITY improvements.

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
Return structured findings matching the schema.`,

  security: `Review these TypeScript source files for SECURITY vulnerabilities in this Bun HTTP server app.

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
allFindings.forEach((f) => {
  log(`  [${f.severity}] ${f.dimension}: ${f.title} (${f.file}:${f.line || "?"}) [${f.confidence}%]`)
})

if (allFindings.length === 0) {
  log("No findings — codebase looks clean!")
  return {
    scan: { totalFiles, totalLines, layers, targetScope: targetFiles ? "targeted" : "full" },
    findings: { total: 0, verified: 0, filtered: 0, byDimension: {}, bySeverity: {}, items: [] },
    adversarial: { totalVerdicts: 0, upheld: 0, rejected: 0 },
    fixes: doFix ? { applied: 0, skipped: 0, failed: 0, filesChanged: [], regressions: 0 } : { mode: "review-only" },
    report: "No findings — codebase passed all review dimensions.",
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 3: Adversarial Verify — skeptical agents refute findings
// ══════════════════════════════════════════════════════════════════════════════

// Determine which findings to adversarially verify
let findingsToVerify = allFindings
if (config.adversarial === "skip") {
  log("Adversarial verify: SKIPPED (low effort)")
  findingsToVerify = []
} else if (config.adversarial === "high-critical") {
  findingsToVerify = allFindings.filter((f) => f.severity === "critical" || f.severity === "high")
  log(`Adversarial verify: ${findingsToVerify.length}/${allFindings.length} findings (high/critical only)`)
} else {
  log(`Adversarial verify: all ${allFindings.length} findings`)
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
const verifiedFindings = allFindings.filter((f) => {
  const verdict = verdictMap[f.id]
  const upheld = !verdict || verdict.upheld !== false   // keep if no verdict or upheld
  const confidence = f.confidence || 0
  return upheld && confidence >= confidenceThreshold
})

const rejected = allFindings.length - verifiedFindings.length
log(`Filter: ${verifiedFindings.length}/${allFindings.length} findings survived (adversarial + confidence ≥ ${confidenceThreshold}%)`)
if (rejected > 0) {
  log(`  Rejected: ${rejected} (false positives or low confidence)`)
  // Log rejected findings briefly
  allFindings.filter((f) => !verifiedFindings.includes(f)).forEach((f) => {
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

// ══════════════════════════════════════════════════════════════════════════════
// Phase 4: Resolve Fix — apply verified fixes
// ══════════════════════════════════════════════════════════════════════════════

let fixResults = { fixes: [], filesChanged: [] }
let reVerifyFindings = []

if (doFix && verifiedFindings.length > 0) {
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

    const applied = fixResults.fixes.filter((f) => f.status === "applied").length
    const skipped = fixResults.fixes.filter((f) => f.status === "skipped").length
    const failed = fixResults.fixes.filter((f) => f.status === "failed").length
    log(`Fix results: ${applied} applied, ${skipped} skipped, ${failed} failed, ${fixResults.filesChanged.length} file(s) changed`)
    fixResults.fixes.forEach((f) => {
      log(`  ${f.status === "applied" ? "✓" : f.status === "skipped" ? "⊘" : "✗"} ${f.findingId}: ${f.change || f.error || ""}`)
    })

    // Re-verify changed files (lite correctness + type-safety scan)
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
    }
  }
} else if (!doFix) {
  log("Review-only mode — skipping Resolve Fix phase.")
} else {
  log("No verified findings to fix.")
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 5: Report — synthesize prioritized findings
// ══════════════════════════════════════════════════════════════════════════════

phase("Report")

const appliedCount = fixResults.fixes.filter((f) => f.status === "applied").length
const skippedCount = fixResults.fixes.filter((f) => f.status === "skipped").length
const failedCount  = fixResults.fixes.filter((f) => f.status === "failed").length

const reportResult = await agent(
  `Generate a concise code review report for the Bun GUI Movie Director app.

## Scan Summary
- Files reviewed: ${totalFiles} (${totalLines} lines)
- Layers: server=${layers.server}, api=${layers.api}, lib=${layers.lib}, frontend=${layers.frontend}
- Effort: ${effort}, Dimensions: ${dimensions.join(", ")}

## All Findings (${allFindings.length} raw → ${verifiedFindings.length} verified)
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
` : "## Fix Phase: SKIPPED (review-only mode)"}

## Your Task

**1. Executive summary** — 2-3 sentences: overall code health, top concern areas.

**2. Findings by dimension** — count per dimension, most critical finding in each.

**3. Findings by severity** — count per severity level.

**4. Top 5 findings** — the most important issues to address, with file:line and one-line fix description.

**5. Fix summary** — what was fixed, what was skipped and why.

**6. Recommendations** — 3-5 specific, actionable next steps (e.g. "Add input validation to handleRunJob", "Replace any types in ws.ts with concrete WebSocket interfaces").

Keep the report concise and actionable. Use markdown.`,
  { label: "report", phase: "Report", model: "sonnet" },
)

// ── Final output ─────────────────────────────────────────────────────────────

log("")
log("=== Bun GUI Review & Optimize Complete ===")
log(`Files: ${totalFiles} (${totalLines} lines) | Findings: ${allFindings.length} raw → ${verifiedFindings.length} verified`)
log(`Dimensions: ${dimensions.join(", ")} | Effort: ${effort}`)
log(`Adversarial: ${allVerdicts.length} verdicts (${allVerdicts.filter((v) => v.upheld).length} upheld)`)
if (doFix) {
  log(`Fixes: ${appliedCount} applied, ${skippedCount} skipped, ${failedCount} failed across ${fixResults.filesChanged.length} file(s)`)
  if (reVerifyFindings.length > 0) log(`Regressions: ${reVerifyFindings.length}`)
}
log(reportResult || "(no report)")

return {
  scan: {
    totalFiles,
    totalLines,
    layers,
    targetScope: targetFiles ? "targeted" : "full",
  },
  findings: {
    total: allFindings.length,
    verified: verifiedFindings.length,
    filtered: verifiedFindings.length,
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
      }
    : { mode: "review-only", applied: 0, skipped: 0, failed: 0, filesChanged: [], regressions: 0 },
  report: reportResult,
}
