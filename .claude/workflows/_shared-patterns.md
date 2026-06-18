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
  const targetPath = `${histDir}/${runId}.json`
  // CRITICAL: the persist-history agent MUST carry the schema below. Without it,
  // agent() returns the subagent's summary as TEXT and `persist?.bytes` parses to
  // undefined -> Number(undefined)||0 = 0 -> the spurious "0 bytes FAILED" warning
  // every run. This doc block is the canonical source workflows copy from; keep
  // the schema in sync with `scripts/check-workflow-patterns.mjs` (which enforces
  // it). See memory: workflow-agent-schema-for-parsed-results.
  const persist = await agent(
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
    { label: "persist-history", phase: "Persist", model: "haiku",
      schema: { type: "object", properties: { written: { type: "boolean" }, bytes: { type: "number", description: "Byte count printed by wc -c" } }, required: ["bytes"] } },
  )
  const histBytes = Number(persist?.bytes) || 0
  if (histBytes > 0) {
    log(`History: written ${histBytes} bytes → ${targetPath}`)
  } else {
    log(`WARNING: history file verification FAILED (0 bytes) — run continues but trend/reflection will miss this run.`)
  }
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

## Workflow Knowledge (colocated, committed JSONL)

Each workflow owns a **distilled knowledge file** next to its `.js`:
`.claude/workflows/<meta.name>.knowledge.jsonl`. Unlike `history/` (gitignored,
pruned to 15 — ephemeral) or `knowledge-base/code/` (shared, Bun-only, coarse),
this file is **per-workflow, distilled from accumulated history, persistent, and
git-tracked** (`.gitignore` matches only `history/`, so a colocated `*.jsonl` is
automatically committable). It is loaded back at Resolve so each run learns from
prior distilled findings, and rewritten at Persist so each run graduates its own.

Keep it **CURATED and SMALL** (≤ ~40 active records) — this is NOT a run dump. Raw
per-run detail stays in the gitignored `history/`; this file holds durable lessons.

### Record schema (one JSON object per line)

```jsonc
{
  "schema_version": 1,
  "id": "<family>:<kebab-slug>",     // stable dedup / supersession key
  "type": "pattern | lever | avoid | gotcha | false_positive | metric",
  "title": "<headline>",
  "detail": "<what was learned, actionable, <=~160 chars>",
  "tags": ["security", "argparse", "..."],
  "dimension": "security",           // optional, review-family only
  "confidence": 0.9,                 // 0..1
  "status": "active | superseded | retired",
  "superseded_by": null,             // id of the replacing record, when superseded
  "evidence": { "run_ids": ["...8 newest"], "occurrences": 5,
                "first_seen": "<runId>", "last_seen": "<runId>" },
  "extracted_at": "<runId>"          // == RUN_ID, NEVER Date.now()
}
```

`type` by family: `pattern` (recurring bug class — review/lora), `lever` (adopted
tuning move — ltx/image), `avoid`/`gotcha` (dead-end/footgun — all),
`false_positive` (always-rejected finding → suppress in review), `metric` (durable
baseline/ceiling — ltx/image). `id` is what keeps the file small: an extractor greps
existing ids and bumps `occurrences` on match instead of appending; `status` lets us
mark stale records (append-only, never delete) while `loadKnowledge` filters them.

### `loadKnowledge` helper — copy this VERBATIM into every workflow

```javascript
// ── loadKnowledge — identical in every workflow; update _shared-patterns.md first ──
// Reads the colocated, committed <wf>.knowledge.jsonl and returns ACTIVE records as
// a compact digest to inject into this run (AVOID/GOTCHA are highest-value). Runs at
// Resolve, AFTER resume-check + reflection load — knowledge is the committed,
// cross-machine superset, injected FIRST so it wins on conflict with ephemeral
// reflection.json. kbFile: absolute path to .claude/workflows/<meta.name>.knowledge.jsonl
// CRITICAL: the load-knowledge agent MUST carry the schema below (same lesson as
// saveHistory: agent() without schema returns text). See memory:
// workflow-agent-schema-for-parsed-results.
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
```

### `extractKnowledge` helper — copy this VERBATIM into every workflow

```javascript
// ── extractKnowledge — identical in every workflow; update _shared-patterns.md first ──
// Distills THIS run's result + the existing knowledge file into an UPDATED file:
// append new records, bump occurrences/last_seen on id match, supersede stale ones,
// retire lowest-value when active records exceed MAX_ACTIVE. Runs at Persist, AFTER
// saveHistory. The file is JSONL (one JSON object/line), committed to git, shared
// across machines — keep it CURATED and SMALL (not a run dump; raw detail stays in
// the gitignored history/).
// kbFile: absolute path to .claude/workflows/<meta.name>.knowledge.jsonl
// runId: this run's RUN_ID (used for extracted_at / evidence.last_seen — NO Date.now())
// runResult: this run's result payload (workflow-specific), JSON.stringify-able
// runReflection: optional reflection object (review workflows); null otherwise
// MAX_ACTIVE: retire threshold (default 40)
// Record schema: see "Record schema" above. CRITICAL: the extract-knowledge agent
// MUST carry the schema below. See memory: workflow-agent-schema-for-parsed-results.
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
B. SUPERSEDE: if a prior record is contradicted by this run (a "lever" that now
   regresses, a "pattern" that no longer reproduces), set status="superseded" — do NOT delete.
C. COMPACT: if active records (status="active") exceed ${MAX_ACTIVE}, retire the
   lowest-confidence / lowest-occurrence ones to status="retired" until <= ${MAX_ACTIVE} active.
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
```

### Usage pattern

```javascript
// At top of script body, next to HISTORY_DIR:
const KB_FILE = `${PROJECT_ROOT}/.claude/workflows/${meta.name}.knowledge.jsonl`

// ... paste loadKnowledge + extractKnowledge functions here ...

// Resolve phase — AFTER resume-check + reflection load:
const knowledge = await loadKnowledge(KB_FILE)
// Thread knowledge.digest into this run's agents (review prompts, dead-ends,
// self-fix rules, etc.). Inject it FIRST so committed knowledge wins over reflection.

// Persist phase — AFTER `await saveHistory(...)`:
await extractKnowledge(KB_FILE, RUN_ID, historyEntry.result, /* reflection obj or */ null)
markPhase("persist", "completed")
```

### Seed / backfill (one-time)

A workflow with accumulated gitignored history can seed its knowledge file in one
shot via an optional arg `seedKnowledge` (default false). When true, Resolve reads
ALL `history/<wf>/*.json` (+ `reflection.json`) instead of just the prior run, passes
the aggregated findings as `runResult` to `extractKnowledge` (file is new → every
record is "new"), then the run EXITS after Persist. Seed candidates: any workflow
with a non-empty `history/<wf>/` dir.

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

// Gate — DIMENSION-AWARE, not overall-only. Each fix declares the dimension it targets
// (targetDimension: detail/composition/prompt_adherence/overall/...). The gate keeps a fix if
// it beats baseline on THAT dimension. An overall-only gate wrongly drops a targeted fix that
// lifts a weak dimension (clothing fidelity → detail 7→8) when overall stays flat (8 <= 8).
const SCORE_DIMS = ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"]
const baselineBest = {}
for (const d of SCORE_DIMS) baselineBest[d] = scoredOutputs.reduce((b, c) => Math.max(b, c[d] || 0), 0)
// per fix:
const dim = SCORE_DIMS.includes(spec.targetDimension) ? spec.targetDimension : "overall"
const baselineForGate = dim === "overall" ? bestScore : baselineBest[dim]
const passed = bestFixOnDim > baselineForGate   // strict >; ties dropped
```

Full pattern: see `mlx-movie-director-run-self-improve-image.js` Self-Fix phase (kind-aware: t2i rules vs i2i rules, dimension-aware score-gate for both kinds).

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

## Drift Guard (enforced)

The workflow runtime has **no `import`/`require`** — shared helpers are copy-pasted
into every workflow. A bug fixed in one silently persists in all siblings until
someone remembers to sweep them (the `saveHistory` 0-bytes bug existed in 8 files
before a manual sweep). The guard below is the enforcement.

### `scripts/check-workflow-patterns.mjs`

Run after any workflow edit, ideally alongside `bun run check:schema`:

```bash
node scripts/check-workflow-patterns.mjs
```

**Hard rules (exit 1):**
1. `meta.name` must equal the filename without `.js` (drift here breaks history
   routing + the dashboard `--workflow` filter).
2. Any `persist-history` agent whose return value is **consumed** (assigned to a
   variable) **must** carry a `schema:`. A schema-less consumed return gives the
   0-bytes bug (text return → `.bytes` = `undefined` → `0`). A *discarded* return
   (bare `await agent(...)`, pure side-effect write) may legitimately be
   schema-less and is reported as `~ discarded ok`, not failed.

**Soft report (never fails, surfaces drift for review):**
- Persists-history schema grouped by normalized text. A group of size 1 is flagged
  `⚠ UNIQUE — verify intentional`. Two accepted variants exist (both bug-free):
  - **Canonical** `{written:boolean, bytes:number, required:["bytes"]}` — the
    8 generation/assistant/review workflows that byte-verify the write.
  - **Minimal** `{written:boolean, required:["written"]}` — `schema-self-improve`
    + `coverage-self-improve`, which verify via `test -s … && echo OK` and only
    gate on `.written`. Do not "unify" these by force; they verify differently.
- Helper coverage matrix: which workflows define `saveHistory` / `markPhase` /
  `reliableWrite`. Absence is reported, not enforced — `schema-self-improve` and
  `coverage-self-improve` inline their persist logic without the shared helpers.

### Coverage (as of 2026-06-18, verified by the checker)

| Workflow | saveHistory | markPhase | reliableWrite | persist schema |
|---|:---:|:---:|:---:|---|
| gui-movie-director-review-optimize | ✓ | ✓ | ✓ | canonical |
| gui-movie-director-self-improve | ✓ | ✓ | — | discarded (no schema) |
| gui-movie-director-schema-self-improve | — | — | — | minimal |
| mlx-movie-director-coverage-self-improve | — | — | — | minimal |
| mlx-movie-director-lora-review-flux2-klein | ✓ | ✓ | — | canonical |
| mlx-movie-director-lora-review-zimage-turbo | ✓ | ✓ | — | canonical |
| mlx-movie-director-ltx-self-improve | ✓ | — | — | canonical |
| mlx-movie-director-models-assistant | ✓ | ✓ | — | canonical |
| mlx-movie-director-review-optimize | ✓ | ✓ | — | canonical |
| mlx-movie-director-run-self-improve-image | ✓ | ✓ | ✓ | canonical |
| mlx-movie-director-video-assistant | ✓ | ✓ | — | canonical |

Known gaps (refine candidates, not bugs): `ltx-self-improve` lacks `markPhase`
(does not track phase status); most generation workflows lack `reliableWrite`
(only the two review-optimize + run-self-improve have it).

### Colocated knowledge coverage (`loadKnowledge` / `extractKnowledge`)

Eight workflows own a committed `.claude/workflows/<wf>.knowledge.jsonl`, distilled
from their accumulated history and loaded back each run (see **Workflow Knowledge**
above). The checker's `═══ knowledge snippet coverage ═══` section reports these
flags per workflow (soft — absence is reported, not enforced):

- **Ported (load ✓ / extract ✓):** `gui-movie-director-review-optimize`,
  `mlx-movie-director-review-optimize`, `mlx-movie-director-ltx-self-improve`
  (its `Knowledge` phase was refactored to call `extractKnowledge` — the old
  `~/.claude-glm` memory-file write path never landed), `mlx-movie-director-run-self-improve-image`,
  `gui-movie-director-self-improve`, `mlx-movie-director-lora-review-flux2-klein`,
  `mlx-movie-director-lora-review-zimage-turbo`, `gui-movie-director-ux-self-improve`.
- **Deferred (recipe only):** `mlx-movie-director-models-assistant`,
  `mlx-movie-director-video-assistant` (light `gotcha` extract later);
  `gui-movie-director-schema-self-improve`, `mlx-movie-director-coverage-self-improve`
  (no `saveHistory` — minimal `loadKnowledge`-only variant later).

### When you fix a shared pattern — port checklist

1. Edit the canonical copy **here in `_shared-patterns.md` first** (this file is
   the contract; every workflow header says "mirrors _shared-patterns.md verbatim").
2. Propagate to siblings: `grep -rln '<pattern>' .claude/workflows/*.js`.
3. Run `node scripts/check-workflow-patterns.mjs` — it must exit 0.
4. The whole-workflow-merge temptation is a dead end: both candidate pairs
   (lora-review flux2-klein↔zimage-turbo; mlx↔gui review-optimize) were vetted and
   rejected — they share ~30% and differ at the generation/test layer. The `kind`
   dimension merge (t2i+i2i) worked only because both used the same `run.py`
   command shape. Do not re-attempt a merge without that precondition.

## History Dashboard

After runs are persisted, use the dashboard to analyze trends:

```bash
ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py
ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py --workflow mlx-movie-director-review-optimize
ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py --json  # machine-readable output
```
