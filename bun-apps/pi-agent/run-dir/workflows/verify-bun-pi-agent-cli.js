export const meta = {
  name: 'verify-bun-pi-agent-cli',
  description: 'Dynamic end-to-end verification of the pi-agent CLI (resolve paths -> build bundle+sourcemap -> smoke -> regression on academic-paper fixture)',
  whenToUse: 'Verifies the pi-agent CLI bundle end-to-end and writes <runDir>/result.jsonl for compare.ts. TWO MODES selected by `stage1From`: (1) FULL baseline re-check — OMIT stage1From to re-run VLM stage1 + distill stage2 (validates both stage code paths; ~6 min; needs LM Studio + distill creds + fixture). (2) DISTILL-MODEL comparison — pass stage1From=docs/benchmarks/verify-bun-pi-agent-cli/stage1-seed-emnlp-893 to reuse the committed stage1 and SKIP the VLM (vary only the distill model; regression ~2 min / full ~5 min; needs distill creds, NOT LM Studio). ARGS: distillModel (default zai/glm-5.3), vlmModel (default lm-studio/google/gemma-4-12b), regPages (1-3), fixtureName, repoRoot (default git toplevel), runRoot (default <repoRoot>/tmp, gitignored). Phases degrade gracefully (skipped + logged) when a prerequisite is absent — see the file-top comment for the full phase list, prerequisites & graceful-degradation rules.',  phases: [
    { title: 'Resolve', detail: 'resolve absolute paths + health-check + fresh runDir (no cwd/worktree drift)' },
    { title: 'Build', detail: 'bundle + external sourcemap; gate on success' },
    { title: 'Smoke', detail: 'offline meta + passthrough + distill via the dist bundle' },
    { title: 'Knowledge', detail: 'live knowledge CRUD lifecycle (add/find/update/check/remove) + fast error-path attacks' },
    { title: 'Robust', detail: 'attack/graceful-failure checks (bad input, invalid flags, path-traversal slug safety)' },
    { title: 'Regression', detail: 'pipeline pdf-to-vault on fixture PDF; reuse stage1 via stage1From (skip VLM); verify distill quality + resume' },
    { title: 'Store Results', detail: 'write <runDir>/result.jsonl (summary + per-check) for compare.ts' },
  ],
}

// args derive from args only and are cwd-independent. All repo/output paths are
// resolved at runtime in the Resolve phase below — never hardcoded — so the
// workflow survives agent cwd drift across worktrees and sandboxes.
// Normalize args FIRST: the Workflow runtime can deliver args as a JSON-encoded
// string, in which case `args.x` is undefined and values silently fall back.
// (Mirrors pi-extension-obsidian-tool.js args normalization.)
let _args = args
if (typeof _args === 'string') {
  try { _args = JSON.parse(_args) } catch { _args = {} }
}
const A = _args ?? {}
const CFG = {
  repoRoot: A.repoRoot ?? '',            // '' => resolve agent detects via `git rev-parse --show-toplevel`
  cliPkg: A.cliPkg ?? 'bun-apps/pi-agent',
  fixtureName: A.fixtureName ?? '2025.emnlp-main.893.pdf',
  runRoot: A.runRoot ?? '',              // '' => <repoRoot>/tmp (gitignored; resolved in Resolve)
  distillModel: A.distillModel ?? 'zai/glm-5.3',
  vlmModel: A.vlmModel ?? 'lm-studio/google/gemma-4-12b',  regPages: A.regPages ?? '1-3',
  stage1From: A.stage1From ?? '',        // dir containing 1-pdf-to-md/<slug>/ to REUSE (skip VLM stage1; control variation across distill models)
}
// distillSlug keys the per-run dir + result filename; identical to pdf-to-vault's slug for the fixture.
const DISTILL_SLUG = CFG.distillModel.replace(/\//g, '-')

const RESOLVED_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['repoRoot','cliDir','bundleDir','bundlePath','sourcemapPath','fixtureDir','fixturePdfPath','runDir','ts','date','distillModel','vlmModel','regPages','lmStudioUp','credsPresent','fixtureReady','lmStudioModels','bunVersion','notes'],
  properties: {
    repoRoot:{type:'string'}, cliDir:{type:'string'}, bundleDir:{type:'string'},
    bundlePath:{type:'string'}, sourcemapPath:{type:'string'},
    fixtureDir:{type:'string'}, fixturePdfPath:{type:'string'}, runDir:{type:'string'},
    ts:{type:'string'}, date:{type:'string'},
    distillModel:{type:'string'}, vlmModel:{type:'string'}, regPages:{type:'string'},
    lmStudioUp:{type:'boolean'}, credsPresent:{type:'boolean'}, fixtureReady:{type:'boolean'},
    lmStudioModels:{type:'array', items:{type:'string'}}, bunVersion:{type:'string'}, notes:{type:'string'},
  },
}
const BUILD_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['ok','bundlePath','sourcemapPath','bundleSizeKB','sourcemapPresent','logTail'],
  properties:{
    ok:{type:'boolean'}, bundlePath:{type:'string'}, sourcemapPath:{type:'string'},
    bundleSizeKB:{type:'integer'}, sourcemapPresent:{type:'boolean'}, logTail:{type:'string'},
  },
}
const SMOKE_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['name','ok','summary','evidence'],
  properties:{ name:{type:'string'}, ok:{type:'boolean'}, summary:{type:'string'}, evidence:{type:'string'} },
}
const REGRUN_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['ok','runDir','status','stage1PagesDone','stage2Notes','stage1RerunVlm','error','logTail'],
  properties:{
    ok:{type:'boolean'}, runDir:{type:'string'}, status:{type:'string'},
    stage1PagesDone:{type:'integer'}, stage2Notes:{type:'integer'},
    stage1RerunVlm:{type:'boolean'},
    error:{type:'string'}, logTail:{type:'string'},
  },
}
const REGQUAL_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['aspect','ok','score','findings'],
  properties:{ aspect:{type:'string'}, ok:{type:'boolean'}, score:{type:'integer'}, findings:{type:'string'} },
}
const ROBUST_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['name','graceful','summary','evidence'],
  properties:{ name:{type:'string'}, graceful:{type:'boolean'}, summary:{type:'string'}, evidence:{type:'string'} },
}
const KNOW_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['name','ok','summary','evidence'],
  properties:{ name:{type:'string'}, ok:{type:'boolean'}, summary:{type:'string'}, evidence:{type:'string'} },
}
const ENSURE_RUNDIR_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['realpath'],
  properties:{ realpath:{type:'string'} },
}
const SEED_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['seedDir','slug','manifestPagesDone','manifestPagesTotal','copiedOk','notes'],
  properties:{
    seedDir:{type:'string'}, slug:{type:'string'},
    manifestPagesDone:{type:'integer'}, manifestPagesTotal:{type:'integer'},
    copiedOk:{type:'boolean'}, notes:{type:'string'},
  },
}
const STORE_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['written','lineCount','firstLineKind'],
  properties:{ written:{type:'boolean'}, lineCount:{type:'integer'}, firstLineKind:{type:'string'} },
}

// ---------------- Resolve ----------------
// NOTE: credsPresent below only checks ZAI_API_KEY, NOT other provider env vars
// (e.g. DEEPSEEK_API_KEY for deepseek/*). This is an accepted limitation — live
// phases (smoke, knowledge, regression) skip when using a non-zai distillModel.
// Do not add provider-adaptive credential checks without an explicit user request.
phase('Resolve')
const repoRootHint = CFG.repoRoot ? `Candidate repoRoot (already absolute): ${CFG.repoRoot}. Use \`realpath\` of it.` : `No repoRoot given. Detect it: \`git rev-parse --show-toplevel\` (run from anywhere; do NOT rely on cwd).`
const resolvePrompt = `You are the RESOLVE phase of a verification workflow. Goal: resolve every path to a CANONICAL ABSOLUTE form, create a FRESH timestamped run dir, and health-check the environment — so downstream phases never depend on cwd or a hardcoded worktree.

Inputs:
- ${repoRootHint}
- cli package name: ${CFG.cliPkg}
- fixture filename: ${CFG.fixtureName}
- runRoot (parent for the fresh run dir): ${CFG.runRoot || '<repoRoot>/tmp (default; repo-local, gitignored)'}
- distillModel: ${CFG.distillModel}
- vlmModel: ${CFG.vlmModel}
- regPages: ${CFG.regPages}

Do this via Bash (absolute paths only; do NOT rely on cwd):
1. repoRoot = canonical absolute repo root (realpath of the candidate, or \`git rev-parse --show-toplevel\`). Confirm \`${CFG.cliPkg}/src/cli.ts\` exists under it.
2. Derive: cliDir=<repoRoot>/${CFG.cliPkg}; bundleDir=<repoRoot>/dist/$(basename "${CFG.cliPkg}"); bundlePath=<bundleDir>/pi-agent.js; sourcemapPath=<bundlePath>.map; fixtureDir=<repoRoot>/fixture; fixturePdfPath=<fixtureDir>/${CFG.fixtureName}.
3. fixtureReady = test -f <fixturePdfPath>.
4. Create a FRESH runDir keyed by the distill slug + timestamp. First: \`ts=$(date +%Y%m%d-%H%M%S); date=$(date -u +%F)\`. runParent = ${CFG.runRoot ? `the given runRoot "${CFG.runRoot}" (absolute)` : '<repoRoot>/tmp (mkdir -p it first)'}. Then: \`runDir="$runParent/${DISTILL_SLUG}-$ts"; mkdir -p "$runDir"; realpath "$runDir"\`. runDir = that realpath. Capture ts and date for the return.
5. lmStudioUp: \`curl -s -m 4 http://localhost:1234/v1/models\`; parse model ids into lmStudioModels; lmStudioUp = request succeeded and includes >=1 model.
6. credsPresent = \`test -n "$ZAI_API_KEY"\`.
7. bunVersion = \`bun --version\`.

Return the StructuredOutput object with EXACTLY these fields: repoRoot, cliDir, bundleDir, bundlePath, sourcemapPath, fixtureDir, fixturePdfPath, runDir, ts, date, distillModel, vlmModel, regPages, lmStudioUp, credsPresent, fixtureReady, lmStudioModels (array of id strings), bunVersion, notes (1-line). Do not omit any field.`
const RESOLVED = await agent(resolvePrompt, { schema: RESOLVED_SCHEMA, phase: 'Resolve', label: 'resolve-paths' })
if (!RESOLVED) return { aborted: 'resolve agent returned nothing', CFG }

// ── Deterministic runDir. Do NOT trust the resolve agent to format the path —
// it has repeatedly ignored the <runRoot>/<distillSlug>-<ts> contract and picked
// arbitrary system tmp dirs. Build it here from repoRoot + slug + ts, ensure it
// exists, canonicalize it, then OVERRIDE whatever the agent returned.
const _runParent = CFG.runRoot ? CFG.runRoot : `${RESOLVED.repoRoot}/tmp`
const _expectedRunDir = `${_runParent}/${DISTILL_SLUG}-${RESOLVED.ts}`
const _ens = await agent(`Run EXACTLY this one command and print ONLY its stdout (a single absolute path line, nothing else):\nmkdir -p "${_expectedRunDir}" && realpath "${_expectedRunDir}"`, { schema: ENSURE_RUNDIR_SCHEMA, phase: 'Resolve', label: 'ensure-rundir' })
RESOLVED.runDir = (_ens && typeof _ens.realpath === 'string' && _ens.realpath.trim().startsWith('/')) ? _ens.realpath.trim() : _expectedRunDir
log(`Resolved: repo=${RESOLVED.repoRoot}; runDir=${RESOLVED.runDir}; fixtureReady=${RESOLVED.fixtureReady}; lmStudio=${RESOLVED.lmStudioUp}; creds=${RESOLVED.credsPresent}`)

// ---------------- Build ----------------
phase('Build')
const buildPrompt = `You are the BUILD phase. Build the single self-contained bundle WITH an external source map (debug-friendly), then verify artifacts.

Do:
- \`cd "${RESOLVED.cliDir}" && bun scripts/deploy.ts --no-freeze\`  (default tier = bundle + minify + external sourcemap)
- Confirm both exist: \`test -f "${RESOLVED.bundlePath}"\` and \`test -f "${RESOLVED.sourcemapPath}"\`.
- bundleSizeKB = size of pi-agent.js in KB (rounded). sourcemapPresent = the .map exists.

Return StructuredOutput EXACTLY: ok (build succeeded AND pi-agent.js exists AND sourcemap present), bundlePath, sourcemapPath, bundleSizeKB, sourcemapPresent, logTail (last ~8 non-empty lines of build output). If build fails, ok=false and put the error in logTail.`
const BUILD = await agent(buildPrompt, { schema: BUILD_SCHEMA, phase: 'Build', label: 'build-bundle' })
if (!BUILD) return { aborted: 'build agent returned nothing', RESOLVED }
log(`Build: ok=${BUILD.ok} sourcemap=${BUILD.sourcemapPresent} size=${BUILD.bundleSizeKB}KB`)
if (!BUILD.ok) return { aborted: 'build failed - gating downstream phases', RESOLVED, BUILD }

// ---------------- Smoke ----------------
phase('Smoke')
const B = RESOLVED.bundlePath
const smokeTasks = []
smokeTasks.push(() => agent(`You are a SMOKE check ("offline-meta"). Run the BUILT bundle (NOT src) and verify meta commands. All paths absolute; do not depend on cwd.

Run and verify each prints sensible content:
1. \`bun "${B}" cli version\` -> prints "pi-agent cli 0.1.0"
2. \`bun "${B}" cli help\` -> lists file2md, zk-extract, pipeline pdf-to-vault
3. \`bun "${B}" cli help file2md\` -> shows usage + flags (--dpi, --type, --pages, --model)
4. \`bun "${B}" cli help pipeline pdf-to-vault\` -> shows --vlm-model, --model, --retries, --force-distill
5. \`bun "${B}" cli list\` -> lists models (Total: N)

Return StructuredOutput EXACTLY: name="offline-meta", ok (all 5 pass), summary (1 line), evidence (concise: the version line + Total count + any failure).`, { schema: SMOKE_SCHEMA, phase: 'Smoke', label: 'smoke:offline-meta' }))
if (RESOLVED.credsPresent) {
  smokeTasks.push(() => agent(`You are a SMOKE check ("passthrough"). Verify the core agent loop via the BUILT bundle with a live model.

Run (ephemeral, one-shot):
\`bun "${B}" -p --no-session --model "${RESOLVED.distillModel}" "Reply with exactly this and nothing else: PI-CLI-OK"\`

ok = stdout contains "PI-CLI-OK". Capture the model line and the reply as evidence. Allow ~60s.
Return StructuredOutput EXACTLY: name="passthrough", ok, summary, evidence.`, { schema: SMOKE_SCHEMA, phase: 'Smoke', label: 'smoke:passthrough' }))
} else { log('skipping passthrough smoke (no creds)') }
if (RESOLVED.credsPresent) {
  smokeTasks.push(() => agent(`You are a SMOKE check ("distill"). Verify the self-contained subagent re-invocation via the BUILT bundle, driven by the CONFIGURED distill model (not the CLI default).

Setup + run (all absolute paths; create the input file yourself):
- Write a short markdown file to: ${RESOLVED.runDir}/smoke/input.md  (a few paragraphs on one topic, e.g. "Spaced repetition").
- Run: \`bun "${B}" cli zk-extract ${RESOLVED.runDir}/smoke/input.md --vault ${RESOLVED.runDir}/smoke/vault --folder Zettelkasten --max-notes 3 --model "${RESOLVED.distillModel}"\`
- Verify: >=1 .md note under ${RESOLVED.runDir}/smoke/vault/Zettelkasten/ has frontmatter (--- ... ---) AND >=1 [[wiki-link]] somewhere in the vault.

ok = notes written with frontmatter AND the model line in stdout reports the CONFIGURED distill model ("${RESOLVED.distillModel}"), NOT the CLI default. Allow ~90s.
Return StructuredOutput EXACTLY: name="distill", ok, summary, evidence (note filenames + confirm frontmatter/links + the model line).`, { schema: SMOKE_SCHEMA, phase: 'Smoke', label: 'smoke:distill' }))
} else { log('skipping distill smoke (no creds)') }
const SMOKE = (await parallel(smokeTasks)).filter(Boolean)
const smokeOk = SMOKE.filter(s => s.ok).length
log(`Smoke: ${smokeOk}/${SMOKE.length} checks ok`)

// ---------------- Knowledge CRUD (live agentic) ----------------
// Exercises the new `knowledge` subcommand end-to-end: a sequential CRUD
// lifecycle on ONE shared vault (add → find → update → check → remove), each
// step verifying the resulting vault state, plus fast error-path attacks.
// Modelled as a single-item pipeline so the steps run strictly in order (each
// mutates the shared vault). The note filename is agent-decided, so update/
// remove glob the vault to rediscover it.
phase('Knowledge')
let KNOW = []
if (!RESOLVED.credsPresent) {
  log('Knowledge lifecycle SKIPPED - no creds (add/find/update/check/remove are live agent calls)')
}
// Fast error-path attacks run regardless (they reject before any LLM call).
const knowErrTasks = [
  () => agent(`You are a KNOWLEDGE robustness check ("knowledge-unknown-sub"). Verify an UNKNOWN subcommand is rejected gracefully BEFORE any LLM call.
Run: \`bun "${B}" cli zk-card boguscmd --vault "${RESOLVED.runDir}/k-err" 2>&1; echo "EXIT=$?"\`
ok = EXIT != 0 AND output mentions "Unknown zk-card subcommand" AND NO stack-trace line (no line matching /^\\s+at /).
Return StructuredOutput EXACTLY: name="knowledge-unknown-sub", ok, summary, evidence (the error line + exit code).`, { schema: KNOW_SCHEMA, phase: 'Knowledge', label: 'knowledge:unknown-sub' }),
  () => agent(`You are a KNOWLEDGE robustness check ("knowledge-add-nocontent"). Verify \`zk-card add\` with NO content (and no --file) fails gracefully BEFORE any LLM call.
Run: \`bun "${B}" cli zk-card add --vault "${RESOLVED.runDir}/k-err" --folder Zettelkasten 2>&1; echo "EXIT=$?"\`
ok = EXIT != 0 AND output mentions "Usage: zk-card add" AND no stack trace.
Return StructuredOutput EXACTLY: name="knowledge-add-nocontent", ok, summary, evidence.`, { schema: KNOW_SCHEMA, phase: 'Knowledge', label: 'knowledge:add-nocontent' }),
  () => agent(`You are a KNOWLEDGE robustness check ("knowledge-find-noquery"). Verify \`zk-card find\` with NO query fails gracefully BEFORE any LLM call.
Run: \`bun "${B}" cli zk-card find --vault "${RESOLVED.runDir}/k-err" 2>&1; echo "EXIT=$?"\`
ok = EXIT != 0 AND output mentions "Usage: zk-card find" AND no stack trace.
Return StructuredOutput EXACTLY: name="knowledge-find-noquery", ok, summary, evidence.`, { schema: KNOW_SCHEMA, phase: 'Knowledge', label: 'knowledge:find-noquery' }),
]
KNOW = (await parallel(knowErrTasks)).filter(Boolean)

if (RESOLVED.credsPresent) {
  const KV = `${RESOLVED.runDir}/knowledge-vault`
  const MD = RESOLVED.distillModel
  // Sequential CRUD lifecycle on ONE shared vault: each step mutates the vault
  // the next step depends on, so they must run strictly in order. Sequential
  // awaits (NOT pipeline) — pipeline would surface only the LAST stage's result
  // per item; we want every stage captured into KNOW for the summary.
  const kn = (prompt, label) => agent(prompt, { schema: KNOW_SCHEMA, phase: 'Knowledge', label })
  const lifecycle = []
  lifecycle.push(await kn(`You are a KNOWLEDGE-CRUD check ("knowledge:add"). Verify \`zk-card add\` creates an atomic Zettelkasten note via a live agent.
1. Setup: \`mkdir -p "${KV}" "${KV}/Zettelkasten"\`.
2. Run (allow ~90s): \`bun "${B}" cli zk-card add "The ZK-CRUD-0001 principle: atomic notes should be linked bidirectionally to form a knowledge graph." --vault "${KV}" --folder Zettelkasten --model "${MD}" 2>&1; echo "EXIT=$?"\`
3. Verify the vault: glob \`${KV}/Zettelkasten/*.md\` — a new note must exist, AND its body must contain "ZK-CRUD-0001".
ok = a note was created under ${KV}/Zettelkasten/ AND its body contains "ZK-CRUD-0001".
Return StructuredOutput EXACTLY: name="knowledge:add", ok, summary, evidence (the created note path + grep result for ZK-CRUD-0001).`, 'knowledge:add'))
  lifecycle.push(await kn(`You are a KNOWLEDGE-CRUD check ("knowledge:find"). Verify \`zk-card find\` locates the note added in the prior step.
A note about "ZK-CRUD-0001 / atomic notes / knowledge graph" now exists under ${KV}/Zettelkasten/.
Run (allow ~90s): \`bun "${B}" cli zk-card find "knowledge graph" --vault "${KV}" --no-context --limit 5 --model "${MD}" 2>&1; echo "EXIT=$?"\`
ok = EXIT == 0 AND the assistant output mentions the created note (by its title or a Zettelkasten/...md path).
Return StructuredOutput EXACTLY: name="knowledge:find", ok, summary, evidence (the matching line from the find output).`, 'knowledge:find'))
  lifecycle.push(await kn(`You are a KNOWLEDGE-CRUD check ("knowledge:update"). Verify \`zk-card update\` smart-merges new content (no overwrite).
1. Discover the note: \`NOTE=$(ls "${KV}"/Zettelkasten/*.md | head -1)\`.
2. Run (allow ~90s): \`bun "${B}" cli zk-card update "Zettelkasten/$(basename "$NOTE")" "Per ZK-CRUD-0002, emergent structure arises from link density." --vault "${KV}" --model "${MD}" 2>&1; echo "EXIT=$?"\`
3. Verify: \`grep -c "ZK-CRUD-0002" "$NOTE"\` must be >=1 (new content merged) AND \`grep -c "ZK-CRUD-0001" "$NOTE"\` must be >=1 (original NOT overwritten).
ok = the note now contains BOTH "ZK-CRUD-0002" (merged) AND "ZK-CRUD-0001" (preserved).
Return StructuredOutput EXACTLY: name="knowledge:update", ok, summary, evidence (grep counts for both tokens).`, 'knowledge:update'))
  lifecycle.push(await kn(`You are a KNOWLEDGE-CRUD check ("knowledge:check"). Verify \`zk-card check\` produces a vault-health audit without crashing.
The vault at ${KV} currently has 1 note under Zettelkasten/.
Run (allow ~120s): \`bun "${B}" cli zk-card check --vault "${KV}" --model "${MD}" 2>&1; echo "EXIT=$?"\`
ok = EXIT == 0 AND the assistant output is a non-empty audit (mentions at least one of: 健全/健康/重複/孤立/連結/duplicate/orphan/dead link/health) AND no stack trace. An "all healthy / no issues" verdict also counts.
Return StructuredOutput EXACTLY: name="knowledge:check", ok, summary, evidence (one line from the audit report).`, 'knowledge:check'))
  lifecycle.push(await kn(`You are a KNOWLEDGE-CRUD check ("knowledge:remove"). Verify \`zk-card remove\` safely deletes the note (backlink check + delete).
1. Discover the note: \`NOTE=$(ls "${KV}"/Zettelkasten/*.md | head -1)\`.
2. Run (allow ~90s): \`bun "${B}" cli zk-card remove "Zettelkasten/$(basename "$NOTE")" --vault "${KV}" --model "${MD}" 2>&1; echo "EXIT=$?"\`
3. Verify: \`test -f "$NOTE" && echo EXISTS || echo GONE\`.
ok = the note file is GONE AND EXIT == 0 AND no stack trace (the note has no inbound links, so the safe-delete protocol should proceed).
Return StructuredOutput EXACTLY: name="knowledge:remove", ok, summary, evidence (the GONE/EXISTS result + the backlink-check line from the output).`, 'knowledge:remove'))
  KNOW = KNOW.concat(lifecycle.filter(Boolean))
}
const knowOk = KNOW.filter(k => k.ok).length
log(`Knowledge: ${knowOk}/${KNOW.length} checks ok`)

// ---------------- Robust (attack / graceful-failure) ----------------
phase('Robust')
const robustTasks = [
  () => agent(`You are a ROBUSTNESS ("attack") check ("bad-input-missing"). Verify the CLI FAILS GRACEFULLY on a missing input — non-zero exit, a clean human message, and NO uncaught-exception stack trace (no lines starting with "    at ").

Run via the BUILT bundle:
\`bun "${B}" cli file2md "${RESOLVED.runDir}/does-not-exist.pdf" --out "${RESOLVED.runDir}/robust/missing" 2>&1; echo "EXIT=$?"\`
graceful = exit != 0 AND output mentions "not found"/"Input not found" AND output has NO stack-trace line (no line matching /^\\s+at /).
Return StructuredOutput EXACTLY: name="bad-input-missing", graceful (bool), summary, evidence (the error line + exit code + stack-trace? yes/no).`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:bad-input-missing' }),
  () => agent(`You are a ROBUSTNESS check ("bad-input-wrongtype"). Verify graceful failure on an unsupported file type.
Create a plain text file: \`printf 'hello' > "${RESOLVED.runDir}/robust/notpdf.txt"\`
Run: \`bun "${B}" cli file2md "${RESOLVED.runDir}/robust/notpdf.txt" --out "${RESOLVED.runDir}/robust/wt" 2>&1; echo "EXIT=$?"\`
graceful = exit != 0 AND mentions "Unsupported input" AND no stack trace.
Return StructuredOutput EXACTLY: name="bad-input-wrongtype", graceful, summary, evidence.`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:bad-input-wrongtype' }),
  () => agent(`You are a ROBUSTNESS check ("page-spec-invalid"). Verify an invalid --pages spec is REJECTED (not silently skipped, which would produce zero pages).
Make a tiny 1-page PNG via Bun (base64-encoded 1x1 white PNG): \`bun -e "Bun.write('${RESOLVED.runDir}/robust/tiny.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64'))"\`
Run with a FORCED profile (skips the classifier VLM call): \`bun "${B}" cli file2md "${RESOLVED.runDir}/robust/tiny.png" --type image --out "${RESOLVED.runDir}/robust/pagespec" --pages abc 2>&1; echo "EXIT=$?"\`
Then repeat with \`--pages 5-2\` (reversed range).
graceful = BOTH exit != 0 AND mention "matched no pages" AND no stack trace.
Return StructuredOutput EXACTLY: name="page-spec-invalid", graceful, summary, evidence (both specs).`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:page-spec-invalid' }),
  () => agent(`You are a ROBUSTNESS check ("bad-type-flag"). Verify an invalid --type profile is rejected FAST (before rasterizing).
Run: \`bun "${B}" cli file2md "${RESOLVED.fixturePdfPath}" --type notaprofile --out "${RESOLVED.runDir}/robust/badtype" 2>&1; echo "EXIT=$?"\`
graceful = exit != 0 AND mentions "Invalid --type" AND no stack trace.
Return StructuredOutput EXACTLY: name="bad-type-flag", graceful, summary, evidence.`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:bad-type-flag' }),
  () => agent(`You are a ROBUSTNESS check ("unknown-pipeline"). Verify unknown/missing pipeline names are rejected.
Run both:
\`bun "${B}" cli pipeline bogus-name 2>&1; echo "EXIT=$?"\`  (expect "Unknown pipeline" + "Available:" + exit 1)
\`bun "${B}" cli pipeline 2>&1; echo "EXIT=$?"\`  (no name; expect a usage error + exit 1)
graceful = both exit != 0 AND print a clear unknown/usage message AND no stack trace.
Return StructuredOutput EXACTLY: name="unknown-pipeline", graceful, summary, evidence (both).`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:unknown-pipeline' }),
  () => agent(`You are a ROBUSTNESS check ("distill-missing"). Verify graceful failure on a missing distill input.
Run: \`bun "${B}" cli zk-extract "${RESOLVED.runDir}/no-such.md" --vault "${RESOLVED.runDir}/robust/dv" 2>&1; echo "EXIT=$?"\`
graceful = exit != 0 AND mentions "not found"/"Input not found"/"No input" AND no stack trace.
Return StructuredOutput EXACTLY: name="distill-missing", graceful, summary, evidence.`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:distill-missing' }),
  () => agent(`You are a ROBUSTNESS check ("slug-traversal-safety"). Verify the output slug can NEVER escape the output dir via path traversal in a filename.
Write this file to "${RESOLVED.runDir}/robust/slug-test.mjs":
  import {slugify} from "${RESOLVED.cliDir}/src/vlm/manifest.ts";
  const cases=["../../etc/passwd.pdf","a/b/c.pdf","....//evil.pdf","..%2f..%2fx.png"];
  let bad=0;
  for (const c of cases){ const s=slugify(c); console.log(c,"=>",s); if(s.includes("/")||s==="..")bad++; }
  process.exit(bad?1:0);
Then run: \`bun "${RESOLVED.runDir}/robust/slug-test.mjs"; echo "EXIT=$?"\`
graceful = exit 0 (NO slug contains "/" and none equals ".." — traversal-safe). If exit 1, graceful=false and quote which case leaked.
Return StructuredOutput EXACTLY: name="slug-traversal-safety", graceful, summary, evidence (the slugify outputs).`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:slug-traversal-safety' }),
  () => agent(`You are a ROBUSTNESS check ("dpi-invalid"). Verify an invalid --dpi value is REJECTED up front (a bad DPI used to silently fall back to 150 or produce a broken render with an opaque per-page error and a misleading exit 0).

Run each via the BUILT bundle and capture exit + first error line:
1. \`bun "${B}" cli file2md "${RESOLVED.fixturePdfPath}" --dpi abc --pages 1 --out "${RESOLVED.runDir}/robust/dpi-abc" 2>&1; echo "EXIT=$?"\`
2. \`bun "${B}" cli file2md "${RESOLVED.fixturePdfPath}" --dpi -1 --pages 1 --out "${RESOLVED.runDir}/robust/dpi-neg" 2>&1; echo "EXIT=$?"\`
3. \`bun "${B}" cli file2md "${RESOLVED.fixturePdfPath}" --dpi 0 --pages 1 --out "${RESOLVED.runDir}/robust/dpi-zero" 2>&1; echo "EXIT=$?"\`
4. \`bun "${B}" cli file2md "${RESOLVED.fixturePdfPath}" --dpi 99999 --pages 1 --out "${RESOLVED.runDir}/robust/dpi-huge" 2>&1; echo "EXIT=$?"\`
graceful = ALL FOUR exit != 0 AND each prints "Invalid --dpi" AND NONE prints a stack-trace line (no line matching /^\\s+at /). Also confirm rejection happens BEFORE any rasterization/VLM work (no "explaining…" or "[N/M] done" lines).
Return StructuredOutput EXACTLY: name="dpi-invalid", graceful, summary, evidence (the 4 error lines + exit codes).`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:dpi-invalid' }),
  () => agent(`You are a ROBUSTNESS check ("directory-input"). Verify file2md FAILS GRACEFULLY when given a DIRECTORY (not a file).
\`mkdir -p "${RESOLVED.runDir}/robust/adir"; bun "${B}" cli file2md "${RESOLVED.runDir}/robust/adir" --out "${RESOLVED.runDir}/robust/dirout" 2>&1; echo "EXIT=$?"\`
graceful = exit != 0 AND mentions "not a regular file"/"not a file"/"Is a directory" AND no stack trace.
Return StructuredOutput EXACTLY: name="directory-input", graceful, summary, evidence (error line + exit code).`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:directory-input' }),
  () => agent(`You are a ROBUSTNESS check ("corrupt-pdf"). Verify file2md FAILS GRACEFULLY on a corrupt/empty PDF (the rasterizer rejects it, not an uncaught exception).
Create two fakes:
- empty: \`> "${RESOLVED.runDir}/robust/empty.pdf"\`  (0 bytes)
- bogus magic: \`printf 'PK\\x03\\x04 not a real pdf' > "${RESOLVED.runDir}/robust/bogus.pdf"\`
Run each: \`bun "${B}" cli file2md "<path>" --out "${RESOLVED.runDir}/robust/cpdf" 2>&1; echo "EXIT=$?"\`
graceful = BOTH exit != 0 AND each prints a clean error mentioning "pdf2png failed"/"cannot open"/"PDF" AND NEITHER prints a stack-trace line (no line matching /^\\s+at /).
Return StructuredOutput EXACTLY: name="corrupt-pdf", graceful, summary, evidence (both error lines + exit codes).`, { schema: ROBUST_SCHEMA, phase: 'Robust', label: 'robust:corrupt-pdf' }),
]
const ROBUST = (await parallel(robustTasks)).filter(Boolean)
const robustOk = ROBUST.filter(r => r.graceful).length
log(`Robust: ${robustOk}/${ROBUST.length} checks graceful`)

// ---------------- Regression ----------------
phase('Regression')
let REG_RUN = null
let REG_VERIFY = []
const stage1Reuse = !!CFG.stage1From   // reuse a pre-built pdf-to-md: skip VLM stage1, control variation across distill models
const regrOut = `${RESOLVED.runDir}/regression`
let SEED = null
if (!RESOLVED.fixtureReady) {
  log('Regression SKIPPED - fixture not ready')
} else if (!stage1Reuse && !RESOLVED.lmStudioUp) {
  log('Regression SKIPPED - LM Studio down (no local VLM for stage 1; pass stage1From to reuse stage1 without VLM)')
} else if (!RESOLVED.credsPresent) {
  log('Regression SKIPPED - no distill creds for stage 2')
} else {
  // When reusing stage1, SEED the pre-built pdf-to-md into regrOut FIRST via a
  // dedicated, verifiable agent. The pipeline then RESUMES and skips the VLM.
  // If seeding fails we ABORT — never silently re-run the VLM (that would
  // destroy the controlled distill-model comparison and waste a full stage1).
  if (stage1Reuse) {
    SEED = await agent(`You SEED a pre-built pdf-to-md stage1 so the pdf-to-vault pipeline RESUMES and SKIPS the VLM (stage1). You ONLY seed — do NOT run the pipeline.

stage1From = ${CFG.stage1From}
regrOut    = "${regrOut}"
regPages   = "${RESOLVED.regPages}"   (the page range the regression will process, e.g. "1-3")

Do exactly, via Bash (absolute paths only):
1. List the single subdir under "${CFG.stage1From}/1-pdf-to-md/" — its name is slug (e.g. 2025.emnlp-main.893).
2. seedDir="${regrOut}/pdf-to-vault-seed-<slug>"; mkdir -p "$seedDir"; cp -r "${CFG.stage1From}/1-pdf-to-md" "$seedDir/"
   (result: $seedDir/1-pdf-to-md/<slug>/ including manifest.json)
3. Parse $seedDir/1-pdf-to-md/<slug>/manifest.json: manifestPagesTotal = pageCount; manifestPagesDone = count of pages whose status === "done". Also derive the set of NEEDED page numbers from regPages (e.g. "1-3" -> {1,2,3}; "1,3,5" -> {1,3,5}; "2" -> {2}).
4. copiedOk = (manifestPagesDone > 0 AND EVERY needed page number has a manifest page entry whose status === "done"). The seed need only cover the pages regPages will process — a PARTIAL seed (e.g. 3/16) is VALID when regPages is "1-3". If false, notes must name exactly which needed page is not done.
5. CRITICAL: do NOT create any pipeline.json under $seedDir — its ABSENCE is what makes the orchestrator run stage2.

Return StructuredOutput EXACTLY: seedDir (absolute), slug, manifestPagesDone, manifestPagesTotal, copiedOk, notes.`, { schema: SEED_SCHEMA, phase: 'Regression', label: 'seed-stage1' })
    if (!SEED || !SEED.copiedOk) {
      log(`Regression ABORTED - stage1From seed failed (copiedOk=${SEED ? SEED.copiedOk : 'no-result'}); refusing to re-run the VLM. notes=${SEED ? SEED.notes : 'agent returned nothing'}`)
    }
  }

  if (!stage1Reuse || (SEED && SEED.copiedOk)) {
    const reuseNote = stage1Reuse
      ? `STAGE 1 IS ALREADY SEEDED: a complete pdf-to-md lives at ${SEED.seedDir}. The orchestrator MUST find it via resume and SKIP stage1 entirely (NO VLM call). After the run the runDir MUST equal ${SEED.seedDir}. If instead a NEW pdf-to-vault-* dir was created and "STAGE 1" ran the VLM, that is a FAILURE: set ok=false and name the unexpected dir in error.`
      : `This runs the FULL pipeline (stage1 VLM + stage2 distill).`
    REG_RUN = await agent(`You are the REGRESSION run. Execute the pdf-to-vault pipeline on the academic-paper fixture via the BUILT bundle. ${reuseNote} Long-running (several minutes when stage1 runs from scratch; far less when reused) — run it and WAIT.

Run:
\`bun "${B}" cli pipeline pdf-to-vault "${RESOLVED.fixturePdfPath}" --out "${regrOut}" --pages ${RESOLVED.regPages} --vlm-model "${RESOLVED.vlmModel}" --model "${RESOLVED.distillModel}"\`

stage1 (vlm) uses ${RESOLVED.vlmModel}; stage2 (distill) uses ${RESOLVED.distillModel} (via the global --model). Allow up to ~6 minutes.
After it finishes:
- runDir = the dir the orchestrator used (under ${regrOut}, pattern pdf-to-vault-*).${stage1Reuse ? ` It MUST be ${SEED.seedDir} (resume of the seed, NOT a new dir).` : ''}
- stage1PagesDone = count of pages with status "done" in <runDir>/1-pdf-to-md/<slug>/manifest.json.
- stage2Notes = count of .md notes under <runDir>/2-obsidian-vault/Zettelkasten/.
- status = pipeline.json "status" field.
- stage1RerunVlm = true if the pipeline's stage1 output contains ANY line with "explaining" (a VLM page-explanation call actually ran); false if stage1 resumed with NO VLM call at all (only "profile ... reused" / "kind: pdf  pages: N" lines). When stage1From seeded stage1, this MUST be false.

Return StructuredOutput EXACTLY: ok (pipeline reached status "done"${stage1Reuse ? ` AND runDir === ${SEED.seedDir} AND stage1RerunVlm === false (stage1 reused, NO VLM call)` : ''}), runDir (absolute), status, stage1PagesDone, stage2Notes, stage1RerunVlm, error ("" if none), logTail (last ~10 non-empty lines).`, { schema: REGRUN_SCHEMA, phase: 'Regression', label: 'regression:run' })
  }

  // Hard gate (reuse mode): even if runDir === seedDir, stage1 could still have
  // re-run the VLM (e.g. a CLI resume bug). That invalidates the controlled
  // distill-model comparison, so fail it explicitly instead of passing silently.
  if (REG_RUN && stage1Reuse && REG_RUN.stage1RerunVlm) {
    log(`Regression FAILED gate - stage1 re-ran the VLM (stage1RerunVlm=true) despite stage1From seed; runDir=${REG_RUN.runDir}`)
    REG_RUN.ok = false
  }

  if (REG_RUN && REG_RUN.ok) {
    const R = REG_RUN.runDir
    const verifyTasks = [
      () => agent(`You are a REGRESSION verifier ("stage1-vlm"). Assess VLM output QUALITY on the academic paper.

Read the stage-1 per-page markdown: glob \`${R}/1-pdf-to-md/*/pages/*.md\`, plus the nearest manifest.json under \`${R}/1-pdf-to-md/\`.
Assess for a real EMNLP paper (page range ${RESOLVED.regPages}). NOTE: this tool is DESIGNED to produce 繁體中文 notes from any source language, so 繁中 output / translation is CORRECT by design — do NOT lower the score for language choice. DO penalize: lost or omitted information (over-condensing that drops substance), a WRONG page number in frontmatter (the \`page:\` field must match the actual page), broken image embeds (e.g. stray angle brackets \`![[<...>]]\`), hallucinated content, or failure to capture title/authors/abstract/section structure/equations/figure captions. Score 1-5 (5 = faithful, well-structured, no data defects; 1 = garbage / mostly wrong).
Return StructuredOutput EXACTLY: aspect="stage1-vlm", ok (score>=3 AND pages produced), score, findings (2-4 concise bullets).`, { schema: REGQUAL_SCHEMA, phase: 'Regression', label: 'regression:stage1-quality' }),
      () => agent(`You are a REGRESSION verifier ("stage2-distill"). Assess distill output QUALITY.

Read the stage-2 Zettelkasten notes under: ${R}/2-obsidian-vault/Zettelkasten/ (and Tags/Index.md MOC).
Assess: atomic notes created from the paper markdown, each with frontmatter (id/created/tags), coherent content, and [[wiki-links]] forming a graph (flag dangling links whose target filename differs from the link text). Score 1-5.
Return StructuredOutput EXACTLY: aspect="stage2-distill", ok (score>=3 AND >=1 note with frontmatter+link), score, findings (2-4 bullets).`, { schema: REGQUAL_SCHEMA, phase: 'Regression', label: 'regression:stage2-quality' }),
      () => agent(`You are a REGRESSION verifier ("coord-resume"). Verify pipeline coordination + resume.

1. Read ${R}/pipeline.json. Confirm: status "done"; stages.file2md.status "done"; stages.distill.status "done"; options captured (vlmModel, retries, pages). Report any inconsistency.
2. RESUME test: re-run the exact same command to confirm idempotent resume:
   \`bun "${B}" cli pipeline pdf-to-vault "${RESOLVED.fixturePdfPath}" --out "${RESOLVED.runDir}/regression" --pages ${RESOLVED.regPages} --vlm-model "${RESOLVED.vlmModel}" --model "${RESOLVED.distillModel}"\`
   Expect: "(resuming existing run)", stage 1 skips already-done pages, stage 2 "skipped - already done". It should reuse the SAME run dir ${R} (no new dir created).
Return StructuredOutput EXACTLY: aspect="coord-resume", ok (pipeline.json consistent AND resume reused run dir AND stage2 skipped), score (1-5), findings (2-4 bullets).`, { schema: REGQUAL_SCHEMA, phase: 'Regression', label: 'regression:coord-resume' }),
    ]
    REG_VERIFY = (await parallel(verifyTasks)).filter(Boolean)
  } else {
    log('Regression verify SKIPPED - run did not reach done')
  }
}

// ---------------- Store Results (JSONL) ----------------
// Flatten every phase's checks into one JSONL file (summary line + one line per
// check) so compare.ts can diff runs across distill models. Written to the run
// dir (gitignored tmp/); the baseline run's file is copied into docs/benchmarks/ and
// committed. (phase/name is the comparison key; robust uses graceful => passed.)
phase('Store Results')
const _M = CFG.distillModel
const _checks = []
const _push = (ph, name, passed, detail) => _checks.push({ kind: 'check', model: _M, phase: ph, name, passed: !!passed, detail: String(detail ?? '').slice(0, 600) })
_push('build', 'bundle+sourcemap', BUILD.ok, `size ${BUILD.bundleSizeKB}KB; sourcemap present=${BUILD.sourcemapPresent}`)
for (const s of SMOKE) _push('smoke', s.name, s.ok, s.summary)
for (const k of KNOW) _push('knowledge', k.name, k.ok, k.summary)
for (const r of ROBUST) _push('robust', r.name, r.graceful, r.summary)
_push('regression', 'pipeline-run', REG_RUN ? REG_RUN.ok : false, REG_RUN ? `status=${REG_RUN.status}; stage1Pages=${REG_RUN.stage1PagesDone}; stage2Notes=${REG_RUN.stage2Notes}; stage1RerunVlm=${REG_RUN.stage1RerunVlm}` : 'skipped')
for (const v of REG_VERIFY) _push('regression', v.aspect, v.ok, `score ${v.score}/5; ${v.findings}`)
const _byPhase = {
  build: `${BUILD.ok ? 1 : 0}/1`,
  smoke: `${SMOKE.filter(s => s.ok).length}/${SMOKE.length}`,
  knowledge: `${KNOW.filter(k => k.ok).length}/${KNOW.length}`,
  robust: `${ROBUST.filter(r => r.graceful).length}/${ROBUST.length}`,
  regression: REG_RUN ? `${REG_VERIFY.filter(v => v.ok).length}/${REG_VERIFY.length}` : 'skipped',
}
const _summaryRec = {
  kind: 'summary', model: _M, vlmModel: CFG.vlmModel, date: RESOLVED.date, ts: RESOLVED.ts,
  buildOk: BUILD.ok, byPhase: _byPhase,
  totalChecks: _checks.length, passed: _checks.filter(c => c.passed).length, failed: _checks.filter(c => !c.passed).length,
  regressionStage1Pages: REG_RUN ? REG_RUN.stage1PagesDone : null,
  regressionStage2Notes: REG_RUN ? REG_RUN.stage2Notes : null,
}
const _jsonl = [_summaryRec, ..._checks].map(o => JSON.stringify(o)).join('\n') + '\n'
const RESULTS_PATH = `${RESOLVED.runDir}/result.jsonl`
const _expectLines = _checks.length + 1
// Embed the entire JSONL inside ONE shell single-quoted printf argument
// (single quotes escaped POSIX-style: ' -> '\''). The agent runs a single
// printf command and the SHELL writes the bytes verbatim — the agent never
// hand-types the JSON, so detail fields' quotes/newlines/backslashes cannot
// corrupt it. Uses only String.replace (no Buffer/btoa, which are absent from
// the workflow sandbox).
const _sq = _jsonl.replace(/'/g, "'\\''")
const _storeRes = await agent(`Write ${RESULTS_PATH} by running this ONE Bash command EXACTLY as printed. The single-quoted printf argument spans MANY lines and contains real newlines and quotes — that is intentional and required; paste it verbatim into the shell. Do NOT modify, reformat, shorten, join lines, or retype it:

printf '%s' '${_sq}' > ${RESULTS_PATH}

Then verify EVERY line is valid JSON (it prints "parsed ${_expectLines}" only if all ${_expectLines} lines parse):
bun -e "const fs=require('fs');const t=fs.readFileSync('${RESULTS_PATH}','utf8');const n=t.trim().split('\n').filter(l=>l.trim()).reduce((c,l)=>{try{JSON.parse(l);return c+1}catch{return c}},0);console.log('parsed',n)"

Return StructuredOutput EXACTLY: written (true ONLY if python printed "parsed ${_expectLines}"), lineCount (the parsed count), firstLineKind (the "kind" of the first line; expect "summary").`, { schema: STORE_SCHEMA, phase: 'Store Results', label: 'store-results' })
const _storeOk = !!(_storeRes && _storeRes.written && _storeRes.lineCount === _expectLines)
log(`Stored results: ${RESULTS_PATH} (ok=${_storeOk}, lines=${_storeRes ? _storeRes.lineCount : '?'}/${_expectLines}, firstLine=${_storeRes ? _storeRes.firstLineKind : '?'})`)

return {
  resolved: RESOLVED,
  build: BUILD,
  smoke: SMOKE,
  knowledge: KNOW,
  robust: ROBUST,
  regressionRun: REG_RUN,
  regressionVerify: REG_VERIFY,
  storedResults: RESULTS_PATH,
  storedResultsOk: _storeOk,
  summary: {
    buildOk: BUILD.ok,
    smokeOk,
    smokeTotal: SMOKE.length,
    knowledgeOk: knowOk,
    knowledgeTotal: KNOW.length,
    robustOk,
    robustTotal: ROBUST.length,
    regressionOk: REG_RUN ? REG_RUN.ok : null,
    regressionStage1Pages: REG_RUN ? REG_RUN.stage1PagesDone : null,
    regressionStage2Notes: REG_RUN ? REG_RUN.stage2Notes : null,
  },
}


/**
 * verify-bun-pi-agent-cli — dynamic end-to-end verification of the
 * pi-agent CLI bundle (`pi-agent cli …`).
 *
 * pi-native port of .claude/workflows/verify-bun-pi-agent-cli.js, kept under
 * bun-apps/pi-agent/run-dir/workflows/ so it is discoverable by the pi-agent-ext-workflow tooling
 * (the `workflow` tool registered by the @quintinshaw/pi-dynamic-workflows
 * extension in bun-apps/pi-agent/run-dir/manifest.json). The script is identical in behavior: all
 * paths are resolved at runtime in the Resolve phase (git rev-parse + realpath),
 * so it never depends on cwd or a hardcoded worktree. When the .claude version
 * changes, update this port to match (or delete the .claude copy).
 *
 * ── METHODOLOGY (how to operate + interpret this workflow) ──
 *   This script only defines WHAT to check. The HOW (controlled-variable
 *   strategy, rebase re-verify rule, signal-vs-noise reading of fails, the
 *   iteration log) lives in the project skill `verify-bun-pi-agent-cli`
 *   (auto-loaded) and the canonical methodology doc:
 *     docs/benchmarks/verify-bun-pi-agent-cli/README.md
 *   The pi-runtime benchmark home (baselines + compare.ts + stage1-seed) is at:
 *     docs/benchmarks/verify-bun-pi-agent-cli/
 *   Read both BEFORE declaring a run "failed" or "regressed".
 *
 * ── WHAT it verifies (every phase writes one line per check into result.jsonl) ──
 *   Resolve    – canonical absolute paths + env health-check + a fresh runDir
 *   Build      – bundle + external sourcemap (hard gate: nothing runs if it fails)
 *   Smoke      – offline meta commands; live passthrough; live distill subagent
 *   Knowledge  – live `knowledge` CRUD lifecycle (add/find/update/check/remove)
 *                + fast error-path rejects (all pre-LLM, so run with no creds too)
 *   Robust     – graceful-failure attacks (bad input, invalid flags/dpi/pages,
 *                path-traversal slug safety, corrupt PDF, directory input)
 *   Regression – `pipeline pdf-to-vault` on fixture/2025.emnlp-main.893.pdf;
 *                scores stage1 (VLM) + stage2 (distill) quality + coord/resume
 *   Store      – <runDir>/result.jsonl (summary + per-check) for compare.ts
 *
 * ── WHEN to run it — TWO MODES, selected by `stage1From` ──
 *   1) FULL baseline re-check  →  omit stage1From
 *      Re-runs VLM stage1 + distill stage2. Use after touching pi-agent CLI
 *      code to validate BOTH stage code paths end-to-end. ~6 min.
 *      Needs: LM Studio serving the VLM model + distill-model API key + fixture.
 *
 *   2) DISTILL-MODEL comparison  →  stage1From = canonical committed seed
 *      (docs/benchmarks/verify-bun-pi-agent-cli/stage1-seed-emnlp-893)
 *      Reuses the committed stage1 — the VLM is SKIPPED entirely — and runs
 *      distill only, so runs vary ONLY the distill model (controlled variable).
 *      Use to compare other distill models against the zai/glm-5.3 baseline.
 *      Regression ~2 min; full workflow (incl. knowledge CRUD) ~5 min.
 *      Needs: distill-model API key + fixture. LM Studio is NOT required.
 *
 * ── Prerequisites & graceful degradation ──
 *   Always: Bun runtime; a repo containing bun-apps/pi-agent/; the fixture PDF.
 *   Live phases need the distill model's provider env (ZAI_API_KEY by default;
 *   deepseek→DEEPSEEK_API_KEY, …). FULL regression also needs LM Studio (VLM).
 *   A missing prerequisite does NOT abort the run: the affected phase is SKIPPED
 *   with a log() line and recorded in result.jsonl (e.g. no creds → smoke /
 *   knowledge / regression skipped; LM Studio down + no stage1From → regression
 *   skipped; fixture missing → regression skipped). Build + Robust always run.
 *
 * ── Output & comparison ──
 *   Each run lands in <runRoot>/<distillSlug>-<ts>/result.jsonl (runRoot defaults
 *   to <repoRoot>/tmp, gitignored). Diff against the committed baseline:
 *     bun run docs/benchmarks/verify-bun-pi-agent-cli/compare.ts <result.jsonl>
 *
 * ── Known issues / TODO (next) ──
 *   1. RESOLVED: SMOKE `distill` check now passes `--model "${RESOLVED.distillModel}"`
 *      to zk-extract and asserts the model line reports the configured distill
 *      model (not the CLI default), so it now actually exercises the distill
 *      model under test.
 *   2. RESOLVED: per-model baselines. compare.ts now auto-selects a committed
 *      `<distill-slug>.jsonl` matching the run's distill model (slug =
 *      model.replace(/\//g, "-")), falling back to zai-glm-5.3.jsonl. Baselines
 *      committed: zai-glm-5.3.jsonl, zai-glm-4.7.jsonl,
 *      lm-studio-google-gemma-4-12b.jsonl. Pass an explicit baseline *      file as the LAST arg to force it for all runs.
 *   3. RESOLVED (not reproducible): zai/glm-4.7 `zk-card remove` once failed —
 *      `obsidian_delete` returned ok but the file stayed on disk. A re-run with
 *      the same model passed: the agent followed the safe-delete protocol and
 *      the file was confirmed GONE. Conclusion: a one-off model tool-use flake,
 *      not an obsidian_delete reliability bug. No fix needed.
 */
