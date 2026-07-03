// pi-agent-ext-flux2 Self-Improve — code-health + REAL end-to-end self-test.
//
// One dynamic workflow to keep bun-apps/pi-agent-ext-flux2 (the pi-agent tool that
// wraps swift/flux2-image-director's `flux2` CLI) healthy. Three lanes:
//
//   • contract — deterministic, cheap: `bun test` (all unit tests) + `check:flags`
//                (CLI flag drift guard). Always safe, always fast.
//   • review   — agent-based multi-dimension code review (correctness /
//                path-safety+argv-injection / schema-consistency / error-handling)
//                of src/*.ts + extensions/pi-flux2.ts, each finding adversarially
//                verified before it counts. REVIEW-ONLY in this version — no
//                git-stash auto-fix yet (see NOTE below).
//   • live-e2e — runs the REAL flux2 binary (not mocks): t2i, scene, the
//                multi-seed scenePipeline (with + without VLM verification,
//                skipping the VLM sub-check gracefully if LM Studio isn't
//                reachable), upscale chained off t2i's output, and gate. This
//                is the lane that actually catches wiring bugs — two real bugs
//                (pi-vlm resolving the wrong model registry; seeds silently
//                overwriting each other's output file) were ONLY found by
//                running the real binary + real LM Studio, not by static review.
//
// NOTE on scope: unlike gui-movie-director-self-improve / mlx-movie-director-
// self-improve, this version does NOT implement git-stash-backed auto-fix for
// the review lane (fix:true is accepted but currently a no-op — logged, not
// silently ignored). Wiring the full fix-and-verify-or-rollback loop is a
// natural follow-up once this harness itself has proven out; shipping a half
// implementation of it now would be worse than shipping review-only honestly.
//
// Modes (selected by args):
//
//   ROUTINE SCAN (default — cheap-ish, collision-safe, review-only, REAL e2e):
//     Workflow({ name: "pi-agent-ext-flux2-self-improve" })
//       → contract + review (effort:low) + live-e2e (all lanes on by default —
//         live-e2e spends real GPU time and, if LM Studio is up, real VLM
//         time, but it is the highest-signal lane so it is NOT opt-in here).
//
//   SINGLE LANE:
//     args: { lanes: ["contract"] }   // bun test + check:flags only
//     args: { lanes: ["review"] }     // code review only
//     args: { lanes: ["live-e2e"] }   // real flux2 binary run only
//
//   FOCUS / TARGET:
//     args: { focus: "path-safety" }         // single review dimension
//     args: { files: ["src/scenePipeline.ts"] }  // review only these files
//     args: { liveE2eSkipVlm: true }         // force-skip the VLM sub-check even if LM Studio is up
//
// Mirrors _shared-patterns.md verbatim for: Phase Tracking, History Persist
// (saveHistory), Workflow Knowledge (loadKnowledge/extractKnowledge). When you
// fix a bug in those blocks, fix _shared-patterns.md FIRST, then port here.

export const meta = {
  name: "pi-agent-ext-flux2-self-improve",
  description:
    "Self-improve loop for bun-apps/pi-agent-ext-flux2 — deterministic contract checks (bun test + check:flags drift guard), agent-based multi-dimension code review (correctness/path-safety/schema-consistency/error-handling) with adversarial verify (review-only, no auto-fix yet), and a REAL end-to-end lane that runs the actual flux2 binary (t2i/scene/scenePipeline with+without VLM/upscale/gate) — the lane that has actually caught real wiring bugs. Merges into one health report with one persist per run.",
  whenToUse:
    "Run after touching bun-apps/pi-agent-ext-flux2 or bun-apps/pi-vlm's shared VLM subagent. Default = contract + review (effort:low, review-only) + live-e2e (all three lanes on by default, unlike other self-improve workflows in this repo — live-e2e is the highest-signal lane here). lanes:['contract'|'review'|'live-e2e'] picks a subset; lanes:'all' is the same as the default. focus/files narrow the review lane. liveE2eSkipVlm:true skips the LM-Studio-dependent sub-check even when LM Studio is reachable (cheaper, deterministic re-runs).",
  phases: [
    { title: "Resolve", detail: "Resolve repo root, timestamp, load knowledge base" },
    { title: "Run", detail: "Lanes: contract (bun test + check:flags) + review (multi-dimension + adversarial verify) + live-e2e (real flux2 binary matrix, VLM sub-check if LM Studio is up)" },
    { title: "Persist", detail: "One unified history entry + extractKnowledge" },
    { title: "Report", detail: "Merged health report: contract status + review findings + live-e2e matrix results" },
  ],
}

// ── Args normalization ──────────────────────────────────────────────────────

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

const ALL_LANES = ["contract", "review", "live-e2e"]
const LANES_RAW = Array.isArray(A.lanes) ? A.lanes : (A.lanes === "all" ? ALL_LANES : (A.lanes ? [A.lanes] : ALL_LANES))
const LANES = LANES_RAW.filter((l) => ALL_LANES.includes(l))
const DO_CONTRACT = LANES.includes("contract")
const DO_REVIEW = LANES.includes("review")
const DO_LIVE_E2E = LANES.includes("live-e2e")

const EFFORT = ["low", "medium", "high"].includes(A.effort) ? A.effort : "low"
const FIX_REQ = A.fix === true // accepted, currently a no-op (see header NOTE)
const FOCUS = A.focus || null
const FILES = Array.isArray(A.files) ? A.files : null
const LIVE_E2E_SKIP_VLM = A.liveE2eSkipVlm === true

// ── Phase tracking (verbatim pattern) ───────────────────────────────────────

const phaseStatus = { resolve: "pending", run: "pending", persist: "pending", report: "pending" }
const phasesCompleted = []
const phasesFailed = []
function markPhase(name, status) {
  phaseStatus[name] = status
  if (status === "completed") phasesCompleted.push(name)
  if (status === "failed") phasesFailed.push(name)
}

// ── Paths (resolved dynamically below — worktree-correct) ──────────────────
// NOTE: the workflow runtime strips `export const meta` — top-level `meta.*`
// refs throw "meta is not defined". Mirror the name into a plain const instead.
const NAME = "pi-agent-ext-flux2-self-improve"
let PROJECT_ROOT = "/Users/huangziyu/proj/video_generation__swift_flux2_agent"
let PKG_DIR = `${PROJECT_ROOT}/bun-apps/pi-agent-ext-flux2`
let HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
let INDEX_FILE = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`
let KB_FILE = `${PROJECT_ROOT}/.claude/workflows/${NAME}.knowledge.jsonl`

// ── saveHistory — identical in every workflow; update _shared-patterns.md first ──
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
Return { updated: true }.`,
    { label: "update-index", phase: "Persist", model: "haiku" },
  )
}

// ── loadKnowledge — identical in every workflow; update _shared-patterns.md first ──
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

// ── extractKnowledge — identical in every workflow; update _shared-patterns.md first ──
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

// ═════════════════════════════════════════════════════════════════════════
phase("Resolve")
// ═════════════════════════════════════════════════════════════════════════

{
  const rootResolve = await agent(
    `Resolve the git repository root of the working tree we are running in.
Bash("git rev-parse --show-toplevel")
Return { root: "<the absolute path, whitespace-trimmed>" }.`,
    { label: "resolve-project-root", phase: "Resolve", model: "haiku",
      schema: { type: "object", properties: { root: { type: "string" } }, required: ["root"] } },
  )
  const resolved = (rootResolve?.root || "").trim()
  if (resolved && resolved.includes("video_generation")) {
    PROJECT_ROOT = resolved
    PKG_DIR = `${PROJECT_ROOT}/bun-apps/pi-agent-ext-flux2`
    HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
    INDEX_FILE = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`
    KB_FILE = `${PROJECT_ROOT}/.claude/workflows/${NAME}.knowledge.jsonl`
    log(`Resolved PROJECT_ROOT → ${PROJECT_ROOT}`)
  } else {
    log(`⚠ could not resolve repo root (got "${resolved}"); keeping fallback ${PROJECT_ROOT}`)
  }
}

const RUN_TIMESTAMP = await agent(
  `Return the current timestamp in ISO format with colons replaced by dashes for filename safety.
  Run: Bash("date -u +%Y-%m-%dT%H-%M-%S")
  Return { timestamp: "<the output>" }.`,
  { label: "timestamp", phase: "Resolve", model: "haiku",
    schema: { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] } },
)
const RUN_ID = RUN_TIMESTAMP?.timestamp || "unknown"

const knowledge = await loadKnowledge(KB_FILE)
const knowledgeDigest = knowledge?.digest || ""

if (FIX_REQ) {
  log(`fix:true was requested but this workflow is REVIEW-ONLY in its current version — no auto-fix will be applied. See the header NOTE.`)
}

markPhase("resolve", "completed")

// ═════════════════════════════════════════════════════════════════════════
phase("Run")
// ═════════════════════════════════════════════════════════════════════════

const CONTRACT_SCHEMA = {
  type: "object",
  properties: {
    testsPass: { type: "boolean" },
    testsSummary: { type: "string", description: "e.g. '64 pass, 0 fail across 6 files'" },
    checkFlagsPass: { type: "boolean" },
    checkFlagsSummary: { type: "string" },
  },
  required: ["testsPass", "checkFlagsPass"],
}

async function runContractLane() {
  return agent(
    `Run pi-agent-ext-flux2's deterministic contract checks. Repo root: ${PROJECT_ROOT}.
1. Bash("cd '${PROJECT_ROOT}' && bun test bun-apps/pi-agent-ext-flux2 bun-apps/pi-vlm 2>&1")
   → testsPass = true iff output ends with "0 fail"; testsSummary = the "N pass / N fail across N files" line.
2. Bash("cd '${PROJECT_ROOT}' && bun run --cwd bun-apps/pi-agent-ext-flux2 check:flags 2>&1")
   → checkFlagsPass = true iff output contains "No drift."; checkFlagsSummary = the "N/N commands fully modeled" line
     plus any "⚠" lines verbatim (missing-flag warnings) if present.
Report both verbatim outputs' tails in your summary text even though the schema only needs booleans + short summaries.`,
    { label: "contract", phase: "Run", model: "sonnet", schema: CONTRACT_SCHEMA },
  )
}

const REVIEW_DIMENSIONS = [
  {
    key: "correctness",
    prompt: `Review bun-apps/pi-agent-ext-flux2/src/scenePipeline.ts and src/index.ts for CORRECTNESS bugs: off-by-one in winner selection, race conditions between sequential seed renders, incorrect fallback logic (best-gate vs verify-match), incorrect null-handling when a candidate's run fails. Read the actual files under ${PKG_DIR}/src/. For each finding return { file, dimension:"correctness", summary, failure_scenario }.`,
  },
  {
    key: "path-safety",
    prompt: `Review bun-apps/pi-agent-ext-flux2/src/paths.ts and every call site of assertPathAllowed/validateExtraArgs (src/index.ts, src/scenePipeline.ts) for argv-injection or path-escape bugs: a value that could reach the flux2 CLI without validation, a scenePipeline field (verifyPrompt/verifyMatch/vlmModel) that could smuggle a flag, a path that could resolve outside the allowed roots via symlink or relative-path tricks. Read the actual files under ${PKG_DIR}/src/. For each finding return { file, dimension:"path-safety", summary, failure_scenario }.`,
  },
  {
    key: "schema-consistency",
    prompt: `Review bun-apps/pi-agent-ext-flux2/src/commands.ts, extensions/pi-flux2.ts, and src/index.ts's EXTRA_ARG_ALLOW set for drift: a field documented in the tool description that commands.ts doesn't actually model, a scenePipeline option in the typebox schema that runFlux2()/scenePipeline.ts doesn't read, an EXTRA_ARG_ALLOW entry for a flag that no longer exists (or a real flag missing from it). Read the actual files under ${PKG_DIR}/. For each finding return { file, dimension:"schema-consistency", summary, failure_scenario }.`,
  },
  {
    key: "error-handling",
    prompt: `Review bun-apps/pi-agent-ext-flux2/src/index.ts, src/scenePipeline.ts, src/vlm.ts, src/result.ts for error-handling gaps: an awaited call with no try/catch where a thrown error would crash the whole pipeline instead of surfacing as details.ok=false, a case where a partial failure (e.g. hand-repair dying mid-run) could leave details in an inconsistent state. Read the actual files under ${PKG_DIR}/src/. For each finding return { file, dimension:"error-handling", summary, failure_scenario }.`,
  },
]

const FINDING_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          dimension: { type: "string" },
          summary: { type: "string" },
          failure_scenario: { type: "string" },
        },
        required: ["file", "summary", "failure_scenario"],
      },
    },
  },
  required: ["findings"],
}

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    upheld: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["upheld"],
}

async function runReviewLane() {
  const dims = FOCUS ? REVIEW_DIMENSIONS.filter((d) => d.key === FOCUS) : REVIEW_DIMENSIONS
  const fileScope = FILES?.length ? `\nLimit review to these files only: ${FILES.join(", ")}.` : ""
  const knowledgeBlock = knowledgeDigest ? `\nKnown findings from prior runs (do not re-report unless newly relevant):\n${knowledgeDigest}` : ""

  const perDim = await parallel(
    dims.map((d) => () =>
      agent(d.prompt + fileScope + knowledgeBlock, { label: `review:${d.key}`, phase: "Run", model: "sonnet", schema: FINDING_SCHEMA })
    ),
  )
  const rawFindings = perDim.filter(Boolean).flatMap((r, i) => (r.findings || []).map((f) => ({ ...f, dimension: dims[i]?.key || f.dimension })))

  if (!rawFindings.length) return { findings: [], dimensionsRun: dims.map((d) => d.key) }

  const verified = await parallel(
    rawFindings.map((f) => () =>
      agent(
        `Adversarially verify this code-review finding by READING the actual file. Default to upheld=false if you cannot confirm it by reading the code.
Finding: ${JSON.stringify(f)}
Repo root: ${PROJECT_ROOT}.`,
        { label: `verify:${f.file}`, phase: "Run", model: "sonnet", schema: VERIFY_SCHEMA },
      ).then((v) => ({ finding: f, verdict: v }))
    ),
  )
  const upheld = verified.filter(Boolean).filter((v) => v.verdict?.upheld).map((v) => v.finding)
  return { findings: upheld, dimensionsRun: dims.map((d) => d.key), rawCount: rawFindings.length }
}

const LIVE_E2E_SCHEMA = {
  type: "object",
  properties: {
    lmStudioAvailable: { type: "boolean" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          ok: { type: "boolean" },
          detail: { type: "string" },
        },
        required: ["name", "ok"],
      },
    },
    overallOk: { type: "boolean" },
  },
  required: ["steps", "overallOk", "lmStudioAvailable"],
}

async function runLiveE2eLane() {
  return agent(
    `Run a REAL end-to-end smoke matrix for pi-agent-ext-flux2 (bun-apps/pi-agent-ext-flux2) — actual flux2 binary calls, no mocks. Repo root: ${PROJECT_ROOT}.

1. Bash("curl -s -m 3 http://localhost:1234/v1/models >/dev/null 2>&1 && echo UP || echo DOWN") → lmStudioAvailable.
2. Write a scratch bun script at /tmp/pi-agent-ext-flux2-live-e2e-${RUN_ID}.ts that:
   - imports { runFlux2 } from "${PKG_DIR}/src/index.ts" via absolute path
   - Step "t2i": runFlux2({ command:"t2i", options:{ prompt:"a red apple on a white table, studio lighting", width:512, height:512, steps:6, seed:42, name:"selftest_${RUN_ID}_t2i" } }) — record ok, output path, gate.
   - Step "upscale-chain": if t2i ok, runFlux2({ command:"upscale", options:{ input: <t2i output>, name:"selftest_${RUN_ID}_upscale" } }) — record ok, gate.
   - Step "scene-pipeline-no-vlm": runFlux2({ command:"scene", options:{ ref:[<t2i output>], prompt:"a red apple sitting on a plain white table, studio lighting", width:512, height:512, steps:6, name:"selftest_${RUN_ID}_scene" }, scenePipeline:{ seeds:[11,22] } }) — record ok, winnerSeed, both candidates' gate.
${LIVE_E2E_SKIP_VLM ? "   - SKIP the VLM step (liveE2eSkipVlm was set)." : `   - Step "scene-pipeline-vlm" (ONLY if lmStudioAvailable): same scene options with scenePipeline:{ seeds:[11,22], verifyPrompt:"What color is the main object in this image? Answer in one short phrase.", verifyMatch:["red"] } — record ok, winnerSeed, winnerReason (should be "verify-match"), each candidate's vlmReply.`}
   - Step "gate": runFlux2({ command:"gate", options:{ images:[<t2i output>], json:true } }) — record ok, gate status.
   - Print a JSON array of { name, ok, detail } for every step actually run (omit the VLM step's array entry if skipped).
   - IMPORTANT: give each step a DISTINCT --name (as above) so this run's files never collide with a previous run's.
3. Bash("cd '${PROJECT_ROOT}' && bun /tmp/pi-agent-ext-flux2-live-e2e-${RUN_ID}.ts 2>&1") — this performs REAL image generation, expect it to take 30-90s total. Capture the printed JSON array.
4. Bash("rm -f /tmp/pi-agent-ext-flux2-live-e2e-${RUN_ID}.ts")
5. overallOk = true iff every step in the array has ok:true.
Return { lmStudioAvailable: <bool from step 1>, steps: <the JSON array from step 3>, overallOk }.`,
    { label: "live-e2e", phase: "Run", model: "sonnet", schema: LIVE_E2E_SCHEMA },
  )
}

const [contractResult, reviewResult, liveE2eResult] = await parallel([
  DO_CONTRACT ? runContractLane : () => Promise.resolve(null),
  DO_REVIEW ? runReviewLane : () => Promise.resolve(null),
  DO_LIVE_E2E ? runLiveE2eLane : () => Promise.resolve(null),
])

const contractOk = contractResult ? (contractResult.testsPass && contractResult.checkFlagsPass) : true
const reviewFindingsCount = reviewResult?.findings?.length ?? 0
const liveE2eOk = liveE2eResult ? liveE2eResult.overallOk : true

if (contractResult) log(`Contract: tests=${contractResult.testsPass ? "PASS" : "FAIL"} (${contractResult.testsSummary || "?"}), check:flags=${contractResult.checkFlagsPass ? "PASS" : "FAIL"} (${contractResult.checkFlagsSummary || "?"})`)
if (reviewResult) log(`Review: ${reviewFindingsCount} upheld finding(s) across ${reviewResult.dimensionsRun?.join(", ") || "?"} (${reviewResult.rawCount ?? "?"} raw before adversarial verify)`)
if (liveE2eResult) log(`Live E2E: ${liveE2eResult.overallOk ? "PASS" : "FAIL"} — LM Studio ${liveE2eResult.lmStudioAvailable ? "UP" : "DOWN"} — ${(liveE2eResult.steps || []).map((s) => `${s.name}=${s.ok ? "ok" : "FAIL"}`).join(", ")}`)

markPhase("run", (contractOk && liveE2eOk) ? "completed" : "failed")

// ═════════════════════════════════════════════════════════════════════════
phase("Persist")
// ═════════════════════════════════════════════════════════════════════════

const runResult = {
  lanes: LANES,
  contract: contractResult,
  review: reviewResult,
  liveE2e: liveE2eResult,
}

const signals = {
  run_quality: (contractOk && liveE2eOk && reviewFindingsCount === 0) ? "good" : (contractOk && liveE2eOk) ? "fair" : "degraded",
  key_metric: reviewFindingsCount,
  delta_from_last: null,
  highlights: [
    contractResult ? `contract: tests ${contractResult.testsPass ? "pass" : "FAIL"}, check:flags ${contractResult.checkFlagsPass ? "pass" : "FAIL"}` : null,
    reviewResult ? `review: ${reviewFindingsCount} upheld finding(s)` : null,
    liveE2eResult ? `live-e2e: ${liveE2eResult.overallOk ? "all steps ok" : "step(s) failed"} (LM Studio ${liveE2eResult.lmStudioAvailable ? "up" : "down"})` : null,
  ].filter(Boolean),
  warnings: reviewFindingsCount > 0 ? [`${reviewFindingsCount} unresolved review finding(s) — this version does not auto-fix`] : [],
}

const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: NAME,
  started_at: RUN_TIMESTAMP,
  args: { lanes: LANES, effort: EFFORT, focus: FOCUS, files: FILES, liveE2eSkipVlm: LIVE_E2E_SKIP_VLM },
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  tags: ["pi-agent-ext-flux2", "code-health", "live-e2e"],
  result: runResult,
}

await saveHistory(HISTORY_DIR, INDEX_FILE, historyEntry, signals)
log(`History: ${HISTORY_DIR}/${RUN_ID}.json`)

await extractKnowledge(KB_FILE, RUN_ID, runResult, null)

markPhase("persist", "completed")

// ═════════════════════════════════════════════════════════════════════════
phase("Report")
// ═════════════════════════════════════════════════════════════════════════

markPhase("report", "completed")

return {
  runId: RUN_ID,
  lanes: LANES,
  contract: contractResult,
  reviewFindings: reviewResult?.findings ?? [],
  liveE2e: liveE2eResult,
  overallOk: contractOk && liveE2eOk,
}
