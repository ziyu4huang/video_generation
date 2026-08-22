// plugin-smoke.mjs — verify the dsh-archify DSH plugin wires up correctly:
// registers all three tools through a minimal Cordis-like ctx stub, asserts the
// parameter schemas are raw JSON Schema (the DSL regression that once broke
// every model request), then runs a REAL `archify_validate` through the tool
// under Bun and asserts a clean receipt.
//
// DSH runs the plugin underneath Node; the engine work is a Bun subprocess run
// by the plugin's lib/run.ts. This smoke test executes the tool's real
// `execute` so the Bun ladder + vendored CLI path are exercised end-to-end.
//
// Usage: node test/plugin-smoke.mjs

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundleRoot = join(here, '..')
const vendoredExamples = join(bundleRoot, 'plugin', 'vendored', 'examples')

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
  assert(typeof schema.additionalProperties === 'boolean', `${label}.additionalProperties is boolean`)
  for (const [key, prop] of Object.entries(schema.properties)) {
    assert(!('required' in prop), `${label}.properties.${key} has no DSL \`required\` key`)
    assert(!prop.properties || typeof prop.properties === 'object', `${label}.properties.${key} nested shape is plain JSON Schema`)
    if ('enum' in prop) assert(Array.isArray(prop.enum), `${label}.properties.${key}.enum is an array`)
    if ('additionalProperties' in prop) assert(typeof prop.additionalProperties === 'boolean', `${label}.properties.${key}.additionalProperties is boolean`)
  }
}

// --- minimal ctx stub ------------------------------------------------------
// Mirrors the Cordis inject contract: the plugin declares inject: ['tools'],
// so the stub must expose ctx.tools directly. ctx.effect uses Cordis 3
// semantics: the callback runs NOW (setup) and its RETURN VALUE is the
// disposer that runs when the fiber is disposed.
const registered = []
const disposers = []

const ctx = {
  tools: {
    register(def) {
      registered.push(def)
      return () => {}
    },
  },
  get() {
    return undefined
  },
  on() {},
  effect(fn) {
    const disposer = fn()
    disposers.push(disposer)
    return disposer
  },
}

const plugin = await import(join(bundleRoot, 'plugin', 'index.js'))
plugin.apply(ctx)

assert(registered.length === 3, `three tools registered (${registered.length})`)
const validate = registered.find((d) => d.name === 'archify_validate')
const render = registered.find((d) => d.name === 'archify_render')
const delta = registered.find((d) => d.name === 'archify_delta')
assert(validate, 'archify_validate registered')
assert(render, 'archify_render registered')
assert(delta, 'archify_delta registered')
assert(validate.output && typeof validate.output.render === 'function', 'archify_validate has output.render')
assert(typeof validate.execute === 'function', 'archify_validate has execute')

console.log('schema shape (the DSL regression guard)')
assertRawJsonSchema(validate.parameters, 'archify_validate.parameters')
assertRawJsonSchema(render.parameters, 'archify_render.parameters')
assertRawJsonSchema(delta.parameters, 'archify_delta.parameters')

// --- run a real validate through the tool (Bun subprocess) ----------------
console.log("executing archify_validate via stub ctx (Bun subprocess)")
// An inline architecture IR we know validates cleanly. Read the shipped hosted
// example and re-inline it so the tool's `ir` path is exercised (the vendored
// CLI writes nothing for validate, so no filesystem side effect).
import { readFile } from 'node:fs/promises'
const examplePath = join(vendoredExamples, 'web-app.architecture.json')
const exampleIr = JSON.parse(await readFile(examplePath, 'utf8'))

const assertExampleType = (t) => {
  assert(typeof t === 'string' && ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'].includes(t), `diagram type "${t}" is one of the allowed set`)
}
assertExampleType(exampleIr.diagram_type)

const result = await validate.execute({ ir: exampleIr }, { signal: new AbortController().signal })
assert(result.valid === true, 'result.valid is true')
assert(result.type === exampleIr.diagram_type, 'result.type matches the IR diagram_type')
assert(result.report && result.report.ok === true, 'result.report.ok is true')
assert(Array.isArray(result.report.checks) && result.report.checks.length > 0, 'result.report.checks present')
assert(result.report.composition?.summary?.errors === 0, 'composition summary has 0 errors')
assert(typeof result.message === 'string' && result.message.includes('valid'), 'result.message is a valid summary')

// --- validate short-circuits on a bad type ---------------------------------
const badType = await validate
  .execute({ ir: exampleIr, type: 'not-a-type' }, { signal: new AbortController().signal })
  .then(() => null, (e) => e)
assert(badType instanceof Error && /type could not be determined|Invalid enum|not-a-type/.test(badType.message), 'unresolvable/unknown type raises an error')

// --- archify_render / archify_delta exist with the right surface -----------
// (their full subprocess runs are exercised by the bundle build, not this
// smoke test; here we assert the registration surface + schema are sound.)
assert(render.output.schema.properties.path, 'archify_render output schema declares path')
assert(delta.output.schema.properties.path, 'archify_delta output schema declares path')

console.log('lifecycle (dispose)')
assert(disposers.length === 1, 'one disposer collected from ctx.effect')

console.log('\nALL PLUGIN SMOKE TESTS PASSED')
