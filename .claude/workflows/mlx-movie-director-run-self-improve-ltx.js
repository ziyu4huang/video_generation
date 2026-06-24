// mlx-movie-director-run-self-improve-ltx — Autonomous LTX generation tuning.
//
// Closes the loop: an agent PROPOSES one CLI-knob change → GENERATE → MEASURE
// (voice + quality composite) → ADOPT-or-REVERT, iterating within a budget,
// while persisting every iteration to a history store and graduating CONFIRMED
// levers into the knowledge base. Each run learns from the last (resume +
// dead-end memory) instead of re-discovering marginal knobs.
//
// It COMPOSES existing infrastructure rather than reinventing it:
//   - Measure: scripts/measure_ltx.py + app.voice_metrics.voice_score +
//     app.quality_metrics.composite_quality_score (deterministic 0-100).
//   - Generate: run.py video generate --json-summary (sequential, GPU-gated).
//   - History/resume/dedup convention: copied from
//     mlx-movie-director-review-optimize.js (HISTORY_DIR/<runId>.jsonl).
//   - KB writeback: the colocated <wf>.knowledge.jsonl (committed, shared across machines).
//
// Scope: CLI knobs + av_ca code-lever — --stage1-steps, --stage2-steps,
// --cfg-scale, --audio-cfg-scale, --audio-stage1-only, --seed, AND
// av_ca_timestep_scale_multiplier (patched in embedded_config.json before each
// generate, restored after). No prompt tuning.
//
// Usage:
//   Workflow({ name: "mlx-movie-director-run-self-improve-ltx" })
//     → DRY-RUN (default): propose-only plan, zero GPU, for human review
//   Workflow({ name: "...", args: { dryRun: false } })
//     → execute the full autonomous loop (baseline + ≤budget iterations)
//   Workflow({ name: "...", args: { dryRun: false, transformer: "dasiwa",
//              budget: 4, objective: "both", target: "Time to create" } })
//   Workflow({ name: "...", args: { resume: "fresh" } })   // ignore prior history
//   Workflow({ name: "...", args: { voiceWeight: 1, qualityWeight: 0 } })  // voice only

export const meta = {
  name: "mlx-movie-director-run-self-improve-ltx",
  description: "Autonomous LTX generation tuning: propose→generate→measure→adopt/revert CLI-knob changes to maximize a deterministic voice+quality composite, persisting iteration history and writing confirmed levers to the knowledge base",
  whenToUse: "Tune LTX (dasiwa/dev) generation params for best voice+quality via a self-improving loop that learns from its own history. Dry-run by default; set dryRun:false to spend GPU.",
  phases: [
    { title: "Resolve",  detail: "resolve paths, stamp runId, load history (resume) + KB known-dead-ends/good-knobs" },
    { title: "Baseline", detail: "measure the base config (reuse existing mp4 if present) → currentBest" },
    { title: "Improve",  detail: "loop ≤budget: propose one knob change → generate+measure (self-fix retry) → adopt/revert" },
    { title: "Reflect",  detail: "lightweight per-iteration self-reflection after each rejection (haiku, feeds next proposal)" },
    { title: "Knowledge", detail: "graduate confirmed levers + failed-experiment avoids to the colocated <wf>.knowledge.jsonl" },
    { title: "Persist",  detail: "write run summary JSON + update cross-workflow index" },
    { title: "Report",   detail: "trajectory HTML (iter→composite) + stdout verdict" },
  ],
}

// The Workflow runtime strips `export const meta` to extract metadata, leaving `meta`
// unbound in execution scope. Mirror the name here so KB_FILE / the history entry can
// reference it (matches mlx-movie-director-run-self-improve-image.js).
const _WF_NAME = "mlx-movie-director-run-self-improve-ltx"

// ── args ────────────────────────────────────────────────────────────────────
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x)
const A = isObj(args) ? args : {}
const objective   = A.objective   || "both"          // "voice" | "quality" | "both"
const transformer = A.transformer || "dasiwa"        // dev | distilled | dasiwa
const budget      = Number(A.budget) || 4            // max iterations
const dryRun      = A.dryRun === true || String(A.dryRun).toLowerCase() === "true"  // tolerate string "true" from Workflow runtime serialization
const resumeMode  = A.resume || "auto"               // auto | fresh | continue
const margin      = Number(A.margin) || 0.75         // adopt threshold (0.75 = fine-tuning mode; use 1.5 for early exploration)
const convergeK   = Number(A.convergeK) || 2         // stop after K non-improving iters
// Complex test target — shortened to 3 key words after iter-9 revealed 14-word phrase
// exceeded LTX audio capacity (voice.asr=15.79). "Every moment matters" is short
// enough for reliable audio synthesis while retaining expressive inflection for DR testing.
const target      = A.target || "Every moment matters"
const vw = objective === "quality" ? 0 : (A.voiceWeight != null ? Number(A.voiceWeight) : 0.5)
const qw = objective === "voice"   ? 0 : (A.qualityWeight != null ? Number(A.qualityWeight) : 0.5)

// Base config — confirmed best for COMPLEX SCENE as of 2026-06-25 (composite=64.47, iter-9):
//   stage1=12, stage2=5, cfg=7, stg=0.5, modality=5, hq=true, seed=3053, avCa=1000, audioVolume=5
// NOTE: stg=0.5 was adopted in iter-9 (complex scene) despite being a dead-end for simple face.
//       Condition field in KB correctly captures this: stg=0.5 was avoid at vol=50+stage1=20,
//       but improves at vol=5+stage1=12. This validates the conditional KB architecture.
// Complex scene baseline: ~62 (vs simple face 79.73) — harder test, more meaningful.
// Bottleneck: quality.noise + voice.asr (audio capacity for complex scene).
// Target shortened: "Every moment matters" (3 words, reliable synthesis, still expressive).
// frames=25: KB confirms 25 frames sufficient for quality judgment; keeps iterations fast.
const baseCfg = {
  stage1: 12, stage2: 5, cfg: 7, stg: 0.5, frames: 25, fps: 24, seed: 3053,
  width: 768, height: 512, lowRam: true, audioVolume: 5,
  audioCfg: null, audioStage1Only: false, modalityScale: 5.0, hq: true,
  avCa: 1000.0,  // av_ca_timestep_scale_multiplier — patched in embedded_config.json
  promptFile: A.promptFile || null,  // resolved after Resolve phase using R.projectRoot
  ...A.base,
}

// Allowed knobs + their discrete value ladders (the proposer picks from these).
// Seed is intentionally EXCLUDED — this run focuses on control-parameter interactions,
// not seed exploration (seed=42 is fixed as baseline; seed-3053 lever already in KB).
const KNOBS = {
  stage1_steps:       [8, 12, 16, 20, 25],             // 12=best simple; 8=avoid; 16=unexplored; 20=avoid@stg=0.5; 25=crash
  stage2_steps:       [1, 3, 5, 7, 10],               // 5=confirmed best; all others neutral/dead-end (KB: ltx:stage2-steps-10-avoid)
  cfg_scale:          [3, 5, 7, 9],                   // 7=confirmed best; 9=dead-end (regresses voice.DR, KB: ltx:cfg-scale-nonmonotonic-pattern)
  stg_scale:          [0.5, 1.0, 1.5, 2.0],           // 1.5=confirmed best; ladder fully exhausted (KB: ltx:stg-scale-plateau-exhausted)
  audio_cfg_scale:    [null, 5, 9],                   // null=best; any explicit val regresses per KB
  modality_scale:     [3.0, 4.0, 5.0, 6.0, 10.0],    // 5=confirmed best; 4/6=dead-ends; resonance-curve pattern (KB)
  audio_stage1_only:  [false, true],
  av_ca:              [200, 500, 1000, 2000, 5000],   // 1000=current best; code-lever (embedded_config.json)
  audio_volume:       [1, 5, 15, 30, 50],             // 5=confirmed best (vol=50→5 total +5.22 pts); 1=unexplored (risk: inaudible)
                                                       // mechanism: lower volume → less alimiter=0.95 compression → higher crest factor
}

// ── schemas ──────────────────────────────────────────────────────────────────
const RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    projectRoot: { type: "string" },
    mlxDir:      { type: "string" },
    pythonExe:   { type: "string" },
    historyDir:  { type: "string" },
    runId:       { type: "string" },
    priorRuns:   { type: "array", items: { type: "string" }, description: "Recent <runId>.jsonl basenames, newest first" },
    knownDeadEnds: { type: "array", items: { type: "string" }, description: "Knob moves already shown to regress (from history + KB)" },
    knownGood:     { type: "array", items: { type: "string" }, description: "Knob moves already shown to help" },
    kbDigest:     { type: "string", description: "Short digest of relevant KB findings (docs/ltx-tuning.md + memory)" },
  },
  required: ["projectRoot", "mlxDir", "pythonExe", "historyDir", "runId"],
}

const GENMEASURE_SCHEMA = {
  type: "object",
  properties: {
    status:    { type: "string", enum: ["success", "error", "noise"] },
    mp4:       { type: "string", description: "Absolute mp4 path, empty on error" },
    composite: { type: "number" },
    voice_score:   { type: ["number", "null"] },
    quality_score: { type: ["number", "null"] },
    weakest:   { type: "string" },
    is_noise:  { type: "boolean" },
    duration_s:{ type: "number" },
    asr_sim:   { type: ["number", "null"] },
    metrics:   { type: "string", description: "Compact metric summary for the history record" },
    appended:  { type: "boolean", description: "True if the iteration record was appended to the jsonl" },
    error:     { type: "string" },
  },
  required: ["status", "composite"],
}

const PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    knob:          { type: "string", enum: ["stage1_steps","stage2_steps","cfg_scale","stg_scale","audio_cfg_scale","modality_scale","audio_stage1_only","av_ca","audio_volume"] },
    from:          { type: "string", description: "Current value (stringified)" },
    to:            { type: "string", description: "Proposed value (stringified; null/true/false allowed)" },
    rationale:     { type: "string" },
    predictedDelta:{ type: "number", description: "Predicted composite change" },
  },
  required: ["knob", "to", "rationale"],
}

const REFLECT_SCHEMA = {
  type: "object",
  required: ["insight", "hypothesisClass"],
  properties: {
    insight:          { type: "string", description: "What this failure tells us about system behavior (1 sentence)" },
    hypothesisClass:  { type: "string", description: "What class of change might help next — not a specific value (1 sentence)" },
  },
  additionalProperties: false,
}

const PLAN_SCHEMA = {  // dry-run output
  type: "object",
  properties: {
    summary: { type: "string" },
    steps:   { type: "array", items: {
      type: "object",
      properties: {
        knob: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        rationale: { type: "string" }, predictedDelta: { type: "number" },
      },
      required: ["knob", "to", "rationale"],
    } },
    expectedCeiling: { type: "string", description: "Honest read on whether gains are likely (or if we're at the ceiling)" },
  },
  required: ["summary", "steps"],
}

// ── command builder (pure JS) ────────────────────────────────────────────────
function buildGenerateCmd(R, cfg) {
  let c = `cd '${R.mlxDir}' && '${R.pythonExe}' run.py video generate`
  c += ` --transformer ${transformer}`
  c += ` --prompt-file '${cfg.promptFile}'`
  c += ` --width ${cfg.width} --height ${cfg.height} --frames ${cfg.frames} --fps ${cfg.fps}`
  c += ` --seed ${cfg.seed} --stage1-steps ${cfg.stage1} --stage2-steps ${cfg.stage2}`
  c += ` --cfg-scale ${cfg.cfg} --stg-scale ${cfg.stg != null ? cfg.stg : 1.0} --audio-volume ${cfg.audioVolume}`
  if (cfg.lowRam)                c += ` --low-ram`
  if (cfg.hq)                    c += ` --hq`
  if (cfg.audioCfg != null)      c += ` --audio-cfg-scale ${cfg.audioCfg}`
  if (cfg.modalityScale != null) c += ` --audio-modality-scale ${cfg.modalityScale}`
  if (cfg.audioStage1Only)       c += ` --audio-stage1-only`
  c += ` --first-frame --json-summary -y`
  return c
}

function buildMeasureCmd(R, mp4) {
  return `cd '${R.mlxDir}' && '${R.pythonExe}' scripts/measure_ltx.py --mp4 '${mp4}' --target '${target.replace(/'/g, `'\\''`)}' --voice-weight ${vw} --quality-weight ${qw}`
}

// Returns shell one-liner to patch av_ca_timestep_scale_multiplier in embedded_config.json
function buildAvCaPatch(R, val) {
  const p = `${R.mlxDir}/models/ltx-mlx/dasiwa/embedded_config.json`
  return `python3 -c "import json; d=json.load(open('${p}')); t=d.get('transformer',d); t['av_ca_timestep_scale_multiplier']=${val}; json.dump(d,open('${p}','w'),indent=2); print('av_ca → ${val}')"`
}

// ── Phase 0: Resolve ─────────────────────────────────────────────────────────
phase("Resolve")
const resolve = await agent(
  `Resolve paths, stamp a runId, and load prior history + knowledge base for the
LTX self-improve workflow.

Do exactly this:
1. Bash("git rev-parse --show-toplevel") → projectRoot
2. mlxDir   = projectRoot + "/python/mlx-movie-director"
   pythonExe= projectRoot + "/python/venv/bin/python"
   historyDir= projectRoot + "/.claude/workflows/history/mlx-movie-director-run-self-improve-ltx"
3. Bash("mkdir -p '\${historyDir}'")
4. runId = Bash("date +%Y%m%d_%H%M%S").trim()
5. Prior history: Bash("ls -t '\${historyDir}'/*.jsonl 2>/dev/null | head -5") → priorRuns (basenames). If resume != "fresh", read the newest jsonl tail (last ~12 lines) to summarize what was tried + best config + dead-ends.
6. Knowledge base:
   - Bash("cat '\${projectRoot}/python/mlx-movie-director/docs/ltx-tuning.md' 2>/dev/null | head -60")
   - Bash("cat ~/.claude-glm/projects/-Users-huangziyu-proj-video-generation/memory/MEMORY.md 2>/dev/null | grep -iE 'ltx|voice|audio|dasiwa' | head -20")
   Extract knownDeadEnds (knob moves that regressed — e.g. "audio_cfg_scale=3 regresses") and knownGood (moves that helped — e.g. "audio_stage1_only helps slightly"). Put the relevant gist in kbDigest.

Return the resolved object. Current invocation: objective=${objective}, transformer=${transformer}, budget=${budget}, dryRun=${dryRun}, resume=${resumeMode}.`,
  { label: "resolve", phase: "Resolve", model: "haiku", schema: RESOLVE_SCHEMA },
)
if (!resolve) { log("Resolve failed — aborting."); throw new Error("resolve failed") }
const R = resolve
const HIST_FILE = `${R.historyDir}/${R.runId}.jsonl`
const _ltx_INDEX_FILE = `${R.projectRoot}/.claude/workflows/history/_index.json`
const KB_FILE = `${R.projectRoot}/.claude/workflows/${_WF_NAME}.knowledge.jsonl`

// Resolve promptFile now that we have projectRoot.
// Complex-scene prompt: architect + city skyline → dense edges + full sentence for voice DR.
if (!baseCfg.promptFile) {
  baseCfg.promptFile = `${R.projectRoot}/.claude/workflows/ltx-test-complex-prompt.txt`
}

// ── saveHistory — identical in every workflow; update _shared-patterns.md first ──
// Writes history JSON then VERIFIES (test -s) and rewrites via a quoted heredoc if the Write
// tool silently produced nothing — a reliability fix: the prior run's persist subagent reported
// success but never wrote the file, breaking the trend/reflection/resume loops.
async function saveHistory(histDir, indexFile, entry, signals) {
  const histJson = JSON.stringify({ ...entry, signals }, null, 2)
  const runId = entry.run_id
  const targetPath = `${histDir}/${runId}.json`
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
5. Verify: Bash("test -s '${indexFile}' && echo OK || echo MISSING")
6. If MISSING, rewrite the index via a quoted heredoc with the same array content.
Return { updated: true }.`,
    { label: "update-index", phase: "Persist", model: "haiku" },
  )
}

// ── loadKnowledge — identical in every workflow; update _shared-patterns.md first ──
// Reads the colocated, committed <wf>.knowledge.jsonl and returns ACTIVE records as
// a compact digest to inject into this run (AVOID/GOTCHA are highest-value). Runs at
// Resolve — knowledge is the committed, cross-machine superset. CRITICAL: the
// load-knowledge agent MUST carry the schema below.
async function loadKnowledge(kbFile) {
  const load = await agent(
    `Load distilled workflow knowledge for injection into this run.
1. Bash("test -f '${kbFile}' && echo EXISTS || echo MISSING")
2. If MISSING → return { found: false, records: [], digest: "" }.
3. If EXISTS: Bash("cat '${kbFile}'")
4. Parse each non-empty line as JSON. Keep ONLY records where status === "active".
5. Build a compact digest (<= 1200 chars), grouped by type — skip empty groups:
   - AVOID/GOTCHA: "- AVOID: <title> — <detail> [cond: <condition_json_compact>]"
     If condition is null, omit the [cond:] suffix. Include condition so the proposer
     knows whether an avoid is universal or only applies at a specific base config.
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
// Distills THIS run's result + the existing knowledge file into an UPDATED file.
// Runs at Persist/Knowledge. Keep it CURATED and SMALL (not a run dump).
// CRITICAL: the extract-knowledge agent MUST carry the schema below.
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
- base config (held constant except for the tested knob): stage1_steps=${baseCfg.stage1}, stage2_steps=${baseCfg.stage2}, cfg_scale=${baseCfg.cfg}, stg_scale=${baseCfg.stg}, modality_scale=${baseCfg.modalityScale}, hq=${baseCfg.hq}, seed=${baseCfg.seed}, av_ca=${baseCfg.avCa}, audio_volume=${baseCfg.audioVolume}
  Use this as the \`condition\` value for new avoid/lever records from this run (list the OTHER knobs, not the one being varied).
RECORD SCHEMA — every record MUST use ONLY these 13 top-level keys; any extra key
triggers check-workflow-patterns.mjs schema drift (HARD exit 1):
  schema_version(=1) | id | type | title | detail | tags | dimension | confidence |
  status | superseded_by | evidence{occurrences,first_seen,last_seen,run_ids[<=8]} | extracted_at | condition
Field guidance for LTX tuning records:
  dimension: set to the most-impacted metric (e.g. "quality.edge", "voice.snr",
    "voice.dynamic_range", "composite"). null only if truly cross-dimensional.
  condition: for avoid/lever records, emit the OTHER key knob values held constant
    during this experiment, as a JSON object: {"stg_scale":1.5,"modality_scale":5.0,...}
    This marks the avoid as CONDITIONAL — e.g. stage2_steps=7 may fail at stg=1.5 but
    could work at stg=1.0. null = universal finding (holds regardless of base config).
    Use condition for ALL new avoid/lever records from this run.
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
log(`Resolve: runId=${R.runId} | priorRuns=${(R.priorRuns || []).length} | deadEnds=${(R.knownDeadEnds || []).length} | dryRun=${dryRun}`)

const deadEnds = new Set((R.knownDeadEnds || []).map((s) => s.trim()).filter(Boolean))
const knownGood = (R.knownGood || []).slice()

// Load colocated knowledge base (committed .knowledge.jsonl) — supersedes the
// fragile memory-file path. Map avoid/gotcha→deadEnds, lever→knownGood for propose.
const kbLoad = await loadKnowledge(KB_FILE)
if (Array.isArray(kbLoad?.records)) {
  for (const r of kbLoad.records) {
    if (r.type === "avoid" || r.type === "gotcha") deadEnds.add(`${r.title}`)
    else if (r.type === "lever") knownGood.push(`${r.title}`)
  }
}
const knowledgeDigest = kbLoad?.digest || ""

// ── DRY-RUN: propose-only plan, no GPU ───────────────────────────────────────
if (dryRun) {
  phase("Improve")
  const plan = await agent(
    `You are the PROPOSER for an autonomous LTX tuning loop, in DRY-RUN mode (no
generation yet — produce a PLAN the human will approve).

Objective: maximize a ${vw}-weighted voice + ${qw}-weighted quality composite
(0-100) for transformer=${transformer}. Base config: stage1=${baseCfg.stage1},
stage2=${baseCfg.stage2}, cfg=${baseCfg.cfg}, frames=${baseCfg.frames}, seed=${baseCfg.seed},
audio_cfg=default, audio_stage1_only=false.

Allowed knobs (propose only these, one change per step):
${JSON.stringify(KNOBS)}

Knowledge-base digest (do NOT re-propose dead-ends; prefer building on known-good):
${R.kbDigest || "(none yet)"}

Prior-run dead-ends: ${[...deadEnds].join("; ") || "(none)"}

Produce an ordered plan of ${budget} steps. Each step changes ONE knob and should
target the current weakest dimension. Reference the KB where relevant. Be honest
in expectedCeiling about whether gains are likely or we're already at the ~60%
naturalness ceiling — marginal/confirm-ceiling plans are valid.`,
    { label: "propose-plan", phase: "Improve", schema: PLAN_SCHEMA },
  )
  if (plan) {
    log(`DRY-RUN plan: ${plan.steps?.length || 0} steps`)
    log(`Ceiling read: ${plan.expectedCeiling || ""}`)
    for (const s of (plan.steps || [])) log(`  · ${s.knob}: ${s.from || "?"} → ${s.to}  (Δ${s.predictedDelta ?? "?"}) — ${s.rationale}`)
  }
  return { dryRun: true, runId: R.runId, plan }
}

// ── Phase 1: Baseline (measure base config; reuse existing mp4 if present) ───
phase("Baseline")
const baseKey = JSON.stringify(baseCfg)
let currentBest = null

const _baseCfgKey = cfgKey(baseCfg)
// If caller explicitly overrides seed via args.base.seed, skip the voice_runs.txt cache — they
// want a fresh measurement, and haiku LLMs fuzzy-match entries and can silently reuse a
// different-seed mp4 (confirmed bug: ltx:stale-baseline-cache-bug in KB).
const forceFreshBaseline = A.base?.seed != null
if (forceFreshBaseline) log(`Baseline: args.base.seed=${baseCfg.seed} explicitly set → forcing fresh generation (cache bypass)`)
const baseline = await agent(
  `Establish the BASELINE measurement for the base config (transformer=${transformer},
stage1=${baseCfg.stage1}, cfg=${baseCfg.cfg}, stg=${baseCfg.stg}, modality=${baseCfg.modalityScale},
hq=${baseCfg.hq}, avCa=${baseCfg.avCa}, seed=${baseCfg.seed}, frames=${baseCfg.frames}).
Config key: ${_baseCfgKey}
${forceFreshBaseline ? `⚠ FORCE-FRESH BASELINE: Skip STEP A entirely — go directly to STEP C and generate fresh with seed=${baseCfg.seed}.\n` : ""}
STEP A — look for a REUSABLE baseline mp4 (DO NOT SKIP the config verification):
  1. Bash("cd '${R.mlxDir}' && cat output/.voice_runs.txt 2>/dev/null || echo MISSING")
  2. If MISSING or empty → go to STEP C.
  3. Parse EVERY line (format: <mp4_path>|<label>|<params>|<metrics>).
     Find a line whose <params> field contains ALL of these EXACT tokens:
       stage1=${baseCfg.stage1}, stage2=${baseCfg.stage2}, cfg=${baseCfg.cfg},
       seed=${baseCfg.seed}, frames=${baseCfg.frames}
     AND whose mp4 file exists: Bash("test -f '<mp4_path>' && echo OK || echo MISSING")
  4. If a MATCHING line exists and the mp4 is present → use that mp4 path.
  5. If NO matching line, or the mp4 is gone → go to STEP C.
  NOTE: DO NOT reuse a line with different cfg, stage1, or frames values. Stale entries
  with old configs (stage1=16, cfg=5, frames=57) MUST be skipped.

STEP B — measure the reused mp4:
  ${buildMeasureCmd(R, "<MP4_PATH>")}
  Parse the single JSON line → composite, voice_score, quality_score, weakest, is_noise, duration_s, asr.similarity.

STEP C — generate fresh baseline (only if STEP A found nothing valid):
  ${buildGenerateCmd(R, baseCfg)}
  then parse the saved mp4 path from the "Saved:" line or the .manifest.json, then run STEP B on it.

Return status=composite result. Set mp4 to the measured file. If generation failed
or audio duration < 0.5s, status="error".`,
  { label: "baseline", phase: "Baseline", schema: GENMEASURE_SCHEMA },
)
if (baseline && baseline.status === "success") {
  currentBest = { config: { ...baseCfg }, ...baseline }
  log(`Baseline composite=${baseline.composite.toFixed(1)} (voice=${baseline.voice_score} quality=${baseline.quality_score} weakest=${baseline.weakest})`)
} else {
  log(`⚠️  baseline failed (${baseline?.error || "unknown"}) — continuing with best=null`)
}

// ── Phase 2: Improve loop ────────────────────────────────────────────────────
phase("Improve")
const iterations = []
let noImprove = 0
let lastMeasure = currentBest
// In-run self-learning: track tested hypotheses so the proposer NEVER re-proposes a rejected value
const triedThisRun = new Map()  // key="knob:value" → {composite, delta, i}
let consecutiveFailures = 0
const reflections = []          // per-iteration insights from the Reflect agent

function cfgWith(cfg, knob, val) {
  const c = { ...cfg }
  switch (knob) {
    case "stage1_steps":      c.stage1 = val; break
    case "stage2_steps":      c.stage2 = val; break
    case "cfg_scale":         c.cfg = val; break
    case "stg_scale":         c.stg = val; break
    case "audio_cfg_scale":   c.audioCfg = val; break
    case "modality_scale":    c.modalityScale = val; break
    case "audio_stage1_only": c.audioStage1Only = val; break
    case "hq":                c.hq = val; break
    case "av_ca":             c.avCa = val; break
    case "audio_volume":      c.audioVolume = val; break
  }
  return c
}
function cfgKey(c) { return `${c.stage1}/${c.stage2}/cfg${c.cfg}/stg${c.stg??1}/acfg${c.audioCfg}/modsca${c.modalityScale}/s1o${c.audioStage1Only}/hq${c.hq||false}/avca${c.avCa??1000}/vol${c.audioVolume??50}/seed${c.seed}` }

for (let i = 1; i <= budget; i++) {
  // --- Propose one knob change ---
  // Build context blocks for the proposer: what we already tested this session
  const testedBlock = triedThisRun.size === 0
    ? "(none yet — this is the first proposal)"
    : [...triedThisRun.entries()].map(([k, v]) =>
        `  - ${k}: composite=${v.composite.toFixed(2)} (Δ${v.delta >= 0 ? '+' : ''}${v.delta.toFixed(2)}, iter ${v.i}) → REJECTED`
      ).join('\n')
  const reflectBlock = reflections.length > 0
    ? `\nITERATION INSIGHTS (self-reflection on prior failures):\n` +
      reflections.slice(-3).map((r, idx) => `  [${idx + 1}] ${r.insight} → next direction: ${r.hypothesisClass}`).join('\n')
    : ""
  const innovationBlock = consecutiveFailures >= 2 && triedThisRun.size >= 3
    ? `\n⚠ INNOVATION REQUIRED: Direct parameter sweeps have stalled (${consecutiveFailures} consecutive failures, ${triedThisRun.size} values tried). ` +
      `Propose a second-order interaction (e.g., does stg_scale behave differently at lower stage1_steps? does modality_scale=6 interact differently with stg_scale=1.0?). ` +
      `DO NOT propose any value in ALREADY_TESTED_THIS_RUN or KB dead-ends.`
    : ""
  const proposal = await agent(
    `You are the PROPOSER for an autonomous LTX tuning loop (iteration ${i}/${budget}).
Pick ONE knob change most likely to raise the composite, targeting the weakest dimension.

Objective: ${vw}-voice + ${qw}-quality composite for transformer=${transformer}.
Current best config: ${currentBest ? cfgKey(currentBest.config) : cfgKey(baseCfg)}
Last measurement: composite=${lastMeasure?.composite?.toFixed?.(1) ?? "?"}, weakest=${lastMeasure?.weakest ?? "?"}
${lastMeasure?.metrics ? "metrics: " + lastMeasure.metrics : ""}

ALREADY_TESTED_THIS_RUN (DO NOT re-propose any of these — empirically rejected this session):
${testedBlock}
${reflectBlock}${innovationBlock}

Allowed knobs (pick one): ${JSON.stringify(KNOBS)}
Dead-ends (do NOT re-propose): ${[...deadEnds].join("; ") || "(none)"}
Known-good (build on these): ${knownGood.join("; ") || "(none)"}
KB digest: ${R.kbDigest || "(none)"}

Rules: change exactly ONE knob to a value in its ladder. Avoid any move already in
dead-ends OR in ALREADY_TESTED_THIS_RUN above. Seed is FIXED (not a knob this run).
PRIORITY GUIDANCE — complex-scene ceiling 64.47 (stg=0.5 adopted), bottlenecks: quality.noise + voice.asr:
  CONTEXT: switched to complex scene (architect+city skyline). Prior simple-face levers may
  not transfer directly — re-test under new conditions is valid (condition field in KB tracks this).
  • stg_scale=1.0: intermediate between 0.5 (current) and 1.5 (prior best); balance noise vs edge.
  • stage1_steps=16: between 12 (current) and 20 (confirmed over-smooths in complex scene). UNEXPLORED.
  • audio_volume=3: between 1 (risk inaudible) and 5 (current). May help voice.asr.
  • seed change: new seed may find a configuration that generates clearer audio for complex scene.
  DEAD-ENDS for THIS config: stage1=8 (under-denoises), stage1=20 (56.07 catastrophic on stg=0.5),
    cfg_scale=9 (voice.DR regression), audio_cfg_scale non-null, stage2_steps ladder exhausted.
Prefer the highest-EV single change targeting the weakest dimension.${innovationBlock ? " INNOVATION MODE: explore second-order interactions." : ""} Return the proposal.`,
    { label: `propose-${i}`, phase: "Improve", schema: PROPOSE_SCHEMA },
  )
  if (!proposal) { log(`iter ${i}: propose failed — skipping`); continue }
  const rawTo = String(proposal.to).replace(/^["']|["']$/g, "")
  const val = rawTo === "null" ? null : (rawTo === "true" ? true : (rawTo === "false" ? false : (!isNaN(Number(rawTo)) && rawTo !== "" ? Number(rawTo) : rawTo)))
  let cfg = cfgWith(currentBest?.config || baseCfg, proposal.knob, val)
  log(`iter ${i}: propose ${proposal.knob} → ${proposal.to} (Δ~${proposal.predictedDelta}) — ${proposal.rationale}`)

  // --- Generate + Measure, with one self-fix retry on failure/noise ---
  const avCaRestore = currentBest?.config?.avCa ?? 1000.0
  let gm = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote = attempt === 1 ? `\nNOTE: previous attempt failed/noisy — SELF-FIX by re-rolling seed (seed=${cfg.seed}).` : ""
    const avCaNote = cfg.avCa !== avCaRestore
      ? `STEP 0 — patch av_ca BEFORE running generate (REQUIRED):
  Bash("${buildAvCaPatch(R, cfg.avCa)}")
  Confirm it printed "av_ca → ${cfg.avCa}" before continuing.

` : ""
    const avCaRestoreNote = cfg.avCa !== avCaRestore
      ? `
STEP 5 — ALWAYS restore av_ca AFTER generate (success OR error), to prevent stale state:
  Bash("${buildAvCaPatch(R, avCaRestore)}")
  This MUST run even if generate failed.` : ""
    gm = await agent(
      `Generate one LTX clip and measure it. Iteration ${i}${attempt ? " (retry)" : ""}.

${avCaNote}Config to generate:
${buildGenerateCmd(R, cfg)}
${retryNote}

1. Run that command (timeout 480000ms). Capture the saved mp4: parse the "Saved:
   <path>.mp4" line, or read the newest output_*.manifest.json "outputs"[0].path,
   or the .run.json. If the command failed (non-zero) or no mp4, return status="error".
2. Measure it:
   ${buildMeasureCmd(R, "<MP4_PATH>")}
   Parse the JSON line. If duration_s < 0.5 or the measure exited non-zero → status="noise".
3. Persist this iteration to the crash-safe history (append ONE JSON line):
   echo '<JSON>' >> '${HIST_FILE}'
   where JSON = {"i":${i},"knob":"${proposal.knob}","to":"${proposal.to}","cfg":"${cfgKey(cfg)}","composite":<num>,"voice":<num|null>,"quality":<num|null>,"weakest":"<...>","adopted":false}
   (set adopted=true only AFTER you know — but you append now with false; the orchestrator
    records adoption separately; that's fine.) Set appended=true if the echo succeeded.
4. Fill metrics with a compact summary, e.g. "snr=6.5 f0st=5.2 cent=2221 dr=10 block=16".${avCaRestoreNote}`,
      { label: `genmeasure-${i}${attempt ? "-retry" : ""}`, phase: "Improve", schema: GENMEASURE_SCHEMA },
    )
    if (gm && gm.status === "success") break
    // self-fix: re-roll seed and retry once
    if (attempt === 0) { cfg = { ...cfg, seed: cfg.seed + 1000 + i * 7 }; log(`iter ${i}: self-fix re-roll seed → ${cfg.seed}`) }
  }

  if (!gm || gm.status !== "success") {
    log(`iter ${i}: ⚠️  ${proposal.knob}=${proposal.to} failed/noisy after retry → dead-end`)
    deadEnds.add(`${proposal.knob}=${proposal.to}`)
    iterations.push({ i, proposal, status: "failed", cfg: cfgKey(cfg) })
    noImprove++
    continue
  }

  // --- Decide (pure JS, deterministic) ---
  const adopted = !currentBest || gm.composite > currentBest.composite + margin
  const regressed = currentBest && gm.composite < currentBest.composite - margin
  if (adopted) {
    currentBest = { config: { ...cfg }, composite: gm.composite, voice_score: gm.voice_score, quality_score: gm.quality_score, weakest: gm.weakest, mp4: gm.mp4, metrics: gm.metrics }
    noImprove = 0
    consecutiveFailures = 0
    log(`iter ${i}: ✅ ADOPTED ${proposal.knob}=${proposal.to} → composite ${gm.composite.toFixed(1)} (best)`)
  } else {
    noImprove++
    if (regressed) { deadEnds.add(`${proposal.knob}=${proposal.to}`); log(`iter ${i}: ❌ regressed (${gm.composite.toFixed(1)}) → dead-end`) }
    else log(`iter ${i}: · no improvement (${gm.composite.toFixed(1)} vs best ${(currentBest?.composite ?? 0).toFixed(1)})`)
    // Track for in-run dedup — prevents proposer re-proposing the same value next iteration
    const iterKey = `${proposal.knob}:${proposal.to}`
    triedThisRun.set(iterKey, { composite: gm.composite, delta: gm.composite - (currentBest?.composite ?? 0), i })
    consecutiveFailures++
    // Lightweight self-reflection: feeds insight into the NEXT proposal
    const reflection = await agent(
      `Scientific observer: analyze ONE failed LTX generation quality experiment and extract insight.

Failed: ${iterKey} — composite=${gm.composite.toFixed(2)} vs best=${(currentBest?.composite ?? 0).toFixed(2)} (Δ${(gm.composite - (currentBest?.composite ?? 0)).toFixed(2)})
Weakest dimension: ${gm.weakest || "unknown"}
All rejected this session: ${JSON.stringify([...triedThisRun.keys()])}
KB context: ${knowledgeDigest.slice(0, 400)}

Answer in 2 sentences:
1. What does this failure tell us about how ${proposal.knob} affects model output?
2. What CLASS of change might break the plateau next (not a specific value)?`,
      { label: `reflect-${i}`, phase: "Reflect", schema: REFLECT_SCHEMA, model: "haiku", effort: "low" }
    )
    if (reflection) {
      reflections.push(reflection)
      log(`iter ${i}: reflect → ${reflection.insight}`)
    }
  }
  iterations.push({ i, proposal, cfg: cfgKey(cfg), composite: gm.composite, adopted, weakest: gm.weakest })
  lastMeasure = { ...gm, config: { ...cfg } }
  if (noImprove >= convergeK) { log(`converged: ${convergeK} non-improving iterations`); break }
}

// ── Phase 3: Knowledge (graduate confirmed levers to colocated KB JSONL) ─────
// Refactored: was a memory-file + docs/ltx-tuning.md writer (the ~/.claude-glm path
// never landed — verified empty). Now distills this run into the committed, colocated
// <wf>.knowledge.jsonl via the shared extractKnowledge helper. docs/ltx-tuning.md is
// no longer written from here (avoid dual-write divergence; regenerate from JSONL later).
phase("Knowledge")
const adoptedMoves = iterations.filter((it) => it.adopted)
const failedExperiments = iterations.filter((it) => !it.adopted && it.composite != null)
const ltxRunResult = {
  runId: R.runId,
  objective,
  transformer,
  baseline: currentBest ? { composite: currentBest.composite } : null,
  best: currentBest ? { composite: currentBest.composite, config: cfgKey(currentBest.config) } : null,
  adoptedMoves: adoptedMoves.map((m) => ({ knob: m.proposal.knob, to: m.proposal.to, composite: m.composite })),
  iterations: iterations.map((m) => ({ i: m.i, knob: m.proposal?.knob, to: m.proposal?.to, composite: m.composite, adopted: m.adopted })),
  // Explicit failed-experiment list so extractKnowledge writes avoid records per rejected value
  failedExperiments: failedExperiments.map((m) => ({
    knob: m.proposal?.knob,
    value: m.proposal?.to,
    composite: m.composite,
    baseline: currentBest?.composite ?? null,
    delta: m.composite != null && currentBest?.composite != null ? +(m.composite - currentBest.composite).toFixed(2) : null,
    weakest: m.weakest,
  })),
  reflections: reflections.map((r) => r.insight),
  deadEnds: [...deadEnds],
  margin,
  priorKbDigest: R.kbDigest || null,
}
const knowledge = await extractKnowledge(KB_FILE, R.runId, ltxRunResult,
  reflections.length > 0 ? reflections.map((r) => r.insight).join('; ') : null)
if (knowledge) log(`Knowledge: ${knowledge.new_ids?.length || 0} new record(s) (active≈${knowledge.active ?? "?"})`)

// ── Phase 4: Persist (run summary JSON + cross-workflow index) ───────────────
phase("Persist")

const _ltx_signals = {
  run_quality: iterations.some((it) => it.adopted) ? "good" : "degraded",
  key_metric: currentBest?.composite ?? null,
  delta_from_last: null,
  highlights: [
    `${iterations.length} iteration(s), ${iterations.filter((it) => it.adopted).length} adopted`,
    currentBest ? `best composite=${currentBest.composite?.toFixed(1)} config=${cfgKey(currentBest.config)}` : "no improvement found",
    knowledge?.new_ids?.length ? `${knowledge.new_ids.length} KB record(s) written` : "no KB updates",
  ],
  warnings: iterations.filter((it) => it.reverted).length > 0
    ? [`${iterations.filter((it) => it.reverted).length} revert(s)`]
    : [],
}

const ltxHistEntry = {
  schema_version: 1,
  run_id: R.runId,
  workflow: _WF_NAME,
  started_at: R.runId,
  args: { objective, transformer, dryRun, budget, base: A.base || null },
  phases_completed: ["Baseline", "Improve", "Knowledge"],
  phases_failed: [],
  status: "complete",
  result: {
    baseline: currentBest ? { composite: currentBest.composite } : null,
    best: currentBest ? { composite: currentBest.composite, config: cfgKey(currentBest.config), mp4: currentBest.mp4 } : null,
    iterations,
    deadEnds: [...deadEnds],
    knowledge: knowledge?.new_ids || [],
  },
}

await saveHistory(R.historyDir, _ltx_INDEX_FILE, ltxHistEntry, _ltx_signals)
log(`History: ${R.historyDir}/${R.runId}.json`)

// ── Phase 5: Report (trajectory HTML) ────────────────────────────────────────
phase("Report")
const summary = await agent(
  `Build a trajectory review HTML for this LTX self-improve run.

1. Write a compact HTML at '${R.mlxDir}/output/review_ltx_self_improve_${R.runId}.html'
   showing iteration → composite (a simple <table> + the best config highlighted). Reuse
   the dark-theme CSS vars (--bg/#0f1115, --surface, --accent, --ok, --err). Include a
   <video controls src="<basename>"> for the best mp4 if it exists. Use a quoted heredoc to
   write it. The mp4 src must be the basename only (HTML lives in output/).

Best mp4: ${currentBest?.mp4 || "(none)"}
Iterations: ${JSON.stringify(iterations)}`,
  { label: "report", phase: "Report", model: "haiku", schema: {
    type: "object",
    properties: { htmlPath: { type: "string" } },
    required: [],
  } },
)

log(`════════════════════════════════════════`)
log(`DONE · runId=${R.runId}`)
log(`best composite = ${currentBest?.composite?.toFixed?.(1) ?? "n/a"}  config=${currentBest ? cfgKey(currentBest.config) : "n/a"}`)
if (summary?.htmlPath) log(`trajectory: ${summary.htmlPath}`)
log(`history:    ${R.historyDir}/${R.runId}.json`)
return {
  runId: R.runId,
  dryRun: false,
  objective,
  transformer,
  baseline: currentBest ? "(baseline measured)" : null,
  best: currentBest ? { composite: currentBest.composite, config: cfgKey(currentBest.config), mp4: currentBest.mp4 } : null,
  iterations,
  knowledge: knowledge?.new_ids || [],
  html: summary?.htmlPath || null,
}
