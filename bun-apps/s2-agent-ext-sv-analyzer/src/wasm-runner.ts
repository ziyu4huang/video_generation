/**
 * wasm-runner.ts — load the sv-analyzer WASM (wasm32-wasip1) with Bun's
 * built-in WASI (`node:wasi`, zero runtime dependencies) and drive it over the
 * tiny exported-function ABI:
 *
 *   alloc(len) -> ptr | run(ptr, len) -> ptr | response_len() | free_response() | dealloc(ptr, len)
 *
 * This is the same loader the dsh-sv-analyzer DSH plugin ships
 * (dsh-plugin/sv-analyzer/plugin/lib/wasm-runner.js) — the module is fully
 * self-contained (tree-sitter C library + both grammars linked in, no `env`
 * imports), so the ONLY host difference is the import source: the DSH plugin
 * runs it in a worker thread to protect a long-lived server event loop; the
 * s2-agent extension runs it inline, because a CLI agent's tool call blocking
 * its own process for a bounded parse is normal (the same sync-call shape
 * every fs/network tool already uses). Requests and responses are lossless
 * JSON crossing linear memory; one persistent WASI instance serves every call.
 *
 * The `version` op is a cheap load probe: callers use it to verify the
 * shipped wasm is present and answers before surfacing tool failures.
 */

import { WASI } from "node:wasi";
import { readFile } from "node:fs/promises";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One JSON request to the wasm dispatch (`op: "analyze" | "ast" | "version"`). */
export interface WasmRequest {
	op: string;
	code?: string;
	dialect?: string;
	include_ast?: boolean;
	max_errors?: number;
}

/** The wasm's envelope: `{ ok: true, data } | { ok: false, error }`. */
export interface WasmResponse {
	ok: boolean;
	data?: unknown;
	error?: string;
}

export interface Analyzer {
	/** Dispatch one JSON request and return the parsed JSON response. */
	call(req: WasmRequest): Promise<WasmResponse>;
}

/**
 * Compile + instantiate the analyzer module and return a persistent caller.
 * The WASI instance owns the module's linear memory for its whole lifetime.
 */
export async function createAnalyzer(wasmPath: string): Promise<Analyzer> {
	const wasi = new WASI({ version: "preview1", args: [], env: {}, returnOnExit: true });
	const module = await WebAssembly.compile(await readFile(wasmPath));
	const instance = await WebAssembly.instantiate(module, {
		wasi_snapshot_preview1: wasi.wasiImport,
	});

	// The parser never performs WASI I/O, but a few std imports (proc_exit,
	// fd_write for panic output) are linked in; satisfy them and ignore errors.
	try {
		wasi.initialize(instance);
	} catch {
		/* no _initialize export — fine */
	}
	const exports = instance.exports as {
		alloc(len: number): number;
		run(ptr: number, len: number): number;
		response_len(): number;
		free_response(): void;
		dealloc(ptr: number, len: number): void;
		memory: WebAssembly.Memory;
	};

	return {
		async call(req: WasmRequest): Promise<WasmResponse> {
			const payload = encoder.encode(JSON.stringify(req));
			const reqPtr = exports.alloc(payload.byteLength);
			if (!reqPtr) throw new Error("sv-analyzer: wasm alloc failed");
			try {
				// Fresh view after alloc: alloc may have grown linear memory.
				new Uint8Array(exports.memory.buffer).set(payload, reqPtr);
				const respPtr = exports.run(reqPtr, payload.byteLength);
				const len = exports.response_len();
				// Fresh view again: run may have grown linear memory.
				const view = new Uint8Array(exports.memory.buffer, respPtr, len);
				const bytes = view.slice();
				const text = decoder.decode(bytes);
				if (!text) throw new Error("sv-analyzer: empty wasm response");
				return JSON.parse(text) as WasmResponse;
			} finally {
				exports.free_response();
				exports.dealloc(reqPtr, payload.byteLength);
			}
		},
	};
}
