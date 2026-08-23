/**
 * adhoc-extensions.ts — load `-e <file>` extensions in the bun-run bundle
 * (deploy-platform-neutral-core ticket 01).
 *
 * WHY THIS EXISTS: pi's own extension loader hands `-e` files to jiti and,
 * for a COMPILED binary, serves the host's module instances via jiti
 * `virtualModules` — bare `@earendil-works/*` imports resolve against the
 * $bunfs graph. In the bun-run bundle every pi module's URL is the one
 * shipped `s2-agent.js`, so pi takes its Node-dist branch (`getAliases()` +
 * `require.resolve` from the deploy dir) and every bare specifier dies with
 * "Cannot find package" — the deploy tree has no node_modules beside the
 * bundle.
 *
 * The sh core therefore intercepts `-e`/`--extension` FILE arguments in
 * bundle mode, loads them itself, and removes the flags from the argv pi's
 * main() sees. Loading rides the SAME pipeline a deployed extension bundle
 * uses: `Bun.build` (the runtime bundler — relative imports are inlined, TS
 * included) with the host module ids `--external`, then ext-loader's
 * `evaluateExtModule` with `extRequire` — so a host-module import resolves to
 * the HOST's in-bundle instance, exactly like an ext.cjs in ext/.
 *
 * Why not jiti (pi's loader): it buys nothing here, and the whole class of
 * loaders interacts badly with bun 1.4's native dynamic import — measured
 * 2026-08-23 (bun 1.4.0): a process can natively `import()` a FRESHLY-WRITTEN
 * tmp `.ts` roughly once; afterwards every new tmp `.ts` import fails with
 * "Cannot find module … from ''", and creating a jiti instance (any options)
 * or a multi-module `Bun.build` burns that shot early. Preexisting files
 * always keep importing fine, so the deployed core (everything bundled, no
 * runtime temp-file imports) is unaffected — the known consumer is the repo
 * CLI's schema-cost, which imports temp factory files. This loader does no
 * native imports at all: single-module builds stay clean, and the sibling-
 * import path (a multi-module build) is the one trigger, noted below.
 *
 * Only files that EXIST are intercepted. Anything else (npm specifiers,
 * URLs, typos) passes through untouched so pi reports it exactly as before.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { evaluateExtModule, extRequire } from "./ext-loader.ts";
import { hostRequire, HOST_MODULE_IDS } from "./host-modules.ts";

/** Extensions pi's arg parser accepts for -e/--extension (value: next argv). */
export const EXTENSION_FLAGS = ["-e", "--extension"] as const;

export interface AdHocExtract {
	/** argv with every intercepted `-e <file>` pair removed, order preserved. */
	passthrough: string[];
	/** Intercepted file paths (existing files only), in argv order. */
	files: string[];
}

/**
 * Split argv into passthrough + interceptable -e files. Pure — no mutation.
 * A `-e` whose value slot is a flag or a nonexistent path is left as-is for
 * pi's parser to handle (or reject) exactly as before.
 */
export function extractAdHocExtensionArgs(argv: string[]): AdHocExtract {
	const passthrough: string[] = [];
	const files: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if ((EXTENSION_FLAGS as readonly string[]).includes(a) && i + 1 < argv.length) {
			const value = argv[i + 1]!;
			if (existsSync(value) && !value.startsWith("-")) {
				files.push(value);
				i++; // consume the value
				continue;
			}
		}
		passthrough.push(a);
	}
	return { passthrough, files };
}

export interface AdHocLoadResult {
	factories: Array<{ path: string; factory: ExtensionFactory }>;
	skipped: Array<{ path: string; reason: string }>;
}

/**
 * Load intercepted -e files. A file that fails to build (top-level await —
 * the cjs format cannot express it — unresolvable bare imports, syntax) or
 * has no callable default is reported in `skipped`, never thrown: pi's own
 * loader reports bad extensions and continues, and so do we.
 */
export async function loadAdHocExtensions(files: string[]): Promise<AdHocLoadResult> {
	const out: AdHocLoadResult = { factories: [], skipped: [] };
	for (const path of files) {
		try {
			const built = await Bun.build({
				entrypoints: [path],
				target: "bun",
				format: "cjs",
				external: [...HOST_MODULE_IDS],
			});
			if (!built.success) {
				out.skipped.push({
					path,
					reason: built.logs.map((l) => (typeof l === "string" ? l : l.message ?? String(l))).join("; ").slice(0, 300),
				});
				continue;
			}
			const code = await built.outputs[0]!.text();
			const mod = evaluateExtModule(code, path, dirname(path), extRequire(dirname(path), hostRequire));
			const factory = mod.default;
			if (typeof factory !== "function") {
				out.skipped.push({ path, reason: "no callable default export" });
				continue;
			}
			out.factories.push({ path, factory: factory as ExtensionFactory });
		} catch (e) {
			out.skipped.push({ path, reason: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}
