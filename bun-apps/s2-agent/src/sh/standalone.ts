/**
 * standalone.ts — side-effect-free entry for OUT-OF-PROCESS consumers of a
 * deployed s2-agent-sh dist.
 *
 * The deploy bundles this file (plus everything it imports — the full host
 * registry and the real loader semantics) into `<dist>/ext/ext-standalone.mjs`.
 * Any bun script, in any directory, can then:
 *
 *   const { loadExt } = require("<dist>/ext/ext-standalone.mjs");
 *   const r = await loadExt("devops").tool("sync_default_branch").execute({ mode: "dryRun" });
 *
 * …with zero repo checkout, zero `bun install`, zero rebuild. The evaluated
 * code is the SAME `ext/<name>/ext.cjs` bytes the running agent loads — this
 * entry adds no extension code of its own. It is a thin layer: (a) the host
 * registry the bundles' `--external` requires need served, (b) the loader
 * functions re-exported from their real home (ext-loader.ts / host-modules.ts
 * — no second implementation to drift).
 *
 * CONTRACT: fail loud. Consumers are scripts, not the agent boot — every
 * problem throws an Error naming the ext/tool and the reason. There are no
 * skip semantics here.
 *
 * No import from cli-sh.ts's boot path may appear here: requiring this bundle
 * must never load extensions, start a session, or touch the TUI.
 *
 * BUILD SHAPE: the deploy builds this with `bun build --target=bun` (ESM, like
 * the core bundle), NOT `--format=cjs`. In an ESM bun bundle `import.meta.dir`
 * is the bundle's REAL runtime path (the deployed core resolves its ext root
 * the same way — mode.ts deployRoot), whereas bun's cjs output REBINDS in-code
 * `__dirname`/`__filename` literals to build-machine paths (the playwright
 * defect, see ext-loader.ts). `#pi/ext-dir` inside a loaded ext.cjs is served
 * by evaluateExtModule with the ext's own dir, so bundles never face the
 * same problem.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluateExtModule, extRequire } from "./ext-loader.ts";
import { hostRequire } from "./host-modules.ts";

/** A tool registered by an extension factory: name + the executable handle. */
export interface StandaloneTool {
	name: string;
	execute: (...args: unknown[]) => unknown;
}

/** One loaded extension: its manifest and its registered tools. */
export interface StandaloneExt {
	name: string;
	/** The parsed ext.json manifest of the deployed extension. */
	manifest: Record<string, unknown>;
	/** All tools the extension's factory registered, in registration order. */
	tools(): StandaloneTool[];
	/** One tool by name. Throws (with the registered names) if absent. */
	tool(name: string): StandaloneTool;
}

/** Manifest-level summary returned by listExts(). */
export interface StandaloneExtSummary {
	name: string;
	manifest: Record<string, unknown>;
}

export interface LoadExtOptions {
	/**
	 * The deploy tree's version dir (the one holding `ext/`). Defaults to the
	 * directory ABOVE this bundle's own location — the shipped layout is
	 * `<dist>/ext/ext-standalone.mjs`, so the bundle's dir IS the ext root and
	 * its parent the dist root. Pass this when the consuming script wants an
	 * explicit tree (e.g. a non-`current` version dir).
	 */
	distRoot?: string;
}

/** The `ext/` dir every ext is resolved from. */
function extRootFor(opts?: LoadExtOptions): string {
	return opts?.distRoot ? join(opts.distRoot, "ext") : dirname(import.meta.dir);
}

/**
 * The registrar handed to an extension factory — the same minimal surface the
 * deploy-e2e `executeExtTool` probe drives file2md/devops tools with, plus
 * explicit no-ops for the registration-time hooks a factory may touch. Unknown
 * methods are NOT swallowed (no Proxy): a factory calling something exotic
 * fails loudly here rather than silently registering nothing.
 */
function registrarCollector(tools: StandaloneTool[]) {
	return {
		on: () => undefined,
		registerTool: (tool: { name?: unknown; execute?: unknown }) => {
			if (typeof tool?.name !== "string" || typeof tool?.execute !== "function") {
				throw new Error(`extension registered a malformed tool: ${JSON.stringify(tool?.name ?? tool)}`);
			}
			tools.push({ name: tool.name, execute: tool.execute as StandaloneTool["execute"] });
		},
		registerCommand: () => undefined,
		registerSkill: () => undefined,
	};
}

/** Read + parse one ext dir's ext.json, or throw naming the ext. */
function readManifest(extDir: string, name: string, opts?: LoadExtOptions): Record<string, unknown> {
	const manifestPath = join(extDir, "ext.json");
	if (!existsSync(manifestPath)) {
		throw new Error(
			`standalone loadExt(${JSON.stringify(name)}): no ext.json at ${manifestPath} — not a deployed extension dir (available: ${listExts(opts).map((e) => e.name).join(", ") || "none"})`,
		);
	}
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
	} catch (e) {
		throw new Error(`standalone loadExt(${JSON.stringify(name)}): ext.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Load one deployed extension and expose its registered tools. Throws on
 * unknown ext, unreadable manifest, or a bundle with no callable default —
 * the consumer is a script and needs the failure, not a skip.
 */
export function loadExt(name: string, opts?: LoadExtOptions): StandaloneExt {
	const extDir = join(extRootFor(opts), name);
	if (!existsSync(extDir)) {
		throw new Error(
			`standalone loadExt(${JSON.stringify(name)}): no extension dir at ${extDir} (available: ${listExts(opts).map((e) => e.name).join(", ") || "none"})`,
		);
	}
	const manifest = readManifest(extDir, name, opts);
	const entryRel = typeof manifest.entry === "string" && manifest.entry ? manifest.entry : "ext.cjs";
	const entryPath = join(extDir, entryRel);
	if (!existsSync(entryPath)) {
		throw new Error(`standalone loadExt(${JSON.stringify(name)}): entry file not found: ${entryPath}`);
	}
	const exports = evaluateExtModule(readFileSync(entryPath, "utf8"), entryPath, extDir, extRequire(extDir, hostRequire));
	const factory = exports.default;
	if (typeof factory !== "function") {
		throw new Error(`standalone loadExt(${JSON.stringify(name)}): bundle has no callable default export`);
	}
	const collected: StandaloneTool[] = [];
	(factory as (api: unknown) => void)(registrarCollector(collected));
	if (collected.length === 0) {
		throw new Error(
			`standalone loadExt(${JSON.stringify(name)}): factory registered no tools at call time (lazy/event-driven registration is not supported standalone — the deploy-e2e probe layer has the same contract)`,
		);
	}
	return {
		name,
		manifest,
		tools: () => [...collected],
		tool: (toolName: string): StandaloneTool => {
			const tool = collected.find((t) => t.name === toolName);
			if (!tool) {
				throw new Error(
					`standalone: tool ${JSON.stringify(toolName)} not registered by ext ${JSON.stringify(name)} (registered: ${collected.map((t) => t.name).join(", ")})`,
				);
			}
			return tool;
		},
	};
}

/** Every deployed extension with a readable ext.json, sorted by name. */
export function listExts(opts?: LoadExtOptions): StandaloneExtSummary[] {
	const root = extRootFor(opts);
	const out: StandaloneExtSummary[] = [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const name of entries.sort()) {
		const extDir = join(root, name);
		const manifestPath = join(extDir, "ext.json");
		// Same ignore rule as the runtime loader: no ext.json dir (or file) is
		// not an extension. This shim's own bundle file lives here too.
		if (!existsSync(manifestPath)) continue;
		try {
			out.push({ name, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> });
		} catch {
			// Listing stays best-effort; loadExt is the loud path.
		}
	}
	return out;
}
