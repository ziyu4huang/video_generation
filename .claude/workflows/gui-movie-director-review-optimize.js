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
  whenToUse: "Self-improve loop for gui-movie-director code health. Scope is INCREMENTAL by default (reviews only files changed since the prior run via git.headBefore — gets cheaper over time, not heavier). Two tiers: (routine scan) effort:'low' — review-only scan of changed files, ~7 agents, no fix, run often to catch regressions; (fix) effort:'medium' [default] — same incremental scope + adversarial-verify + auto-fix high/critical findings with git-stash rollback. effort:'high' = full deep-dive scan of ALL files + fix everything (periodic, e.g. monthly). Narrow further with args.files:[...] or focus:'security'.",
  phases: [
    { title: "Resolve",            detail: "Detect project root, normalize args, check for prior run to resume" },
    { title: "Scan",               detail: "File inventory — INCREMENTAL: changed files since prior run's HEAD (high effort = all files)" },
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
    // Was VALID_DIMENSIONS (all 5). Trimmed to the 3 highest-value dimensions:
    // a medium run reviews the same 11 files 5× with sonnet (each reads the
    // full scope), which ballooned the 2026-06-14T06-14-30 run to 1.18M tokens
    // / 82min and hit the API usage limit. type-safety & error-handling move
    // to high-only — they're valuable but lower-signal per agent-second.
    // Estimated ~40% fewer review tokens + ~29 fewer downstream findings.
    dimensions: ["correctness", "security", "code-quality"],
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

// ── Agent budget guard ──────────────────────────────────────────────────────
// Bounds total spawnAgent() calls so a run can't balloon into an API usage-limit
// crash. The 2026-06-14T06-14-30 medium run hit 28 agents / 1.18M tokens and
// 429'd the persist-history / update-index / reflect tail — the history JSON
// was never written. spawnAgent() wraps the raw engine hook: at the cap it
// resolves null instead of spawning, so parallel()/pipeline() callers (which
// already .filter(Boolean)) degrade gracefully rather than throwing. The cap
// sits ABOVE a normal run's count (medium ≈ 24 after the 3-dimension trim) so
// it only trips on runaway scope or a finding flood — it is insurance, not a
// runtime optimizer (token cost lives inside each agent, not in the count).
const AGENT_CAP = { high: 90, medium: 40, low: 20 }[effort]
let agentsSpawned = 0
let capHit = false
const _rawAgent = agent  // capture before spawnAgent is defined (avoids recursion)
function spawnAgent(prompt, opts) {
  if (agentsSpawned >= AGENT_CAP) {
    if (!capHit) {
      capHit = true
      log(`⚠ Agent cap (${AGENT_CAP}) reached after ${agentsSpawned} agents — remaining agents resolve null; finalizing with results so far to avoid API-limit crash`)
    }
    return Promise.resolve(null)
  }
  agentsSpawned++
  return _rawAgent(prompt, opts)
}

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
    headSha:     { type: "string" },
    treeDirty:   { type: "boolean" },
    dirtyFiles:  { type: "array", items: { type: "string" } },
  },
  required: ["headSha", "treeDirty"],
}

// bun test result (pre/post fix) for the regression delta gate
const TEST_RESULT_SCHEMA = {
  type: "object",
  properties: {
    passCount:    { type: "number" },
    failCount:    { type: "number" },
    failingTests: { type: "array", items: { type: "string" } },
    ranOk:        { type: "boolean" },
  },
  required: ["passCount", "failCount", "failingTests"],
}

// Revert result — replaces the old stash-pop Restore. reverted = files reverted
// via git checkout/rm; skippedConcurrent = files left alone (user edited mid-run)
const RESTORE_SCHEMA = {
  type: "object",
  properties: {
    reverted:          { type: "array", items: { type: "string" } },
    skippedConcurrent: { type: "array", items: { type: "string" } },
    method:            { type: "string", enum: ["checkout", "rm", "mixed", "none"] },
  },
  required: ["reverted", "skippedConcurrent"],
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

const pathResolution = await spawnAgent(
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
// Writes history JSON then VERIFIES (test -s) and rewrites via a quoted heredoc if the Write
// tool silently produced nothing — a reliability fix: the prior run's persist subagent reported
// success but never wrote the file, breaking the trend/reflection/resume loops.
async function saveHistory(histDir, indexFile, entry, signals) {
  const histJson = JSON.stringify({ ...entry, signals }, null, 2)
  const runId = entry.run_id
  const targetPath = `${histDir}/${runId}.json`
  const persist = await spawnAgent(
    `Persist workflow history to disk RELIABLY.
1. Bash("mkdir -p '${histDir}'")
2. Write the file with the Write tool: file_path='${targetPath}', content is the JSON below — paste it VERBATIM, do not summarize or truncate:
${histJson}
3. Verify it landed: Bash("test -s '${targetPath}' && echo OK || echo MISSING")
4. If step 3 printed MISSING, rewrite via a quoted heredoc (no expansion):
   Bash("cat > '${targetPath}' <<'HIST_EOF'
${histJson}
HIST_EOF")
5. Bash("wc -c < '${targetPath}'")
6. Prune old (keep newest 15, exclude reflection): Bash("cd '${histDir}' && ls -t *.json 2>/dev/null | grep -v reflection | tail -n +16 | xargs rm -f 2>/dev/null || true")
Return { written: true, bytes: <the number printed by wc> }.`,
    { label: "persist-history", phase: "Persist", model: "haiku" },
  )
  const histBytes = Number(persist?.bytes) || 0
  if (histBytes > 0) {
    log(`History: written ${histBytes} bytes → ${targetPath}`)
  } else {
    log(`WARNING: history file verification FAILED (0 bytes) — run continues but trend/reflection will miss this run.`)
  }
  await spawnAgent(
    `Update cross-workflow index at ${indexFile}.
1. Bash("cat '${indexFile}' 2>/dev/null || echo '[]'")
2. Parse JSON array. Append: ${JSON.stringify({ run_id: runId, workflow: entry.workflow, started_at: entry.started_at, run_quality: signals.run_quality, key_metric: signals.key_metric, highlights: signals.highlights })}
3. Keep only latest 50 entries (sort by run_id descending).
4. Write({ file_path: '${indexFile}', content: <updated array, 2-space indent> })
5. Verify: Bash("test -s '${indexFile}' && echo OK || echo MISSING")
6. If MISSING, rewrite the index via a quoted heredoc with the same array content.
Return { updated: true }.`,
    { label: "update-index", phase: "Persist", model: "haiku" },
  )
}

// ── reliableWrite — write a JSON artifact with verify + heredoc fallback ──
// Extracted from saveHistory's proven persist pattern (Write tool → test -s
// verify → quoted-heredoc fallback). Used for interrupt-safe findings dumps so
// a haiku agent fumbling a bare heredoc (the Bug 3 failure mode — the agent
// reported success but never wrote the file) can't silently lose the artifact.
async function reliableWrite(targetPath, jsonStr, label) {
  const dir = targetPath.slice(0, targetPath.lastIndexOf("/"))
  const result = await spawnAgent(
    `Write a JSON file to disk RELIABLY.
1. Bash("mkdir -p '${dir}'")
2. Write the file with the Write tool: file_path='${targetPath}', content is the JSON below — paste it VERBATIM, do not summarize or truncate:
${jsonStr}
3. Verify it landed: Bash("test -s '${targetPath}' && echo OK || echo MISSING")
4. If step 3 printed MISSING, rewrite via a quoted heredoc (no expansion):
   Bash("cat > '${targetPath}' <<'WFWRITE'
${jsonStr}
WFWRITE")
5. Bash("wc -c < '${targetPath}'")
Return { written: true, bytes: <the number printed by wc> }.`,
    { label: label || "reliable-write", phase: "Review", model: "haiku" },
  )
  const bytes = Number(result?.bytes) || 0
  log(bytes > 0 ? `Wrote ${bytes} bytes → ${targetPath}` : `WARNING: write verification FAILED (0 bytes) → ${targetPath}`)
  return bytes
}

log(`Resolved: PROJECT_ROOT=${PROJECT_ROOT}`)
log(`  GUI_DIR: ${GUI_DIR}`)
log(`  HISTORY_DIR: ${HISTORY_DIR}`)

// Get timestamp for this run
const timestampResult = await spawnAgent(
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
  const resumeCheck = await spawnAgent(
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
      const priorLoad = await spawnAgent(
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

  // ── Incremental scope fallback (Bug 4) ─────────────────────────────────────
  // The resume-check / load-prior haiku agents above are nondeterministic: they
  // can return action:"fresh" or fail to extract result.git.headBefore, leaving
  // priorHistory empty → the Scan phase falls back to a FULL scan (expensive,
  // noisy: 126 files vs a handful). This scans the history dir directly for the
  // most-recent run that DID persist git.headBefore, sidestepping the agent
  // classification entirely.
  if (resumeMode !== "fresh" && !(priorHistory?.git?.headBefore || "").trim()) {
    const scopeFallback = await spawnAgent(
      `Find the most recent prior run that persisted a non-empty result.git.headBefore (used for incremental scoping).
1. Bash("ls -t '${HISTORY_DIR}'/*.json 2>/dev/null | grep -v reflection | head -5")
2. For each file (newest first), Bash("cat <file>") and check whether its "result.git.headBefore" field is a non-empty string.
3. Return the FIRST (newest) one that has it as: { found: true, runId: <the file's run_id>, headBefore: <the sha>, result: <the whole result object> }. If none of the 5 have it, return { found: false }.`,
      { label: "scope-fallback", phase: "Resolve", model: "haiku" },
    )
    if (scopeFallback?.found && scopeFallback.headBefore) {
      priorHistory = scopeFallback.result || priorHistory
      log(`Incremental scope: recovered headBefore ${scopeFallback.headBefore.slice(0, 8)} from prior run ${scopeFallback.runId} (history-scan fallback)`)
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
  const reflectLoad = await spawnAgent(
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

  // ── Deterministic incremental scope (Bug 4 real fix) ────────────────────────
  // The old approach embedded a `git diff` instruction in scanScope text and
  // HOPED the haiku scan agent would honor it — but the scan agent's step 1 was
  // a blanket `find`, so it scanned ALL files every run (runs never got cheaper;
  // this is the runtime-cost root cause). We now compute the changed-files list
  // UP FRONT via one direct bash agent (self-discovers prevHead from history +
  // runs the diff), then the scan agent inventories ONLY those. Empty list ⇒
  // graceful full-scan fallback (no worse than before).
  let incrementalFiles = []
  if (effort !== "high" && !targetFiles) {
    const scopeRes = await spawnAgent(
      `Determine the incremental scan scope. Run this Bash command VERBATIM (do not modify or split it):

Bash("cd '${PROJECT_ROOT}' && PREV=$(for f in $(ls -t '${HISTORY_DIR}'/*.json 2>/dev/null | grep -v reflection.json | head -10); do h=$(bun -e 'try{process.stdout.write(String(((require(process.argv[1]).result||{}).git||{}).headBefore||""))}catch(e){}' "$f" 2>/dev/null); if [ -n "$h" ]; then printf '%s' "$h"; break; fi; done); if [ -n "$PREV" ]; then echo PREV=$PREV; git diff --name-only $PREV -- 'bun/gui-movie-director/api/' 'bun/gui-movie-director/lib/' 'bun/gui-movie-director/server.ts' 'bun/gui-movie-director/frontend/' 2>/dev/null | sed 's|^bun/gui-movie-director/||' | grep -E '\\.(ts|tsx)$' | sort -u; else echo PREV=none; fi")

The output is either "PREV=none" (no prior run had a headBefore) OR a "PREV=<sha>" line followed by zero-or-more changed file paths (relative to ${GUI_DIR}).
Return { prevHead: <the sha string, or "">, changedFiles: <array of the changed file paths after the PREV= line; empty if PREV=none or no paths> }.`,
      { label: "scope-resolve", phase: "Scan", model: "haiku", schema: { type: "object", properties: { prevHead: { type: "string" }, changedFiles: { type: "array", items: { type: "string" } } }, required: ["prevHead", "changedFiles"] } },
    )
    incrementalFiles = (scopeRes?.changedFiles || []).filter((f) => f && !f.startsWith("PREV="))
    if (scopeRes?.prevHead) log(`Incremental scope: prevHead ${String(scopeRes.prevHead).slice(0, 8)} → ${incrementalFiles.length} changed file(s)`)
    if (incrementalFiles.length === 0) log(`Incremental scope: no changed files (first run / no prior headBefore / empty diff) — full scan`)
  }

  const wantFullScan = effort === "high" || (incrementalFiles.length === 0 && !targetFiles)
  const explicitList = targetFiles || (incrementalFiles.length > 0 ? incrementalFiles : null)

  const scanResult = await spawnAgent(
    `Inventory TypeScript source files in the Bun GUI Movie Director app.

${explicitList
  ? `Scan ONLY these specific files (relative to ${GUI_DIR}). Do NOT run a blanket find — inventory just the listed files:
${explicitList.map((f) => `- ${f}`).join("\n")}

For each listed file: Bash("wc -l '${GUI_DIR}/<file>'") for its line count. Skip any that don't exist on disk.`
  : `Deep-dive / first-run: scan ALL .ts and .tsx files under ${GUI_DIR}.
1. Run: Bash("find '${GUI_DIR}' -name '*.ts' -o -name '*.tsx' | grep -v node_modules | grep -v .playwright-cli | sort")
2. For each file found, get its line count: Bash("wc -l <file>")`}

Classify each file's layer by path:
- "server" for server.ts
- "api" for api/*.ts
- "lib" for lib/*.ts and lib/schemas/*.ts
- "frontend" for frontend/**/*.ts and frontend/**/*.tsx
Skip node_modules, .playwright-cli, and .d.ts files.

Return the file inventory as structured JSON.`,
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

// Build set of prior FIXED finding keys for incremental dedup. We suppress only
// findings actually applied-fixed last run — NOT every upheld finding — so
// upheld-but-unfixed findings (review-only runs, or ones deferred by the fix
// cap) keep resurfacing until fixed. Without this, a low-effort run's upheld
// findings would suppress a later medium run's fixes (low→medium would fix nothing).
const priorUpheldKeys = new Set()
let suppressedCount = 0
const priorFixedIds = new Set(
  (priorHistory?.fixes?.items || [])
    .filter((fx) => fx && fx.status === "applied" && fx.findingId)
    .map((fx) => fx.findingId),
)
if (priorHistory?.findings?.items) {
  priorHistory.findings.items.forEach((f) => {
    if (f.file && f.line && f.dimension && priorFixedIds.has(f.id)) {
      priorUpheldKeys.add(`${f.file}:${f.line}:${f.dimension}`)
    }
  })
  if (priorUpheldKeys.size > 0) {
    log(`Incremental: ${priorUpheldKeys.size} prior FIXED finding key(s) loaded for dedup (${priorFixedIds.size} fixed / ${priorHistory.findings.items.length} upheld last run)`)
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
    return spawnAgent(
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
  log(`Incremental: ${suppressedFromPrior.length} finding(s) suppressed (previously FIXED in prior run)`)
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

// ── Durable findings dump (interrupt-safe) ───────────────────────────────────
// Write RAW activeFindings NOW (right after Review), unconditionally — so a run
// killed during Adversarial/Checkpoint/Fix, OR a review-only (low-effort) run,
// still yields a consumable findings file. The final <RUN_ID>.json (Persist)
// holds the adversarially-verified set; this early dump is the safety net.
// reliableWrite (Write tool + verify + heredoc fallback) replaces the bare
// heredoc-via-haiku that nondeterministically failed to land the file (Bug 3).
{
  const dumpJson = JSON.stringify({ runId: RUN_ID, writtenAt: RUN_TIMESTAMP, phase: "post-review-raw", findingCount: activeFindings.length, findings: activeFindings })
  await reliableWrite(`${HISTORY_DIR}/${RUN_ID}.findings.json`, dumpJson, "dump-findings")
}

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

      return spawnAgent(
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

// (Findings dump moved earlier — right after Review, via reliableWrite. The
//  old post-verify dump used a bare heredoc-via-haiku that nondeterministically
//  failed to land the file; the early dump + the final <RUN_ID>.json cover it.)

// ══════════════════════════════════════════════════════════════════════════════
// Phase 4: Checkpoint — git stash backup before fixes
// ══════════════════════════════════════════════════════════════════════════════

let checkpointResult = { headSha: "", treeDirty: false, dirtyFiles: [] }
let fixResults = { fixes: [], filesChanged: [], testBaseline: null, testPostFix: null, tscDelta: null }
let reVerifyFindings = []   // repurposed: list of newly-failing tests (for history.regressions)
let restoreResult = { triggered: false, reason: null, reverted: [], skippedConcurrent: [], newFailures: [], method: "none" }

// Gate (Bug 1): fix ONLY when doFix AND effort allows (config.fix !== "skip").
// The old gate checked only `doFix`, so effort:"low" (config.fix="skip") still
// entered Checkpoint and stashed the user's WIP while applying zero fixes.
if (doFix && config.fix !== "skip" && verifiedFindings.length > 0) {
  phase("Checkpoint")

  // ── Dirty-tree check (Bug 2). NO git stash. ────────────────────────────────
  // The old checkpoint did `git stash push -- bun/gui-movie-director/`, stashing
  // whatever WIP was dirty, then only popped on a detected regression — stranding
  // the user's WIP forever on a clean/zero-fix run. We now REFUSE to touch a dirty
  // tree: if anything tracked-dirty is in scope, skip the entire fix phase + warn.
  // Untracked files (??) are excluded so scratch files don't trigger the refuse.
  checkpointResult = await spawnAgent(
    `Snapshot the working-tree state BEFORE deciding whether to apply fixes. Do NOT stash anything.
1. Bash("cd '${PROJECT_ROOT}' && git rev-parse HEAD")  → capture headSha.
2. Bash("cd '${PROJECT_ROOT}' && git status --short -- 'bun/gui-movie-director/' | grep -v '^??' || true")  → tracked-dirty files only (untracked '??' excluded). Capture the list.
3. treeDirty = (the step-2 list is non-empty). dirtyFiles = the list (file paths as printed, minus the 2-char status prefix).
Return { headSha, treeDirty, dirtyFiles }.`,
    { label: "checkpoint", phase: "Checkpoint", model: "haiku", schema: CHECKPOINT_SCHEMA },
  )

  if (checkpointResult?.treeDirty) {
    log(`WARNING: working tree is DIRTY in scope (bun/gui-movie-director/) — SKIPPING auto-fix to avoid stranding your work.`)
    log(`  Tracked-dirty file(s): ${(checkpointResult.dirtyFiles || []).join(", ")}`)
    log(`  To enable auto-fix: commit or stash these, then re-run with effort:medium. For review-only on a dirty tree, use effort:low.`)
    log(`  Findings dumped for manual triage: ${HISTORY_DIR}/${RUN_ID}.findings.json`)
    markPhase("checkpoint", "completed")
    markPhase("resolveFix", "skipped")
    markPhase("reVerify", "skipped")
    markPhase("restore", "skipped")
  } else {
    log(`Checkpoint: clean tree (HEAD=${(checkpointResult.headSha || "").slice(0, 8)}) — safe to apply fixes.`)
    markPhase("checkpoint", "completed")

    // ══════════════════════════════════════════════════════════════════════════════
    // Phase 5: Resolve Fix — apply verified fixes
    // ══════════════════════════════════════════════════════════════════════════════

    phase("Resolve Fix")

    // Determine which findings to fix based on effort config
    let findingsToFix = verifiedFindings
    if (config.fix === "high-critical") {
      findingsToFix = verifiedFindings.filter((f) => f.severity === "critical" || f.severity === "high")
    }

    // Cap fixes per run so the Resolve Fix phase can't balloon on a broad/first
    // scan (one agent per file, sequential). Defer the rest — they're captured in
    // the findings dump and remain fixable next run (dedup suppresses only FIXED
    // findings, not merely upheld, so deferred ones resurface).
    const MAX_FIXES = Number(resolvedArgs?.maxFixes) || 5
    if (findingsToFix.length > MAX_FIXES) {
      const sevRank = (s) => ({ critical: 0, high: 1, medium: 2, low: 3 }[s] ?? 9)
      findingsToFix.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || (b.line || 0) - (a.line || 0))
      const deferred = findingsToFix.slice(MAX_FIXES)
      findingsToFix = findingsToFix.slice(0, MAX_FIXES)
      log(`Fix cap (${MAX_FIXES}): applying top ${MAX_FIXES}, deferring ${deferred.length} (captured in findings dump; resurface next run)`)
      deferred.forEach((d) => log(`  deferred [${d.severity}] ${d.file}:${d.line || "?"} — ${d.title}`))
    }

    if (findingsToFix.length === 0) {
      log(`No findings to fix (${config.fix} filter removed all candidates).`)
    } else {
      // ── C: pre-fix test baseline (clean tree) ──────────────────────────────
      // Run the REAL test suite before and after fixes; revert if any previously-
      // green test goes red. Replaces the weak haiku-eyeball re-verify that
      // couldn't reliably catch type/logic regressions. tsc is advisory only.
      fixResults.testBaseline = await spawnAgent(
        `Run the GUI test suite to capture the PRE-fix baseline.
1. Bash("cd '${GUI_DIR}' && bun test 2>&1")
2. From the summary lines, capture passCount and failCount (e.g. "527 pass" / "0 fail").
3. Capture failingTests: every failed test, as "file::testname" (best-effort from the (fail) lines; empty array if none).
4. ranOk = true if bun ran at all (even with failures); false only if bun itself couldn't start.
Return { passCount, failCount, failingTests, ranOk }.`,
        { label: "test-baseline", phase: "Resolve Fix", model: "haiku", schema: TEST_RESULT_SCHEMA },
      )
      const tscBaselineRes = await spawnAgent(
        `Count TypeScript errors (advisory baseline — tsc has ~108 pre-existing errors on a green tree, so only the DELTA matters).
Bash("cd '${GUI_DIR}' && bunx tsc --noEmit 2>&1 | grep -c 'error TS' || echo 0")
Return { count: <the number> }.`,
        { label: "tsc-baseline", phase: "Resolve Fix", model: "haiku", schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } },
      )
      const tscBaselineCount = Number(tscBaselineRes?.count) || 0
      log(`Pre-fix baseline: bun test ${fixResults.testBaseline?.passCount ?? "?"} pass / ${fixResults.testBaseline?.failCount ?? "?"} fail; tsc ${tscBaselineCount} errors`)

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

          return spawnAgent(
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
      // Phase 6: Re-verify — REAL test suite delta gate (replaces haiku eyeball)
      // ══════════════════════════════════════════════════════════════════════════════

      if (fixResults.filesChanged.length > 0) {
        phase("Re-verify")

        fixResults.testPostFix = await spawnAgent(
          `Run the GUI test suite AFTER fixes to detect regressions.
1. Bash("cd '${GUI_DIR}' && bun test 2>&1")
2. Capture passCount and failCount from the summary.
3. Capture failingTests as "file::testname" for every failed test.
Return { passCount, failCount, failingTests, ranOk }.`,
          { label: "test-postfix", phase: "Re-verify", model: "haiku", schema: TEST_RESULT_SCHEMA },
        )

        // Delta = tests that passed pre-fix but fail post-fix (set difference,
        // NOT pass-count — correct the day the baseline has a known failure).
        const baseFail = new Set((fixResults.testBaseline?.failingTests || []).filter(Boolean))
        const postFail = new Set((fixResults.testPostFix?.failingTests || []).filter(Boolean))
        const newFailures = [...postFail].filter((t) => !baseFail.has(t))
        reVerifyFindings = newFailures   // history.regressions reads this length

        // tsc advisory (never a revert trigger on its own)
        const tscPostRes = await spawnAgent(
          `Count TypeScript errors after fixes (advisory).
Bash("cd '${GUI_DIR}' && bunx tsc --noEmit 2>&1 | grep -c 'error TS' || echo 0")
Return { count: <the number> }.`,
          { label: "tsc-postfix", phase: "Re-verify", model: "haiku", schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] } },
        )
        fixResults.tscDelta = (Number(tscPostRes?.count) || 0) - tscBaselineCount
        if (fixResults.tscDelta > 0) {
          log(`ADVISORY: tsc errors increased by ${fixResults.tscDelta} (${tscBaselineCount} → ${tscBaselineCount + fixResults.tscDelta}). Not auto-reverting (bun test is the hard gate) — review the type changes.`)
        }

        if (newFailures.length > 0) {
          log(`REGRESSION: ${newFailures.length} test(s) that passed pre-fix now FAIL — ${newFailures.join("; ")}`)
          log(`  post-fix ${fixResults.testPostFix?.passCount ?? "?"} pass / ${fixResults.testPostFix?.failCount ?? "?"} fail (baseline ${fixResults.testBaseline?.passCount ?? "?"} pass / ${fixResults.testBaseline?.failCount ?? "?"} fail)`)
        } else {
          log(`Re-verify: no new test failures ✓ (baseline ${fixResults.testBaseline?.passCount ?? "?"} pass → post ${fixResults.testPostFix?.passCount ?? "?"} pass)`)
        }
        markPhase("reVerify", "completed")

        // ══════════════════════════════════════════════════════════════════════════════
        // Phase 7: Restore — auto-revert on test regression (replaces stash-pop)
        // ══════════════════════════════════════════════════════════════════════════════

        if (newFailures.length > 0) {
          phase("Restore")
          log(`RESTORE: test regression — reverting fix changes via git checkout HEAD / rm (tree was clean at checkpoint).`)

          const revertRaw = await spawnAgent(
            `A fix introduced test regressions. Revert ONLY the fix changes — but NEVER clobber a file the user edited concurrently mid-run.
Files changed by fixes: ${JSON.stringify(fixResults.filesChanged)}

For EACH file in that list:
1. Bash("cd '${PROJECT_ROOT}' && git status --short -- 'bun/gui-movie-director/<file>' | grep -v '^??' || true")
   - If NON-empty (file is tracked-dirty — user edited it concurrently): do NOT revert. Add <file> to skippedConcurrent.
   - If empty (clean — safe to revert): revert it:
     a. Bash("cd '${PROJECT_ROOT}' && git ls-files --error-unmatch 'bun/gui-movie-director/<file>' >/dev/null 2>&1 && echo TRACKED || echo UNTRACKED")
        - TRACKED (existed at HEAD): Bash("cd '${PROJECT_ROOT}' && git checkout HEAD -- 'bun/gui-movie-director/<file>'")
        - UNTRACKED (created by the fix): Bash("cd '${PROJECT_ROOT}' && rm -f 'bun/gui-movie-director/<file>'")
     b. Add <file> to reverted.
After all files: Bash("cd '${PROJECT_ROOT}' && git status --short -- 'bun/gui-movie-director/'")
Return { reverted: [...], skippedConcurrent: [...], method: "checkout"|"rm"|"mixed"|"none" }.`,
            { label: "restore", phase: "Restore", model: "haiku", schema: RESTORE_SCHEMA },
          )

          restoreResult = {
            triggered: true,
            reason: "test-regression",
            reverted: revertRaw?.reverted || [],
            skippedConcurrent: revertRaw?.skippedConcurrent || [],
            newFailures,
            method: revertRaw?.method || "none",
          }
          if (restoreResult.reverted.length > 0) {
            log(`Restore: reverted ${restoreResult.reverted.length} file(s) via ${restoreResult.method}`)
          }
          if (restoreResult.skippedConcurrent.length > 0) {
            log(`WARNING: ${restoreResult.skippedConcurrent.length} file(s) were dirty mid-run (concurrent edit) — NOT reverted, manual review needed: ${restoreResult.skippedConcurrent.join(", ")}`)
          }
          markPhase("restore", restoreResult.reverted.length > 0 ? "completed" : "failed")
        } else {
          markPhase("restore", "skipped")
        }
      } else {
        markPhase("reVerify", "skipped")
        markPhase("restore", "skipped")
      }
    }

    markPhase("resolveFix", "completed")
  }
} else if (!doFix || config.fix === "skip") {
  log(`Review-only mode (doFix=${doFix}, effort=${effort} → config.fix="${config.fix}") — skipping Checkpoint, Resolve Fix, Re-verify, Restore.`)
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
          testBaseline: fixResults.testBaseline,
          testPostFix: fixResults.testPostFix,
          tscDelta: fixResults.tscDelta,
          items: fixResults.fixes,
        }
      : { mode: "review-only", applied: 0, skipped: 0, failed: 0, filesChanged: [], regressions: 0 },
    restore: restoreResult,
    git: {
      headBefore: checkpointResult?.headSha || "",
      treeDirty: checkpointResult?.treeDirty || false,
      dirtyFilesBefore: checkpointResult?.dirtyFiles || [],
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

const reflectResult = await spawnAgent(
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
  await spawnAgent(
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

const reportResult = await spawnAgent(
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
${restoreResult.triggered ? `- RESTORE triggered: ${restoreResult.reason}, ${restoreResult.reverted?.length || 0} file(s) reverted${restoreResult.skippedConcurrent?.length ? `, ${restoreResult.skippedConcurrent.length} left (concurrent edit)` : ""}` : ""}
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
  if (restoreResult.triggered) log(`RESTORE: ${restoreResult.reason} — ${restoreResult.reverted?.length || 0} file(s) reverted${restoreResult.skippedConcurrent?.length ? `, ${restoreResult.skippedConcurrent.length} left for manual review (concurrent edit)` : ""}`)
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
        testBaseline: fixResults.testBaseline,
        testPostFix: fixResults.testPostFix,
        tscDelta: fixResults.tscDelta,
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
