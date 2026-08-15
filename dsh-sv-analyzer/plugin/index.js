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

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAnalyzer } from './lib/wasm-runner.js'

const WASM_PATH = join(dirname(fileURLToPath(import.meta.url)), 'wasm', 'sv-analyzer.wasm')

// 4 MiB source cap: keeps wasm responses bounded and the tool predictable.
const MAX_CODE_BYTES = 4 * 1024 * 1024

let analyzerPromise = null

function getAnalyzer() {
  if (!analyzerPromise) {
    analyzerPromise = createAnalyzer(WASM_PATH).catch((err) => {
      analyzerPromise = null // allow a later retry after the wasm is built
      throw new Error(
        `sv-analyzer wasm unavailable (${err.message}); run ./build.sh to build plugin/wasm/sv-analyzer.wasm`,
      )
    })
  }
  return analyzerPromise
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function checkAborted(exec) {
  if (exec && exec.signal && exec.signal.aborted) {
    throw new Error('aborted before dispatch')
  }
}

async function resolveCode(args, ctx) {
  let code = typeof args.code === 'string' ? args.code : ''
  if (typeof args.file === 'string' && args.file.length > 0) {
    const fs = ctx.get('fs')
    if (!fs) {
      throw new Error('sv_analyze: file input requested but the fs service is unavailable; pass `code` instead')
    }
    const target = await fs.resolve(args.file)
    code = await fs.readText(target)
  }
  if (!code.trim()) {
    throw new Error('sv_analyze: empty source — provide `code` or a readable `file`')
  }
  const bytes = new TextEncoder().encode(code).byteLength
  if (bytes > MAX_CODE_BYTES) {
    throw new Error(`sv_analyze: source too large (${bytes} bytes > ${MAX_CODE_BYTES} limit)`)
  }
  return code
}

function buildAnalyzeDefinition(ctx) {
  return {
    name: 'sv_analyze',
    description:
      'Analyze Verilog/SystemVerilog source with a tree-sitter parser compiled to WASM. ' +
      'Returns parsed design units (modules/interfaces/programs/packages) with ports, ' +
      'parameters, module instances, signal declarations, always blocks and continuous ' +
      'assigns, plus syntax issues with positions. Provide the source inline via `code` ' +
      'or a workspace file path via `file`; choose the grammar with `dialect`.',
    parameters: {
      code: {
        type: 'string',
        required: false,
        description:
          'Verilog/SystemVerilog source text to analyze. Required unless `file` is provided.',
      },
      file: {
        type: 'string',
        required: false,
        description:
          'Path (relative to the workspace) of a .v/.sv file to read and analyze instead of inline `code`.',
      },
      dialect: {
        type: 'string',
        required: false,
        enum: ['auto', 'systemverilog', 'verilog'],
        description:
          'Grammar to use. "auto" (default) parses with SystemVerilog (IEEE 1800-2023) and falls back to the classic Verilog grammar when the parse has errors.',
      },
      include_ast: {
        type: 'boolean',
        required: false,
        description:
          'Include the full tree-sitter parse tree in the result (can be large; prefer sv_ast for trees).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          dialect: { type: 'string' },
          parse_ok: { type: 'boolean' },
          error_count: { type: 'number' },
          design_units: { type: 'array' },
          stats: { type: 'object' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      checkAborted(exec)
      const code = await resolveCode(args, ctx)
      checkAborted(exec)
      const analyzer = await getAnalyzer()
      const response = await analyzer.call({
        op: 'analyze',
        code,
        dialect: typeof args.dialect === 'string' ? args.dialect : 'auto',
        include_ast: args.include_ast === true,
      })
      if (!response.ok) throw new Error(response.error)
      return response.data
    },
  }
}

function buildAstDefinition(ctx) {
  return {
    name: 'sv_ast',
    description:
      'Dump the raw tree-sitter parse tree (JSON: node type, field, byte range, error/missing flags, children) ' +
      'for Verilog/SystemVerilog source. Provide source inline via `code` or a workspace file via `file`; ' +
      'pick the grammar with `dialect`. Use sv_analyze for a summarized design view.',
    parameters: {
      code: {
        type: 'string',
        required: false,
        description: 'Verilog/SystemVerilog source text. Required unless `file` is provided.',
      },
      file: {
        type: 'string',
        required: false,
        description: 'Path (relative to the workspace) of a .v/.sv file to read and parse.',
      },
      dialect: {
        type: 'string',
        required: false,
        enum: ['auto', 'systemverilog', 'verilog'],
        description: 'Grammar to use; defaults to "auto".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          dialect: { type: 'string' },
          parse_ok: { type: 'boolean' },
          ast: { type: 'object' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      checkAborted(exec)
      const code = await resolveCode(args, ctx)
      checkAborted(exec)
      const analyzer = await getAnalyzer()
      const response = await analyzer.call({
        op: 'ast',
        code,
        dialect: typeof args.dialect === 'string' ? args.dialect : 'auto',
      })
      if (!response.ok) throw new Error(response.error)
      return response.data
    },
  }
}

export const name = 'dsh-sv-analyzer'

export function apply(ctx) {
  const tools = ctx.get('tools')
  if (!tools) return
  const disposers = [tools.register(buildAnalyzeDefinition(ctx)), tools.register(buildAstDefinition(ctx))]
  ctx.on('dispose', () => {
    for (const dispose of disposers) dispose()
  })
}
