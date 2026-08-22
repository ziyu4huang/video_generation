// dsh-archify — DeepSeek Harness host plugin.
//
// Registers three model tools backed by the vendored archify CLI (typed-JSON-IR
// technical diagrams: architecture / workflow / sequence / dataflow / lifecycle):
//
//   archify_validate — validate IR against its schema BEFORE rendering.
//   archify_render   — render IR to a self-contained validated HTML file.
//   archify_delta    — compare two architecture IR snapshots (before/delta/after).
//
// The package is a dsh *bundle* (see package.json `dsh.bundle`), so
// `dsh plugin --profile <name> add dsh-archify` auto-activates it. All engine
// work happens in a **Bun** subprocess (`bun vendored/bin/archify.mjs`); the
// DSH host only runs Node, so this plugin is a thin adapter that resolves the
// Bun runtime (D1), locates the vendored CLI, and marshals args/results.
//
// `parameters` and `output.schema` are raw JSON Schema: `ctx.tools.register`
// validates them but does NOT compile the schemastery DSL — authoring DSL
// shapes here silently corrupts the model-facing tool schema.

import { dirname, isAbsolute, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { runArchify, withTempIr } from './lib/run.ts'
import { loadIrMeta } from './lib/load-ir.ts'
import { resolveOutputPath } from './lib/output-path.ts'

const BUNDLE_DIR = dirname(fileURLToPath(import.meta.url))

// Cap on the model-facing rendered text. Larger results compact then hard
// truncate with an explicit notice (mirrors sv-analyzer).
const MAX_RENDER_CHARS = 256 * 1024

// The diagram types the vendored CLI accepts.
const ALLOWED_TYPES = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'])

/** Resolve the DSH session workspace cwd (the same convention sv-analyzer uses). */
function sessionCwd(exec) {
  return typeof exec?.agent?.session?.header?.cwd === 'string'
    ? exec.agent.session.header.cwd
    : process.cwd()
}

/**
 * Guard against a tool call after the owning fiber was disposed (a profile
 * reload/stop clears `fiberCtx`). Tools have no long-lived subprocess to kill,
 * but a call through a dead fiber should fail cleanly, never half-work.
 */
function ensureFiberActive() {
  if (!fiberCtx) {
    throw new Error(
      'archify plugin fiber is not active — restart the profile or re-activate the plugin',
    )
  }
}

function checkAborted(exec) {
  if (exec && exec.signal && exec.signal.aborted) {
    throw new Error('aborted before dispatch')
  }
}

/** Render a text value to content blocks, size-capped. */
function renderText(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (text.length > MAX_RENDER_CHARS) {
    text = JSON.stringify(value)
  }
  if (text.length > MAX_RENDER_CHARS) {
    let cut = text.slice(0, MAX_RENDER_CHARS)
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
    text =
      cut +
      `\n…[render truncated: showing ${cut.length} of ${text.length} chars; ask for a narrower result]`
  }
  return [{ type: 'text', text }]
}

/** Resolve a user-supplied path to an absolute path against the session cwd. */
function resolvePath(cwd, p) {
  return isAbsolute(p) ? p : join(cwd, p)
}

/** archify `compare` always writes a sidecar `<output>.receipt.json` beside the HTML. */
function receiptPathFor(htmlPath) {
  const ext = extname(htmlPath)
  return ext ? `${htmlPath.slice(0, -ext.length)}.receipt.json` : `${htmlPath}.receipt.json`
}

// ── archify_validate ──────────────────────────────────────────────────────────

async function runValidate(params, cwd, exec) {
  checkAborted(exec)
  const loaded = loadIrMeta({ ir: params.ir, irPath: params.irPath, cwd })
  if (!loaded.ok) throw new Error(loaded.error)
  const type = params.type ?? loaded.meta.type
  if (!type) throw new Error('diagram type could not be determined; pass `type` or set ir.diagram_type.')
  const run = (irPath) => runArchify(['validate', type, irPath, '--json'], cwd, exec?.signal)
  const { stdout, stderr, status } = params.irPath
    ? await run(resolvePath(cwd, params.irPath))
    : await withTempIr(params.ir ?? {}, run)
  if (status !== 0) {
    const binMissing = stdout === ''
    throw new Error(binMissing ? stderr : `archify validate failed (exit ${status}).\n${stderr || stdout}`)
  }
  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    throw new Error(`archify validate produced non-JSON output (exit 0).\n${stdout}`)
  }
  const ok = report.ok === true
  const composition = report.composition
  const warnings = composition?.summary?.warnings ?? 0
  const errors = composition?.summary?.errors ?? 0
  const summary = composition
    ? ` composition ${composition.profile ?? 'n/a'}: ${errors} error(s), ${warnings} warning(s).`
    : ''
  return {
    type,
    valid: ok,
    message: ok ? `IR is valid (${type}).${summary}` : `IR has ${report.diagnostics?.length ?? 1} issue(s):\n${report.error ?? stdout}`,
    report,
  }
}

// ── archify_render ────────────────────────────────────────────────────────────

async function runRender(params, cwd, exec) {
  checkAborted(exec)
  const loaded = loadIrMeta({ ir: params.ir, irPath: params.irPath, cwd })
  if (!loaded.ok) throw new Error(loaded.error)
  const type = params.type ?? loaded.meta.type
  if (!type) throw new Error('diagram type could not be determined; pass `type` or set ir.diagram_type.')
  const irPathGiven = params.irPath ? resolvePath(cwd, params.irPath) : null
  const outPath = resolveOutputPath({
    cwd,
    outputPath: params.outputPath,
    metaOutput: loaded.meta.metaOutput,
    diagramType: type,
  })
  // deliver: render → check → atomic commit → JSON receipt. Never --open
  // (headless; the open-artifact script is not part of the DSH surface).
  const deliver = (irPath) => runArchify(['deliver', type, irPath, outPath, '--json'], cwd, exec?.signal)
  const { stdout, stderr, status } = irPathGiven
    ? await deliver(irPathGiven)
    : await withTempIr(params.ir ?? {}, deliver)
  let receipt
  try {
    receipt = JSON.parse(stdout)
  } catch {
    const binMissing = stdout === ''
    const detail = binMissing ? stderr : `archify deliver produced non-JSON output (exit ${status}). ${stderr || stdout}`
    throw new Error(binMissing ? 'vendored bin missing — see stderr' : detail)
  }
  if (receipt.ok !== true || status !== 0) {
    const diag = receipt.diagnostics?.length
      ? receipt.diagnostics.map((d) => `[${d.code ?? '?'}] ${d.message ?? ''}`).join('\n')
      : receipt.error ?? ''
    throw new Error(`archify render failed: ${receipt.error ?? 'see diagnostics'}.\nValidate the IR first with archify_validate.\n${diag}`)
  }
  const v = receipt.validation
  const checks = v ? `${v.checksPassed ?? '?'}/${v.checkCount ?? '?'} checks` : ''
  const comp = v ? `; composition ${v.compositionProfile ?? 'n/a'}: ${v.compositionStatus ?? '?'}` : ''
  return {
    path: outPath,
    type,
    message: `Rendered ${type} diagram → ${outPath} (${checks}${comp}).`,
    artifact: receipt.artifact,
    validation: receipt.validation,
  }
}

// ── archify_delta ─────────────────────────────────────────────────────────────

async function runDelta(params, cwd, exec) {
  checkAborted(exec)
  const type = params.type ?? 'architecture'
  if (type !== 'architecture') {
    throw new Error("archify_delta is architecture-only (archify compare requires type 'architecture').")
  }
  const base = resolvePath(cwd, params.basePath)
  const head = resolvePath(cwd, params.headPath)
  const outPath = resolveOutputPath({ cwd, outputPath: params.outputPath, diagramType: 'architecture-delta' })
  const { status, stderr, stdout } = await runArchify(['compare', 'architecture', base, head, outPath], cwd, exec?.signal)
  if (status !== 0) {
    const binMissing = stdout === ''
    const detail = binMissing ? stderr : `archify compare failed (exit ${status}). ${stderr || stdout}`
    throw new Error(binMissing ? 'vendored bin missing — see stderr' : detail)
  }
  const receiptPath = receiptPathFor(outPath)
  let summary = ''
  if (existsSync(receiptPath)) {
    try {
      const r = JSON.parse(readFileSync(receiptPath, 'utf8'))
      const v = r.validation
      summary = `\nReceipt → ${receiptPath} (${v ? `${v.checksPassed}/${v.checkCount} checks; ` : ''}completeness ${r.completeness ?? '?'}; ${r.proofLevel ?? '?'}).`
    } catch {
      summary = `\nReceipt → ${receiptPath}.`
    }
  }
  return { path: outPath, type: 'architecture-delta', message: `Rendered architecture delta → ${outPath}${summary}`, receipt: receiptPath }
}

// ── tool definitions ──────────────────────────────────────────────────────────

const TYPE_DESCRIPTION = 'Diagram type: architecture | workflow | sequence | dataflow | lifecycle. Inferred from ir.diagram_type if omitted.'

function buildValidateDefinition() {
  return {
    name: 'archify_validate',
    description:
      'Validate a typed-JSON-IR diagram against its schema BEFORE rendering. Pass `ir` (the JSON object) or `irPath`. ' +
      'Returns validation diagnostics. Always validate before archify_render; never deliver unvalidated IR.',
    parameters: {
      type: 'object',
      properties: {
        ir: { type: 'object', description: 'The diagram IR as a JSON object. Omit if passing irPath.' },
        irPath: { type: 'string', description: 'Path to an IR .json file (absolute or cwd-relative). Used if `ir` is omitted.' },
        type: { type: 'string', enum: [...ALLOWED_TYPES], description: TYPE_DESCRIPTION },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          type: { type: 'string' },
          valid: { type: 'boolean' },
          message: { type: 'string' },
          report: { type: 'object' },
        },
      },
      render: (_args, value) => renderText(value?.message ?? value),
    },
    async execute(args, exec) {
      ensureFiberActive()
      return runValidate(args, sessionCwd(exec), exec)
    },
  }
}

function buildRenderDefinition() {
  return {
    name: 'archify_render',
    description:
      'Render a typed-JSON-IR diagram to a self-contained HTML file (inline SVG, theme toggle, export menu). ' +
      'Pass `ir` (JSON object) or `irPath`. Optional `outputPath` (absolute or cwd-relative); default honors ir.meta.output else <cwd>/<type>.html. ' +
      'Validate first with archify_validate. Returns the absolute output path.',
    parameters: {
      type: 'object',
      properties: {
        ir: { type: 'object', description: 'Diagram IR as a JSON object.' },
        irPath: { type: 'string', description: 'Path to an IR .json file (absolute or cwd-relative).' },
        outputPath: { type: 'string', description: 'Output HTML path (absolute or cwd-relative). Default: ir.meta.output else <cwd>/<type>.html.' },
        type: { type: 'string', enum: [...ALLOWED_TYPES], description: TYPE_DESCRIPTION },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          type: { type: 'string' },
          message: { type: 'string' },
          artifact: { type: 'object' },
          validation: { type: 'object' },
        },
      },
      render: (_args, value) => renderText(value?.message ?? value),
    },
    async execute(args, exec) {
      ensureFiberActive()
      return runRender(args, sessionCwd(exec), exec)
    },
  }
}

function buildDeltaDefinition() {
  return {
    name: 'archify_delta',
    description:
      'Compare two architecture IR snapshots and render a before/delta/after HTML (merge-review). ' +
      'Architecture-only. Pass `basePath` + `headPath` (absolute or cwd-relative). Optional `outputPath`. Returns the absolute output path.',
    parameters: {
      type: 'object',
      properties: {
        basePath: { type: 'string', description: 'Base (before) architecture IR .json path.' },
        headPath: { type: 'string', description: 'Head (after) architecture IR .json path.' },
        outputPath: { type: 'string', description: 'Output HTML path. Default: <cwd>/architecture-delta.html.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          type: { type: 'string' },
          message: { type: 'string' },
          receipt: { type: 'string' },
        },
      },
      render: (_args, value) => renderText(value?.message ?? value),
    },
    async execute(args, exec) {
      ensureFiberActive()
      return runDelta(args, sessionCwd(exec), exec)
    },
  }
}

export const name = 'dsh-archify'

// Hard dependency: wait for the tool registry instead of silently no-oping
// when `tools` is not yet available at activation time (the pattern shipped
// tool plugins use; `ctx.get` + early return would mount the row without
// registering anything).
export const inject = ['tools']

// The Cordis fiber context is captured once in apply() and rebuilt on each
// activation so a stop/update never leaves a stale context reachable. The
// tools use it only as a lifetime guard (see ensureFiberActive) — the real
// engine work is a per-call Bun subprocess owned by each execute.
let fiberCtx = null

export function apply(ctx) {
  fiberCtx = ctx
  // Registered contributions are owned by this plugin fiber and removed
  // automatically on stop/update.
  ctx.tools.register(buildValidateDefinition())
  ctx.tools.register(buildRenderDefinition())
  ctx.tools.register(buildDeltaDefinition())
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      fiberCtx = null
    })
  }
}
