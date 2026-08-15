// wasm-runner.js — load the dsh-sv-analyzer WASM (wasm32-wasip1) with Node's
// built-in WASI (node:wasi, zero runtime dependencies) and drive it over a
// tiny exported-function ABI:
//
//   alloc(len) -> ptr | run(ptr, len) -> ptr | response_len() | free_response() | dealloc(ptr, len)
//
// The module is fully self-contained (tree-sitter C library + both grammars
// linked in, no `env` imports). One persistent WASI instance serves every
// call; requests and responses are lossless JSON crossing linear memory.

import { WASI } from 'node:wasi'
import { readFile } from 'node:fs/promises'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * @param {string} wasmPath absolute path to sv-analyzer.wasm
 * @returns {Promise<{ call(obj: object): Promise<object> }>}
 */
export async function createAnalyzer(wasmPath) {
  const wasi = new WASI({ version: 'preview1', args: [], env: {}, returnOnExit: true })
  const module = await WebAssembly.compile(await readFile(wasmPath))
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  })

  // The parser never performs WASI I/O, but a few std imports (proc_exit,
  // fd_write for panic output) are linked in; satisfy them and ignore errors.
  try {
    wasi.initialize(instance)
  } catch {
    /* no _initialize export — fine */
  }
  const exports = instance.exports

  /**
   * Dispatch one JSON request and return the parsed JSON response.
   * @param {object} req
   * @returns {Promise<object>}
   */
  async function call(req) {
    const payload = encoder.encode(JSON.stringify(req))
    const reqPtr = exports.alloc(payload.byteLength)
    if (!reqPtr) throw new Error('sv-analyzer: wasm alloc failed')
    try {
      // Fresh view after alloc: alloc may have grown linear memory.
      new Uint8Array(exports.memory.buffer).set(payload, reqPtr)
      const respPtr = exports.run(reqPtr, payload.byteLength)
      const len = exports.response_len()
      // Fresh view again: run may have grown linear memory.
      const view = new Uint8Array(exports.memory.buffer, respPtr, len)
      const bytes = view.slice()
      const text = decoder.decode(bytes)
      if (!text) throw new Error('sv-analyzer: empty wasm response')
      return JSON.parse(text)
    } finally {
      exports.free_response()
      exports.dealloc(reqPtr, payload.byteLength)
    }
  }

  return { call }
}
