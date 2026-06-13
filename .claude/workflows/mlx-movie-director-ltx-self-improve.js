// mlx-movie-director-ltx-self-improve — Autonomous LTX generation tuning.
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
//   - KB writeback: the auto-memory fact-file format + docs/ltx-tuning.md.
//
// Scope (hard-coded): CLI knobs ONLY — --stage1-steps, --stage2-steps,
// --cfg-scale, --audio-cfg-scale, --audio-stage1-only, --seed. No vendored-
// patch edits (av_ca speech-gate stays fixed), no prompt tuning.
//
// Usage:
//   Workflow({ name: "mlx-movie-director-ltx-self-improve" })
//     → DRY-RUN (default): propose-only plan, zero GPU, for human review
//   Workflow({ name: "...", args: { dryRun: false } })
//     → execute the full autonomous loop (baseline + ≤budget iterations)
//   Workflow({ name: "...", args: { dryRun: false, transformer: "dasiwa",
//              budget: 4, objective: "both", target: "Time to create" } })
//   Workflow({ name: "...", args: { resume: "fresh" } })   // ignore prior history
//   Workflow({ name: "...", args: { voiceWeight: 1, qualityWeight: 0 } })  // voice only

export const meta = {
  name: "mlx-movie-director-ltx-self-improve",
  description: "Autonomous LTX generation tuning: propose→generate→measure→adopt/revert CLI-knob changes to maximize a deterministic voice+quality composite, persisting iteration history and writing confirmed levers to the knowledge base",
  whenToUse: "Tune LTX (dasiwa/dev) generation params for best voice+quality via a self-improving loop that learns from its own history. Dry-run by default; set dryRun:false to spend GPU.",
  phases: [
    { title: "Resolve",  detail: "resolve paths, stamp runId, load history (resume) + KB known-dead-ends/good-knobs" },
    { title: "Baseline", detail: "measure the base config (reuse existing mp4 if present) → currentBest" },
    { title: "Improve",  detail: "loop ≤budget: propose one knob change → generate+measure (self-fix retry) → adopt/revert" },
    { title: "Knowledge", detail: "graduate confirmed levers to the KB (memory fact + docs/ltx-tuning.md), dedup" },
    { title: "Persist",  detail: "write run summary JSON + update cross-workflow index" },
    { title: "Report",   detail: "trajectory HTML (iter→composite) + stdout verdict" },
  ],
}

// ── args ────────────────────────────────────────────────────────────────────
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x)
const A = isObj(args) ? args : {}
const objective   = A.objective   || "both"          // "voice" | "quality" | "both"
const transformer = A.transformer || "dasiwa"        // dev | distilled | dasiwa
const budget      = Number(A.budget) || 4            // max iterations
const dryRun      = A.dryRun !== false               // default: dry-run (no GPU)
const resumeMode  = A.resume || "auto"               // auto | fresh | continue
const margin      = Number(A.margin) || 1.5          // adopt threshold (composite pts)
const convergeK   = Number(A.convergeK) || 2         // stop after K non-improving iters
const target      = A.target || "Time to create"
const vw = objective === "quality" ? 0 : (A.voiceWeight != null ? Number(A.voiceWeight) : 0.5)
const qw = objective === "voice"   ? 0 : (A.qualityWeight != null ? Number(A.qualityWeight) : 0.5)

// Base config (the voice sweet spot proven in prior sweeps).
const baseCfg = {
  stage1: 16, stage2: 3, cfg: 5, frames: 57, fps: 24, seed: 42,
  width: 768, height: 512, lowRam: true, audioVolume: 50,
  audioCfg: null, audioStage1Only: false,
  promptFile: A.promptFile || "/tmp/voice-optimized.txt",
  ...A.base,
}

// Allowed knobs + their discrete value ladders (the proposer picks from these).
const KNOBS = {
  stage1_steps:       [8, 16, 20, 30],
  stage2_steps:       [1, 3, 5],
  cfg_scale:          [3, 5, 7],
  audio_cfg_scale:    [null, 3, 5],
  audio_stage1_only:  [false, true],
  seed:               "int",                       // any int (re-roll)
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
    knob:          { type: "string", enum: Object.keys(KNOBS) },
    from:          { type: "string", description: "Current value (stringified)" },
    to:            { type: "string", description: "Proposed value (stringified; null/true/false allowed)" },
    rationale:     { type: "string" },
    predictedDelta:{ type: "number", description: "Predicted composite change" },
  },
  required: ["knob", "to", "rationale"],
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
  c += ` --cfg-scale ${cfg.cfg} --audio-volume ${cfg.audioVolume}`
  if (cfg.lowRam)           c += ` --low-ram`
  if (cfg.audioCfg != null) c += ` --audio-cfg-scale ${cfg.audioCfg}`
  if (cfg.audioStage1Only)  c += ` --audio-stage1-only`
  c += ` --first-frame --json-summary -y`
  return c
}

function buildMeasureCmd(R, mp4) {
  return `cd '${R.mlxDir}' && '${R.pythonExe}' scripts/measure_ltx.py --mp4 '${mp4}' --target '${target.replace(/'/g, `'\\''`)}' --voice-weight ${vw} --quality-weight ${qw}`
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
   historyDir= projectRoot + "/.claude/workflows/history/mlx-movie-director-ltx-self-improve"
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
    { label: "persist-history", phase: "Persist", model: "haiku" },
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
log(`Resolve: runId=${R.runId} | priorRuns=${(R.priorRuns || []).length} | deadEnds=${(R.knownDeadEnds || []).length} | dryRun=${dryRun}`)

const deadEnds = new Set((R.knownDeadEnds || []).map((s) => s.trim()).filter(Boolean))
const knownGood = (R.knownGood || []).slice()

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

const baseline = await agent(
  `Establish the BASELINE measurement for the base config (transformer=${transformer},
stage1=${baseCfg.stage1}, cfg=${baseCfg.cfg}, seed=${baseCfg.seed}, frames=${baseCfg.frames}).

STEP A — try to REUSE an existing base-config mp4 before spending GPU:
  Bash("cd '${R.mlxDir}' && grep -l 'dasiwa-16st-opt' output/.voice_runs.txt 2>/dev/null; head -1 output/.voice_runs.txt 2>/dev/null")
  The first line of output/.voice_runs.txt (label dasiwa-16st-opt) IS this base config.
  Parse its mp4 path (field before the first '|'). If that mp4 exists, use it.

STEP B — measure it:
  ${buildMeasureCmd(R, "<MP4_PATH>")}
  Parse the single JSON line → composite, voice_score, quality_score, weakest, is_noise, duration_s, asr.similarity.

STEP C — if NO reusable mp4 exists, generate it first:
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

function cfgWith(cfg, knob, val) {
  const c = { ...cfg }
  switch (knob) {
    case "stage1_steps":      c.stage1 = val; break
    case "stage2_steps":      c.stage2 = val; break
    case "cfg_scale":         c.cfg = val; break
    case "audio_cfg_scale":   c.audioCfg = val; break
    case "audio_stage1_only": c.audioStage1Only = val; break
    case "seed":              c.seed = val; break
  }
  return c
}
function cfgKey(c) { return `${c.stage1}/${c.stage2}/cfg${c.cfg}/acfg${c.audioCfg}/s1o${c.audioStage1Only}/seed${c.seed}` }

for (let i = 1; i <= budget; i++) {
  // --- Propose one knob change ---
  const proposal = await agent(
    `You are the PROPOSER for an autonomous LTX tuning loop (iteration ${i}/${budget}).
Pick ONE knob change most likely to raise the composite, targeting the weakest dimension.

Objective: ${vw}-voice + ${qw}-quality composite for transformer=${transformer}.
Current best config: ${currentBest ? cfgKey(currentBest.config) : cfgKey(baseCfg)}
Last measurement: composite=${lastMeasure?.composite?.toFixed?.(1) ?? "?"}, weakest=${lastMeasure?.weakest ?? "?"}
${lastMeasure?.metrics ? "metrics: " + lastMeasure.metrics : ""}

Allowed knobs (pick one): ${JSON.stringify(KNOBS)}
Dead-ends (do NOT re-propose): ${[...deadEnds].join("; ") || "(none)"}
Known-good (build on these): ${knownGood.join("; ") || "(none)"}
KB digest: ${R.kbDigest || "(none)"}

Rules: change exactly ONE knob to a value in its ladder; 'seed' = re-roll to a new
random int (cheap, fixes stochastic garble per the ltx-voice memory). Avoid any
move already in dead-ends. Prefer the highest-EV single change. Return the proposal.`,
    { label: `propose-${i}`, phase: "Improve", schema: PROPOSE_SCHEMA },
  )
  if (!proposal) { log(`iter ${i}: propose failed — skipping`); continue }
  const val = proposal.to === "null" ? null : (proposal.to === "true" ? true : (proposal.to === "false" ? false : (Number(proposal.to)) || proposal.to))
  let cfg = cfgWith(lastMeasure?.config || baseCfg, proposal.knob, val)
  log(`iter ${i}: propose ${proposal.knob} → ${proposal.to} (Δ~${proposal.predictedDelta}) — ${proposal.rationale}`)

  // --- Generate + Measure, with one self-fix retry on failure/noise ---
  let gm = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote = attempt === 1 ? `\nNOTE: previous attempt failed/noisy — SELF-FIX by re-rolling seed (seed=${cfg.seed}).` : ""
    gm = await agent(
      `Generate one LTX clip and measure it. Iteration ${i}${attempt ? " (retry)" : ""}.

Config to generate:
${buildGenerateCmd(R, cfg)}
${retryNote}

1. Run that command (timeout 240000ms). Capture the saved mp4: parse the "Saved:
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
4. Fill metrics with a compact summary, e.g. "snr=6.5 f0st=5.2 cent=2221 dr=10 block=16".`,
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
    log(`iter ${i}: ✅ ADOPTED ${proposal.knob}=${proposal.to} → composite ${gm.composite.toFixed(1)} (best)`)
  } else {
    noImprove++
    if (regressed) { deadEnds.add(`${proposal.knob}=${proposal.to}`); log(`iter ${i}: ❌ regressed (${gm.composite.toFixed(1)}) → dead-end`) }
    else log(`iter ${i}: · no improvement (${gm.composite.toFixed(1)} vs best ${currentBest.composite.toFixed(1)})`)
  }
  iterations.push({ i, proposal, cfg: cfgKey(cfg), composite: gm.composite, adopted, weakest: gm.weakest })
  lastMeasure = { ...gm, config: { ...cfg } }
  if (noImprove >= convergeK) { log(`converged: ${convergeK} non-improving iterations`); break }
}

// ── Phase 3: Knowledge (graduate confirmed levers to KB) ─────────────────────
phase("Knowledge")
const adoptedMoves = iterations.filter((it) => it.adopted)
const knowledge = await agent(
  `Synthesize CONFIRMED tuning levers from this run and write ONLY durable findings
to the knowledge base. Do NOT write within-noise or rejected moves.

Run summary:
- runId: ${R.runId}
- baseline composite: ${currentBest ? "(see iterations)" : "n/a"}
- best composite: ${currentBest?.composite?.toFixed?.(1) ?? "n/a"}, best config: ${currentBest ? cfgKey(currentBest.config) : "n/a"}
- adopted moves: ${JSON.stringify(adoptedMoves.map((m) => ({ knob: m.proposal.knob, to: m.proposal.to, composite: m.composite })))}
- all iterations: ${JSON.stringify(iterations.map((m) => ({ i: m.i, knob: m.proposal?.knob, to: m.proposal?.to, composite: m.composite, adopted: m.adopted })))}
- prior KB digest: ${R.kbDigest || "(none)"}

A lever is CONFIRMED only if an adopted move raised composite by ≥ ${margin} pts AND it
isn't already known-good in the KB. If NO lever clears that bar (e.g. all within
noise / at the ceiling), that is itself the finding — confirm the ceiling instead.

For each confirmed lever (or the ceiling confirmation):
1. DEDUP: Bash("grep -i '<knob>' ~/.claude-glm/projects/-Users-huangziyu-proj-video-generation/memory/MEMORY.md 2>/dev/null"). Skip if an entry already covers it.
2. Write a memory fact file at ~/.claude-glm/projects/-Users-huangziyu-proj-video-generation/memory/ltx-tune-<knob>-<short>.md using the EXACT project format (frontmatter: name/description/metadata.type=project; body with **Why:** + **How to apply:**; link related [[ltx-voice-prompt-optimization]]). Use a quoted heredoc (cat > file <<'EOF' ... EOF).
3. Add a one-line pointer to MEMORY.md:  - [LTX tune: <knob>](ltx-tune-...md) — <hook>
4. Append a concise entry to ${R.projectRoot}/python/mlx-movie-director/docs/ltx-tuning.md (date · objective · lever · Δcomposite · verdict).

Report what you wrote (or "no new confirmed levers; ceiling reconfirmed").`,
  { label: "knowledge", phase: "Knowledge", schema: {
    type: "object",
    properties: {
      written: { type: "array", items: { type: "string" }, description: "memory/docs entries written" },
      summary: { type: "string" },
    },
    required: ["summary"],
  } },
)
if (knowledge) log(`Knowledge: ${knowledge.summary}`)

// ── Phase 4: Persist (run summary JSON + cross-workflow index) ───────────────
phase("Persist")

const _ltx_signals = {
  run_quality: iterations.some((it) => it.adopted) ? "good" : "degraded",
  key_metric: currentBest?.composite ?? null,
  delta_from_last: null,
  highlights: [
    `${iterations.length} iteration(s), ${iterations.filter((it) => it.adopted).length} adopted`,
    currentBest ? `best composite=${currentBest.composite?.toFixed(1)} config=${cfgKey(currentBest.config)}` : "no improvement found",
    knowledge?.written?.length ? `${knowledge.written.length} KB entries written` : "no KB updates",
  ],
  warnings: iterations.filter((it) => it.reverted).length > 0
    ? [`${iterations.filter((it) => it.reverted).length} revert(s)`]
    : [],
}

const ltxHistEntry = {
  schema_version: 1,
  run_id: R.runId,
  workflow: meta.name,
  started_at: R.runId,
  args: { objective, transformer, dryRun, budget },
  phases_completed: ["Baseline", "Improve", "Knowledge"],
  phases_failed: [],
  status: "complete",
  result: {
    baseline: currentBest ? { composite: currentBest.composite } : null,
    best: currentBest ? { composite: currentBest.composite, config: cfgKey(currentBest.config), mp4: currentBest.mp4 } : null,
    iterations,
    deadEnds: [...deadEnds],
    knowledge: knowledge?.written || [],
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
  knowledge: knowledge?.written || [],
  html: summary?.htmlPath || null,
}
