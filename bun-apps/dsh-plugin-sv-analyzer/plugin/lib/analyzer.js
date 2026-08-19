// analyzer.js — worker-thread facade over the sv-analyzer WASM.
//
// Why a worker: a WASI call is fully synchronous inside the instance
// (parse + tree walks + JSON serialization of up to ~1 MiB of source),
// which measured ~300 ms for 0.5 MiB on the host event loop. Running it
// on the main thread would freeze the whole DSH process — UI, other
// agents, RPC — for the duration of every call. One persistent worker
// owns the WASI instance; concurrent calls queue on it (they are CPU
// bound anyway, so parallelism would not help).
//
// Lifecycle: the worker is spawned lazily on the first call, torn down
// after IDLE_MS with no in-flight calls (so a one-shot call never leaks
// a ~80 MB thread), and `dispose()` kills it immediately; a later call
// transparently respawns. The plugin also registers `dispose` as a fiber
// effect so the thread dies with the plugin.

import { Worker } from 'node:worker_threads'

const WORKER_URL = new URL('./wasm-worker.mjs', import.meta.url)

// Idle teardown delay: long enough that back-to-back calls in one task
// reuse the instance, short enough that an idle plugin holds no thread.
const IDLE_MS = 60_000

export function createAnalyzerService(wasmPath) {
  let worker = null
  let seq = 0
  let idleTimer = null
  const pending = new Map() // id -> { resolve, reject }

  function dropPending(reason) {
    for (const { reject } of pending.values()) {
      reject(new Error(`sv-analyzer worker unavailable: ${reason}`))
    }
    pending.clear()
  }

  function teardown() {
    if (!worker) return
    const w = worker
    worker = null
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    w.removeAllListeners()
    w.terminate().catch(() => {})
  }

  function armIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (pending.size === 0) teardown()
    }, IDLE_MS)
    // Do not hold the event loop open just for the teardown timer.
    idleTimer.unref?.()
  }

  // Called whenever pending drops to zero: an idle worker must not keep
  // the host event loop (or a test process) alive. The next call re-refs
  // it before posting, so an in-flight reply can never be missed.
  function markIdle(w) {
    if (pending.size === 0) {
      w.unref?.()
      armIdleTimer()
    }
  }

  function ensureWorker() {
    if (worker) return worker
    const w = new Worker(WORKER_URL)
    w.on('message', (msg) => {
      const entry = pending.get(msg.id)
      if (!entry) return // stale reply (e.g. the caller aborted meanwhile)
      pending.delete(msg.id)
      markIdle(w)
      if (msg.ok) entry.resolve(msg.res)
      else entry.reject(new Error(msg.error))
    })
    // A crashed / exited worker must reject every in-flight call and be
    // respawned by the next one.
    w.on('error', (err) => {
      dropPending(err?.message ?? 'worker error')
      teardown()
    })
    w.on('exit', (code) => {
      if (worker === w) {
        dropPending(`worker exited (code ${code})`)
        worker = null
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }
    })
    worker = w
    return w
  }

  function call(req, options = {}) {
    const w = ensureWorker()
    // Re-ref for the duration of the call: the loop must stay alive until
    // the reply lands (promises alone hold nothing).
    w.ref?.()
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    const id = ++seq
    const signal = options.signal
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject }
      const detachSignal = () => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
      }
      const onAbort = () => {
        // Drop the entry; the worker keeps parsing to completion but its
        // late reply is ignored (wasm execution cannot be interrupted).
        pending.delete(id)
        detachSignal()
        markIdle(w)
        reject(new Error('aborted'))
      }
      pending.set(id, entry)
      if (signal) {
        if (signal.aborted) {
          pending.delete(id)
          reject(new Error('aborted'))
          return
        }
        // Real harness signals are AbortSignals; plain signal-shaped
        // objects (tests) may only expose `.aborted`.
        if (typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }
      try {
        // Structured-clone failures (never for plain JSON) throw here.
        w.postMessage({ id, wasmPath, req })
      } catch (err) {
        pending.delete(id)
        detachSignal()
        reject(err)
      }
    })
  }

  function dispose() {
    dropPending('analyzer disposed')
    teardown()
  }

  return { call, dispose }
}
