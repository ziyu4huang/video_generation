// wasm-worker.mjs — worker-thread host for the sv-analyzer WASM.
//
// Runs inside a worker thread so parsing (potentially hundreds of ms of
// synchronous wasm execution) never blocks the DSH host event loop. The
// worker owns the WASI instance for its whole lifetime; requests and
// responses are plain JSON over postMessage.
//
// The .mjs extension forces ESM regardless of any surrounding package.json.

import { parentPort } from 'node:worker_threads'
import { createAnalyzer } from './wasm-runner.js'

let ready = null

function ensure(wasmPath) {
  // Single-flight: concurrent first messages must not compile the 40 MB
  // module twice. A failed load clears `ready` so the next call retries.
  if (!ready) {
    ready = createAnalyzer(wasmPath).catch((err) => {
      ready = null
      throw err
    })
  }
  return ready
}

parentPort.on('message', async ({ id, wasmPath, req }) => {
  let analyzer
  try {
    analyzer = await ensure(wasmPath)
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: `wasm unavailable: ${err.message} — run ./build.sh to rebuild plugin/wasm/sv-analyzer.wasm`,
    })
    return
  }
  try {
    parentPort.postMessage({ id, ok: true, res: await analyzer.call(req) })
  } catch (err) {
    // wasm traps surface as catchable JS exceptions; propagate the message.
    parentPort.postMessage({ id, ok: false, error: String(err?.message ?? err) })
  }
})
