// @ts-nocheck
/**
 * retrieval-quality-self-improve.js — READ-side retrieval-quality loop.
 *
 * Proves (or refutes) that the three-way blend (semantic + lexical + graph)
 * retrieves better than the default lexical+graph mode, with a blind LLM judge
 * and a persisted receipt. The companion to knowledge-distill (WRITE): if
 * distilled cards aren't findable by semantic, the distill is bad.
 *
 * Pipeline (deterministic, journaled):
 *   Generate  — agent crafts N adversarial queries (paraphrased concepts the
 *               title/tags/body lexical strategies are likely to miss) under a
 *               gate() that retries until N valid queries are produced
 *   Retrieve  — pipeline() over queries; each agent runs BOTH
 *               `zk-ask --retrieve-only --blend default` AND `--blend three-way`
 *               via Bash and captures each mode's top-5 seed context
 *   Judge     — pipeline stage 2: a BLIND judge agent gets {query, contextA,
 *               contextB} with labels assigned by DETERMINISTIC alternation
 *               (idx % 2 — the vm forbids the global rng, so no coin-flip blinding)
 *               and returns {winner, relevanceA, relevanceB, reason}; mapped
 *               back to lexical/blend
 *   Persist   — receipt (per-query verdicts, blendWins vs lexicalWins, mean
 *               relevance@5 per mode) + a .knowledge.jsonl record
 *
 * Lives in bun-apps/pi-agent-cli/workflows/ (ENGINE dir) for the gate/pipeline/
 * journal primitives. See docs/workflow-cli.md (two-runtime boundary).
 *
 * INVOCATION
 *   bun --cwd bun-apps/pi-agent-cli src/cli.ts workflow run retrieval-quality-self-improve \
 *     --model lm-studio/google/gemma-4-26b-a4b-qat --thinking medium \
 *     --args '{"queryCount":3,"folder":"Zettelkasten/knowledge-graph"}'
 *
 * REQUIRES vault-mind running (VAULT_MIND_BASE_URL; default 127.0.0.1:8000) for
 * the three-way semantic seed. The retrieve agent detects semantic fallback and
 * flags it — a three-way run that fell back to lexical is reported as
 * `semanticLive:false` and excluded from the blend-wins tally.
 *
 * SAFETY: read-only over the vault; writes only the history receipt + the
 * workflow's own .knowledge.jsonl. Never edits vault cards, never git-applies.
 */

export const meta = {
  name: "retrieval-quality-self-improve",
  description:
    "READ-side retrieval-quality loop: adversarial query-gen → zk-ask --retrieve-only in two blend modes → blind LLM judge (deterministic A/B alternation) → persist receipt + .knowledge.jsonl. Proves blend > lexical with data (mean relevance@5, win tally). Engine workflow — runnable via `pi-agent workflow run`. Needs vault-mind for the semantic seed.",
  phases: [
    { title: "Generate", detail: "adversarial query-gen under gate()" },
    { title: "Retrieve", detail: "pipeline: both blend modes via zk-ask --retrieve-only" },
    { title: "Judge", detail: "pipeline stage 2: blind judge, deterministic A/B" },
    { title: "Persist", detail: "receipt (win tally, relevance@5) + .knowledge.jsonl" },
  ],
}

// ── Args ────────────────────────────────────────────────────────────────────
let resolvedArgs = args
if (typeof resolvedArgs === "string") {
  try { resolvedArgs = JSON.parse(resolvedArgs) } catch { resolvedArgs = {} }
}
const A = (typeof resolvedArgs === "object" && resolvedArgs !== null) ? resolvedArgs : {}

const NAME = "retrieval-quality-self-improve"
const QUERY_COUNT = Math.max(1, Number(A.queryCount ?? 3))
const FOLDER = String(A.folder ?? "Zettelkasten/knowledge-graph")
// --top-k 4 + --thinking medium is the PROVEN-complete driver config (iter-3
// spike): at --thinking low the longer three-way pipeline loops on tool calls
// without emitting the final synthesis turn, so the judge compares a real
// lexical page against a truncated blend page → fake "lexical wins". Tunable
// per-run via args.topK / args.thinkingLevel without code edits.
const TOP_K = Math.max(1, Number(A.topK ?? 4))
const THINKING = String(A.thinkingLevel ?? "medium")

let PROJECT_ROOT = "/Users/huangziyu/proj/video_generation__pi"
let VAULT = `${PROJECT_ROOT}/vaults_root/pi-agent-vault`
let HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
let KB_FILE = `${PROJECT_ROOT}/.claude/workflows/${NAME}.knowledge.jsonl`

// ═════════════════════════════════════════════════════════════════════════
phase("Generate")
// ═════════════════════════════════════════════════════════════════════════

{
  const r = await agent(
    `Bash("git rev-parse --show-toplevel") and return the trimmed path.`,
    { label: "resolve-root", phase: "Generate",
      schema: { type: "object", properties: { root: { type: "string" } }, required: ["root"] } },
  )
  const resolved = (r?.root || "").trim()
  if (resolved && resolved.includes("video_generation")) {
    PROJECT_ROOT = resolved
    VAULT = A.vault ? String(A.vault) : `${PROJECT_ROOT}/vaults_root/pi-agent-vault`
    HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${NAME}`
    KB_FILE = `${PROJECT_ROOT}/.claude/workflows/${NAME}.knowledge.jsonl`
  }
}
const RUN_TS = await agent(
  `Bash("date -u +%Y-%m-%dT%H-%M-%S") and return the timestamp.`,
  { label: "timestamp", phase: "Generate",
    schema: { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] } },
)
const RUN_ID = RUN_TS?.timestamp || "unknown"
log(`Root: ${PROJECT_ROOT} · Vault: ${VAULT} · queries: ${QUERY_COUNT}`)

// ── Adversarial query generation under gate() ───────────────────────────────
const genResult = await gate(
  async (feedback) => {
    const hint = feedback ? `\nPrior attempt feedback: ${feedback}` : ""
    const langInstr = A.queryLang ? `\nIMPORTANT: write every query (text, lexicalMissReason, expectedConcept) in ${A.queryLang}. This tests cross-lingual retrieval — the vault cards may be in a different language, so the queries MUST be in ${A.queryLang} with zero vocabulary overlap with likely card terms.` : ""
    const g = await agent(
      `Craft ${QUERY_COUNT} ADVERSARIAL retrieval-test queries for this Zettelkasten vault.
The goal: queries a LEXICAL search (title/tags/body keyword) handles POORLY but
SEMANTIC (vector) search should win — paraphrased concepts, synonyms, colloquial
phrasings, or symptom→cause framings with no keyword overlap with card titles.
1. Bash("OB_VAULT_PATH='${VAULT}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-card find 'error' --folder '${FOLDER}' --limit 5 2>&1 | head -40")
   to sample what cards exist IN THE TARGET FOLDER ('${FOLDER}'). The queries
   MUST be about concepts documented in THIS folder's cards (read several first
   via zk-card find + obsidian_read if needed) — do NOT generate queries about
   other vault content. The folder is the universe of testable concepts.
2. Produce ${QUERY_COUNT} queries, each about a DISTINCT concept from this
   folder's cards. For each, give: a natural-language question,
   a one-line reason lexical search should miss it, and the expected concept.
Avoid generic queries where title-match trivially wins.
Return { queries: [{ id: <int>, text: <string>, lexicalMissReason: <string>, expectedConcept: <string> }] }.${langInstr}${hint}`,
      { label: "gen-queries", phase: "Generate",
        schema: { type: "object", properties: {
          queries: { type: "array", items: { type: "object", properties: {
            id: { type: "number" }, text: { type: "string" },
            lexicalMissReason: { type: "string" }, expectedConcept: { type: "string" },
          }, required: ["id", "text"] } },
        }, required: ["queries"] } },
    )
    return g
  },
  async (r) => {
    const n = Array.isArray(r?.queries) ? r.queries.length : 0
    const allText = n > 0 && r.queries.every((q) => typeof q?.text === "string" && q.text.trim().length > 5)
    return { ok: n >= QUERY_COUNT && !!allText,
      feedback: `need ${QUERY_COUNT} queries each with a non-empty text (got ${n})` }
  },
  { attempts: 2 },
)
const QUERIES = (genResult.value?.queries ?? []).slice(0, QUERY_COUNT)
log(`Generate: ${QUERIES.length}/${QUERY_COUNT} adversarial queries (attempts ${genResult.attempts})`)

if (QUERIES.length === 0) throw new Error("retrieval-quality-self-improve: query generation failed")

// ═════════════════════════════════════════════════════════════════════════
phase("Retrieve")
// ═════════════════════════════════════════════════════════════════════════

/**
 * Stage 1 of the per-query pipeline: run BOTH blend modes via zk-ask
 * --retrieve-only and capture each mode's assembled context. Reports
 * semanticLive so a fallback run is excluded from the blend-wins tally.
 */
async function retrieveBothModes(qObj, _originalItem, idx) {
  const q = qObj.text
  const esc = q.replace(/'/g, "'\\''")
  const lexFile = `/tmp/rq-${RUN_ID}-${idx}-lexical.txt`
  const blendFile = `/tmp/rq-${RUN_ID}-${idx}-blend.txt`
  const r = await agent(
    `Run zk-ask in TWO retrieval modes, writing EACH mode's FULL output to a file.
CRITICAL: run the two Bash commands SEQUENTIALLY (one at a time, await each
fully before the next) — they share one LM Studio model and concurrent runs
truncate each other's output. Do NOT issue them as parallel tool calls.
(thinking=medium, not low: a low-thinking gemma judge over the ~4-8k-token
retrieve context inverts its own relevance verdicts — see receipt
2026-07-04T17-13-01. top-k 4 + medium is the proven-clean combination.)
1. DEFAULT (lexical+graph):
   Bash("OB_VAULT_PATH='${VAULT}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-ask '${esc}' --retrieve-only --blend default --folder '${FOLDER}' --top-k ${TOP_K} --model lm-studio/google/gemma-4-26b-a4b-qat --thinking ${THINKING} -p > '${lexFile}' 2>&1")
2. THREE-WAY (semantic+lexical+graph):
   Bash("OB_VAULT_PATH='${VAULT}' bun --cwd '${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-ask '${esc}' --retrieve-only --blend three-way --folder '${FOLDER}' --top-k ${TOP_K} --model lm-studio/google/gemma-4-26b-a4b-qat --thinking ${THINKING} -p > '${blendFile}' 2>&1")
   The vault-mind service is running at the default 127.0.0.1:8000 — do NOT override VAULT_MIND_BASE_URL.
3. Bash("wc -c '${lexFile}' '${blendFile}'")
4. Peek each file's tail to set flags, but DO NOT relay the content — the judge reads the files directly:
   Bash("grep -c 'obsidian_semantic_search' '${blendFile}'; grep -Ei 'iserror|fall back|unreachable' '${blendFile}' | head -1")
   semanticLive = true iff the blend file's semantic_search count > 0 AND no isError/fallback/unreachable line.
Return { lexicalFile: "${lexFile}", blendFile: "${blendFile}", semanticLive: <bool>, lexicalBytes: <int>, blendBytes: <int> }.`,
    { label: `retrieve-${idx + 1}`, phase: "Retrieve",
      schema: { type: "object", properties: {
        lexicalFile: { type: "string" }, blendFile: { type: "string" },
        semanticLive: { type: "boolean" },
        lexicalBytes: { type: "number" }, blendBytes: { type: "number" },
      }, required: ["lexicalFile", "blendFile", "semanticLive"] } },
  )
  log(`Retrieve [${idx + 1}/${QUERIES.length}] "${q.slice(0, 40)}…" — semanticLive ${r?.semanticLive ?? false} (lex ${r?.lexicalBytes ?? 0}B, blend ${r?.blendBytes ?? 0}B)`)
  return { query: qObj, retrieve: r ?? { lexicalFile: lexFile, blendFile, semanticLive: false } }
}

/**
 * Stage 2 of the per-query pipeline: a BLIND judge. Labels assigned by
 * DETERMINISTIC alternation (idx % 2) — the vm forbids the global rng, so no
 * coin-flip blinding. The judge is a fresh agent with no knowledge of the
 * assignment scheme.
 */
async function blindJudge(item, _originalItem, idx) {
  if (!item?.retrieve) return null
  const { query, retrieve } = item
  const lexicalIsA = (idx % 2) === 0
  const fileA = lexicalIsA ? retrieve.lexicalFile : retrieve.blendFile
  const fileB = lexicalIsA ? retrieve.blendFile : retrieve.lexicalFile
  const j = await agent(
    `You are a blind retrieval-quality judge. TWO retrieval runs have written
their full zk-ask --retrieve-only output to files. Read BOTH, then pick which
note-set better answers the question by MEANING, and rate each set's
relevance@${TOP_K} (0-1: fraction of surfaced notes on-topic to the intent).
Ignore [tool]/[tool done] scaffolding lines — focus on the assembled context
and the **Reference notes** list (the actual surfaced cards).
1. Bash("cat '${fileA}'")
2. Bash("cat '${fileB}'")
Do NOT assume A or B is lexical/semantic — judge only by content fit.

Question: ${query.text}
Expected concept: ${query.expectedConcept ?? "(unspecified)"}

Return { winner: "A" | "B" | "tie", relevanceA: <0-1>, relevanceB: <0-1>,
  reason: <one sentence citing the deciding card(s)> }.`,
    { label: `judge-${idx + 1}`, phase: "Judge",
      schema: { type: "object", properties: {
        winner: { type: "string" }, relevanceA: { type: "number" }, relevanceB: { type: "number" },
        reason: { type: "string" },
      }, required: ["winner", "relevanceA", "relevanceB"] } },
  )
  // Map A/B back to lexical/blend
  let blendRel, lexicalRel, blendWins
  if (lexicalIsA) {
    lexicalRel = j?.relevanceA ?? 0
    blendRel = j?.relevanceB ?? 0
    blendWins = j?.winner === "B"
  } else {
    blendRel = j?.relevanceA ?? 0
    lexicalRel = j?.relevanceB ?? 0
    blendWins = j?.winner === "A"
  }
  const tie = j?.winner === "tie"
  const verdict = {
    id: query.id ?? idx + 1, query: query.text, expectedConcept: query.expectedConcept,
    lexicalMissReason: query.lexicalMissReason,
    semanticLive: retrieve.semanticLive,
    lexicalRelevance: lexicalRel, blendRelevance: blendRel,
    winner: tie ? "tie" : (blendWins ? "blend" : "lexical"),
    judgeReason: j?.reason ?? "",
  }
  log(`Judge [${idx + 1}/${QUERIES.length}] winner=${verdict.winner} (lex ${lexicalRel.toFixed(2)} vs blend ${blendRel.toFixed(2)})`)
  return verdict
}

// Sequential (not pipeline) per-query retrieve→judge. Concurrent zk-ask runs
// share one LM Studio model and truncate each other's -p output, so we
// serialize: await both modes + the judge for query i before starting query i+1.
const verdicts = []
for (let i = 0; i < QUERIES.length; i++) {
  const retrieved = await retrieveBothModes(QUERIES[i], QUERIES[i], i)
  const verdict = await blindJudge(retrieved, QUERIES[i], i)
  if (verdict) verdicts.push(verdict)
}
const valid = verdicts.filter((v) => v && v.semanticLive !== false && v.semanticLive !== undefined)
const semanticLiveCount = verdicts.filter((v) => v?.semanticLive).length

// ═════════════════════════════════════════════════════════════════════════
phase("Persist")
// ═════════════════════════════════════════════════════════════════════════

const tally = valid.reduce((acc, v) => {
  acc.blendWins += v.winner === "blend" ? 1 : 0
  acc.lexicalWins += v.winner === "lexical" ? 1 : 0
  acc.ties += v.winner === "tie" ? 1 : 0
  acc.sumLexicalRel += v.lexicalRelevance ?? 0
  acc.sumBlendRel += v.blendRelevance ?? 0
  return acc
}, { blendWins: 0, lexicalWins: 0, ties: 0, sumLexicalRel: 0, sumBlendRel: 0 })

const meanLexicalRel = valid.length ? tally.sumLexicalRel / valid.length : 0
const meanBlendRel = valid.length ? tally.sumBlendRel / valid.length : 0
const blendBetter = tally.blendWins > tally.lexicalWins && meanBlendRel > meanLexicalRel

const runResult = {
  queryCount: QUERIES.length,
  semanticLiveCount,
  semanticLiveRatio: QUERIES.length ? semanticLiveCount / QUERIES.length : 0,
  verdicts,
  tally,
  meanLexicalRelevance: meanLexicalRel,
  meanBlendRelevance: meanBlendRel,
  blendBetterOverall: blendBetter,
}

const historyEntry = {
  schema_version: 1,
  run_id: RUN_ID,
  workflow: NAME,
  started_at: RUN_TS,
  status: "complete",
  tags: ["knowledge", "retrieval-quality", "read-side", "blend"],
  result: runResult,
}

const signals = {
  run_quality: blendBetter ? "good" : (semanticLiveCount > 0 ? "fair" : "poor"),
  key_metric: tally.blendWins,
  highlights: [
    `blend wins = ${tally.blendWins} / ${valid.length} (lexical ${tally.lexicalWins}, ties ${tally.ties})`,
    `mean relevance@${TOP_K}: lexical ${meanLexicalRel.toFixed(3)} vs blend ${meanBlendRel.toFixed(3)}`,
    `semanticLive = ${semanticLiveCount}/${QUERIES.length} queries`,
    `blendBetterOverall = ${blendBetter}`,
  ],
}

const histJson = JSON.stringify({ ...historyEntry, signals }, null, 2)
const targetPath = `${HISTORY_DIR}/${RUN_ID}.json`
await agent(
  `Persist the history file AND append a knowledge.jsonl record.
1. Bash("mkdir -p '${HISTORY_DIR}'")
2. Write({ file_path: "${targetPath}", content: <the JSON below> })
3. Append (create if missing) one JSONL line to '${KB_FILE}' with this exact object on one line:
   {"id":"retrieval-quality:${RUN_ID}","type":"finding","title":"three-way blend vs lexical — ${tally.blendWins}/${valid.length} blend wins (mean rel blend ${meanBlendRel.toFixed(2)} vs lexical ${meanLexicalRel.toFixed(2)})","detail":"${(signals.highlights.join("; ")).replace(/"/g, "'")}","tags":["retrieval","blend","semantic"],"dimension":"quality","confidence":${blendBetter ? 0.8 : 0.4},"status":"active","superseded_by":null}
4. Bash("test -s '${targetPath}' && echo OK || echo MISSING")
JSON for step 2:
${histJson}
Return { written: true, bytes: <file size> }.`,
  { label: "persist-history", phase: "Persist",
    schema: { type: "object", properties: { written: { type: "boolean" }, bytes: { type: "number" } }, required: ["bytes"] } },
)
log(`History: ${targetPath}`)
log(`KB: ${KB_FILE}`)

return {
  runId: RUN_ID,
  queryCount: QUERIES.length,
  blendWins: tally.blendWins,
  lexicalWins: tally.lexicalWins,
  ties: tally.ties,
  meanBlendRelevance: meanBlendRel,
  meanLexicalRelevance: meanLexicalRel,
  blendBetterOverall: blendBetter,
  semanticLiveCount,
  historyPath: targetPath,
  ...runResult,
}
