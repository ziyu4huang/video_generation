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

### `loadGraphKnowledge` helper — cross-workflow retrieval (the READ side)

`loadKnowledge` loads a workflow's OWN knowledge. `loadGraphKnowledge` loads
CROSS-WORKFLOW knowledge from the shared graph — cards OTHER workflows
published that share tags with this workflow's tag space but are NOT in this
workflow's own `.knowledge.jsonl`. This closes the read/write loop:
publishKnowledge WRITES this workflow's cards to the graph;
loadGraphKnowledge READS other workflows' cards back.

**Default-on (opt-out).** Set `PI_GRAPH_KNOWLEDGE=0` to disable. Best-effort,
non-fatal — a missing vault or a failed query is logged and skipped. The vault
path is `PI_VAULT_PATH` or defaults to
`${PROJECT_ROOT}/vaults_root/pi-agent-vault`.

Shells out to the deterministic `zk-query` CLI (see
`bun-apps/pi-knowledge-card/src/retrieve.ts`): `--tags <graphTags>`
`--exclude-from-kb <kbFile>` (excludes the caller's own active ids). Returns
`{ count, digest, published }` for the run receipt.

```javascript
// ── loadGraphKnowledge — identical in every workflow; update _shared-patterns.md first ──
// Retrieves CROSS-WORKFLOW knowledge cards from the shared graph (the READ side).
// Default-on (PI_GRAPH_KNOWLEDGE=0 kills it); best-effort (never throws).
// graphTags: array of tag strings defining this workflow's retrieval tag space.
async function loadGraphKnowledge(kbFile, graphTags, workflowName) {
  if (!graphTags || graphTags.length === 0) return { count: 0, digest: "", published: false, reason: "no-tags" }
  const vault = `${PROJECT_ROOT}/vaults_root/pi-agent-vault`
  const tagsCsv = graphTags.join(",")
  const q = await agent(
    `Check PI_GRAPH_KNOWLEDGE env var, then run cross-workflow retrieval if enabled.
1. Bash("printenv PI_GRAPH_KNOWLEDGE || echo 1")
   If "0", return { count: 0, digest: "", published: false, reason: "opt-out" }.
2. Bash("OB_VAULT_PATH='${vault}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-query --tags '${tagsCsv}' --exclude-from-kb '${kbFile}' --top-k 8 2>&1 | tail -40")
3. Extract the "matched: N" count from the stderr status line.
4. Capture the digest body.
Return { count: <N or 0>, digest: <digest body or "">, published: true }.`,
    { label: "load-graph-knowledge", phase: "Resolve", model: "haiku",
      schema: { type: "object", properties: {
        count: { type: "number", description: "Number of cross-workflow cards matched" },
        digest: { type: "string", description: "The grouped digest body from the query" },
        published: { type: "boolean" },
      }, required: ["count"] } },
  )
  const c = q?.count ?? 0
  if (c > 0) log(`Graph: retrieved ${c} cross-workflow card(s) from shared graph ← tags [${tagsCsv}]`)
  else log(`Graph: no cross-workflow cards matched (or graph disabled) ← tags [${tagsCsv}]`)
  return q ?? { count: 0, digest: "", published: false }
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
// Default-on: converge the just-written records into the shared knowledge graph.
// PI_PUBLISH_KNOWLEDGE=0 kills it (e.g. for a clean-tree fix-lane run). See below.
await publishKnowledge(KB_FILE, meta.name)
markPhase("persist", "completed")
```

### `publishKnowledge` helper — the loop that LEARNS also PUBLISHES

`extractKnowledge` writes a per-workflow `.knowledge.jsonl`. Without a publish
step, that knowledge is trapped: it reloads into the NEXT run of the SAME
workflow, but a different workflow (or a human querying the vault) never sees
it. `publishKnowledge` is the wire that closes that gap — it shells out to the
deterministic `zk-ingest` CLI (see `bun-apps/pi-knowledge-card/src/ingest.ts`),
converging the records into the SHARED vault as zettel cards, dedup'd by id,
cross-linked by tag, indexed by a MOC. The graph then spans every workflow.

**Default-on (opt-out).** Publishing is ON by default — every run converges its
knowledge into the shared graph so other workflows can read it. Set
`PI_PUBLISH_KNOWLEDGE=0` to disable (e.g. for a clean-tree fix-lane run where
the vault submodule bump would dirty the tree). The vault path is
`PI_VAULT_PATH` or defaults to `${PROJECT_ROOT}/vaults_root/pi-agent-vault`
(the repo submodule convention).

**Best-effort, never fatal.** A missing vault, a failed ingest, or a missing
CLI is logged as a warning and the run continues — publishing is a projection
over the canonical `.knowledge.jsonl`, never a critical path.

```javascript
// ── publishKnowledge — identical in every workflow; update _shared-patterns.md first ──
// Converges kbFile's records into the shared knowledge-graph vault via zk-ingest.
// Default-on (PI_PUBLISH_KNOWLEDGE=0 kills it); best-effort (never throws, never fails the run).
async function publishKnowledge(kbFile, workflowName) {
  const vault = `${PROJECT_ROOT}/vaults_root/pi-agent-vault`
  const sourceLabel = `workflow-jsonl:${workflowName}`
  // Resolve the pi-agent-cli entry. Prefer the built dist binary when present
  // (production), fall back to the workspace source (dev) — both accept the
  // same zk-ingest subcommand.
  const cli = await agent(
    `Check PI_PUBLISH_KNOWLEDGE env var, then run the ingest CLI if enabled.
1. Bash("printenv PI_PUBLISH_KNOWLEDGE || echo 1")
   If "0", return { published: false, reason: "opt-out" }.
2. Bash("OB_VAULT_PATH='${vault}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-ingest '${kbFile}' --source-label '${sourceLabel}' 2>&1 | tail -20")
3. Report { published: <true iff output contains "created" or "unchanged" or "updated" with no "Error">, summary: <the tail output> }.`,
    { label: "publish-knowledge", phase: "Persist", model: "sonnet",
      schema: { type: "object", properties: {
        published: { type: "boolean" },
        summary: { type: "string" },
      }, required: ["published"] } },
  )
  if (cli?.published) log(`Knowledge: published → ${vault} (zk-ingest)`)
  else log(`WARNING: knowledge publish skipped/failed — run continues. ${(cli?.summary || "").slice(0, 160)}`)
  return cli
}
```

### Generation workflows: publish-only (parked read-side) — WHY

The image/video generation self-improve loops (mlx-image, mlx-ltx, gui-*, flux2)
got `publishKnowledge` (WRITE side) but NOT `loadGraphKnowledge` (READ side).
This is deliberate, verified by a live retrieval test (2026-07-04):

- **The tag overlap is noise, not signal.** Generation tags (`cfg`, `lever`,
  `seed`, `steps`, `prompt-adherence`, `cfg_scale`, `lora`, `tradeoff`)
  cross with the code-health graph on the WRONG axis — they match argparse
  gotchas (seed default drift, lora list-vs-scalar) rather than content-tuning
  wins (cfg ceilings, denoise strengths, STG tradeoffs). Injecting those at
  Resolve would add noise, not signal.
- **The right cross-workflow edges for generation loops are BETWEEN each other**
  (image↔ltx sharing cfg/lever/metric knowledge), not with the code-health
  graph. That requires content-aware tag routing that doesn't exist yet.
- **Decision: PARK.** Generation loops are publish-only until a content-aware
  tag router exists. Code-health loops (pi-infra, flux2) DO read the graph
  because their tag space (argv, argparse, path-validation, schema-consistency)
  genuinely overlaps.

To unpark: add `loadGraphKnowledge` with generation-content tags
(`metric`, `lever`, `ceiling`, `cfg`, `denoise`) AFTER verifying the retrieval
  produces signal (cards from OTHER generation workflows, not code-health).

### Knowledge lifecycle — prune stale-active records (detect-only, every run)

The 12-key schema carries a lifecycle (`status: active|superseded|retired`,
`evidence.{occurrences,last_seen}`) that was **write-only**: `extractKnowledge`
supersedes on contradiction and retires on cap-overflow (`MAX_ACTIVE`) but **never
on code-deletion** — so records about deleted/renamed source files linger as `active`,
polluting `loadKnowledge` injections and crowding the cap during active development.
`pruneKnowledge(kbFile, runId)` surfaces them every Persist **right after
`extractKnowledge`**. Sonnet: Bash `cat` → filter active → extract literal SOURCE path
tokens → `test -e` → collect candidates. **DETECT-ONLY — it never writes/retires.**

- **Why detect-only:** an earlier auto-retire variant let a free-form agent extract
  paths; it mis-tokenized a `.jsonl` log path (read `iterations.jsonl` as `iterations.js`)
  and **retired a high-value occ-17 record** whose only "staleness" was a moved log path
  (knowledge still valid). Free-form agent path extraction is not trustworthy enough for a
  destructive auto-retire, so v1 reports candidates and the operator manually retires
  confirmed-stale records in `KB_FILE`.
- **Source-only extraction:** tokens must match `(frontend|api|lib|scripts|python|bun)/…
  .{ts,tsx,py}` (strip `:line`). EXCLUDE data/log/config (`.jsonl/.json/.md/.log`,
  `history/`, `records`, `iterations`, `manifest`, `knowledge-base/`, `models/`) — their
  absence does not imply the knowledge is stale. A record with no source token is KEPT.
- **Candidate rule:** active record with **≥1 source token AND every token absent**
  (`test -e` under `<PROJECT_ROOT>/bun-apps/gui-movie-director/<path>` OR `<PROJECT_ROOT>/<path>`).
  Any PRESENT token → KEPT. `test -e`, not judgment.
- **Scoped:** the workflow's own `KB_FILE` only. Non-fatal. Surface `prune.candidates`
  in the report + a `nextStep` note so the operator reviews.

```javascript
// Paste pruneKnowledge after extractKnowledge (identical-in-every-workflow).

// Persist — AFTER extractKnowledge, non-fatal:
let pruneResult = null
try { pruneResult = await pruneKnowledge(KB_FILE, RUN_ID) }
catch (e) { log(`prune-knowledge failed (non-fatal): ${e?.message || e}`) }
// Report: prune: { scanned, candidates:[{id, reason}] } + a nextStep note (detect-only).
```

### Operation-lessons (curated, injected) + self-learning propose step

Beside the distilled `.knowledge.jsonl`, a workflow may own an **operation-lessons**
store `<wf>.operation-lessons.jsonl` — high-trust rules about HOW this workflow
operates (its fix/restore/review/report posture), hand-curated from post-mortems.
One JSON object per line: `{id, phase ∈ fix|restore|review|report, severity ∈
hard|soft, rule, why, source}`.

- **`loadOperationLessons(opFile)` + `operationRulesBlock(byPhase, phase)`** — copy
  VERBATIM (as with the knowledge helpers). Loaded at Resolve; the block is injected
  into the matching phase's agent prompt so operating posture persists across runs
  independent of any operator's project-memory. Empty file → empty block (no-op).
- The orchestrator injects its OWN store into its inlined fix agents; a review child
  injects ITS store into the child's fix/restore/report agents. Two fix contexts →
  two (possibly overlapping) stores.

**Self-learning (propose → human-gate).** The single structural gap this closes: a
run's failures (regression+restore, adversarial-verify-upheld-but-fabricated, recurring
runtime-error pattern) used to teach nothing automatically — every operation-lesson was
hand-written post-mortem (mlx iter-8's `fix-relocate-call-relocate-import` is the
canonical example). `proposeOperationLessons(inboxFile, opFile, runId, runResult)`
(sonnet, modeled on `extractKnowledge`: gather existing ids → extract ≤2 candidates
each citing a CONCRETE signal from this run → dedup in JS → append + jq-validate) writes
candidates to a **staging inbox** `<wf>.operation-lessons.proposed.jsonl` (gitignored),
**never** the approved store.

```javascript
// Paths (let — Resolve reassigns once PROJECT_ROOT is known):
let OP_FILE  = `${PROJECT_ROOT}/.claude/workflows/${meta.name}.operation-lessons.jsonl`
let OP_INBOX = `${PROJECT_ROOT}/.claude/workflows/${meta.name}.operation-lessons.proposed.jsonl`

// Resolve — load the APPROVED store only (the inbox is NEVER loaded/injected):
const operationLessons = await loadOperationLessons(OP_FILE)
const opFixBlock = operationRulesBlock(operationLessons?.byPhase || {}, "fix")
// ... interpolate ${opFixBlock} into the inlined fix-agent prompts ...

// Persist — AFTER extractKnowledge, non-fatal:
let proposedLessons = []
try { proposedLessons = await proposeOperationLessons(OP_INBOX, OP_FILE, RUN_ID, historyEntry.result) }
catch (e) { log(`propose-lessons failed (non-fatal): ${e?.message || e}`) }
// Auto-refresh MANIFEST.md (generator resolves paths from its own __dirname):
try { /* agent runs: node '<PROJECT_ROOT>/scripts/workflow-knowledge-manifest.mjs' */ }
catch (e) { log(`manifest refresh failed (non-fatal): ${e?.message || e}`) }
```

**Trust invariant (do not violate):** the approved store is 100% human-curated. The
propose step ONLY writes the gitignored inbox; `loadOperationLessons` ONLY reads the
approved store; an unapproved lesson is therefore NEVER injected into a fix prompt. A
human reviews the inbox and copy-promotes winners into the matching `*.operation-lessons.jsonl`
(promoting `severity` to `hard` where warranted). Surface `proposedLessons` + the inbox
path in the report so the operator knows to review.

### Seed / backfill (one-time)

A workflow with accumulated gitignored history can seed its knowledge file in one
shot via an optional arg `seedKnowledge` (default false). When true, Resolve reads
ALL `history/<wf>/*.json` (+ `reflection.json`) instead of just the prior run, passes
the aggregated findings as `runResult` to `extractKnowledge` (file is new → every
record is "new"), then the run EXITS after Persist. Seed candidates: any workflow
with a non-empty `history/<wf>/` dir.

## KB manifest (self-explaining JSONL)

Every knowledge JSONL in this repo — both `.claude/workflows/<wf>.knowledge.jsonl`
(distilled workflow knowledge) and `python/.../models/**/kb.jsonl` (per-model
experiment logs) — is **opaque to a cold reader**: a new agent has to grep + infer
what the file is, its schema, and its version, and still misses things (one agent
missed the `kb_version` field entirely and under-reported half the provenance
fields). The fix is a **sibling manifest** that declares all of that up front.

### Naming + scope

- A knowledge file `<stem>.jsonl` is described by a sibling **`<stem>.manifest.json`**
  (replace the trailing `.jsonl` with `.manifest.json`). So `kb.jsonl` →
  `kb.manifest.json`; `gui-…review-optimize.knowledge.jsonl` →
  `gui-…review-optimize.knowledge.manifest.json`.
- The manifest is a **dataset card**, NOT data: it stays small and human/machine-
  readable. The JSONL stays pure data (every line = one record; jq / `loadKnowledge`
  / the generator / the dashboard never special-case a "header line" — a header
  record inside the JSONL was rejected for breaking that invariant).
- The 12 workflow manifests are **generated** by `scripts/kb-manifest-gen.mjs` from
  the shared record schema below (edit the template there → re-run; do not hand-edit).
  A per-model `kb.manifest.json` is **hand-maintained** next to its experiment log.

### Manifest schema (the contract)

```jsonc
{
  "manifest_version": 1,                 // MANIFEST shape version (bump if this object's shape changes)
  "file": "<stem>.jsonl",                // the JSONL this describes (basename)
  "kind": "workflow-knowledge | per-model-experiment",
  "purpose": "<one line: what this file IS>",
  "record_version_field": "schema_version", // the per-record version key (migration key)
  "record_version": 1,
  "produced_by": "<what writes it>",
  "consumed_by": "<what reads it>",
  "record_schema": [                      // ONE entry per top-level record key
    { "name": "schema_version", "type": "int",    "desc": "record schema version (migration key)" },
    { "name": "id",             "type": "string", "desc": "…" },
    …
  ],
  "enums":   { "type": ["pattern","lever","avoid","gotcha","false_positive","metric"] },
  "findings": "<pre-distilled conclusion so a cold reader gets the answer immediately>",
  "see_also": ["_shared-patterns.md#workflow-knowledge", "[[memory-link]]"],
  "notes": "<caveats, e.g. how this differs from the other kb.jsonl kind>"
}
```

- **`record_version_field` + `record_version`** make the per-record version
  discoverable and consumable — the foundation for future schema migrations
  (an upgrader reads the version to know how to rewrite). `schema_version` is the
  canonical field name going forward; legacy files may use `kb_version` (declared
  here so consumers know).
- **`findings`** is the high-value field for experiment logs: it pre-distills the
  conclusion so a cold agent doesn't have to re-derive it. For workflow-knowledge
  files the records ARE the findings, so `findings` just points at the active records.

### Enforcement (HARD rule in `check-workflow-patterns.mjs`)

The checker's `═══ kb.jsonl manifest + schema drift ═══` section enforces, per
knowledge JSONL (exit 1 on violation):

1. **sibling manifest exists** (`<stem>.manifest.json`), and is valid JSON with
   `record_schema`;
2. **no schema drift** — every top-level key that appears in the data must be
   declared in `record_schema[].name`. A key present in the data but absent from
   the manifest means the manifest no longer explains the file (the exact miss this
   rule prevents). Extra declared keys (optional fields absent from some records)
   are fine.

So: change a record's fields → update the manifest (or the generator template) →
the checker forces them to agree.

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

## Self-Fix (Code-Review-Based) — the review→fix loop

For **code-review** workflows (unlike the score-based self-fix above, which is for
VLM-scored image generation). Closes the loop that review-only workflows leave
open: each adversarially-upheld finding → propose a minimal patch → apply →
re-run the contract gate → adversarially re-verify the finding is actually closed.
First shipped in `pi-infra-self-improve.js`.

**Hard guarantees** (port ALL of them — a half implementation is worse than none):
- **opt-in** — only runs when `args.fix === true`. Default off.
- **dirty-tree-refuse** — `git status --porcelain --ignore-submodules=dirty` must be
  empty (after filtering out the workflow's own knowledge artifacts: `*.knowledge.jsonl`,
  `_shared-patterns.md`, `.claude/workflows/history/`) before applying ANY patch.
  A dirty SOURCE tree means WIP the lane could corrupt; refuse and log, never apply.
  Submodule-dirty (the vault bumped by default-on `publishKnowledge`) and knowledge
  artifacts are NOT source WIP — they're excluded so the fix lane doesn't collide
  with the knowledge loop. Set `PI_PUBLISH_KNOWLEDGE=0` to skip the vault bump
  entirely if you need a truly clean tree.
- **dryRun-capable** — `args.dryRun === true` proposes patches and returns them
  WITHOUT applying. Lets you preview before committing.
- **never pushes** — the apply path commits to the CURRENT local branch only
  (`git commit` on `HEAD`). Pushing is a human action; the lane never runs
  `git push`, so it can never reach `main` directly. Run the workflow on a feature
  branch (the repo SOP already mandates main-via-PR).

```javascript
// ── Self-Fix (Code-Review-Based) helper — copy VERBATIM into every code-review workflow ──

const FIX_PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string", description: "repo-relative path" },
    oldString: { type: "string", description: "exact text to replace; MUST be unique in the file (Edit tool contract)" },
    newString: { type: "string", description: "the replacement" },
    rationale: { type: "string", description: "why this closes the finding's failure_scenario" },
    confidence: { type: "number", description: "0..1" },
  },
  required: ["file", "oldString", "newString", "rationale"],
}
const FIX_DIRTY_SCHEMA = {
  type: "object",
  properties: { dirty: { type: "boolean" }, output: { type: "string" } },
  required: ["dirty"],
}
const FIX_APPLY_SCHEMA = {
  type: "object",
  properties: { applied: { type: "boolean" }, detail: { type: "string" } },
  required: ["applied"],
}

// `contractCmd`: the Bash string that re-runs the workflow's deterministic gate
// (e.g. the bun-test / build command the contract lane uses). Findings MUST come
// from the review lane's adversarially-upheld set, not raw findings.
async function runFixLane({ findings, projectRoot, contractCmd, dryRun }) {
  // 1. refuse on dirty tree — never collide with WIP
  const dirty = await agent(
    `Bash("git -C '${projectRoot}' status --porcelain --ignore-submodules=dirty") and return whether the output is non-empty.
Also filter OUT lines matching: vaults_root/, .knowledge.jsonl, _shared-patterns.md, .claude/workflows/history/. Report dirty=true iff ANY other line remains.`,
    { label: "fix:dirty-check", phase: "Self-Fix", model: "haiku", schema: FIX_DIRTY_SCHEMA },
  )
  if (dirty?.dirty) {
    log(`Self-Fix: SKIPPED — dirty tree (fix lane refuses to avoid corrupting WIP). Stash or commit first. TIP: set PI_PUBLISH_KNOWLEDGE=0 to avoid vault-submodule dirt.`)
    return { skipped: true, reason: "dirty tree", porcelain: dirty.output }
  }

  if (!findings?.length) {
    log(`Self-Fix: no upheld findings to fix — lane is a no-op.`)
    return { applied: [], dryRun, reason: "no upheld findings" }
  }

  // 2. propose a minimal patch per finding (parallel); each reads the actual file
  const proposals = await parallel(
    findings.map((f) => () =>
      agent(
        `Propose a MINIMAL, TARGETED patch for this verified code-review finding. Read the actual file first.
Finding: ${JSON.stringify(f)}
Repo root: ${projectRoot}.
Rules:
- oldString MUST be unique in the file (the Edit tool rejects ambiguous matches). Include just enough surrounding context to be unique.
- newString MUST be the smallest change that closes the finding's failure_scenario. NEVER reformat or rewrite surrounding code.
- If the finding is not safely patchable (needs design discussion, ambiguous fix), return confidence < 0.5 and the smallest possible guard rather than a rewrite.`,
        { label: `fix:propose:${f.file}`, phase: "Self-Fix", model: "sonnet", schema: FIX_PROPOSE_SCHEMA },
      ).then((p) => ({ finding: f, proposal: p })),
    ),
  )
  const valid = proposals.filter(Boolean).filter((p) => p.proposal?.file && p.proposal?.oldString)

  // 3. dryRun → return proposals WITHOUT applying
  if (dryRun) {
    log(`Self-Fix: dryRun — ${valid.length} patch(es) proposed, NOT applied.`)
    return { dryRun: true, proposals: valid.map((p) => p.proposal) }
  }

  // 4. apply each patch (Edit tool via subagent), then 5. re-run the contract gate
  const applied = await parallel(
    valid.map((p) => () =>
      agent(
        `Apply this patch with the Edit tool, then verify it landed.
Edit({ file_path: "${projectRoot}/${p.proposal.file}", old_string: ${JSON.stringify(p.proposal.oldString)}, new_string: ${JSON.stringify(p.proposal.newString)} })
Then Bash("grep -c '<a unique snippet from newString>' '${projectRoot}/${p.proposal.file}'") to confirm the new text is present.
If Edit reports the old_string was not found (file changed since propose), report applied:false with the error — do NOT retry blindly.
Return { applied, detail }.`,
        { label: `fix:apply:${p.proposal.file}`, phase: "Self-Fix", model: "sonnet", schema: FIX_APPLY_SCHEMA },
      ).then((a) => ({ finding: p.finding, proposal: p.proposal, apply: a })),
    ),
  )
  const appliedOk = applied.filter(Boolean).filter((a) => a.apply?.applied)

  // 5. re-run the deterministic contract gate (must still be green after patches)
  const recontract = await agent(
    `Re-run the contract gate after applying fixes.
Bash("${contractCmd}")
Return { pass: <true iff the gate is green>, summary: <the pass/fail line> }.`,
    { label: "fix:recontract", phase: "Self-Fix", model: "sonnet",
      schema: { type: "object", properties: { pass: { type: "boolean" }, summary: { type: "string" } }, required: ["pass"] } },
  )

  // 6. adversarially re-verify each applied finding is actually CLOSED
  const reverified = await parallel(
    appliedOk.map((a) => () =>
      agent(
        `Adversarially verify this finding is now CLOSED by reading the patched file. Default to closed=false if the failure_scenario could still occur.
Finding: ${JSON.stringify(a.finding)}
Patch applied: ${JSON.stringify(a.proposal)}
Repo root: ${projectRoot}.`,
        { label: `fix:reverify:${a.proposal.file}`, phase: "Self-Fix", model: "sonnet",
          schema: { type: "object", properties: { closed: { type: "boolean" }, reason: { type: "string" } }, required: ["closed"] } },
      ).then((v) => ({ finding: a.finding, closed: v?.closed })),
    ),
  )
  const closedCount = reverified.filter(Boolean).filter((v) => v.closed).length
  log(`Self-Fix: applied ${appliedOk.length}/${valid.length}; contract ${recontract?.pass ? "green" : "RED"}; ${closedCount}/${appliedOk.length} findings re-verified closed.`)

  return { dryRun: false, proposed: valid.length, applied: appliedOk, recontract, reverified, closedCount }
}
```

**Persist** — one history entry per finding with `{applied, verified, rationale}`,
folded into the run's signals (`key_metric` = upheld findings remaining AFTER fix).
If `recontract.pass` is false, the run quality is `degraded` regardless of
anything else — a fix that breaks the gate is a regression and must surface loudly.

**Port checklist when adopting** (e.g. flux2/mlx/gui self-improve): copy the three
schemas + `runFixLane` verbatim; pass YOUR contract gate command as `contractCmd`
and YOUR review lane's upheld findings as `findings`; gate the whole lane behind
`args.fix === true` and thread `args.dryRun`. Do NOT specialize the dirty-tree
refuse or the never-push guarantee — those are invariant across workflows.

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
  - **Minimal** `{written:boolean, required:["written"]}` — verifies via
    `test -s … && echo OK` and only gates on `.written`. No current workflow uses this
    variant (the former `schema-self-improve` did, before its 2026-06-19 merge into
    `gui-movie-director-self-improve`); the checker still tolerates it.
- Helper coverage matrix: which workflows define `saveHistory` / `markPhase` /
  `reliableWrite`. Absence is reported, not enforced.

### Coverage (as of 2026-06-19, verified by the checker)

| Workflow | saveHistory | markPhase | reliableWrite | persist schema |
|---|:---:|:---:|:---:|---|
| gui-movie-director-review-optimize | ✓ | ✓ | ✓ | canonical |
| gui-movie-director-self-improve | ✓ | ✓ | — | canonical |
| mlx-movie-director-review-optimize | ✓ | ✓ | — | canonical |
| mlx-movie-director-run-self-improve-image | ✓ | ✓ | ✓ | canonical |
| mlx-movie-director-run-self-improve-ltx | ✓ | — | — | canonical |

Known gaps (refine candidates, not bugs): `run-self-improve-ltx` lacks `markPhase`
(does not track phase status); most generation workflows lack `reliableWrite`
(only the two review-optimize + run-self-improve have it).

### Colocated knowledge coverage (`loadKnowledge` / `extractKnowledge`)

All five workflows own a committed `.claude/workflows/<wf>.knowledge.jsonl`,
distilled from their accumulated history and loaded back each run (see **Workflow
Knowledge** above). The checker's `═══ knowledge snippet coverage ═══` section
reports these flags per workflow (soft — absence is reported, not enforced) — as of
2026-06-19 all five are `load ✓ / extract ✓`.

- **Full mirror (shared `saveHistory`):** `gui-movie-director-review-optimize`,
  `mlx-movie-director-review-optimize`,
  `mlx-movie-director-run-self-improve-image`,
  `gui-movie-director-self-improve` (owns the inlined schema + UX lanes — the former
  `schema-self-improve` / `ux-self-improve` children were merged in 2026-06-19; full
  consolidation: one knowledge base, one history, one persist per run),
  `mlx-movie-director-run-self-improve-ltx` (its `Knowledge` phase was refactored to call
  `extractKnowledge` — the old `~/.claude-glm` memory-file write path never landed).

Four files are seeded from real history (126 records); one is a 0-byte placeholder
that fills organically on first real run. State is tracked in `MANIFEST.md`
(generated by `scripts/workflow-knowledge-manifest.mjs`).

### When you fix a shared pattern — port checklist

1. Edit the canonical copy **here in `_shared-patterns.md` first** (this file is
   the contract; every workflow header says "mirrors _shared-patterns.md verbatim").
2. Propagate to siblings: `grep -rln '<pattern>' .claude/workflows/*.js`.
3. Run `node scripts/check-workflow-patterns.mjs` — it must exit 0.
4. Regenerate the coverage matrix: `node scripts/workflow-knowledge-manifest.mjs`
   (rewrites only the sentinel region of `MANIFEST.md`).
5. The whole-workflow-merge temptation: merges work ONLY when the pair shares the
   same `run.py` command shape AND the same purpose. The `kind` merge (t2i+i2i) met
   that precondition. The mlx↔gui review-optimize pair was vetted and rejected — they
   differ at the generation/test layer AND live in separate apps (mlx Python CLI vs
   Bun GUI). The reverse lesson (2026-06-19): `lora-review` shared ~9/11 phases with
   `run-self-improve-image` (Resolve/Knowledge/GPU-Wait/Generate/VLM-Check/Review/
   Report/Review-HTML/Persist) but had a distinct *purpose* (multi-LoRA A/B compare vs
   single-config self-fix). Rather than merge, it was **retired** once that LoRA line of
   work concluded; its 2 reusable scoring records were folded into run-image (the other
   ~14 were harness-mechanics, dead on retirement, and their conclusions already lived
   in `MEMORY.md`). Lesson: do not merge two workflows whose *purpose* differs even when
   their phases overlap — fold the reusable knowledge and retire the rest.
6. A complementary case (2026-06-19): `gui-movie-director-schema-self-improve` +
   `gui-movie-director-ux-self-improve` were merged INTO `gui-movie-director-self-improve`
   even though their *purposes* differ (CLI boundary vs visual UX). That is NOT a
   contradiction of rule 5 — they were ALREADY sequenced as lanes of that orchestrator
   (one entry point, one merged report) and shared identical harness infra
   (`saveHistory`/`loadKnowledge`/`extractKnowledge`, args + phase tracking). When
   distinct-purpose workflows are already unified at the orchestration layer, inlining
   them removes file indirection without conflating purposes: the lane model
   (`lanes:['schema'|'ux']`) preserves each purpose, and full consolidation collapses the
   redundant per-lane persists (4→1 per run). The lane return-shapes were kept identical,
   so the orchestrator's Persist/Report logic needed no change. Merge-precondition for
   this shape: shares the harness contract AND is already orchestrated as a lane.
7. Operation-lessons + self-learning (2026-06-24, gui self-improve first): when porting
   the `loadOperationLessons` / `operationRulesBlock` / `proposeOperationLessons`
   trio to a sibling, also create its `<wf>.operation-lessons.jsonl` (0-byte or seeded)
   and gitignore `<wf>.operation-lessons.proposed.jsonl`. The propose step is non-fatal
   and gated by dedup; the approved store stays human-curated. Mirror to mlx next.
8. Knowledge prune (2026-06-24, gui self-improve first): when porting `pruneKnowledge`,
   wire it in Persist right after `extractKnowledge` — `pruneKnowledge(KB_FILE, RUN_ID)`.
   It is **DETECT-ONLY**: every run it reports active records whose referenced SOURCE file
   (`frontend/api/lib/scripts/python/bun` ….{ts,tsx,py}) is verifiably absent (`test -e`),
   excluding data/log paths (`.jsonl/.json/.md/…`). It NEVER writes/retires — an auto-retire
   variant mis-tokenized a `.jsonl` log and wrongly retired an occ-17 record, so the operator
   manually retires confirmed candidates in `KB_FILE`. Scoped to the workflow's own `KB_FILE`;
   never touches operation-lessons or `structured/*.jsonl`. Non-fatal. Mirror to mlx next.

## History Dashboard

After runs are persisted, use the dashboard to analyze trends:

```bash
ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py
ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py --workflow mlx-movie-director-review-optimize
ComfyUI/.venv/bin/python scripts/workflow-history-dashboard.py --json  # machine-readable output
```
