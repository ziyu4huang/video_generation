/**
 * config.ts — project the deploy pipeline's ShConfig out of the registry.
 *
 * Since ticket 03 (.planning/2026-08-24-registry-code-as-config/) the typed
 * REGISTRY in s2-agent/src/registry-config.ts is the data; `shConfig()` reads
 * it through run-dir/registry.ts's `loadRegistry()` (the validation authority:
 * disk existence, duplicate names/orders, deploy/excludeReason contradictions,
 * vendor overlaps) and projects ShConfig in deploy order. devops runs inside
 * the workspace, so a plain relative import is fine here — map D4's
 * link-state-immunity constraint applies only to bun-apps/tests.
 *
 * `parseShConfig(text)` / `excludedExtensions(text)` are the RETIRED-BRIDGE
 * YAML projections, kept for the fixture-based tests until ticket 04 deletes
 * them with the YAML. No production caller passes YAML text anymore.
 */
import {
	loadRegistry,
	parseRegistry,
	type Registry,
	type RegistryDeployBlock,
	type RegistryExt,
} from "../../../../s2-agent/run-dir/registry.ts";

export interface ShExtConfig {
	name: string;
	/** Directory name under bun-apps/, e.g. "s2-agent-ext-power-tool". */
	package: string;
	/** Entry file relative to the package dir, e.g. "extensions/power-tool.ts". */
	entry: string;
	order: number;
	/** Skill dirs relative to the package dir, copied into the deployed ext dir. */
	skills: string[];
	/**
	 * Data dirs relative to the package dir, copied into the deployed ext dir
	 * WITHOUT being forwarded as `--skill` (the loader only forwards `skills`).
	 * For non-skill assets the extension reads at runtime through
	 * `import.meta.url` / `__dirname` relative resolution (wayfind's
	 * procedures/*.md): the bundler does not carry data files, so they must be
	 * copied like skills — but they are not skills and must not pollute the
	 * system prompt.
	 */
	copy: string[];
	/**
	 * Specifiers left OUT of the bundle and out of the host registry — heavy,
	 * optional deps the extension reaches for lazily at runtime (power-tool's
	 * `await import("playwright-core")`). Bundling them is not an option:
	 * playwright-core's vendored bundle requires chromium-bidi paths the bundler
	 * cannot resolve, which fails the build outright. Declaring one here means
	 * "this extension degrades if the dep is absent", not "the host provides it".
	 */
	externals: string[];
	/**
	 * Packages copied VERBATIM into <ext>/node_modules/<pkg>/ instead of being
	 * bundled, and resolved at runtime from the extension's own directory.
	 *
	 * This exists because bundling is not neutral for every dependency. Bun's cjs
	 * output rewrites `__dirname` to the path the file had ON THE BUILD MACHINE,
	 * so a package that locates its own resources through `__dirname`
	 * (playwright-core) ends up pointing at the builder's install cache and the
	 * deploy tree stops being relocatable. Vendoring gives it a real directory
	 * inside the deploy, where `__dirname` means what it says.
	 *
	 * Distinct from `externals` (not bundled, NOT shipped — the extension
	 * degrades without it) and from hostModules (the core provides it).
	 */
	vendor: string[];
	/**
	 * Closure deps deliberately dropped from the vendored tree, as exact
	 * package names or `<scope>/*` patterns. For deps a vendored package
	 * DECLARES but never resolves at runtime (hyperframes' @fontsource/*:
	 * producer embeds its fonts as base64 and reads no font package from
	 * disk) — ~22MB of pure weight otherwise. Recorded in ext.json's
	 * vendoredClosure.excluded so Gate 5d treats the absence as deliberate.
	 */
	vendorExclude: string[];
	enabled: boolean;
}

export interface ShConfig {
	outRoot: string;
	version: { from: "package.json"; gitSha: boolean };
	freeze: boolean;
	current: boolean;
	/** Version dirs to retain when pruning (registry `deploy.keep`); undefined = deploy default. */
	keep?: number;
	hostApi: number;
	hostModules: string[];
	extensions: ShExtConfig[];
}

/** A registry entry ships iff it has a deploy block that is not disabled. */
function isShipped(
	ext: RegistryExt,
): ext is RegistryExt & { deploy: RegistryDeployBlock } {
	return ext.deploy?.enabled === true;
}

/** The deploy projection over a validated legacy Registry (shared by both read paths). */
function projectShConfig(registry: Registry): ShConfig {
	// Registry `skills: true` means "the package's skills/ dir ships" — the one
	// dir convention the deploy layout hardcodes.
	const extensions: ShExtConfig[] = registry.extensions
		.filter(isShipped)
		.map((ext) => ({
			name: ext.name,
			package: ext.package,
			entry: ext.entry,
			order: ext.deploy.order,
			skills: ext.skills ? ["skills"] : [],
			copy: ext.deploy.copy,
			vendor: ext.deploy.vendor,
			externals: ext.deploy.externals,
			vendorExclude: ext.deploy.vendorExclude,
			enabled: ext.deploy.enabled,
		}))
		.sort((a, b) => a.order - b.order);

	return {
		outRoot: registry.deploy.outRoot,
		version: registry.deploy.version,
		freeze: registry.deploy.freeze,
		current: registry.deploy.current,
		keep: registry.deploy.keep,
		hostApi: registry.hostApi,
		hostModules: registry.hostModules,
		extensions,
	};
}

/** The production read path: typed REGISTRY → validation → ShConfig. */
export function shConfig(opts: { bunAppsDir: string }): ShConfig {
	return projectShConfig(loadRegistry(opts));
}

/**
 * @deprecated Retired bridge (ticket 03): projects ShConfig from
 * s2-agent.registry.yaml text. Fixture tests only; ticket 04 deletes it.
 */
export function parseShConfig(
	text: string,
	opts: { bunAppsDir: string },
): ShConfig {
	return projectShConfig(parseRegistry(text, opts));
}

export interface ExcludedExtension {
	name: string;
	package: string;
	reason: string;
}

/**
 * The not-shipped half of the registry — every entry WITHOUT a live deploy
 * block, with its excludeReason verbatim. parseShConfig keeps only the shipped
 * entries, so the deploy report reads this for its excluded table: the reason
 * a package stays local is part of the deploy's record, not tribal knowledge.
 */
export function excludedExtensionsFromRegistry(opts: { bunAppsDir: string }): ExcludedExtension[] {
	const registry = loadRegistry(opts);
	return registry.extensions
		.filter((ext) => ext.deploy?.enabled !== true)
		.map((ext) => ({
			name: ext.name,
			package: ext.package,
			reason: ext.excludeReason ?? "(no excludeReason given)",
		}));
}

/**
 * @deprecated Retired bridge (ticket 03): the not-shipped half from
 * s2-agent.registry.yaml text. Fixture tests only; ticket 04 deletes it.
 */
export function excludedExtensions(text: string, opts: { bunAppsDir: string }): ExcludedExtension[] {
	const registry = parseRegistry(text, opts);
	return registry.extensions
		.filter((ext) => ext.deploy?.enabled !== true)
		.map((ext) => ({
			name: ext.name,
			package: ext.package,
			reason: ext.excludeReason ?? "(no excludeReason given)",
		}));
}
