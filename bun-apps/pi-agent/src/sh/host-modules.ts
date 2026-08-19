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
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxValue from "typebox/value";
import * as coreRuntime from "@repo/pi-agent-core-runtime";

/**
 * The host↔extension contract version. Bump ONLY on a breaking change to the
 * loader contract (ext.json shape, require semantics, factory shape). Every
 * ext.json declares the version it was built against; a mismatch skips that
 * extension instead of half-loading it.
 */
export const HOST_API = 1;

const REGISTRY: Readonly<Record<string, unknown>> = Object.freeze({
	"@earendil-works/pi-coding-agent": piCodingAgent,
	"@earendil-works/pi-tui": piTui,
	typebox: typebox,
	"typebox/value": typeboxValue,
	"@repo/pi-agent-core-runtime": coreRuntime,
});

/** Specifiers an extension may require. Also the `--external` set at build time. */
export const HOST_MODULE_IDS: readonly string[] = Object.freeze(Object.keys(REGISTRY));

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
	if (!Object.hasOwn(REGISTRY, spec)) throw new HostModuleNotFoundError(spec);
	return REGISTRY[spec];
}
