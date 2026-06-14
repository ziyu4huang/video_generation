# Shared Workflow Patterns

Reference for workflow authors. These patterns are copy-pasted into each workflow — the sandboxed JS environment has no `import`/`require`.

## Phase Tracking

Every workflow must track phase status for the Persist phase and resume capability.

```javascript
const phaseStatus = {
  resolve: "pending",
  // ... one entry per phase ...
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
```

Usage — wrap each phase:
```javascript
phase("MyPhase")
try {
  // ... phase logic ...
  markPhase("myPhase", "completed")
} catch (e) {
  log(`MyPhase failed: ${e?.message || e}`)
  markPhase("myPhase", "failed")
}
```

## History Persist

Standard envelope written to `.claude/workflows/history/<meta.name>/<timestamp>.json`.

### `saveHistory` helper — copy this VERBATIM into every workflow

```javascript
// ── saveHistory — identical in every workflow; update _shared-patterns.md first ──
// entry: standard envelope (schema_version, run_id, workflow, started_at, args,
//        phases_completed, phases_failed, status, tags, result)
// signals: { run_quality, key_metric, delta_from_last, highlights, warnings }
//   → merged into the saved JSON via spread (readable from the history file)
// histDir: absolute path to .claude/workflows/history/<workflow-name>/
// indexFile: absolute path to .claude/workflows/history/_index.json
// grep -v reflection: protects reflection.json from being pruned (lives in same dir)
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
```

### Usage pattern

```javascript
// At top of script body (after PROJECT_ROOT):
const HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${meta.name}`
const INDEX_FILE  = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`

// ... paste saveHistory function here ...

// Persist phase — BEFORE Report:
phase("Persist")

const signals = {
  run_quality: phasesFailed.length === 0 ? "good" : "degraded",
  key_metric: /* workflow-specific scalar */,
  delta_from_last: null,
  highlights: [ /* 2-3 short strings */ ],
  warnings: [ /* optional */ ],
}

const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: meta.name,
  started_at: RUN_TIMESTAMP,
  args: { /* workflow-specific */ },
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  tags: [ /* workflow-specific */ ],
  result: { /* workflow-specific payload */ },
  // NOTE: do NOT add signals here — saveHistory merges it via spread
}

await saveHistory(HISTORY_DIR, INDEX_FILE, historyEntry, signals)
log(`History: ${HISTORY_DIR}/${RUN_ID}.json`)
markPhase("persist", "completed")
```

### Resume Check (optional — for long-running workflows)

Add to the Resolve phase to support resuming interrupted runs:

```javascript
// Requires RESUME_CHECK_SCHEMA
const RESUME_CHECK_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["fresh", "resume", "compare"] },
    previousRunId: { type: "string" },
    resumeFromPhase: { type: "string" },
    reason: { type: "string" },
  },
  required: ["action"],
}

const resumeCheck = await agent(
  `Check for a previous run history file for the workflow "${WORKFLOW_NAME}".
  Steps:
  1. Bash("mkdir -p '${HISTORY_DIR}'")
  2. Bash("ls -t '${HISTORY_DIR}'/*.json 2>/dev/null | head -1")
  3. If a file path was returned, read it: Bash("cat '<path>'")
  4. Check status, phases_completed, args match.
  Decide: fresh / resume / compare.`,
  { label: "resume-check", phase: "Resolve", model: "haiku", schema: RESUME_CHECK_SCHEMA },
)
```

## Self-Fix (Score-Based)

For generation workflows that produce images scored by VLM. Triggered when best score < threshold.

```javascript
// Trigger condition:
const bestScore = scoredOutputs.reduce((b, c) => Math.max(b, c.overall || 0), 0)
if (bestScore < autoFixThreshold) { /* enter self-fix */ }

// Fix rules — map low-scoring dimensions to parameter changes:
// - detail < 5 → +5 steps
// - sharpness < 5 → denoise_strength − 0.1
// - artifacts < 5 → ctrl_strength − 0.2
// - composition < 5 → different seed
// - overall low → combine lower denoise + different seed
```

Full pattern: see `mlx-movie-director-run-self-improve-image.js` Self-Fix phase (kind-aware: t2i rules vs i2i rules, score-gated for both).

## Adversarial Verify (Code Review Only)

For code-review workflows. Skeptical agents try to refute findings.

```javascript
// After Review phase, spawn N skeptical agents:
const verifiedFindings = await parallel(
  allFindings.map(f => () =>
    agent(`Adversarially verify this finding. Try to REFUTE it.
Finding: ${JSON.stringify(f)}
Read the actual file and check line accuracy. Default to refuted=true if uncertain.`,
      { label: `verify-${f.file}`, phase: "Adversarial Verify", model: "sonnet", schema: VERIFY_SCHEMA }
    )
  )
)
// Filter to upheld findings only
const upheld = verifiedFindings.filter(v => v.upheld)
```

Full pattern: see `mlx-movie-director-review-optimize.js`.

## Schema Conventions

All structured outputs use JSON Schema objects:

```javascript
// Pattern: define schema as plain objects, pass to agent() via schema option
const MY_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "error"] },
    data: { type: "array", items: { type: "object" } },
  },
  required: ["status"],
}
const result = await agent("...", { schema: MY_SCHEMA })
```

Common schemas across workflows:
- `PATH_SCHEMA` — `{ projectRoot: string }`
- `TIMESTAMP_SCHEMA` — `{ timestamp: string }`
- `RESUME_CHECK_SCHEMA` — `{ action, previousRunId, resumeFromPhase, reason }`
- `GEN_SCHEMA` — `{ status, outputPngs, error }`
- `CAPTION_SCHEMA` — `{ overall, detail, sharpness, composition, artifacts, prompt_adherence, summary, error }`

## Timestamp / Run ID

```javascript
const RUN_TIMESTAMP = await agent(
  `Return the current timestamp in ISO format with colons replaced by dashes for filename safety.
  Run: Bash("date -u +%Y-%m-%dT%H-%M-%S")
  Return { timestamp: "<the output>" }.`,
  { label: "timestamp", phase: "Resolve", model: "haiku", schema: { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] } },
)
const RUN_ID = RUN_TIMESTAMP?.timestamp || "unknown"
```

## History Dashboard

After runs are persisted, use the dashboard to analyze trends:

```bash
ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py
ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py --workflow mlx-movie-director-review-optimize
ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py --json  # machine-readable output
```
