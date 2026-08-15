// wasm.mjs — end-to-end test of the compiled WASM through Node's built-in
// WASI (node:wasi). Run after ./build.sh (requires plugin/wasm/sv-analyzer.wasm).
//
// Usage: node test/wasm.mjs [path-to-wasm]

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAnalyzer } from '../plugin/lib/wasm-runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const wasmPath = process.argv[2] ?? join(here, '..', 'plugin', 'wasm', 'sv-analyzer.wasm')

const COUNTER = await readFile(join(here, '..', 'examples', 'counter.sv'), 'utf8')

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  console.log(`  ok - ${msg}`)
}

const analyzer = await createAnalyzer(wasmPath)

// --- version op ---------------------------------------------------------
console.log('version op')
const version = await analyzer.call({ op: 'version' })
assert(version.ok === true, 'version returns ok')
assert(typeof version.data.plugin === 'string', 'version has plugin string')

// --- analyze op ---------------------------------------------------------
console.log('analyze op (auto dialect)')
const analyze = await analyzer.call({ op: 'analyze', code: COUNTER, dialect: 'auto' })
assert(analyze.ok === true, 'analyze returns ok')
assert(analyze.data.parse_ok === true, `parse_ok (issues: ${JSON.stringify(analyze.data.issues)})`)
assert(analyze.data.error_count === 0, 'no parse issues')

const names = analyze.data.design_units.map((u) => u.name)
assert(names.includes('counter') && names.includes('reg_sync'), `design units: ${names.join(', ')}`)

const counter = analyze.data.design_units.find((u) => u.name === 'counter')
assert(counter, 'counter unit present')
assert(
  counter.ports.some((p) => p.name === 'clk' && p.direction === 'input'),
  'port clk/input extracted',
)
assert(
  counter.ports.some((p) => p.name === 'count' && p.width === '[WIDTH-1:0]'),
  'port count width extracted',
)
assert(counter.parameters.some((p) => p.name === 'WIDTH' && p.default === '8'), 'param WIDTH=8')
assert(
  counter.instances.some((i) => i.module === 'reg_sync' && i.name === 'sync_inst'),
  'instance reg_sync sync_inst',
)
assert(counter.signals.some((s) => s.name === 'next_count'), 'signal next_count')
assert(
  counter.always_blocks.some((a) => a.kind === 'always_ff' && a.trigger.includes('posedge clk')),
  'always_ff with posedge clk trigger',
)
assert(counter.continuous_assigns.some((a) => a.lhs === 'next_count'), 'assign next_count')

// --- syntax error reporting ---------------------------------------------
console.log('analyze op (syntax errors)')
const broken = await analyzer.call({
  op: 'analyze',
  code: 'module broken(input a; output b); endmodule',
  dialect: 'systemverilog',
})
assert(broken.ok === true, 'broken source still returns ok')
assert(broken.data.parse_ok === false, 'broken source parse_ok=false')
assert(broken.data.error_count >= 1, `issues reported (${broken.data.error_count})`)

// --- issue cap semantics ---------------------------------------------------
// error_count is the TRUE total; `issues` is capped (default 50) and
// issues_truncated says so. NOTE: the space in `$$$bad {i}` matters —
// without it tree-sitter merges the garbage into one ERROR node.
console.log('analyze op (issue cap semantics)')
let junk = 'module m;\n'
for (let i = 0; i < 300; i++) junk += `$$$bad ${i} ;;\n`
junk += 'endmodule\n'
const capped = await analyzer.call({ op: 'analyze', code: junk, dialect: 'systemverilog' })
assert(capped.ok === true, 'junk source returns ok')
assert(capped.data.issues.length <= 50, `issues list capped (${capped.data.issues.length})`)
assert(capped.data.error_count > capped.data.issues.length, 'error_count is the true total')
assert(capped.data.issues_truncated === true, 'issues_truncated flags the cap')

// --- deep nesting must not trap --------------------------------------------
// Guards: MAX_WALK_DEPTH caps the walkers; the 8 MiB wasm stack (link flag)
// carries tree-sitter's own C recursion. 20k nested parens trapped the
// original 1 MiB-stack build.
console.log('analyze op (deep nesting does not trap)')
const depth = 20000
const deep =
  'module m;\nassign x = ' + '('.repeat(depth) + '1' + ')'.repeat(depth) + ';\nendmodule\n'
const deepRes = await analyzer.call({ op: 'analyze', code: deep, dialect: 'systemverilog' })
assert(deepRes.ok === true, 'deeply nested input returns ok (no stack trap)')

// --- ast op: slim payload + truncation flag --------------------------------
console.log('ast op')
const ast = await analyzer.call({ op: 'ast', code: 'module m; endmodule', dialect: 'auto' })
assert(ast.ok === true, 'ast returns ok')
assert(ast.data.ast?.type === 'source_file', 'ast root is source_file')
assert(!('design_units' in ast.data), 'ast op payload has no design_units')
assert(!('stats' in ast.data), 'ast op payload has no stats')

console.log('ast op (truncation flag)')
let many = ''
for (let i = 0; i < 6000; i++) many += `module u${i};\nwire w${i};\nassign w${i} = 1'b0;\nendmodule\n`
const bigAst = await analyzer.call({ op: 'ast', code: many, dialect: 'systemverilog' })
assert(bigAst.ok === true, 'big ast returns ok')
assert(bigAst.data.ast_truncated === true, 'ast_truncated set when node budget is hit')

// --- ast omitted when not requested (output.schema compat) ----------------
console.log('analyze op (ast key omitted unless requested)')
const plain = await analyzer.call({ op: 'analyze', code: 'module m; endmodule' })
assert(!('ast' in plain.data), 'no null ast key when include_ast is unset')

// --- error path ----------------------------------------------------------
console.log('error paths')
const unknown = await analyzer.call({ op: 'nope' })
assert(unknown.ok === false && unknown.error, 'unknown op reports error')
const badJson = await analyzer.call({ op: 'analyze', code: '' })
assert(badJson.ok === false, 'empty code reports error')

console.log('\nALL WASM TESTS PASSED')
