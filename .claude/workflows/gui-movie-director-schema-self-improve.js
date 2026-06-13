export const meta = {
  name: 'gui-movie-director-schema-self-improve',
  description: 'Self-improve gui-movie-director schemas two ways: (coverage) add unit tests via propose→test→adopt/revert; (drift) align GUI schemas to run.py — the CLI source of truth — via check:schema',
  whenToUse: 'objective=coverage (default): raise schema test coverage. objective=drift: auto-fix GUI↔run.py CLI drift. objective=both: drift first, then coverage.',
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
// `args` may arrive as an object or a JSON string depending on the caller; accept both.
const _rawArgs = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : args
const A = isObj(_rawArgs) ? _rawArgs : {}
const BUDGET     = Number(A.budget) || 6           // max iterations
const DRY_RUN    = A.dryRun !== false              // default: dry-run (safe to demo)
const MARGIN     = Number(A.margin) || 1.5         // min composite delta to adopt (pp)
const CONVERGE_K = Number(A.convergeK) || 2        // stop after K non-improving iters
const TARGET     = A.target || null                // optional: focus on one schema file
const OBJECTIVE  = String(A.objective || 'coverage')  // 'coverage' | 'drift' | 'both'
const DO_DRIFT   = OBJECTIVE !== 'coverage'         // drift-fix lane runs when objective includes drift
const DO_COVERAGE = OBJECTIVE !== 'drift'           // coverage lane runs when objective includes coverage

// ── Paths ─────────────────────────────────────────────────────────────────────

const GUI_DIR      = '/Users/huangziyu/proj/video_generation/bun/gui-movie-director'
const PROJECT_ROOT = GUI_DIR.replace(/\/bun\/gui-movie-director$/, '')
const SCHEMAS_DIR  = `${GUI_DIR}/schemas`
const HISTORY_DIR  = '/Users/huangziyu/proj/video_generation/.claude/workflows/history/gui-movie-director-schema-self-improve'
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

// ── Drift baseline (when objective includes drift) ───────────────────────────
// run.py is the CLI source of truth; check:schema --json lists GUI↔run.py drift.
let baselineDriftCount = 0
let driftWorkList = []
if (DO_DRIFT) {
  const driftBase = await agent(
    `Run this exact command and return the parsed JSON object verbatim:
cd "${GUI_DIR}" && bun run check:schema --json 2>/dev/null

It prints one JSON object: { warningCount, errorCount, warnings: [...], errors: [...] }.
Return that object under the field "schema".`,
    { label: 'drift-baseline', phase: 'Baseline',
      schema: { type: 'object', properties: { schema: { type: 'object' } }, required: ['schema'] }
    }
  )
  const allFindings = (driftBase?.schema?.warnings || [])
  baselineDriftCount = Number(driftBase?.schema?.warningCount) || allFindings.length
  // Dedupe to one fix per flag (choices) or per action:flag (default). --pipeline
  // appears across 6 actions but is a single shared fix via schemas/shared.ts.
  const seen = new Set()
  driftWorkList = allFindings.filter(f => {
    const key = f.kind === 'choices' ? `choice:${f.flag}` : `default:${f.action}:${f.flag}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
  log(`Baseline drift: ${baselineDriftCount} warning(s) → ${driftWorkList.length} unique fix target(s)`)
}

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

// ── Drift-fix sub-loop (runs before coverage when objective includes drift) ──
// run.py is the source of truth; align GUI → run.py. Where the GUI legitimately
// has MORE than run.py's argparse (runpy_narrow), widen run.py instead.
let driftFixed = 0
let driftRemaining = baselineDriftCount
const driftIterations = []

if (DO_DRIFT && driftWorkList.length > 0) {
  for (const f of driftWorkList) {
    log(`Drift: ${f.flag} [${f.action}] (${f.category}) — GUI:${JSON.stringify(f.guiValue)} run.py:${JSON.stringify(f.runValue)}`)

    if (DRY_RUN) {
      log(`  [DRY RUN] would apply policy fix for ${f.flag} (${f.category})`)
      driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: false, dryRun: true })
      continue
    }

    // Conservative guard: choices mismatches where GUI ≠ run.py (runpy_narrow,
    // mixed_choices) need human judgment — the GUI may offer options the backend
    // doesn't implement (e.g. --controlnet-type: only "canny" is implemented;
    // others fall back to raw at runtime), or run.py's set may be intentionally
    // wider. Auto-widening run.py or trimming the GUI is unsafe; report instead.
    if (f.category === 'runpy_narrow' || f.category === 'mixed_choices') {
      log(`  ⚠ needs human review (GUI/run.py choice sets differ — may be backend-limited or intentional) — skip`)
      driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: false, skipped: 'needs-review' })
      continue
    }

    // Apply the fix per policy
    const applyResult = await agent(
      `Apply ONE schema-drift fix to align the GUI with run.py (run.py is the source of truth).
Repo root: ${PROJECT_ROOT}. GUI dir: ${GUI_DIR}.

Finding (from \`bun run check:schema --json\`):
${JSON.stringify(f, null, 2)}

Apply exactly ONE branch based on category:
- "gui_missing_choice": run.py offers choice value(s) the GUI lacks → add them to the GUI field.
    • If flag is "--pipeline": choices come from PIPELINE_OPTIONS in bun/gui-movie-director/schemas/shared.ts (one edit fixes all schemas). Each entry is { value, label }. Add the missing value(s) with a sensible label.
    • Otherwise edit the field's choices array in bun/gui-movie-director/schemas/<file>.ts (action→file map: t2i→t2i.ts, i2i→i2i.ts, workflow→workflow.ts, controlnet→controlnet.ts, profile→profile.ts, faceswap→faceswap.ts, restore→image-restore.ts, video-relay→video-relay.ts). Add { value, label } entries for run.py's extra value(s).
- "runpy_narrow": GUI offers value(s) run.py's argparse rejects → widen run.py. grep for the flag in python/mlx-movie-director/app/commands/*.py, find add_argument(..., choices=[...]), add the GUI's missing value(s) to choices.
- "default_mismatch": set the GUI field's default to run.py's default (run.py wins). Edit the field in bun/gui-movie-director/schemas/<file>.ts (same action→file map). ONLY if the field has no choices, OR run.py's default value is already among the field's choice values — otherwise make NO edit and set notes="default not in choices" (a default outside the choice list would be inconsistent).
- "mixed_choices": add run.py's extra value(s) to the GUI choices (align toward run.py); do NOT remove GUI-only values.

Rules: make the MINIMAL edit, do not reformat, preserve existing entries. Return absolute paths of files modified.`,
      { label: `drift-apply-${f.flag.replace(/^--/, '')}`, phase: 'Improve',
        schema: { type: 'object', properties: { touchedFiles: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['touchedFiles'] }
      }
    )

    const touchedFiles = (applyResult?.touchedFiles || []).filter(Boolean)
    const touchedRunpy = touchedFiles.some(p => p.includes('/python/mlx-movie-director/'))

    if (touchedFiles.length === 0) {
      log(`  no edit made (skip)`)
      driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: false })
      continue
    }

    // Verify: check:schema warning count down + bun test pass (+ pytest if run.py touched)
    const verifyResult = await agent(
      `Verify a schema-drift fix broke nothing. Run each, capture the numbers:
1. cd "${GUI_DIR}" && bun run check:schema 2>&1            → the "⚠  N warning(s)" count, and whether it printed "drift error(s)" / exited nonzero (errored=true)
2. cd "${GUI_DIR}" && bun test 2>&1                         → count of failing tests (the "N fail" number)
${touchedRunpy ? `3. cd "${PROJECT_ROOT}/python/mlx-movie-director" && ../../python/venv/bin/python -m pytest app/tests/test_schema.py -q 2>&1  → schemaPytestPass true iff "failed" not in summary` : `3. (run.py not touched — schemaPytestPass=true)`}
Return { warningCount, errored, bunFail, schemaPytestPass }.`,
      { label: `drift-verify-${f.flag.replace(/^--/, '')}`, phase: 'Improve',
        schema: { type: 'object', properties: { warningCount: { type: 'number' }, errored: { type: 'boolean' }, bunFail: { type: 'number' }, schemaPytestPass: { type: 'boolean' } }, required: ['warningCount', 'bunFail'] }
      }
    )

    const warnCount = Number(verifyResult?.warningCount)
    const testsOk = (verifyResult?.bunFail === 0) && (touchedRunpy ? verifyResult?.schemaPytestPass !== false : true)
    const countImproved = Number.isFinite(warnCount) && warnCount < driftRemaining && !verifyResult?.errored

    if (countImproved && testsOk) {
      driftFixed++
      driftRemaining = warnCount
      log(`  ✓ adopted → ${driftRemaining} drift warning(s) remain`)
      driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: true })
    } else {
      // Revert
      await agent(
        `Revert the failed drift fix. For each path run: git checkout -- "<path>"
Paths: ${touchedFiles.map(p => `"${p}"`).join(' ')}
Return { reverted: true }.`,
        { label: `drift-revert-${f.flag.replace(/^--/, '')}`, phase: 'Improve',
          schema: { type: 'object', properties: { reverted: { type: 'boolean' } }, required: ['reverted'] }
        }
      )
      log(`  ✗ reverted (warnCount=${warnCount}, bunFail=${verifyResult?.bunFail})`)
      driftIterations.push({ flag: f.flag, action: f.action, category: f.category, adopted: false })
    }
  }
}

// ── Coverage sub-loop (existing; runs when objective includes coverage) ──────
for (let iter = 0; DO_COVERAGE && iter < BUDGET; iter++) {
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

const persistLines = [...iterations, ...driftIterations]
if (persistLines.length > 0) {
  await agent(
    `Append these JSON entries (one per line) to the JSONL file at ${JSONL_PATH}.
Create the file and directory if they don't exist (mkdir -p "${HISTORY_DIR}").

Lines to append:
${persistLines.map(e => JSON.stringify(e)).join('\n')}

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
{ "workflow": "gui-movie-director-schema-self-improve", "runId": "${runId}", "objective": "${OBJECTIVE}", "iters": ${iterations.length}, "adopted": ${iterations.filter(e=>e.adopted).length}, "baselineComposite": ${baselineComposite.toFixed(2)}, "finalComposite": ${currentBest.toFixed(2)}, "baselineDrift": ${baselineDriftCount}, "driftFixed": ${driftFixed}, "driftRemaining": ${driftRemaining} }
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
  objective: OBJECTIVE,
  dryRun: DRY_RUN,
  baseline: baselineComposite.toFixed(2),
  final:    currentBest.toFixed(2),
  delta:    totalDelta.toFixed(2),
  iters:    iterations.length,
  adopted,
  rejected: iterations.length - adopted,
  baselineDrift: baselineDriftCount,
  driftFixed,
  driftRemaining,
  driftIterations,
  summary: [
    DO_DRIFT ? `Drift: ${baselineDriftCount} → ${driftRemaining} (${driftFixed} fixed)` : null,
    DO_COVERAGE ? `Coverage: ${baselineComposite.toFixed(1)}% → ${currentBest.toFixed(1)}% (+${totalDelta.toFixed(1)}pp) | ${adopted}/${iterations.length} adopted` : null,
  ].filter(Boolean).join(' | '),
}
