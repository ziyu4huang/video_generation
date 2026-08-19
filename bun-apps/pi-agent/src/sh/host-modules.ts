/**
 * host-modules.ts — the modules the sh-mode core lends to dynamically loaded
 * extensions.
 *
 * WHY THIS EXISTS: an extension bundle that resolves `@earendil-works/pi-tui`
 * from disk gets a DIFFERENT module instance than the one compiled into this
 * binary (measured). pi-agent-ext-task builds TUI overlays and keybindings
 * against the host's running pi-tui, so a second instance breaks
 * identity-sensitive behavior. Extensions are therefore built with these
 * specifiers marked `--external`, and this registry serves them at load time.
 *
 * Every entry MUST be a static `import * as` — only a literal import is inlined
 * by `bun build --compile`; a dynamic or computed import leaves a runtime
 * resolve that crashes inside the binary's virtual filesystem.
 */
import { createRequire } from "node:module";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxValue from "typebox/value";
import * as coreRuntime from "@repo/pi-agent-core-runtime";
// pi-ai is already compiled in via pi-coding-agent (it is a pi-agent dep), so
// serving it costs ~zero core bytes while keeping every extension's model types
// and the streaming helpers identity-stable against the host's session.
import * as piAi from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai/compat";

/**
 * The host↔extension contract version. Bump ONLY on a breaking change to the
 * loader contract (ext.json shape, require semantics, factory shape). Every
 * ext.json declares the version it was built against; a mismatch skips that
 * extension instead of half-loading it.
 *
 * 2 (2026-08-20): `@repo/pi-agent-ext-subagent` was REMOVED from the registry.
 * It had been served because hermes-memory's background handlers imported
 * `spawnSubagent` / `roleAwareDirectCall` from it — an extension importing
 * another extension, resolved by promoting the whole package into the core.
 * Those symbols now live in `@repo/pi-agent-core-runtime` (already a host
 * module, and where the in-flight registry always lived), so subagent is a
 * plain removable extension again. REMOVING a served module is a breaking
 * change for any bundle built against 1: it would resolve the specifier at
 * load and be skipped with a clear reason instead of half-loading.
 */
export const HOST_API = 2;

const REGISTRY: Readonly<Record<string, unknown>> = Object.freeze({
	"@earendil-works/pi-coding-agent": piCodingAgent,
	"@earendil-works/pi-tui": piTui,
	typebox: typebox,
	"typebox/value": typeboxValue,
	"@repo/pi-agent-core-runtime": coreRuntime,
	"@earendil-works/pi-ai": piAi,
	"@earendil-works/pi-ai/compat": piAiCompat,
});

/** Specifiers an extension may require. Also the `--external` set at build time. */
export const HOST_MODULE_IDS: readonly string[] = Object.freeze(Object.keys(REGISTRY));

/**
 * Node/Bun builtins an extension bundle may require. These are NOT host modules
 * in the identity sense — a builtin has one implementation per process either
 * way — but the loader's injected `require` is the ONLY require the bundle
 * gets, so it has to serve them. A minified bundle asks for `module` and
 * `child_process` for its own interop shims even when the extension source
 * never mentions them; without this the extension is skipped at boot.
 *
 * createRequire is verified to resolve builtins inside a `bun build --compile`
 * binary (where import.meta.url is the $bunfs virtual scheme).
 */
const nodeRequire = createRequire(import.meta.url);

const BUILTIN_PREFIXES = ["node:", "bun:"];
const BUILTINS = new Set([
	"assert", "async_hooks", "buffer", "child_process", "cluster", "constants", "crypto",
	"dgram", "dns", "domain", "events", "fs", "http", "http2", "https", "module", "net",
	"os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
	"stream", "string_decoder", "sys", "timers", "tls", "tty", "url", "util", "v8", "vm",
	"worker_threads", "zlib",
]);

/** True for a Node/Bun builtin specifier (with or without the node:/bun: prefix). */
export function isBuiltinSpecifier(spec: string): boolean {
	if (BUILTIN_PREFIXES.some((p) => spec.startsWith(p))) return true;
	return BUILTINS.has(spec.split("/")[0]!);
}

export class HostModuleNotFoundError extends Error {
	constructor(spec: string) {
		super(
			`[pi-agent-sh] extension required "${spec}", which the host does not provide. ` +
				`Host modules: ${HOST_MODULE_IDS.join(", ")}. ` +
				`Either the extension was built against a different host, or the bundler failed to inline it.`,
		);
		this.name = "HostModuleNotFoundError";
	}
}

/** The `require` handed to every extension bundle. Never touches the filesystem. */
export function hostRequire(spec: string): unknown {
	if (isBuiltinSpecifier(spec)) return nodeRequire(spec);
	if (!Object.hasOwn(REGISTRY, spec)) throw new HostModuleNotFoundError(spec);
	return REGISTRY[spec];
}
