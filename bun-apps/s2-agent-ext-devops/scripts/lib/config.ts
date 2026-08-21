/**
 * config.ts — project the deploy pipeline's ShConfig out of the registry.
 *
 * s2-agent.registry.yaml is the ONE config file, parsed + validated by
 * run-dir/registry.ts (`parseRegistry` — the schema authority). This module is
 * a pure projection: registry entries with a `deploy:` block that is not
 * `enabled: false` become ShExtConfig in deploy order. Schema-level checks
 * (unknown keys, ~ expansion, absolute outRoot, entries on disk,
 * vendor∩externals) live in parseRegistry; two disk checks the old parser
 * made — skills/copy dirs existing — are NOT re-validated here and surface
 * at build time (ext-build's cpSync), loudly but with less context.
 */
import {
	parseRegistry,
	type RegistryDeployBlock,
	type RegistryExt,
} from "../../../s2-agent/run-dir/registry.ts";

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

export function parseShConfig(
	text: string,
	opts: { bunAppsDir: string },
): ShConfig {
	const registry = parseRegistry(text, opts);
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
