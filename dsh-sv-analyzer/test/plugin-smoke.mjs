// plugin-smoke.mjs — verify the DSH plugin module wires up correctly:
// registers both tools through a minimal Cordis-like ctx stub and runs a real
// analysis through the compiled WASM. Run after ./build.sh.
//
// Usage: node test/plugin-smoke.mjs

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  console.log(`  ok - ${msg}`)
}

// --- minimal ctx stub ----------------------------------------------------
// Mirrors the Cordis inject contract: the plugin declares inject: ['tools'],
// so the stub must expose ctx.tools directly (ctx.get stays for the optional
// fs service used by the file-input path).
const registered = []
const ctx = {
  tools: {
    register(def) {
      registered.push(def)
      return () => {}
    },
  },
  get(name) {
    return name === 'fs' ? undefined : undefined
  },
  on() {},
}

const plugin = await import(join(here, '..', 'plugin', 'index.js'))
plugin.apply(ctx)

assert(registered.length === 2, `two tools registered (${registered.length})`)
const analyze = registered.find((d) => d.name === 'sv_analyze')
const ast = registered.find((d) => d.name === 'sv_ast')
assert(analyze, 'sv_analyze registered')
assert(ast, 'sv_ast registered')
assert(analyze.output && typeof analyze.output.render === 'function', 'sv_analyze has output.render')
assert(typeof analyze.execute === 'function', 'sv_analyze has execute')

// --- run a real analysis through the tool --------------------------------
console.log('executing sv_analyze via stub ctx')
const counter = await readFile(join(here, '..', 'examples', 'counter.sv'), 'utf8')
const result = await analyze.execute({ code: counter, dialect: 'auto' }, { signal: { aborted: false } })
assert(result.parse_ok === true, 'result.parse_ok')
assert(
  result.design_units.some((u) => u.name === 'counter'),
  'found module counter',
)
assert(
  result.design_units.find((u) => u.name === 'counter').ports.some((p) => p.name === 'clk' && p.direction === 'input'),
  'port clk/input extracted',
)

console.log('executing sv_ast via stub ctx')
const astResult = await ast.execute({ code: 'module m; endmodule' }, { signal: { aborted: false } })
assert(astResult.ast?.type === 'source_file', 'ast root source_file')

console.log('error paths')
const empty = await analyze
  .execute({ code: '' }, { signal: { aborted: false } })
  .then(() => null, (e) => e)
assert(empty instanceof Error, 'empty code raises an error')
const thrown = await analyze
  .execute({ code: 'module m; endmodule', file: '/definitely/missing/file.sv' }, { signal: { aborted: false } })
  .then(() => null, (e) => e)
assert(thrown instanceof Error, 'missing file raises an error')

console.log('\nALL PLUGIN SMOKE TESTS PASSED')
