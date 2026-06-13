export const meta = {
  name: 'bun-command-self-improve',
  description: 'Autonomous test coverage improvement for gui-movie-director command schemas via propose→test→adopt/revert loop',
  whenToUse: 'Improve unit test coverage for bun/gui-movie-director command schemas, iterating until coverage plateaus',
  phases: [
    { title: 'Resolve',  detail: 'Load history, dead-ends, prior run context' },
    { title: 'Baseline', detail: 'Run bun test --coverage to get starting state' },
    { title: 'Improve',  detail: 'Loop: propose test addition → write → run → adopt/revert' },
    { title: 'Persist',  detail: 'Write JSONL history + reflection.json' },
    { title: 'Report',   detail: 'Print coverage delta summary' },
  ],
}

// ── Config ────────────────────────────────────────────────────────────────────

const isObj = x => x && typeof x === 'object' && !Array.isArray(x)
const A = isObj(args) ? args : {}
const BUDGET     = Number(A.budget) || 6           // max iterations
const DRY_RUN    = A.dryRun !== false              // default: dry-run (safe to demo)
const MARGIN     = Number(A.margin) || 1.5         // min composite delta to adopt (pp)
const CONVERGE_K = Number(A.convergeK) || 2        // stop after K non-improving iters
const TARGET     = A.target || null                // optional: focus on one schema file

// ── Paths ─────────────────────────────────────────────────────────────────────

const GUI_DIR      = '/Users/huangziyu/proj/video_generation/bun/gui-movie-director'
const SCHEMAS_DIR  = `${GUI_DIR}/schemas`
const HISTORY_DIR  = '/Users/huangziyu/proj/video_generation/.claude/workflows/history/bun-command-self-improve'
const JSONL_PATH   = `${HISTORY_DIR}/iterations.jsonl`
const REFLECT_PATH = `${HISTORY_DIR}/reflection.json`
const INDEX_PATH   = '/Users/huangziyu/proj/video_generation/.claude/workflows/history/_index.json'

// Source schema files that tests should cover (excludes helpers, adapters, registry)
const COMMAND_SCHEMA_FILES = [
  'schemas/t2i.ts', 'schemas/i2i.ts', 'schemas/anime2real.ts', 'schemas/expansion.ts',
  'schemas/faceswap.ts', 'schemas/swap.ts', 'schemas/controlnet.ts', 'schemas/angle.ts',
  'schemas/profile.ts', 'schemas/quality.ts', 'schemas/workflow.ts',
  'schemas/video-generate.ts', 'schemas/video-relay.ts', 'schemas/video-restore.ts',
  'schemas/image-restore.ts', 'lib/args.ts',
]

// ── Coverage parsing ──────────────────────────────────────────────────────────

function parseCoverageTable(output) {
  const files = {}
  // Format: " path/file.ts    |   72.46 |   94.17 | ..."
  const re = /^\s+(\S+\.ts)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/gm
  let m
  while ((m = re.exec(output)) !== null) {
    const [, file, funcs, lines] = m
    const f = parseFloat(funcs), l = parseFloat(lines)
    files[file] = { funcs: f, lines: l, composite: 0.4 * f + 0.6 * l }
  }
  return files
}

function globalComposite(fileCoverage) {
  const relevant = COMMAND_SCHEMA_FILES.map(f => fileCoverage[f]).filter(Boolean)
  if (relevant.length === 0) return 0
  return relevant.reduce((s, f) => s + f.composite, 0) / relevant.length
}

function findWeakestFile(fileCoverage, deadEnds) {
  const candidates = TARGET
    ? COMMAND_SCHEMA_FILES.filter(f => f.includes(TARGET))
    : COMMAND_SCHEMA_FILES

  return candidates
    .map(f => ({ file: f, cov: fileCoverage[f] || { composite: 0 } }))
    .filter(({ file }) => !deadEnds.has(file))
    .sort((a, b) => a.cov.composite - b.cov.composite)[0]?.file || null
}

// ── History helpers ───────────────────────────────────────────────────────────

const HISTORY_SCHEMA = {
  type: 'object',
  properties: {
    runId:      { type: 'string' },
    iter:       { type: 'number' },
    targetFile: { type: 'string' },
    testClass:  { type: 'string' },
    adopted:    { type: 'boolean' },
    delta:      { type: 'number' },
    prevScore:  { type: 'number' },
    newScore:   { type: 'number' },
    dryRun:     { type: 'boolean' },
  },
  required: ['runId', 'iter', 'targetFile', 'adopted', 'delta'],
}

// ── Phase: Resolve ────────────────────────────────────────────────────────────

phase('Resolve')

// Generate a run ID from a counter in the history file (no Date.now() in workflows)
const resolveResult = await agent(
  `You are a file reader agent. Do the following steps in order:
1. Check if directory exists: ${HISTORY_DIR}. If not, create it with: mkdir -p "${HISTORY_DIR}"
2. Read file ${JSONL_PATH} if it exists. Parse each line as JSON. Extract fields: iter, targetFile, adopted, testClass.
3. Read file ${REFLECT_PATH} if it exists. Extract any known dead-end patterns.
4. Count total lines in JSONL to derive a runId like "run-<N+1>".
5. Return JSON: { runId, totalPriorIters, deadEndFiles: string[], knownGoodPatterns: string[] }

Rules:
- deadEndFiles: files that appear in >= 2 consecutive non-adopted iterations
- knownGoodPatterns: testClass strings that were adopted (successfully improved coverage)
- If JSONL is empty or missing, return defaults with runId "run-1"`,
  { label: 'resolve-history', phase: 'Resolve',
    schema: {
      type: 'object',
      properties: {
        runId:             { type: 'string' },
        totalPriorIters:   { type: 'number' },
        deadEndFiles:      { type: 'array', items: { type: 'string' } },
        knownGoodPatterns: { type: 'array', items: { type: 'string' } },
      },
      required: ['runId', 'totalPriorIters', 'deadEndFiles', 'knownGoodPatterns'],
    }
  }
)

const runId      = resolveResult?.runId || 'run-1'
const deadEnds   = new Set(resolveResult?.deadEndFiles || [])
const goodPats   = resolveResult?.knownGoodPatterns || []

log(`Run: ${runId} | Prior iters: ${resolveResult?.totalPriorIters || 0} | Dead-ends: ${deadEnds.size} | Good patterns: ${goodPats.length}`)

// ── Phase: Baseline ───────────────────────────────────────────────────────────

phase('Baseline')

const baselineResult = await agent(
  `Run this exact command and return the full stdout output:
cd "${GUI_DIR}" && bun test --coverage 2>&1

Return the complete terminal output as a JSON string in the field "output". Include the coverage table lines.`,
  { label: 'baseline-run', phase: 'Baseline',
    schema: { type: 'object', properties: { output: { type: 'string' } }, required: ['output'] }
  }
)

const baselineCoverage = parseCoverageTable(baselineResult?.output || '')
const baselineComposite = globalComposite(baselineCoverage)
let currentBest = baselineComposite

log(`Baseline composite: ${baselineComposite.toFixed(2)}pp across ${COMMAND_SCHEMA_FILES.length} files`)

// Log weakest files
const sorted = COMMAND_SCHEMA_FILES
  .map(f => ({ f, c: (baselineCoverage[f] || { composite: 0 }).composite }))
  .sort((a, b) => a.c - b.c)
log(`Weakest: ${sorted.slice(0, 3).map(x => `${x.f}(${x.c.toFixed(0)}%)`).join(', ')}`)

// ── Phase: Improve ────────────────────────────────────────────────────────────

phase('Improve')

const iterations = []
let noImprove = 0

for (let iter = 0; iter < BUDGET; iter++) {
  const targetFile = findWeakestFile(baselineCoverage, deadEnds)
  if (!targetFile) {
    log(`No candidates left (all in dead-ends). Stopping.`)
    break
  }

  // Derive test file path from source file
  const testFile = targetFile.replace(/\.ts$/, '.test.ts')
  const baseName = targetFile.replace(/^(schemas|lib)\//, '').replace(/\.ts$/, '')

  log(`Iter ${iter + 1}/${BUDGET}: targeting ${targetFile} (${(baselineCoverage[targetFile]?.composite || 0).toFixed(1)}% composite)`)

  // Read source file and current test file to propose improvements
  const proposeResult = await agent(
    `You are a test-writing agent for a Bun TypeScript project. Your task: propose NEW unit tests to improve coverage of ${targetFile}.

Context:
- Project: ${GUI_DIR}
- Source file: ${GUI_DIR}/${targetFile}
- Current test file: ${GUI_DIR}/${testFile} (may not exist yet — check)
- Test framework: bun:test (import { describe, it, expect } from "bun:test")
- Helper: schemas/test-helpers.ts exports invariants(cmd) for boilerplate tests
- Coverage baseline: funcs=${(baselineCoverage[targetFile]?.funcs || 0).toFixed(1)}% lines=${(baselineCoverage[targetFile]?.lines || 0).toFixed(1)}%
- Known good patterns from prior runs: ${goodPats.length > 0 ? goodPats.slice(0, 5).join('; ') : 'none yet'}

Steps:
1. Read the source file at ${GUI_DIR}/${targetFile}
2. Read the current test file at ${GUI_DIR}/${testFile} (note what's already tested)
3. Identify the specific functions/branches NOT yet covered (check Uncovered Line #s from baseline)
4. Write 3-6 new it() test cases that exercise those uncovered paths
5. Focus on: buildParams() edge cases, isDisabled() boundary values, or field validation

Return JSON:
{
  "testClass": "one-line description of what you're testing (e.g. 'swap isDisabled with empty inputs')",
  "targetTestFile": "${testFile}",
  "newTestCode": "the TypeScript test code to APPEND to the test file (just the describe block, no imports needed)",
  "estimatedLines": <number of uncovered lines this should cover>,
  "reasoning": "why these tests will improve coverage"
}`,
    { label: `propose-${baseName}`, phase: 'Improve',
      schema: {
        type: 'object',
        properties: {
          testClass:      { type: 'string' },
          targetTestFile: { type: 'string' },
          newTestCode:    { type: 'string' },
          estimatedLines: { type: 'number' },
          reasoning:      { type: 'string' },
        },
        required: ['testClass', 'targetTestFile', 'newTestCode'],
      }
    }
  )

  if (!proposeResult) {
    log(`Iter ${iter + 1}: proposal agent failed, skipping`)
    noImprove++
    if (noImprove >= CONVERGE_K) { log('Converged (agent failures). Stopping.'); break }
    continue
  }

  log(`Proposed: "${proposeResult.testClass}"`)
  log(`Code preview: ${proposeResult.newTestCode.slice(0, 120).replace(/\n/g, ' ')}...`)

  let adopted = false
  let delta = 0

  if (DRY_RUN) {
    log(`[DRY RUN] Would append to ${proposeResult.targetTestFile}`)
    adopted = false
    delta = 0
  } else {
    // Write the tests
    const writeResult = await agent(
      `Append the following TypeScript test code to the file ${GUI_DIR}/${proposeResult.targetTestFile}.

The file may already have content. DO NOT replace existing content. Append AFTER the last line.

Code to append:
${proposeResult.newTestCode}

After appending, confirm by returning: { "written": true, "filePath": "${proposeResult.targetTestFile}" }`,
      { label: `write-${baseName}`, phase: 'Improve',
        schema: {
          type: 'object',
          properties: { written: { type: 'boolean' }, filePath: { type: 'string' } },
          required: ['written'],
        }
      }
    )

    if (!writeResult?.written) {
      log(`Iter ${iter + 1}: write failed, skipping`)
      noImprove++
      continue
    }

    // Measure new coverage
    const measureResult = await agent(
      `Run this exact command and return full stdout:
cd "${GUI_DIR}" && bun test --coverage 2>&1

Return JSON: { "output": "<full stdout>" }`,
      { label: `measure-${baseName}`, phase: 'Improve',
        schema: { type: 'object', properties: { output: { type: 'string' } }, required: ['output'] }
      }
    )

    const newCoverage = parseCoverageTable(measureResult?.output || '')
    const newComposite = globalComposite(newCoverage)
    delta = newComposite - currentBest

    // Check if tests pass (no failures)
    const testsPassed = !(measureResult?.output || '').includes(' fail\n') ||
      (measureResult?.output || '').includes(' 0 fail\n')

    if (testsPassed && delta >= MARGIN) {
      adopted = true
      currentBest = newComposite
      // Update coverage for next iteration's weakest-file lookup
      Object.assign(baselineCoverage, newCoverage)
      log(`✓ Adopted! +${delta.toFixed(2)}pp → ${newComposite.toFixed(2)}pp total`)
    } else {
      // Revert
      await agent(
        `Revert the test file to its previous state. Run:
cd "${GUI_DIR}" && git checkout -- "${proposeResult.targetTestFile}" 2>&1 || true

If git checkout fails (file was newly created), delete it:
rm -f "${GUI_DIR}/${proposeResult.targetTestFile}"

Return: { "reverted": true }`,
        { label: `revert-${baseName}`, phase: 'Improve',
          schema: { type: 'object', properties: { reverted: { type: 'boolean' } }, required: ['reverted'] }
        }
      )
      const reason = !testsPassed ? 'tests failed' : `delta ${delta.toFixed(2)} < margin ${MARGIN}`
      log(`✗ Reverted (${reason})`)
    }
  }

  // Record iteration
  const entry = { runId, iter: iter + 1, targetFile, testClass: proposeResult.testClass, adopted, delta, prevScore: currentBest - (adopted ? delta : 0), newScore: adopted ? currentBest : currentBest - delta, dryRun: DRY_RUN }
  iterations.push(entry)

  if (!adopted) {
    noImprove++
    deadEnds.add(targetFile)
  } else {
    noImprove = 0
    deadEnds.delete(targetFile)
    goodPats.push(proposeResult.testClass)
  }

  if (noImprove >= CONVERGE_K) {
    log(`Converged (${CONVERGE_K} non-improving iters). Stopping.`)
    break
  }
}

// ── Phase: Persist ────────────────────────────────────────────────────────────

phase('Persist')

if (iterations.length > 0) {
  await agent(
    `Append these JSON entries (one per line) to the JSONL file at ${JSONL_PATH}.
Create the file and directory if they don't exist (mkdir -p "${HISTORY_DIR}").

Lines to append:
${iterations.map(e => JSON.stringify(e)).join('\n')}

After writing, confirm: { "written": true }`,
    { label: 'persist-history', phase: 'Persist',
      schema: { type: 'object', properties: { written: { type: 'boolean' } }, required: ['written'] }
    }
  )
}

// Update cross-workflow index
await agent(
  `Append or update the cross-workflow index at ${INDEX_PATH}.
Read the file if it exists (JSON array), add/update an entry:
{ "workflow": "bun-command-self-improve", "runId": "${runId}", "iters": ${iterations.length}, "adopted": ${iterations.filter(e=>e.adopted).length}, "baselineComposite": ${baselineComposite.toFixed(2)}, "finalComposite": ${currentBest.toFixed(2)} }
Keep only the 50 most recent entries. Write back.
Return: { "done": true }`,
  { label: 'update-index', phase: 'Persist',
    schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] }
  }
)

// ── Phase: Report ─────────────────────────────────────────────────────────────

phase('Report')

const totalDelta = currentBest - baselineComposite
const adopted = iterations.filter(e => e.adopted).length

return {
  runId,
  dryRun: DRY_RUN,
  baseline: baselineComposite.toFixed(2),
  final:    currentBest.toFixed(2),
  delta:    totalDelta.toFixed(2),
  iters:    iterations.length,
  adopted,
  rejected: iterations.length - adopted,
  summary:  `Coverage: ${baselineComposite.toFixed(1)}% → ${currentBest.toFixed(1)}% (+${totalDelta.toFixed(1)}pp) | ${adopted}/${iterations.length} proposals adopted`,
}
