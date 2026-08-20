// @ts-nocheck
/**
 * knowledge-distill.js — deterministic WRITE-side distill pipeline.
 *
 * Takes a codebase source (a GitHub PR thread via `gh`, or one or more
 * markdown/text files, or a session's `.operation-lessons.jsonl`) and distils
 * it into atomic, graph-linked vault cards UNDER ENGINE GATE CONTROL — not a
 * one-shot agent run.
 *
 * Pipeline (each step is a journaled agent() call, resume-safe):
 *   Resolve   — repo root, vault, source list; fetch PR thread → temp .md if --pr
 *   Baseline  — count cards in the target folder + graphHealth snapshot (before)
 *   Distill   — pipeline() over sources; each source runs zk-extract under a
 *               gate() that retries on failure (validator: exitOk && notesCreated>0)
 *   GraphLink — OPTIONAL: when --knowledge-file is given, zk-ingest writes
 *               cross-source graph edges (the structured .knowledge.jsonl path)
 *   Garden    — gate() around zk-card check + zk-query --health; validator:
 *               graphHealth.ok && no fatal orphans. Feedback feeds a repair retry
 *   Persist   — history receipt: cardsBefore/cardsAfter, delta, graphHealth
 *               before/after, sources, gate verdict, per-source distill trace
 *
 * This lives in bun-apps/s2-agent/workflows/ (the ENGINE dir) on purpose:
 * the deterministic gate/retry/pipeline primitives only exist in the
 * s2-agent-ext-workflow engine vm, NOT in Claude Code's Workflow tool. See
 * ../docs/workflow-cli.md (two-runtime boundary).
 *
 * INVOCATION
 *   bun --cwd bun-apps/s2-agent src/cli.ts cli workflow run knowledge-distill \
 *     --model lm-studio/google/gemma-4-12b --thinking medium \
 *     --args '{"pr":244,"folder":"Zettelkasten/distill"}'
 *   # or from markdown sources:
 *   --args '{"sources":["./notes.md"],"folder":"Zettelkasten/distill"}'
 *   # driver default: thinkingLevel=medium (args.thinkingLevel overrides)
 *
 * SAFETY: writes only to the target vault folder + history receipt. It never
 * touches source code, never git-applies, never pushes. The garden gate is a
 * floor (no orphans/dead-links), not a ceiling on card quality — the READ-side
 * retrieval loop is the real quality signal.
 */

export const meta = {
  name: "knowledge-distill",
  description:
    "Deterministic WRITE-side distill: codebase source (PR thread via gh, markdown files, or .operation-lessons.jsonl) → zk-extract atomise under gate/retry → optional zk-ingest graph-link → garden gate (zk-card check + zk-query --health). pipeline over sources. Produces ≥N atomic vault cards + a history receipt. Engine workflow — runnable via `s2-agent workflow run`.",
  phases: [
    { title: "Resolve", detail: "repo root, vault, source list; fetch PR if --pr" },
    { title: "Baseline", detail: "cards-before count + graphHealth snapshot" },
    { title: "Distill", detail: "pipeline over sources: zk-extract under gate()" },
    { title: "GraphLink", detail: "optional zk-ingest when --knowledge-file given" },
    { title: "Garden", detail: "gate(): zk-card check + zk-query --health" },
    { title: "Persist", detail: "history receipt (cardsBefore/After, gate verdict)" },
  ],
}

// ── Args ────────────────────────────────────────────────────────────────────
let resolvedArgs = args
if (typeof resolvedArgs === "string") {
  try { resolvedArgs = JSON.parse(resolvedArgs) } catch { resolvedArgs = {} }
}
const A = (typeof resolvedArgs === "object" && resolvedArgs !== null) ? resolvedArgs : {}

const NAME = "knowledge-distill"
const FOLDER = String(A.folder ?? "Zettelkasten/distill")
const MAX_NOTES = Number(A.maxNotes ?? 16)
const MIN_CARDS = Number(A.minCards ?? 10)
// zk-extract spawns a distill subagent that makes many tool calls then writes
// cards — same class of longer multi-tool pipeline as zk-ask --blend three-way.
// --thinking low truncates it (subagent loops without emitting all cards); medium
// is the proven-complete level. Tunable per-run via args.thinkingLevel.
const THINKING = String(A.thinkingLevel ?? "medium")
const PR_LIST = Array.isArray(A.pr) ? A.pr.map((n) => Number(n)).filter((n) => Number.isFinite(n))
  : (A.pr != null && Number.isFinite(Number(A.pr))) ? [Number(A.pr)]
  : []
const KNOWLEDGE_FILE = A.knowledgeFile ? String(A.knowledgeFile) : null
let SOURCES = Array.isArray(A.sources) ? A.sources.map(String) : []

// ── Paths (resolved dynamically; defaults are placeholders) ─────────────────
let PROJECT_ROOT = "/Users/huangziyu/proj/video_generation__pi"
let VAULT = `${PROJECT_ROOT}/vaults_root/s2-agent-vault`
let HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`

// ── Small schema helpers ────────────────────────────────────────────────────
const SCHEMA_ROOT = { type: "object", properties: { root: { type: "string" } }, required: ["root"] }
const SCHEMA_TS = { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] }
const SCHEMA_COUNT = {
  type: "object", properties: { count: { type: "number" }, ok: { type: "boolean" }, raw: { type: "string" } },
  required: ["count"],
}

// ═════════════════════════════════════════════════════════════════════════
phase("Resolve")
// ═════════════════════════════════════════════════════════════════════════

{
  const r = await agent(
    `Bash("git rev-parse --show-toplevel") and return the trimmed path.`,
    { label: "resolve-root", phase: "Resolve", schema: SCHEMA_ROOT },
  )
  const resolved = (r?.root || "").trim()
  if (resolved && resolved.includes("video_generation")) {
    PROJECT_ROOT = resolved
    VAULT = A.vault ? String(A.vault) : `${PROJECT_ROOT}/vaults_root/s2-agent-vault`
    HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
  }
}
const RUN_TS = await agent(
  `Bash("date -u +%Y-%m-%dT%H-%M-%S") and return the timestamp.`,
  { label: "timestamp", phase: "Resolve", schema: SCHEMA_TS },
)
const RUN_ID = RUN_TS?.timestamp || "unknown"
log(`Root: ${PROJECT_ROOT}`)
log(`Vault: ${VAULT} (folder: ${FOLDER})`)

// ── Fetch PR thread(s) if --pr given (single number OR array) ───────────────
for (const PR of PR_LIST) {
  const prMd = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}/pr-${PR}.md`
  const fetchPr = await agent(
    `Fetch GitHub PR #${PR} thread and render it to a markdown file for distillation.
1. Bash("mkdir -p '${PROJECT_ROOT}/.claude/workflows/history/${NAME}'")
2. Bash("gh pr view ${PR} --json title,number,body,comments,reviews,files,commits --repo ziyu4huang/video_generation > '${prMd}'")
3. Bash("test -s '${prMd}' && wc -c < '${prMd}'")
If the fetch failed (empty/missing file), set ok=false.
Return { ok: <true iff file exists and is non-empty>, path: "${prMd}", bytes: <size or 0> }.`,
    { label: `fetch-pr-${PR}`, phase: "Resolve",
      schema: { type: "object", properties: { ok: { type: "boolean" }, path: { type: "string" }, bytes: { type: "number" } }, required: ["ok", "path"] } },
  )
  if (fetchPr?.ok) {
    SOURCES = [...SOURCES, prMd]
    log(`PR #${PR}: fetched ${fetchPr.bytes} bytes → ${prMd}`)
  } else {
    log(`WARNING: PR #${PR} fetch failed — continuing with ${SOURCES.length} explicit source(s)`)
  }
}

if (SOURCES.length === 0) {
  throw new Error(
    "knowledge-distill: no sources. Pass --args '{\"pr\":<n>}' or '{\"sources\":[\"file.md\",...]}'.",
  )
}
log(`Sources: ${SOURCES.length} — ${SOURCES.join(", ")}`)

// ═════════════════════════════════════════════════════════════════════════
phase("Baseline")
// ═════════════════════════════════════════════════════════════════════════

async function countCards(folder) {
  const r = await agent(
    `Count markdown files in the vault folder.
Bash("find '${VAULT}/${folder}' -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' '")
Return { count: <integer>, ok: true }.`,
    { label: `count-${folder.split("/").pop()}`, phase: "Baseline", schema: SCHEMA_COUNT },
  )
  return r?.count ?? 0
}

async function graphHealthSnapshot() {
  const r = await agent(
    `Run the knowledge-graph health audit CLI and report the result.
Bash("OB_VAULT_PATH='${VAULT}' bun --cwd '${PROJECT_ROOT}/bun-apps/s2-agent' src/cli.ts cli zk-query --health 2>&1")
ok = true iff the output contains "status:  OK".
Return { ok, orphans: <int, default 0>, deadLinks: <int, default 0>, summary: <full output> }.`,
    { label: "graph-health-before", phase: "Baseline",
      schema: { type: "object", properties: {
        ok: { type: "boolean" }, orphans: { type: "number" }, deadLinks: { type: "number" }, summary: { type: "string" },
      }, required: ["ok"] } },
  )
  return r ?? { ok: false, orphans: 0, deadLinks: 0, summary: "" }
}

const cardsBefore = await countCards(FOLDER)
const healthBefore = await graphHealthSnapshot()
log(`Baseline: ${cardsBefore} card(s) in ${FOLDER}; graphHealth ${healthBefore.ok ? "OK" : "DRIFT"}`)

// ═════════════════════════════════════════════════════════════════════════
phase("Distill")
// ═════════════════════════════════════════════════════════════════════════

/**
 * Distil a single source under a gate(). The thunk runs zk-extract via Bash;
 * the validator requires exitOk AND at least one note created. gate() feeds
 * failure feedback into the retry attempt.
 */
async function distilSource(src, idx) {
  const label = `distil-${idx + 1}-${src.split("/").pop()}`
  const result = await gate(
    async (feedback) => {
      const hint = feedback ? `\nPrior attempt feedback: ${feedback}` : ""
      const r = await agent(
        `Atomise a source file into Zettelkasten atomic notes via zk-extract.
1. Bash("OB_VAULT_PATH='${VAULT}' bun --cwd '${PROJECT_ROOT}/bun-apps/s2-agent' src/cli.ts cli zk-extract '${src}' --folder '${FOLDER}' --max-notes ${MAX_NOTES} --model lm-studio/google/gemma-4-12b --thinking ${THINKING} -p 2>&1 | tail -40")
2. The command spawns a distill subagent that writes atomic notes to '${VAULT}/${FOLDER}'.
3. After it returns, count the cards created:
   Bash("find '${VAULT}/${FOLDER}' -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' '")
Return { exitOk: <true iff the zk-extract output has no "Error"/"error:" line>, notesCreated: <count AFTER minus known baseline, or just the count>, output: <tail of zk-extract output> }.${hint}`,
        { label, phase: "Distill",
          schema: { type: "object", properties: {
            exitOk: { type: "boolean" }, notesCreated: { type: "number" }, output: { type: "string" },
          }, required: ["exitOk", "notesCreated"] } },
      )
      return r
    },
    async (r) => {
      const ok = !!r?.exitOk && (Number(r?.notesCreated) || 0) > 0
      return {
        ok,
        feedback: ok ? undefined : `zk-extract did not produce notes (exitOk=${r?.exitOk}, notesCreated=${r?.notesCreated}); check the model is reachable and the source is non-empty`,
      }
    },
    { attempts: 2 },
  )
  log(`Distil [${idx + 1}/${SOURCES.length}] ${src.split("/").pop()}: ${result.ok ? "ok" : "FAILED"} — ${result.value?.notesCreated ?? 0} note(s)`)
  return { source: src, ok: result.ok, attempts: result.attempts, notesCreated: result.value?.notesCreated ?? 0 }
}

const distillTrace = await pipeline(SOURCES, distilSource)
const totalCreated = distillTrace.reduce((s, t) => s + (t?.notesCreated ?? 0), 0)
log(`Distill: ${distillTrace.filter((t) => t?.ok).length}/${SOURCES.length} source(s) ok; ${totalCreated} note(s) created`)

// ═════════════════════════════════════════════════════════════════════════
phase("GraphLink") // optional — only when a structured .knowledge.jsonl is given
// ═════════════════════════════════════════════════════════════════════════

let ingestResult = { ran: false, published: false }
if (KNOWLEDGE_FILE) {
  const kf = `${PROJECT_ROOT}/${KNOWLEDGE_FILE}`
  const r = await agent(
    `Graph-link a structured knowledge.jsonl into the vault via zk-ingest.
1. Bash("test -f '${kf}' && echo EXISTS || echo MISSING")
2. If EXISTS: Bash("OB_VAULT_PATH='${VAULT}' bun --cwd '${PROJECT_ROOT}/bun-apps/s2-agent' src/cli.ts cli zk-ingest '${kf}' --source-label 'workflow-jsonl:${NAME}' 2>&1 | tail -20")
3. Report { ran: true, published: <true iff output contains "created"/"updated"/"unchanged" with no "Error">, summary: <tail> }.
If MISSING, return { ran: false, published: false, summary: "knowledge file not found" }.`,
    { label: "zk-ingest", phase: "GraphLink",
      schema: { type: "object", properties: { ran: { type: "boolean" }, published: { type: "boolean" }, summary: { type: "string" } }, required: ["ran", "published"] } },
  )
  ingestResult = r ?? ingestResult
  log(`GraphLink: zk-ingest ${ingestResult.published ? "published" : "skipped/failed"} ← ${KNOWLEDGE_FILE}`)
} else {
  log("GraphLink: skipped (no --knowledge-file; freeform cards rely on distill-time [[]] links)")
}

// ═════════════════════════════════════════════════════════════════════════
phase("Garden")
// ═════════════════════════════════════════════════════════════════════════

/**
 * Garden gate: zk-card check (orphans/dead-links/duplicates) + zk-query --health.
 * Validator requires graphHealth.ok && orphans<=cardsAfter (no catastrophic
 * orphaning). On fail, feedback tells the next attempt to repair via zk-card.
 */
const garden = await gate(
  async (feedback) => {
    const hint = feedback ? `\nPrior attempt feedback: ${feedback}` : ""
    const r = await agent(
      `Audit vault garden health after distillation.
1. Bash("OB_VAULT_PATH='${VAULT}' bun --cwd '${PROJECT_ROOT}/bun-apps/s2-agent' src/cli.ts cli zk-card check 2>&1 | tail -30")
2. Bash("OB_VAULT_PATH='${VAULT}' bun --cwd '${PROJECT_ROOT}/bun-apps/s2-agent' src/cli.ts cli zk-query --health 2>&1")
3. Parse both outputs: graphHealthOk = the --health output contains "status:  OK"; count orphans/deadLinks if reported (default 0).
${feedback ? `4. Repair attempt: if there are orphaned new cards, link them by appending a "## 連結" section with a [[]] link to a related tag/MOC card via obsidian_append_section, then re-audit.\n` : ""}Return { graphHealthOk, orphans, deadLinks, duplicates, summary: <combined tail> }.${hint}`,
      { label: "garden-gate", phase: "Garden",
        schema: { type: "object", properties: {
          graphHealthOk: { type: "boolean" }, orphans: { type: "number" }, deadLinks: { type: "number" },
          duplicates: { type: "number" }, summary: { type: "string" },
        }, required: ["graphHealthOk"] } },
    )
    return r
  },
  async (r) => {
    const ok = !!r?.graphHealthOk && Number(r?.deadLinks ?? 0) === 0
    return {
      ok,
      feedback: ok ? undefined : `garden not healthy (graphHealthOk=${r?.graphHealthOk}, deadLinks=${r?.deadLinks}); repair orphaned/dead-linked cards`,
    }
  },
  { attempts: 2 },
)
log(`Garden: ${garden.ok ? "OK" : "DRIFT"} — graphHealth ${garden.value?.graphHealthOk ? "OK" : "DRIFT"}, orphans ${garden.value?.orphans ?? "?"}, deadLinks ${garden.value?.deadLinks ?? "?"}`)

// ═════════════════════════════════════════════════════════════════════════
phase("Persist")
// ═════════════════════════════════════════════════════════════════════════

const cardsAfter = await countCards(FOLDER)
const netNew = Math.max(0, cardsAfter - cardsBefore)
const healthAfter = garden.value ?? {}

const runResult = {
  sources: SOURCES,
  folder: FOLDER,
  cardsBefore,
  cardsAfter,
  netNew,
  minCardsTarget: MIN_CARDS,
  metTarget: netNew >= MIN_CARDS,
  distill: { trace: distillTrace, totalCreated },
  graphLink: ingestResult,
  garden: { ok: garden.ok, attempts: garden.attempts, ...healthAfter },
  healthBefore: { ok: healthBefore.ok, orphans: healthBefore.orphans, deadLinks: healthBefore.deadLinks },
}

const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: NAME,
  started_at: RUN_TS,
  status: "complete",
  tags: ["knowledge", "distill", "write-side"],
  result: runResult,
}

const signals = {
  run_quality: netNew >= MIN_CARDS && garden.ok ? "good" : (netNew > 0 ? "fair" : "poor"),
  key_metric: netNew,
  highlights: [
    `netNew = ${netNew} (target ≥${MIN_CARDS})`,
    `distill ok = ${distillTrace.filter((t) => t?.ok).length}/${SOURCES.length}`,
    `garden ok = ${garden.ok}`,
    `graphHealth before→after = ${healthBefore.ok ? "OK" : "DRIFT"}→${healthAfter.graphHealthOk ? "OK" : "DRIFT"}`,
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
  { label: "persist-history", phase: "Persist",
    schema: { type: "object", properties: { written: { type: "boolean" }, bytes: { type: "number" } }, required: ["bytes"] } },
)
log(`History: ${targetPath}`)

return {
  runId: RUN_ID,
  netNew,
  metTarget: netNew >= MIN_CARDS,
  distillOk: `${distillTrace.filter((t) => t?.ok).length}/${SOURCES.length}`,
  gardenOk: garden.ok,
  graphHealthAfter: healthAfter.graphHealthOk ?? false,
  historyPath: targetPath,
  ...runResult,
}
