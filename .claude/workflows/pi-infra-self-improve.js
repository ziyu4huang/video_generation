// pi-infra Self-Improve — code-health for the pi-agent / pi-ext INFRASTRUCTURE layer.
//
// One dynamic workflow to keep the infrastructure packages healthy — the layer
// every OTHER worktree's self-improve loops depend on:
//   • pi-agent            — agent runtime; builds + loads extensions; deploy
//   • pi-agent-cli        — single-bundle CLI consumer of pi-agent
//   • pi-dynamic-workflows— the workflow engine every self-improve runs on
//   • pi-vlm              — shared VLM subagent used by all extensions
//   • pi-obsidian         — obsidian vault tool
//
// This is the INFRASTRUCTURE counterpart to the image-scoped self-improve
// workflows (gui-/mlx-/flux2-). It deliberately does NOT touch image-generation
// content — that belongs to the image worktree. Here we harden the engine,
// runtime, and extension mechanism that those image loops run ON.
//
// Three lanes:
//
//   • contract — deterministic, cheap: runs each infra package's REAL gate.
//                pi-agent test:e2e + verify (getAllTools probe); pi-agent-cli
//                bun test; pi-dynamic-workflows check+build+test:unit; pi-vlm
//                bun test; pi-obsidian bun test + baseline-contract. Always safe.
//   • build    — the deploy-mechanic regression catcher: pi-agent `build:all`
//                (THIN/portable/release bundle+compile) then the `verify` script
//                which loads the produced bundle and probes pi.getAllTools().
//                This is the ONLY lane that catches the recurring deploy foot-
//                guns catalogued in memory (node_modules symlink, jiti
//                NameTooLong, single-.js bare-specifier resolution, 3-mode
//                portability ceiling, Type.Any stringified) — unit tests can't.
//   • review   — agent-based multi-dimension code review (correctness /
//                path-safety+extension-loading / schema-consistency /
//                error-handling) over the infra packages, each finding
//                adversarially verified before it counts.
//   • fix      — CLOSES the review→fix loop (opt-in, fix:true). For each upheld
//                review finding: propose a minimal patch → apply (Edit) → re-run
//                the contract gate → adversarially re-verify the finding closed.
//                dirty-tree-refuse, dryRun-capable, never pushes. First adopter
//                of the "Self-Fix (Code-Review-Based)" shared primitive in
//                _shared-patterns.md — the flux2/mlx/gui self-improve workflows
//                adopt the same helper without copy-paste divergence.
//
// Modes (selected by args):
//
//   ROUTINE SCAN (default — cheap-ish, collision-safe, review-only):
//     Workflow({ name: "pi-infra-self-improve" })
//       → contract + build + review (effort:low). Build is opt-OUT via
//         skipBuild:true for a fast re-run (build:all is the slowest lane).
//
//   CLOSE THE LOOP (opt-in):
//     args: { fix: true }                 // review → propose → apply → re-verify
//     args: { fix: true, dryRun: true }   // propose patches, DON'T apply
//
//   SINGLE LANE:
//     args: { lanes: ["contract"] }   // gate-each-package only
//     args: { lanes: ["build"] }      // build:all + getAllTools probe only
//     args: { lanes: ["review"] }     // code review only
//
// Mirrors _shared-patterns.md verbatim for: Phase Tracking, History Persist
// (saveHistory), Workflow Knowledge (loadKnowledge/extractKnowledge). When you
// fix a bug in those blocks, fix _shared-patterns.md FIRST, then port here.

export const meta = {
  name: "pi-infra-self-improve",
  description:
    "Self-improve loop for the pi-agent / pi-ext INFRASTRUCTURE layer (pi-agent, pi-agent-cli, pi-dynamic-workflows, pi-vlm, pi-obsidian, pi-knowledge-card, pi-hermes-memory, pi-agent-ext-flux2, pi-agent-ext-krea2, pi-agent-ext-ltx, pi-agent-ext-power-tool) — deterministic contract lane (each package's real test gate), a build lane that runs pi-agent build:all + getAllTools() probe to catch the recurring deploy/bundle footguns unit tests can't, a multi-dimension code review (correctness/path-safety/schema-consistency/error-handling) with adversarial verify, AND an opt-in fix lane (fix:true) that closes the review→fix loop: propose-patch → apply → re-run contract → re-verify, dirty-tree-refuse + dryRun-capable + never-pushes. First adopter of the Self-Fix (Code-Review-Based) shared primitive. The infrastructure counterpart to the image-scoped self-improve workflows.",
  whenToUse:
    "Run after touching bun-apps/pi-agent, pi-agent-cli, pi-dynamic-workflows, pi-vlm, pi-obsidian, pi-knowledge-card, pi-hermes-memory, or any pi-agent-ext-* (flux2/krea2/ltx/power-tool) — the runtime + extension-mechanism + workflow-engine + content-extension-integration layer. Default = contract + build + review (effort:low, review-only). fix:true closes the loop (propose→apply→re-verify; refuses on dirty tree, never pushes); fix:true+dryRun:true proposes without applying. lanes:['contract'|'build'|'review'] picks a subset; lanes:'all' is the same as the default. focus/files narrow the review lane. skipBuild:true drops the slow build:all lane for fast re-runs. NOTE: this loop gates the ext INTEGRATION plumbing (bundle/deploy/knowledge-emission), not the image-gen content params — those stay in the image worktree.",
  phases: [
    { title: "Resolve", detail: "Resolve repo root, timestamp, load knowledge base" },
    { title: "Run", detail: "Lanes: contract (each package's gate) + build (build:all + getAllTools probe) + review (multi-dimension + adversarial verify) + fix (opt-in: propose→apply→re-contract→re-verify)" },
    { title: "Persist", detail: "One unified history entry + extractKnowledge" },
    { title: "Report", detail: "Merged health report: contract status + build status + review findings" },
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

const ALL_LANES = ["contract", "build", "review"]
const LANES_RAW = Array.isArray(A.lanes) ? A.lanes : (A.lanes === "all" ? ALL_LANES : (A.lanes ? [A.lanes] : ALL_LANES))
const LANES = LANES_RAW.filter((l) => ALL_LANES.includes(l))
const DO_CONTRACT = LANES.includes("contract")
// build is the slowest lane; allow skipBuild to drop it even when included.
const DO_BUILD = LANES.includes("build") && A.skipBuild !== true
// fix lane is opt-in (fix:true), NOT part of ALL_LANES (never runs by default),
// and consumes the review lane's upheld findings — so fix forces review on.
const FIX_REQ = A.fix === true
const DRY_RUN = A.dryRun === true
const DO_REVIEW = LANES.includes("review") || FIX_REQ
const DO_FIX = FIX_REQ

const EFFORT = ["low", "medium", "high"].includes(A.effort) ? A.effort : "low"
const FOCUS = A.focus || null
const FILES = Array.isArray(A.files) ? A.files : null

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
const NAME = "pi-infra-self-improve"
let PROJECT_ROOT = "/Users/huangziyu/proj/video_generation__pi"
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
    { label: "persist-history", phase: "Persist", tier: "small",
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
    { label: "update-index", phase: "Persist", tier: "small" },
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
    { label: "load-knowledge", phase: "Resolve", tier: "small",
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

// ── loadGraphKnowledge — identical in every workflow; update _shared-patterns.md first ──
async function loadGraphKnowledge(kbFile, graphTags, workflowName) {
  if (!graphTags || graphTags.length === 0) return { count: 0, digest: "", published: false, reason: "no-tags" }
  const vault = `${PROJECT_ROOT}/vaults_root/pi-agent-vault`
  const tagsCsv = graphTags.join(",")
  const q = await agent(
    `Check PI_GRAPH_KNOWLEDGE env var, then run cross-workflow retrieval if enabled.
1. Bash("printenv PI_GRAPH_KNOWLEDGE || echo 1")
   If the output is "0", return { count: 0, digest: "", published: false, reason: "opt-out" }.
2. Bash("OB_VAULT_PATH='${vault}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-query --tags '${tagsCsv}' --exclude-from-kb '${kbFile}' --top-k 8 --json 2>/dev/null")
3. Parse the JSON output. The \`count\` field gives the number of matched cards, \`digest\` gives the grouped digest.
Return { count: <count from JSON or 0>, digest: <digest from JSON or "">, published: true }.`,
    { label: "load-graph-knowledge", phase: "Resolve", tier: "small",
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

// ── publishKnowledge — identical in every workflow; update _shared-patterns.md first ──
async function publishKnowledge(kbFile, workflowName) {
  const vault = `${PROJECT_ROOT}/vaults_root/pi-agent-vault`
  const sourceLabel = `workflow-jsonl:${workflowName}`
  const cli = await agent(
    `Check PI_PUBLISH_KNOWLEDGE env var, then run the ingest CLI if enabled.
1. Bash("printenv PI_PUBLISH_KNOWLEDGE || echo 1")
   If the output is "0", return { published: false, reason: "opt-out" }.
2. Bash("OB_VAULT_PATH='${vault}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-ingest '${kbFile}' --source-label '${sourceLabel}' 2>&1 | tail -20")
3. Report { published: <true iff output contains "created" or "unchanged" or "updated" with no "Error">, summary: <the tail output> }.`,
    { label: "publish-knowledge", phase: "Persist", tier: "big",
      schema: { type: "object", properties: {
        published: { type: "boolean" },
        summary: { type: "string" },
      }, required: ["published"] } },
  )
  if (cli?.published) log(`Knowledge: published → ${vault} (zk-ingest)`)
  else log(`WARNING: knowledge publish skipped/failed — run continues. ${(cli?.summary || "").slice(0, 160)}`)
  return cli
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
   extracted_at = "${runId}", status="active", superseded_by=null.
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
    { label: "extract-knowledge", phase: "Persist", tier: "big",
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
    { label: "resolve-project-root", phase: "Resolve", tier: "small",
      schema: { type: "object", properties: { root: { type: "string" } }, required: ["root"] } },
  )
  const resolved = (rootResolve?.root || "").trim()
  if (resolved && resolved.includes("video_generation")) {
    PROJECT_ROOT = resolved
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
  { label: "timestamp", phase: "Resolve", tier: "small",
    schema: { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] } },
)
const RUN_ID = RUN_TIMESTAMP?.timestamp || "unknown"

const knowledge = await loadKnowledge(KB_FILE)
const knowledgeDigest = knowledge?.digest || ""

// Cross-workflow graph retrieval (the READ side of the closed loop).
// Default-on; PI_GRAPH_KNOWLEDGE=0 kills it. Best-effort, non-fatal.
const GRAPH_TAGS = ["argv", "argparse", "path-validation", "schema-consistency", "error-handling", "extension-loading", "correctness"]
const graphKnowledge = await loadGraphKnowledge(KB_FILE, GRAPH_TAGS, NAME)
const graphDigest = graphKnowledge?.digest || ""

if (FIX_REQ) {
  log(`fix:true requested — review→propose→apply→re-verify loop is ON (dryRun=${DRY_RUN}). The lane refuses on a dirty tree and never pushes.`)
}

markPhase("resolve", "completed")

// ═════════════════════════════════════════════════════════════════════════
phase("Run")
// ═════════════════════════════════════════════════════════════════════════

// ── contract lane: each infra package's real gate ──────────────────────────
const CONTRACT_SCHEMA = {
  type: "object",
  properties: {
    packages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "package dir, e.g. pi-agent" },
          ok: { type: "boolean" },
          summary: { type: "string", description: "the pass/fail line(s) verbatim" },
        },
        required: ["name", "ok"],
      },
    },
    overallOk: { type: "boolean" },
  },
  required: ["packages", "overallOk"],
}

async function runContractLane() {
  return agent(
    `Run the deterministic contract gate for each pi-agent/pi-ext INFRASTRUCTURE package.
Repo root: ${PROJECT_ROOT}. Run each command and capture whether it passed.

1. pi-agent (runtime + extension loader):
   Bash("cd '${PROJECT_ROOT}' && PI_AGENT_E2E=1 bun test bun-apps/pi-agent 2>&1 | tail -40")
   ok iff output contains "0 fail" (or all pass). summary = the "(pass/fail)" totals line.
2. pi-agent-cli (single-bundle CLI consumer):
   Bash("cd '${PROJECT_ROOT}' && bun test bun-apps/pi-agent-cli 2>&1 | tail -25")
3. pi-dynamic-workflows (the workflow engine — heaviest gate: lint+build+unit):
   Bash("cd '${PROJECT_ROOT}' && bun run --cwd bun-apps/pi-dynamic-workflows test 2>&1 | tail -50")
   (this runs biome check + tsc build + bun test:unit; ok iff build AND tests pass)
4. pi-vlm (shared VLM subagent — includes verify-portability):
   Bash("cd '${PROJECT_ROOT}' && bun test bun-apps/pi-vlm 2>&1 | tail -25")
5. pi-obsidian (vault tool — includes frozen baseline-contract):
   Bash("cd '${PROJECT_ROOT}' && bun test bun-apps/pi-obsidian 2>&1 | tail -25")
6. pi-knowledge-card (zettelkasten engine — zk_extract/zk_card/zk_ask/zk_ingest + ingest library):
   Bash("cd '${PROJECT_ROOT}' && bun test bun-apps/pi-knowledge-card 2>&1 | tail -25")
7. pi-hermes-memory (memory extension — contract tests via shell runner, NOT plain bun test):
   Bash("cd '${PROJECT_ROOT}' && ( cd bun-apps/pi-hermes-memory && ./tests/run-all.sh ) 2>&1 | tail -30")
   ok iff output contains "passed" with no failures.
8. pi-agent-ext-flux2 (flux2 content extension — bun test + flag-drift guard):
   Bash("cd '${PROJECT_ROOT}' && bun run --cwd bun-apps/pi-agent-ext-flux2 test 2>&1 | tail -20 && bun run --cwd bun-apps/pi-agent-ext-flux2 check:flags 2>&1 | tail -5")
   ok iff tests show "0 fail" AND check:flags shows "No drift".
9. pi-agent-ext-krea2 (krea2 content extension):
   Bash("cd '${PROJECT_ROOT}' && bun run --cwd bun-apps/pi-agent-ext-krea2 test 2>&1 | tail -20")
10. pi-agent-ext-ltx (ltx content extension):
   Bash("cd '${PROJECT_ROOT}' && bun run --cwd bun-apps/pi-agent-ext-ltx test 2>&1 | tail -20")
11. pi-agent-ext-power-tool (power-tool extension):
   Bash("cd '${PROJECT_ROOT}' && bun run --cwd bun-apps/pi-agent-ext-power-tool test 2>&1 | tail -20")
12. graph-health (knowledge-graph convergence folder — dead-link / MOC-drift gate):
   Bash("cd '${PROJECT_ROOT}' && OB_VAULT_PATH='${PROJECT_ROOT}/vaults_root/pi-agent-vault' bun --cwd bun-apps/pi-agent-cli src/cli.ts zk-query --health 2>&1 | tail -15")
   ok iff the output contains "status:  OK". summary = the status + dead-links/moc-stale lines.
   If the vault or convergence folder does not exist, report ok:true with summary "graph: no vault (skipped)".

For each package report { name, ok, summary }. overallOk = true iff every package ok.
If a package dir doesn't exist, report ok:false with summary "package dir missing".
Report each command's tail in your summary text even though the schema only needs booleans.`
    ,
    { label: "contract", phase: "Run", tier: "big", schema: CONTRACT_SCHEMA },
  )
}

// ── build lane: pi-agent build:all + getAllTools probe ─────────────────────
// This is the ONLY lane that catches the deploy/bundle footguns unit tests
// structurally cannot (node_modules symlink, jiti NameTooLong, single-.js
// bare-specifier resolution, 3-mode portability ceiling, Type.Any stringified).
const BUILD_SCHEMA = {
  type: "object",
  properties: {
    buildAllOk: { type: "boolean", description: "pi-agent build:all (bundle+compile) succeeded" },
    buildSummary: { type: "string", description: "modes produced + artifact sizes/counts" },
    verifyOk: { type: "boolean", description: "getAllTools() probe (bun run verify) passed" },
    verifySummary: { type: "string", description: "tools loaded count / any load errors" },
    overallOk: { type: "boolean" },
  },
  required: ["buildAllOk", "verifyOk", "overallOk"],
}

async function runBuildLane() {
  return agent(
    `Run the deploy-mechanic regression gate for pi-agent. Repo root: ${PROJECT_ROOT}.
This lane catches the bundle/deploy footguns unit tests cannot.

1. Bash("cd '${PROJECT_ROOT}' && bun run --cwd bun-apps/pi-agent build:all 2>&1 | tail -60")
   buildAllOk = true iff the build completes without error AND produces bundle output
   (look for the compiled/bundled artifacts, e.g. dist entries). buildSummary = the modes
   produced + any artifact size/count lines verbatim. If build:all is not a recognized
   script, report buildAllOk:false with summary naming the missing script.
2. Bash("cd '${PROJECT_ROOT}' && bun run --cwd bun-apps/pi-agent verify 2>&1 | tail -40")
   This runs src/__tests__/e2e-extensions.test.ts which loads the produced bundle and
   probes pi.getAllTools() across SOURCE + DEPLOY cwd. verifyOk = true iff "0 fail".
   verifySummary = the pass/fail totals + any extension-load error lines verbatim.
overallOk = buildAllOk && verifyOk.
Report both commands' tails in your summary text.`,
    { label: "build", phase: "Run", tier: "big", schema: BUILD_SCHEMA },
  )
}

// ── review lane: multi-dimension + adversarial verify ──────────────────────
const INFRA_SCOPE = `bun-apps/pi-agent/src, bun-apps/pi-agent-cli/src, bun-apps/pi-dynamic-workflows/src, bun-apps/pi-vlm/src, bun-apps/pi-obsidian/extensions, bun-apps/pi-knowledge-card (extensions + src), bun-apps/pi-hermes-memory/src, bun-apps/pi-agent-ext-flux2, bun-apps/pi-agent-ext-krea2, bun-apps/pi-agent-ext-ltx, bun-apps/pi-agent-ext-power-tool, bun-apps/pi-agent/scripts (build.ts, build-extensions.ts, deploy.ts, verify-extensions.ts)`

const REVIEW_DIMENSIONS = [
  {
    key: "correctness",
    prompt: `Review the pi-agent/pi-ext infrastructure code for CORRECTNESS bugs: logic errors in pi-dynamic-workflows schema-resolution / run-persistence / agent-registry, race conditions or stale-state in pi-agent extension loading or pi-agent-cli arg slicing, wrong default-when-null handling in pi-vlm session-factory or pi-obsidian vault resolution. Scope: ${INFRA_SCOPE}. Read the actual files under ${PROJECT_ROOT}/. For each finding return { file, dimension:"correctness", summary, failure_scenario }.`,
  },
  {
    key: "path-safety",
    prompt: `Review the infrastructure for argv-injection / path-escape / unsafe-load bugs: pi-agent's jiti extension loader resolving a bare specifier outside the repo, build-extensions.ts/deploy.ts symlinking or writing outside the intended tree, pi-agent-cli passing an unsanitized argv token, pi-obsidian resolving a vault path outside the vault root. Scope: ${INFRA_SCOPE}. Read the actual files under ${PROJECT_ROOT}/. For each finding return { file, dimension:"path-safety", summary, failure_scenario }.`,
  },
  {
    key: "schema-consistency",
    prompt: `Review for schema / contract drift in the infrastructure: a pi-dynamic-workflows structured-output or schema-resolution field that the runtime doesn't actually enforce, a pi-agent extension tool description that getAllTools() exposes but the handler doesn't implement, a pi-vlm/pi-obsidian option accepted by the typebox schema but ignored by the pipeline. Scope: ${INFRA_SCOPE}. Read the actual files under ${PROJECT_ROOT}/. For each finding return { file, dimension:"schema-consistency", summary, failure_scenario }.`,
  },
  {
    key: "error-handling",
    prompt: `Review for error-handling gaps in the infrastructure: an awaited build/deploy/load call with no try/catch where a throw would crash instead of surfacing ok:false, a pi-agent deploy step that leaves node_modules/bundle in an inconsistent state on partial failure, a pi-dynamic-workflows run-persistence path that corrupts history on a failed write. Scope: ${INFRA_SCOPE}. Read the actual files under ${PROJECT_ROOT}/. For each finding return { file, dimension:"error-handling", summary, failure_scenario }.`,
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
  const knowledgeBlock = [knowledgeDigest, graphDigest].filter(Boolean).join("\n\n--- cross-workflow graph knowledge ---\n")
  const injected = knowledgeBlock ? `\nKnown findings from prior runs (do not re-report unless newly relevant):\n${knowledgeBlock}` : ""

  const perDim = await parallel(
    dims.map((d) => () =>
      agent(d.prompt + fileScope + injected, { label: `review:${d.key}`, phase: "Run", tier: "big", schema: FINDING_SCHEMA })
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
        { label: `verify:${f.file}`, phase: "Run", tier: "big", schema: VERIFY_SCHEMA },
      ).then((v) => ({ finding: f, verdict: v }))
    ),
  )
  const upheld = verified.filter(Boolean).filter((v) => v.verdict?.upheld).map((v) => v.finding)
  return { findings: upheld, dimensionsRun: dims.map((d) => d.key), rawCount: rawFindings.length }
}

const [contractResult, buildResult, reviewResult] = await parallel([
  DO_CONTRACT ? runContractLane : () => Promise.resolve(null),
  DO_BUILD ? runBuildLane : () => Promise.resolve(null),
  DO_REVIEW ? runReviewLane : () => Promise.resolve(null),
])

const contractOk = contractResult ? contractResult.overallOk : true
const buildOk = buildResult ? buildResult.overallOk : true
const reviewFindings = reviewResult?.findings ?? []
const reviewFindingsCount = reviewFindings.length

if (contractResult) {
  const pkgs = (contractResult.packages || []).map((p) => `${p.name}=${p.ok ? "ok" : "FAIL"}`).join(", ")
  log(`Contract: ${contractResult.overallOk ? "PASS" : "FAIL"} — ${pkgs}`)
}
if (buildResult) log(`Build: build:all=${buildResult.buildAllOk ? "ok" : "FAIL"}, verify(getAllTools)=${buildResult.verifyOk ? "ok" : "FAIL"} — ${buildResult.buildSummary || "?"} | ${buildResult.verifySummary || "?"}`)
if (reviewResult) log(`Review: ${reviewFindingsCount} upheld finding(s) across ${reviewResult.dimensionsRun?.join(", ") || "?"} (${reviewResult.rawCount ?? "?"} raw before adversarial verify)`)

// ── fix lane: closes the review→fix loop (opt-in, after review) ────────────
// Ported from _shared-patterns.md "Self-Fix (Code-Review-Based)". The contract
// re-run gate: all 5 infra packages green (same as the contract lane).
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
const RECONTRACT_CMD = `cd '${PROJECT_ROOT}' && PI_AGENT_E2E=1 bun test bun-apps/pi-agent >/dev/null 2>&1 && bun test bun-apps/pi-agent-cli >/dev/null 2>&1 && bun run --cwd bun-apps/pi-dynamic-workflows test >/dev/null 2>&1 && bun test bun-apps/pi-vlm >/dev/null 2>&1 && bun test bun-apps/pi-obsidian >/dev/null 2>&1 && bun test bun-apps/pi-knowledge-card >/dev/null 2>&1 && ( cd bun-apps/pi-hermes-memory && ./tests/run-all.sh ) >/dev/null 2>&1 && bun run --cwd bun-apps/pi-agent-ext-flux2 test >/dev/null 2>&1 && bun run --cwd bun-apps/pi-agent-ext-flux2 check:flags >/dev/null 2>&1 && bun run --cwd bun-apps/pi-agent-ext-krea2 test >/dev/null 2>&1 && bun run --cwd bun-apps/pi-agent-ext-ltx test >/dev/null 2>&1 && bun run --cwd bun-apps/pi-agent-ext-power-tool test >/dev/null 2>&1 && echo ALL_GREEN`

async function runFixLane(findings) {
  // 1. refuse on dirty tree — never collide with WIP. BUT ignore submodule-dirty
  //    changes (the vault submodule is dirtied by default-on publishKnowledge;
  //    that's a knowledge artifact, not source WIP) and the workflow's own
  //    knowledge/history artifacts (*.knowledge.jsonl, _shared-patterns.md,
  //    history/). PI_PUBLISH_KNOWLEDGE=0 also prevents the vault bump entirely.
  const dirty = await agent(
    `Bash("git -C '${PROJECT_ROOT}' status --porcelain --ignore-submodules=dirty") and return whether the output is non-empty.
Also filter OUT lines matching: vaults_root/, .knowledge.jsonl, _shared-patterns.md, .claude/workflows/history/.
Report dirty=true iff ANY other line remains after filtering.`,
    { label: "fix:dirty-check", phase: "Run", tier: "small", schema: FIX_DIRTY_SCHEMA },
  )
  if (dirty?.dirty) {
    log(`Self-Fix: SKIPPED — dirty tree (fix lane refuses to avoid corrupting WIP). Stash or commit first. TIP: set PI_PUBLISH_KNOWLEDGE=0 to avoid vault-submodule dirt.`)
    return { skipped: true, reason: "dirty tree", porcelain: dirty.output }
  }

  if (!findings?.length) {
    log(`Self-Fix: no upheld findings to fix — lane is a no-op.`)
    return { applied: [], dryRun: DRY_RUN, reason: "no upheld findings" }
  }

  // 2. propose a minimal patch per finding (parallel); each reads the actual file
  const proposals = await parallel(
    findings.map((f) => () =>
      agent(
        `Propose a MINIMAL, TARGETED patch for this verified code-review finding. Read the actual file first.
Finding: ${JSON.stringify(f)}
Repo root: ${PROJECT_ROOT}.
Rules:
- oldString MUST be unique in the file (the Edit tool rejects ambiguous matches). Include just enough surrounding context to be unique.
- newString MUST be the smallest change that closes the finding's failure_scenario. NEVER reformat or rewrite surrounding code.
- If the finding is not safely patchable (needs design discussion, ambiguous fix), return confidence < 0.5 and the smallest possible guard rather than a rewrite.`,
        { label: `fix:propose:${f.file}`, phase: "Run", tier: "big", schema: FIX_PROPOSE_SCHEMA },
      ).then((p) => ({ finding: f, proposal: p })),
    ),
  )
  const valid = proposals.filter(Boolean).filter((p) => p.proposal?.file && p.proposal?.oldString)

  // 3. dryRun → return proposals WITHOUT applying
  if (DRY_RUN) {
    log(`Self-Fix: dryRun — ${valid.length} patch(es) proposed, NOT applied.`)
    return { dryRun: true, proposals: valid.map((p) => p.proposal) }
  }

  // 4. apply each patch (Edit tool via subagent)
  const applied = await parallel(
    valid.map((p) => () =>
      agent(
        `Apply this patch with the Edit tool, then verify it landed.
Edit({ file_path: "${PROJECT_ROOT}/${p.proposal.file}", old_string: ${JSON.stringify(p.proposal.oldString)}, new_string: ${JSON.stringify(p.proposal.newString)} })
Then Bash("grep -c '<a unique snippet from newString>' '${PROJECT_ROOT}/${p.proposal.file}'") to confirm the new text is present.
If Edit reports the old_string was not found (file changed since propose), report applied:false with the error — do NOT retry blindly.
Return { applied, detail }.`,
        { label: `fix:apply:${p.proposal.file}`, phase: "Run", tier: "big", schema: FIX_APPLY_SCHEMA },
      ).then((a) => ({ finding: p.finding, proposal: p.proposal, apply: a })),
    ),
  )
  const appliedOk = applied.filter(Boolean).filter((a) => a.apply?.applied)

  // 5. re-run the deterministic contract gate (must still be green after patches)
  const recontract = await agent(
    `Re-run the infra contract gate after applying fixes. pass=true iff output contains ALL_GREEN.
Bash("${RECONTRACT_CMD}")
Return { pass, summary }.`,
    { label: "fix:recontract", phase: "Run", tier: "big",
      schema: { type: "object", properties: { pass: { type: "boolean" }, summary: { type: "string" } }, required: ["pass"] } },
  )

  // 6. adversarially re-verify each applied finding is actually CLOSED
  const reverified = await parallel(
    appliedOk.map((a) => () =>
      agent(
        `Adversarially verify this finding is now CLOSED by reading the patched file. Default to closed=false if the failure_scenario could still occur.
Finding: ${JSON.stringify(a.finding)}
Patch applied: ${JSON.stringify(a.proposal)}
Repo root: ${PROJECT_ROOT}.`,
        { label: `fix:reverify:${a.proposal.file}`, phase: "Run", tier: "big",
          schema: { type: "object", properties: { closed: { type: "boolean" }, reason: { type: "string" } }, required: ["closed"] } },
      ).then((v) => ({ finding: a.finding, closed: v?.closed })),
    ),
  )
  const closedCount = reverified.filter(Boolean).filter((v) => v.closed).length
  log(`Self-Fix: applied ${appliedOk.length}/${valid.length}; contract ${recontract?.pass ? "green" : "RED"}; ${closedCount}/${appliedOk.length} findings re-verified closed.`)

  return { dryRun: false, proposed: valid.length, applied: appliedOk, recontract, reverified, closedCount }
}

const fixResult = DO_FIX ? await runFixLane(reviewFindings) : null
const fixOk = fixResult ? (fixResult.skipped || fixResult.dryRun ? true : (fixResult.recontract?.pass && (fixResult.closedCount ?? 0) >= 0)) : true
const fixBrokeGate = fixResult && !fixResult.dryRun && !fixResult.skipped && fixResult.recontract?.pass === false

if (fixResult) {
  if (fixResult.skipped) log(`Fix: SKIPPED (${fixResult.reason})`)
  else if (fixResult.dryRun) log(`Fix: dryRun — ${fixResult.proposals?.length ?? 0} patch(es) proposed, not applied`)
  else log(`Fix: ${fixResult.closedCount}/${fixResult.applied?.length ?? 0} closed; contract ${fixResult.recontract?.pass ? "green" : "RED"}`)
}

markPhase("run", (contractOk && buildOk && !fixBrokeGate) ? "completed" : "failed")

// ═════════════════════════════════════════════════════════════════════════
phase("Persist")
// ═════════════════════════════════════════════════════════════════════════

const runResult = {
  lanes: LANES,
  contract: contractResult,
  build: buildResult,
  review: reviewResult,
  fix: fixResult,
  graphKnowledge,
}

// After a fix lane run, "remaining" findings = those NOT re-verified closed.
const findingsRemaining = fixResult && !fixResult.dryRun && !fixResult.skipped
  ? Math.max(0, reviewFindingsCount - (fixResult.closedCount ?? 0))
  : reviewFindingsCount

const signals = {
  run_quality: fixBrokeGate
    ? "degraded"
    : (contractOk && buildOk && findingsRemaining === 0) ? "good" : (contractOk && buildOk) ? "fair" : "degraded",
  key_metric: findingsRemaining,
  delta_from_last: null,
  highlights: [
    contractResult ? `contract: ${contractResult.overallOk ? "all packages pass" : "package(s) failed"} (${(contractResult.packages || []).filter((p) => !p.ok).map((p) => p.name).join(",") || "none"})` : null,
    buildResult ? `build: build:all ${buildResult.buildAllOk ? "ok" : "FAIL"}, getAllTools ${buildResult.verifyOk ? "ok" : "FAIL"}` : null,
    reviewResult ? `review: ${reviewFindingsCount} upheld finding(s)` : null,
    fixResult ? (fixResult.skipped ? `fix: SKIPPED (${fixResult.reason})` : fixResult.dryRun ? `fix: dryRun, ${fixResult.proposals?.length ?? 0} proposed` : `fix: ${fixResult.closedCount}/${fixResult.applied?.length ?? 0} closed, contract ${fixResult.recontract?.pass ? "green" : "RED"}`) : null,
  ].filter(Boolean),
  warnings: [
    reviewFindingsCount > 0 && !fixResult ? `${reviewFindingsCount} unresolved review finding(s) — fix:true closes the loop` : null,
    fixBrokeGate ? `fix lane broke the contract gate — patches are a regression, do not commit` : null,
  ].filter(Boolean),
}

const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: NAME,
  started_at: RUN_TIMESTAMP,
  args: { lanes: LANES, effort: EFFORT, focus: FOCUS, files: FILES, skipBuild: A.skipBuild === true, fix: FIX_REQ, dryRun: DRY_RUN },
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  tags: ["pi-agent", "pi-ext", "infrastructure", "code-health"],
  result: runResult,
}

await saveHistory(HISTORY_DIR, INDEX_FILE, historyEntry, signals)
log(`History: ${HISTORY_DIR}/${RUN_ID}.json`)

await extractKnowledge(KB_FILE, RUN_ID, runResult, null)

// Publish this workflow's knowledge into the shared graph (the WRITE side).
// Default-on; PI_PUBLISH_KNOWLEDGE=0 kills it. Best-effort, non-fatal.
const publishResult = await publishKnowledge(KB_FILE, NAME)
runResult.publishKnowledge = publishResult

markPhase("persist", "completed")

// ═════════════════════════════════════════════════════════════════════════
phase("Report")
// ═════════════════════════════════════════════════════════════════════════

markPhase("report", "completed")

return {
  runId: RUN_ID,
  lanes: LANES,
  contract: contractResult,
  build: buildResult,
  reviewFindings: reviewResult?.findings ?? [],
  fix: fixResult,
  findingsRemaining,
  overallOk: contractOk && buildOk && !fixBrokeGate,
}
