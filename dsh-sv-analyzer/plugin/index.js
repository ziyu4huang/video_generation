// dsh-sv-analyzer — DeepSeek Harness host plugin.
//
// Registers two model tools backed by a self-contained tree-sitter WASM
// (wasm32-wasip1) analyzer for Verilog / SystemVerilog:
//
//   sv_analyze — parse and summarize: modules/interfaces/programs/packages,
//                ports, parameters, instances, signals, always blocks,
//                continuous assigns, and syntax issues.
//   sv_ast     — dump the raw tree-sitter parse tree as JSON.
//
// The package is a dsh *bundle* (see package.json `dsh.bundle`), so
// `dsh plugin --profile <name> add dsh-sv-analyzer` auto-activates it and
// the tarball is fully self-contained (the .wasm ships inside).
//
// `parameters` and `output.schema` are raw JSON Schema: `ctx.tools.register`
// validates them but does NOT compile the schemastery DSL — authoring DSL
// shapes here silently corrupts the model-facing tool schema.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAnalyzerService } from './lib/analyzer.js'

const WASM_PATH = join(dirname(fileURLToPath(import.meta.url)), 'wasm', 'sv-analyzer.wasm')

// 1 MiB source cap. Parsing is CPU-heavy (hundreds of ms near the cap) and
// the result grows with the source, so this bounds both the worker's run
// time and the model-facing payload.
const MAX_CODE_BYTES = 1024 * 1024

// Cap on the model-facing rendered text. Larger results fall back to
// compact JSON, then to a hard truncate with an explicit notice.
const MAX_RENDER_CHARS = 256 * 1024

// The `file` input accepts HDL sources only.
const ALLOWED_EXTENSIONS = ['.v', '.sv', '.vh', '.svh']

let analyzerService = null

function getAnalyzer() {
  if (!analyzerService) {
    analyzerService = createAnalyzerService(WASM_PATH)
  }
  return analyzerService
}

function renderJson(_args, value) {
  let text = JSON.stringify(value, null, 2)
  if (text.length > MAX_RENDER_CHARS) {
    text = JSON.stringify(value) // compact before truncating hard
  }
  if (text.length > MAX_RENDER_CHARS) {
    // Avoid splitting a surrogate pair at the cut.
    let cut = text.slice(0, MAX_RENDER_CHARS)
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
    text =
      cut +
      `\n…[render truncated: showing ${cut.length} of ${text.length} chars; ` +
      `analyze a smaller region or use sv_analyze without include_ast]`
  }
  return [{ type: 'text', text }]
}

function checkAborted(exec) {
  if (exec && exec.signal && exec.signal.aborted) {
    throw new Error('aborted before dispatch')
  }
}

function checkExtension(path, toolName) {
  const lower = path.toLowerCase()
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new Error(
      `${toolName}: file must be a Verilog/SystemVerilog source (${ALLOWED_EXTENSIONS.join('/')}), got '${path}'`,
    )
  }
}

async function resolveCode(args, ctx, toolName, exec) {
  let code = typeof args.code === 'string' ? args.code : ''
  if (typeof args.file === 'string' && args.file.length > 0) {
    checkExtension(args.file, toolName)
    const fs = ctx.get('fs')
    if (!fs) {
      throw new Error(
        `${toolName}: file input requested but the fs service is unavailable; pass \`code\` instead`,
      )
    }
    const target = await fs.resolve(args.file)
    // Size pre-check when the backend exposes metadata, so an oversized
    // file is rejected before its content is ever buffered.
    if (typeof fs.stat === 'function') {
      const info = await fs.stat(target, exec?.signal)
      if (info === undefined) {
        throw new Error(`${toolName}: file not found: ${args.file}`)
      }
      if (typeof info.size === 'number' && info.size > MAX_CODE_BYTES) {
        throw new Error(
          `${toolName}: file too large (${info.size} bytes > ${MAX_CODE_BYTES} limit): ${args.file}`,
        )
      }
    }
    code = await fs.readText(target, exec?.signal)
  }
  if (!code.trim()) {
    throw new Error(`${toolName}: empty source — provide \`code\` or a readable \`file\``)
  }
  const bytes = new TextEncoder().encode(code).byteLength
  if (bytes > MAX_CODE_BYTES) {
    throw new Error(`${toolName}: source too large (${bytes} bytes > ${MAX_CODE_BYTES} limit)`)
  }
  return code
}

async function runAnalyzer(op, args, ctx, exec, extra = {}) {
  checkAborted(exec)
  const code = await resolveCode(args, ctx, op === 'ast' ? 'sv_ast' : 'sv_analyze', exec)
  checkAborted(exec)
  const analyzer = getAnalyzer()
  const response = await analyzer.call(
    {
      op,
      code,
      dialect: typeof args.dialect === 'string' ? args.dialect : 'auto',
      ...extra,
    },
    { signal: exec?.signal },
  )
  if (!response.ok) throw new Error(response.error)
  return response.data
}

function buildAnalyzeDefinition() {
  return {
    name: 'sv_analyze',
    description:
      'Analyze Verilog/SystemVerilog source with a tree-sitter parser compiled to WASM. ' +
      'Returns parsed design units (modules/interfaces/programs/packages) with ports, ' +
      'parameters, module instances, signal declarations, always blocks and continuous ' +
      'assigns, plus syntax issues with positions. Provide the source inline via `code` ' +
      'or a workspace file path via `file` (.v/.sv/.vh/.svh); choose the grammar with `dialect`.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Verilog/SystemVerilog source text to analyze. Required unless `file` is provided.',
        },
        file: {
          type: 'string',
          description:
            'Path (relative to the workspace) of a .v/.sv/.vh/.svh file to read and analyze instead of inline `code`.',
        },
        dialect: {
          type: 'string',
          enum: ['auto', 'systemverilog', 'verilog'],
          description:
            'Grammar to use. "auto" (default) parses with SystemVerilog (IEEE 1800-2023); ' +
            'when that parse has errors it also tries the classic Verilog grammar and keeps ' +
            'the cleaner parse.',
        },
        include_ast: {
          type: 'boolean',
          description:
            'Include the full tree-sitter parse tree in the result (can be large and may be ' +
            'truncated — see ast_truncated; prefer the sv_ast tool for trees).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          dialect: { type: 'string' },
          parse_ok: { type: 'boolean' },
          error_count: { type: 'number' },
          issues_truncated: { type: 'boolean' },
          ast_truncated: { type: 'boolean' },
          design_units: { type: 'array' },
          stats: { type: 'object' },
        },
      },
      render: renderJson,
    },
    execute(args, exec) {
      return runAnalyzer('analyze', args, fiberCtx, exec, {
        include_ast: args.include_ast === true,
      })
    },
  }
}

function buildAstDefinition() {
  return {
    name: 'sv_ast',
    description:
      'Dump the raw tree-sitter parse tree (JSON: node type, field, byte range, error/missing ' +
      'flags, children) for Verilog/SystemVerilog source — large trees are truncated with an ' +
      'ast_truncated flag. Provide source inline via `code` or a workspace file via `file` ' +
      '(.v/.sv/.vh/.svh); pick the grammar with `dialect`. Use sv_analyze for a summarized design view.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Verilog/SystemVerilog source text. Required unless `file` is provided.',
        },
        file: {
          type: 'string',
          description: 'Path (relative to the workspace) of a .v/.sv/.vh/.svh file to read and parse.',
        },
        dialect: {
          type: 'string',
          enum: ['auto', 'systemverilog', 'verilog'],
          description: 'Grammar to use; defaults to "auto".',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          dialect: { type: 'string' },
          parse_ok: { type: 'boolean' },
          error_count: { type: 'number' },
          issues_truncated: { type: 'boolean' },
          ast_truncated: { type: 'boolean' },
          ast: { type: 'object' },
        },
      },
      render: renderJson,
    },
    execute(args, exec) {
      return runAnalyzer('ast', args, fiberCtx, exec)
    },
  }
}

export const name = 'dsh-sv-analyzer'

// Hard dependency: wait for the tool registry instead of silently no-oping
// when `tools` is not yet available at activation time (the pattern shipped
// tool plugins use; `ctx.get` + early return would mount the row without
// registering anything).
export const inject = ['tools']

// The Cordis fiber context is closed over by both tool definitions so
// `execute` can reach optional services (the `fs` service for `file`
// inputs). Captured once in apply(); the definitions are rebuilt on every
// activation so a stop/update never leaves a stale context reachable.
let fiberCtx = null

export function apply(ctx) {
  fiberCtx = ctx
  // Registered contributions are owned by this plugin fiber and removed
  // automatically on stop/update; the worker thread and any lazy analyzer
  // state die with it.
  ctx.tools.register(buildAnalyzeDefinition())
  ctx.tools.register(buildAstDefinition())
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      if (analyzerService) {
        analyzerService.dispose()
        analyzerService = null
      }
      fiberCtx = null
    })
  }
}
