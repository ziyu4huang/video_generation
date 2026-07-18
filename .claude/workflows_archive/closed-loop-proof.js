export const meta = {
  name: "closed-loop-proof",
  description:
    "Focused end-to-end proof of the knowledge-graph closed loop: loadGraphKnowledge (READ) at Resolve + graphHealth gate (contract) + publishKnowledge (WRITE) at Persist. Produces a history JSON receipt carrying graphKnowledge.count, publishKnowledge.published, and contract.graphHealth.ok — the three fields that prove the loop is live.",
  phases: [
    { title: "Resolve", detail: "loadKnowledge + loadGraphKnowledge (cross-workflow READ)" },
    { title: "Run", detail: "graphHealth contract gate" },
    { title: "Persist", detail: "extractKnowledge + publishKnowledge (WRITE) + saveHistory receipt" },
  ],
}

// ── Args ────────────────────────────────────────────────────────────────────
let resolvedArgs = args
if (typeof resolvedArgs === "string") {
  try { resolvedArgs = JSON.parse(resolvedArgs) } catch { resolvedArgs = {} }
}
const A = (typeof resolvedArgs === "object" && resolvedArgs !== null) ? resolvedArgs : {}

// ── Paths ───────────────────────────────────────────────────────────────────
const NAME = "closed-loop-proof"
let PROJECT_ROOT = "/Users/huangziyu/proj/video_generation__pi"
let HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
let KB_FILE = `${PROJECT_ROOT}/.claude/workflows/pi-infra-self-improve.knowledge.jsonl`
let VAULT = `${PROJECT_ROOT}/vaults_root/pi-agent-vault`

// Resolve repo root dynamically
{
  const r = await agent(
    `Bash("git rev-parse --show-toplevel") and return the trimmed path.`,
    { label: "resolve-root", phase: "Resolve", tier: "small",
      schema: { type: "object", properties: { root: { type: "string" } }, required: ["root"] } },
  )
  const resolved = (r?.root || "").trim()
  if (resolved && resolved.includes("video_generation")) {
    PROJECT_ROOT = resolved
    HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
    KB_FILE = `${PROJECT_ROOT}/.claude/workflows/${A.kbFile ?? "pi-infra-self-improve"}.knowledge.jsonl`
    VAULT = `${PROJECT_ROOT}/vaults_root/pi-agent-vault`
  }
}

const RUN_TS = await agent(
  `Bash("date -u +%Y-%m-%dT%H-%M-%S") and return the timestamp.`,
  { label: "timestamp", phase: "Resolve", tier: "small",
    schema: { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] } },
)
const RUN_ID = RUN_TS?.timestamp || "unknown"

// ═════════════════════════════════════════════════════════════════════════
phase("Resolve")
// ═════════════════════════════════════════════════════════════════════════

// ── loadKnowledge (OWN knowledge) ───────────────────────────────────────────
async function loadKnowledge(kbFile) {
  const load = await agent(
    `Load distilled workflow knowledge for injection into this run.
1. Bash("test -f '${kbFile}' && echo EXISTS || echo MISSING")
2. If MISSING → return { found: false, records: [], digest: "" }.
3. If EXISTS: Bash("cat '${kbFile}'")
4. Parse each non-empty line as JSON. Keep ONLY records where status === "active".
5. Build a compact digest (<= 600 chars) grouped by type.
Return { found: true, records: <active records array>, digest: <string> }.`,
    { label: "load-knowledge", phase: "Resolve", tier: "small",
      schema: { type: "object", properties: {
        found: { type: "boolean" },
        records: { type: "array", items: { type: "object" } },
        digest: { type: "string" },
      }, required: ["found", "digest"] } },
  )
  const n = Array.isArray(load?.records) ? load.records.length : 0
  log(`Knowledge: loaded ${n} active record(s) ← ${kbFile}`)
  return load
}

// ── loadGraphKnowledge (CROSS-WORKFLOW READ side) ───────────────────────────
async function loadGraphKnowledge(kbFile, graphTags) {
  
  
  const tagsCsv = graphTags.join(",")
  const q = await agent(
    `Check PI_GRAPH_KNOWLEDGE env var, then run cross-workflow retrieval if enabled.
1. Bash("printenv PI_GRAPH_KNOWLEDGE || echo 1")
   If "0", return { count: 0, digest: "", published: false, reason: "opt-out" }.
2. Bash("OB_VAULT_PATH='${VAULT}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-query --tags '${tagsCsv}' --exclude-from-kb '${kbFile}' --top-k 8 --json 2>/dev/null")
3. Parse the JSON output. The "count" field gives the number of matched cards, "digest" gives the grouped digest.
Return { count: <count from JSON or 0>, digest: <digest from JSON or "">, published: true }.`,
    { label: "load-graph-knowledge", phase: "Resolve", tier: "small",
      schema: { type: "object", properties: {
        count: { type: "number" },
        digest: { type: "string" },
        published: { type: "boolean" },
      }, required: ["count"] } },
  )
  const c = q?.count ?? 0
  if (c > 0) log(`Graph: retrieved ${c} cross-workflow card(s) ← tags [${tagsCsv}]`)
  else log(`Graph: no cross-workflow cards matched ← tags [${tagsCsv}]`)
  return q ?? { count: 0, digest: "", published: false }
}

const knowledge = await loadKnowledge(KB_FILE)
const GRAPH_TAGS = ["argv", "argparse", "path-validation", "schema-consistency", "error-handling", "correctness"]
const graphKnowledge = await loadGraphKnowledge(KB_FILE, GRAPH_TAGS)

// ═════════════════════════════════════════════════════════════════════════
phase("Run")
// ═════════════════════════════════════════════════════════════════════════

// ── graphHealth contract gate ───────────────────────────────────────────────
const contractResult = await agent(
  `Run the knowledge-graph health audit CLI and report the result.
Bash("OB_VAULT_PATH='${PROJECT_ROOT}/vaults_root/pi-agent-vault' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-query --health 2>&1")
ok = true iff the output contains "status:  OK".
Return { ok, summary: <the full output>, graphHealth: { ok, deadLinks, mocMissing, mocStale, orphans } }.
Extract deadLinks/mocMissing/mocStale/orphans counts from the output lines if present (default 0/false).`,
  { label: "contract:graph-health", phase: "Run", tier: "small",
    schema: { type: "object", properties: {
      ok: { type: "boolean" },
      summary: { type: "string" },
      graphHealth: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          deadLinks: { type: "number" },
          mocMissing: { type: "boolean" },
          mocStale: { type: "boolean" },
          orphans: { type: "number" },
        },
      },
    }, required: ["ok"] } },
)
log(`Contract: graphHealth ${contractResult?.graphHealth?.ok ? "OK" : "DRIFT"} — ${contractResult?.summary?.split("\n").find((l) => l.includes("status:")) || "?"}`)

// ═════════════════════════════════════════════════════════════════════════
phase("Persist")
// ═════════════════════════════════════════════════════════════════════════

// ── extractKnowledge (no-op for proof — we don't modify the KB) ─────────────
// For the proof, we skip extractKnowledge to avoid dirtying the KB file.
log(`Knowledge: extract skipped (proof run — KB untouched)`)

// ── publishKnowledge (WRITE side) ───────────────────────────────────────────
async function publishKnowledge(kbFile, workflowName) {
  const vault = VAULT
  const sourceLabel = `workflow-jsonl:${workflowName}`
  const cli = await agent(
    `Check PI_PUBLISH_KNOWLEDGE env var, then run the ingest CLI if enabled.
1. Bash("printenv PI_PUBLISH_KNOWLEDGE || echo 1")
   If "0", return { published: false, reason: "opt-out" }.
2. Bash("OB_VAULT_PATH='${vault}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-ingest '${kbFile}' --source-label '${sourceLabel}' 2>&1 | tail -20")
3. Report { published: <true iff output contains "created" or "unchanged" or "updated" with no "Error">, summary: <tail output> }.`,
    { label: "publish-knowledge", phase: "Persist", tier: "big",
      schema: { type: "object", properties: {
        published: { type: "boolean" },
        summary: { type: "string" },
      }, required: ["published"] } },
  )
  if (cli?.published) log(`Knowledge: published → ${vault} (zk-ingest)`)
  else log(`WARNING: knowledge publish skipped/failed — ${(cli?.summary || "").slice(0, 160)}`)
  return cli
}

const publishResult = await publishKnowledge(KB_FILE, NAME)

// ── saveHistory receipt ─────────────────────────────────────────────────────
const runResult = {
  graphKnowledge,
  publishKnowledge: publishResult,
  contract: { graphHealth: contractResult?.graphHealth ?? { ok: false } },
}

const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: NAME,
  started_at: RUN_TS,
  status: "complete",
  tags: ["closed-loop", "proof", "knowledge-graph"],
  result: runResult,
}

const signals = {
  run_quality: (graphKnowledge?.count ?? 0) > 0 && publishResult?.published && contractResult?.graphHealth?.ok ? "good" : "fair",
  key_metric: graphKnowledge?.count ?? 0,
  highlights: [
    `graphKnowledge.count = ${graphKnowledge?.count ?? 0}`,
    `publishKnowledge.published = ${publishResult?.published ?? false}`,
    `contract.graphHealth.ok = ${contractResult?.graphHealth?.ok ?? false}`,
  ],
}

const histJson = JSON.stringify({ ...historyEntry, signals }, null, 2)
const targetPath = `${HISTORY_DIR}/${RUN_ID}.json`
await agent(
  `Persist the history file.
1. Bash("mkdir -p '${HISTORY_DIR}'")
2. Write({ file_path: "${targetPath}", content: <the JSON below> })
3. Bash("test -s '${targetPath}' && echo OK || echo MISSING")
JSON:
${histJson}
Return { written: true, bytes: <file size> }.`,
  { label: "persist-history", phase: "Persist", tier: "small",
    schema: { type: "object", properties: { written: { type: "boolean" }, bytes: { type: "number" } }, required: ["bytes"] } },
)
log(`History: ${targetPath}`)

return {
  runId: RUN_ID,
  graphKnowledgeCount: graphKnowledge?.count ?? 0,
  publishKnowledgePublished: publishResult?.published ?? false,
  contractGraphHealthOk: contractResult?.graphHealth?.ok ?? false,
  historyPath: targetPath,
  ...runResult,
}
