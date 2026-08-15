// plugin-smoke.mjs — verify the DSH plugin module wires up correctly:
// registers both tools through a minimal Cordis-like ctx stub, asserts the
// parameter schemas are raw JSON Schema (the DSL regression that once broke
// every model request), and runs real analyses through the worker thread.
// Run after ./build.sh.
//
// Usage: node test/plugin-smoke.mjs

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const here = dirname(fileURLToPath(import.meta.url))

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  console.log(`  ok - ${msg}`)
}

// --- schema-shape guard ---------------------------------------------------
// ctx.tools.register does NOT compile the schemastery DSL; a DSL-shaped
// `parameters` silently corrupts the model-facing tool schema and every
// request with it. This is the regression test for exactly that bug.
function assertRawJsonSchema(schema, label) {
  assert(schema && schema.type === 'object', `${label}.type === "object"`)
  assert(schema.properties && typeof schema.properties === 'object', `${label}.properties is a map`)
  assert(
    typeof schema.additionalProperties === 'boolean',
    `${label}.additionalProperties is boolean`,
  )
  for (const [key, prop] of Object.entries(schema.properties)) {
    assert(!('required' in prop), `${label}.properties.${key} has no DSL \`required\` key`)
    assert(
      !prop.properties || typeof prop.properties === 'object',
      `${label}.properties.${key} nested shape is plain JSON Schema`,
    )
    if ('enum' in prop) assert(Array.isArray(prop.enum), `${label}.properties.${key}.enum is an array`)
  }
}

// --- minimal ctx stub ------------------------------------------------------
// Mirrors the Cordis inject contract: the plugin declares inject: ['tools'],
// so the stub must expose ctx.tools directly (ctx.get stays for the optional
// fs service used by the file-input path).
const registered = []
const disposers = []
const ctx = {
  tools: {
    register(def) {
      registered.push(def)
      return () => {}
    },
  },
  get(name) {
    return undefined
  },
  on() {},
  effect(fn) {
    disposers.push(fn)
    return fn
  },
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

console.log('schema shape (the DSL regression guard)')
assertRawJsonSchema(analyze.parameters, 'sv_analyze.parameters')
assertRawJsonSchema(ast.parameters, 'sv_ast.parameters')

// --- run a real analysis through the tool (worker thread + wasm) ----------
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
assert(result.issues_truncated === false, 'issues_truncated present and false')
assert(!('ast' in result), 'ast absent when include_ast not set (no null vs {type:object} violation)')

console.log('executing sv_ast via stub ctx')
const astResult = await ast.execute({ code: 'module m; endmodule' }, { signal: { aborted: false } })
assert(astResult.ast?.type === 'source_file', 'ast root source_file')
assert(astResult.ast_truncated === false, 'ast_truncated present and false')
assert(!('design_units' in astResult), 'sv_ast payload is slim (no design_units)')
assert(!('stats' in astResult), 'sv_ast payload is slim (no stats)')

console.log('error paths')
const empty = await analyze
  .execute({ code: '' }, { signal: { aborted: false } })
  .then(() => null, (e) => e)
assert(empty instanceof Error && /sv_analyze:/.test(empty.message), 'empty code raises sv_analyze-prefixed error')

const wrongExt = await ast
  .execute({ file: 'readme.md' }, { signal: { aborted: false } })
  .then(() => null, (e) => e)
assert(wrongExt instanceof Error && /\.v\/\.sv/.test(wrongExt.message), 'non-HDL extension rejected')

const missing = await analyze
  .execute({ file: '/definitely/missing/file.sv' }, { signal: { aborted: false } })
  .then(() => null, (e) => e)
assert(missing instanceof Error, 'missing file raises an error')

// --- lifecycle: dispose kills the worker, next call respawns --------------
console.log('lifecycle (dispose -> respawn)')
assert(disposers.length === 1, 'analyzer disposer registered via ctx.effect')
for (const dispose of disposers) dispose()
const after = await analyze.execute(
  { code: 'module post_dispose; endmodule' },
  { signal: { aborted: false } },
)
assert(after.parse_ok === true, 'analyzer respawns after dispose')

console.log('\nALL PLUGIN SMOKE TESTS PASSED')
