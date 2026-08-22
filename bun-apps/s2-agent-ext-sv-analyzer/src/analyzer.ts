/**
 * analyzer.ts — the s2-agent extension's facade over the sv-analyzer WASM.
 *
 * Ports the dsh-sv-analyzer DSH plugin's tool logic (plugin/index.js) minus
 * the worker thread: the DSH plugin runs parses on a worker to protect a
 * long-lived server event loop, while this extension runs them inline because
 * a CLI agent's tool call blocking its own process for a bounded parse is the
 * normal shape (the same sync-call shape every fs/network tool uses). The
 * bounded work is identical: 1 MiB source cap, 256 KiB render cap, extension
 * allow-list for `file` inputs, lazy single-flight wasm load.
 *
 * Load discipline (the `#pi/ext-dir` idiom — see sh-ext-dir.ts):
 *   1. sh deploy: `require("#pi/ext-dir")` → the deployed ext dir, where the
 *      registry's `copy: [wasm]` placed `wasm/sv-analyzer.wasm` beside the
 *      bundle.
 *   2. source / jiti / bun test: package.json `"#pi/ext-dir"` imports entry →
 *      the package root, where `wasm/sv-analyzer.wasm` lives.
 *   3. unresolvable → undefined; callers fall through to their own fallback
 *      (tests may inject an explicit path).
 *
 * Deliberately NOT `import.meta.url`: bun's cjs bundler folds it into a
 * build-machine path literal, which the sh deploy's relocatability gate
 * (scanForeignPaths) rejects.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createAnalyzer, type Analyzer, type WasmRequest } from "./wasm-runner.ts";

/** 1 MiB source cap. Parsing is CPU-heavy (hundreds of ms near the cap) and
 *  the result grows with the source, so this bounds both the run time and the
 *  model-facing payload. */
const MAX_CODE_BYTES = 1024 * 1024;

/** Cap on the model-facing rendered text. Larger results fall back to
 *  compact JSON, then to a hard truncate with an explicit notice. */
const MAX_RENDER_CHARS = 256 * 1024;

/** The `file` input accepts HDL sources only. */
const ALLOWED_EXTENSIONS = [".v", ".sv", ".vh", ".svh"] as const;

const EXT_DIR_SPEC = "#pi/ext-dir";

/** The narrow slice of the tool-execute context this facade needs. */
export interface SvAnalyzerToolContext {
	cwd?: string;
}

export interface AnalyzerServiceOptions {
	/** Override the wasm path (tests / exotic layouts). */
	wasmPath?: string;
}

/**
 * Locate the extension's deployed/package directory through the `#pi/ext-dir`
 * idiom (see sh-ext-dir.ts's header for the resolution order).
 */
export function shExtDir(): string | undefined {
	try {
		if (typeof require === "function") {
			const mod = require(EXT_DIR_SPEC) as { default?: unknown } | string;
			if (typeof mod === "string") return mod; // sh loader: the deployed ext dir
			if (mod !== null && typeof mod === "object" && typeof mod.default === "string") {
				return mod.default; // source/jiti: package.json "#pi/ext-dir" imports entry
			}
		}
	} catch {
		// Not resolvable here (native ESM / tests) — fall through.
	}
	return undefined;
}

/** Default wasm location: `<ext-dir>/wasm/sv-analyzer.wasm`. */
export function defaultWasmPath(extDir: string): string {
	return join(extDir, "wasm", "sv-analyzer.wasm");
}

/** True when `path` ends with an allowed HDL extension (case-insensitive). */
export function isHdlSource(path: string): boolean {
	const lower = path.toLowerCase();
	return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Render a tool result as capped text: pretty JSON, compact JSON when over
 * the cap, then a hard truncate with an explicit notice.
 */
export function renderJson(value: unknown): string {
	let text = JSON.stringify(value, null, 2);
	if (text.length > MAX_RENDER_CHARS) {
		text = JSON.stringify(value); // compact before truncating hard
	}
	if (text.length > MAX_RENDER_CHARS) {
		// Avoid splitting a surrogate pair at the cut.
		let cut = text.slice(0, MAX_RENDER_CHARS);
		const last = cut.charCodeAt(cut.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
		text =
			cut +
			`\n…[render truncated: showing ${cut.length} of ${text.length} chars; ` +
			`analyze a smaller region or use sv_analyze without include_ast]`;
	}
	return text;
}

export interface AnalyzeArgs {
	code?: unknown;
	file?: unknown;
	dialect?: unknown;
	include_ast?: unknown;
}

/**
 * Resolve the source text for one call: inline `code`, or a file path read
 * from disk (s2-agent has no sandbox fs service — extensions read directly,
 * like every other tool; the harness-level sandbox story is the tool-gate).
 */
export function resolveCode(args: AnalyzeArgs, ctx: SvAnalyzerToolContext | undefined, toolName: string): string {
	let code = typeof args.code === "string" ? args.code : "";
	if (typeof args.file === "string" && args.file.length > 0) {
		if (!isHdlSource(args.file)) {
			throw new Error(
				`${toolName}: file must be a Verilog/SystemVerilog source (${ALLOWED_EXTENSIONS.join("/")}), got '${args.file}'`,
			);
		}
		const base = ctx?.cwd ?? process.cwd();
		const target = isAbsolute(args.file) ? args.file : resolve(base, args.file);
		if (!existsSync(target)) {
			throw new Error(`${toolName}: file not found: ${args.file} (resolved to ${target})`);
		}
		const info = statSync(target);
		if (info.size > MAX_CODE_BYTES) {
			throw new Error(`${toolName}: file too large (${info.size} bytes > ${MAX_CODE_BYTES} limit): ${args.file}`);
		}
		code = readFileSync(target, "utf8");
	}
	if (!code.trim()) {
		throw new Error(`${toolName}: empty source — provide \`code\` or a readable \`file\``);
	}
	const bytes = new TextEncoder().encode(code).byteLength;
	if (bytes > MAX_CODE_BYTES) {
		throw new Error(`${toolName}: source too large (${bytes} bytes > ${MAX_CODE_BYTES} limit)`);
	}
	return code;
}

/**
 * The lazy analyzer service. The wasm (≈40 MB module, ~1.6 MB in the tarball)
 * is compiled ONCE on the first tool call and reused for the process lifetime
 * — the enabled path of the extension factory stays IO-free, which is what the
 * base-set isolation contract (STANDALONE LOAD) requires.
 */
export function createAnalyzerService(options: AnalyzerServiceOptions = {}) {
	let analyzerPromise: Promise<Analyzer> | null = null;
	const wasmPath = options.wasmPath ?? (() => {
		const extDir = shExtDir();
		return extDir ? defaultWasmPath(extDir) : undefined;
	})();

	/** Single-flight compile: concurrent first calls must not compile twice. */
	function getAnalyzer(): Promise<Analyzer> {
		if (!analyzerPromise) {
			analyzerPromise = (async () => {
				const path = wasmPath ?? defaultWasmPath(process.cwd());
				if (!existsSync(path)) {
					throw new Error(
						`sv-analyzer: wasm not found at ${path} — rebuild with dsh-plugin/sv-analyzer/build.sh and mirror it here`,
					);
				}
				return createAnalyzer(path);
			})().catch((err) => {
				analyzerPromise = null; // a failed load clears the cache so the next call retries
				throw err;
			});
		}
		return analyzerPromise;
	}

	/**
	 * Dispatch one analyze/ast call. Throws on wasm errors; returns the
	 * parsed `data` on success.
	 */
	async function runAnalyzer(
		op: "analyze" | "ast",
		args: AnalyzeArgs,
		ctx: SvAnalyzerToolContext | undefined,
		signal: AbortSignal | undefined,
		extra: Partial<WasmRequest> = {},
	): Promise<unknown> {
		if (signal?.aborted) throw new Error("aborted before dispatch");
		const code = resolveCode(args, ctx, op === "ast" ? "sv_ast" : "sv_analyze");
		if (signal?.aborted) throw new Error("aborted before dispatch");
		const analyzer = await getAnalyzer();
		const response = await analyzer.call({
			op,
			code,
			dialect: typeof args.dialect === "string" ? args.dialect : "auto",
			...extra,
		});
		if (!response.ok) throw new Error(response.error ?? "sv-analyzer: unknown wasm error");
		return response.data;
	}

	return { getAnalyzer, runAnalyzer, wasmPath };
}

export type AnalyzerService = ReturnType<typeof createAnalyzerService>;
