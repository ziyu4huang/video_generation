/**
 * sh-config.ts — parse + validate bun-apps/pi-agent/deploy-config.yaml.
 *
 * Strict on purpose: an unknown key is an error, not a silent no-op. A typo in
 * a deploy config that silently does nothing is the failure mode this rejects.
 * Uses Bun.YAML.parse — no dependency needed.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ShExtConfig {
	name: string;
	/** Directory name under bun-apps/, e.g. "pi-agent-ext-power-tool". */
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
	enabled: boolean;
}

export interface ShConfig {
	outRoot: string;
	version: { from: "package.json"; gitSha: boolean };
	freeze: boolean;
	current: boolean;
	hostApi: number;
	hostModules: string[];
	extensions: ShExtConfig[];
}

const TOP_KEYS = new Set(["outRoot", "version", "freeze", "current", "hostApi", "hostModules", "extensions"]);
const EXT_KEYS = new Set(["name", "package", "entry", "order", "skills", "copy", "enabled", "externals", "vendor"]);

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export function parseShConfig(text: string, opts: { bunAppsDir: string }): ShConfig {
	const raw = Bun.YAML.parse(text) as Record<string, unknown> | null;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("deploy-config.yaml must be a YAML mapping");
	}
	for (const k of Object.keys(raw)) {
		if (!TOP_KEYS.has(k)) throw new Error(`unknown config key "${k}" (known: ${[...TOP_KEYS].join(", ")})`);
	}

	if (typeof raw.outRoot !== "string" || raw.outRoot.length === 0) {
		throw new Error(`config key "outRoot" is required and must be a string`);
	}
	const outRoot = expandHome(raw.outRoot);
	if (!isAbsolute(outRoot)) throw new Error(`outRoot must resolve to an absolute path, got "${outRoot}"`);

	if (typeof raw.hostApi !== "number" || !Number.isInteger(raw.hostApi)) {
		throw new Error(`config key "hostApi" is required and must be an integer`);
	}
	if (
		!Array.isArray(raw.hostModules) ||
		raw.hostModules.length === 0 ||
		!raw.hostModules.every((m) => typeof m === "string")
	) {
		throw new Error(`config key "hostModules" is required and must be a non-empty array of strings`);
	}

	const versionRaw = (raw.version ?? {}) as Record<string, unknown>;
	for (const k of Object.keys(versionRaw)) {
		if (k !== "from" && k !== "gitSha") throw new Error(`unknown version key "${k}" (known: from, gitSha)`);
	}
	if (versionRaw.from !== undefined && versionRaw.from !== "package.json") {
		throw new Error(`version.from currently supports only "package.json"`);
	}

	if (!Array.isArray(raw.extensions) || raw.extensions.length === 0) {
		throw new Error(`config key "extensions" must list at least one extension`);
	}

	const seen = new Set<string>();
	const extensions: ShExtConfig[] = raw.extensions.map((e, i) => {
		if (e === null || typeof e !== "object" || Array.isArray(e)) {
			throw new Error(`extensions[${i}] must be a mapping`);
		}
		const ext = e as Record<string, unknown>;
		for (const k of Object.keys(ext)) {
			if (!EXT_KEYS.has(k)) throw new Error(`unknown extension key "${k}" (known: ${[...EXT_KEYS].join(", ")})`);
		}
		for (const field of ["name", "package", "entry"]) {
			if (typeof ext[field] !== "string" || (ext[field] as string).length === 0) {
				throw new Error(`extensions[${i}].${field} is required and must be a string`);
			}
		}
		const name = ext.name as string;
		if (seen.has(name)) throw new Error(`duplicate extension name "${name}"`);
		seen.add(name);

		const pkgDir = resolve(opts.bunAppsDir, ext.package as string);
		if (!existsSync(pkgDir)) throw new Error(`extensions[${i}] package dir not found: ${pkgDir}`);
		const entryAbs = resolve(pkgDir, ext.entry as string);
		if (!existsSync(entryAbs)) throw new Error(`extensions[${i}] entry not found: ${entryAbs}`);

		const skills = ext.skills === undefined ? [] : ext.skills;
		if (!Array.isArray(skills) || !skills.every((s) => typeof s === "string")) {
			throw new Error(`extensions[${i}].skills must be an array of strings`);
		}
		for (const s of skills as string[]) {
			if (!existsSync(resolve(pkgDir, s))) {
				throw new Error(`extensions[${i}] skills dir not found: ${resolve(pkgDir, s)}`);
			}
		}

		const copy = ext.copy === undefined ? [] : ext.copy;
		if (!Array.isArray(copy) || !copy.every((s) => typeof s === "string")) {
			throw new Error(`extensions[${i}].copy must be an array of strings`);
		}
		for (const c of copy as string[]) {
			if (!existsSync(resolve(pkgDir, c))) {
				throw new Error(`extensions[${i}] copy dir not found: ${resolve(pkgDir, c)}`);
			}
		}

		const externals = ext.externals === undefined ? [] : ext.externals;
		if (!Array.isArray(externals) || !externals.every((s) => typeof s === "string")) {
			throw new Error(`extensions[${i}].externals must be an array of strings`);
		}

		const vendor = ext.vendor === undefined ? [] : ext.vendor;
		if (!Array.isArray(vendor) || !vendor.every((s) => typeof s === "string")) {
			throw new Error(`extensions[${i}].vendor must be an array of strings`);
		}
		for (const v of vendor as string[]) {
			// A package cannot be both shipped and declared-absent; the two answer
			// the same question ("where does this come from at runtime?") with
			// different answers, and the build would honor whichever it read last.
			if ((externals as string[]).includes(v)) {
				throw new Error(`extensions[${i}]: "${v}" is in both vendor and externals — pick one`);
			}
		}

		const order = ext.order === undefined ? 100 : ext.order;
		if (typeof order !== "number" || !Number.isFinite(order)) {
			throw new Error(`extensions[${i}].order must be a number`);
		}
		const enabled = ext.enabled === undefined ? true : ext.enabled;
		if (typeof enabled !== "boolean") throw new Error(`extensions[${i}].enabled must be a boolean`);

		return {
			name,
			package: ext.package as string,
			entry: ext.entry as string,
			order,
			skills: skills as string[],
			copy: copy as string[],
			enabled,
			externals: externals as string[],
			vendor: vendor as string[],
		};
	});

	return {
		outRoot,
		version: {
			from: "package.json",
			gitSha: versionRaw.gitSha === undefined ? true : versionRaw.gitSha === true,
		},
		freeze: raw.freeze === undefined ? true : raw.freeze === true,
		current: raw.current === undefined ? true : raw.current === true,
		hostApi: raw.hostApi,
		hostModules: raw.hostModules as string[],
		extensions,
	};
}
