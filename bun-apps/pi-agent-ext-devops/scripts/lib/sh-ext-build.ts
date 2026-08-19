/**
 * sh-ext-build.ts — build ONE extension package for a pi-agent-sh deploy.
 *
 * Output per extension: <outDir>/{ext.cjs, ext.json, <skills dirs>}.
 *
 * The bundle is cjs with the host module whitelist marked --external, so the
 * core can serve those specifiers from its own embedded copies (see
 * bun-apps/pi-agent/src/sh/host-modules.ts for WHY that matters). Two gates run
 * on every build:
 *   1. scanForeignSpecifiers — nothing outside the whitelist may remain
 *      unresolved, or the extension would fail to load on the user's machine.
 *   2. loadProbe — the emitted bundle is actually loaded the way the runtime
 *      loader loads it. This is what catches a change in bun's cjs output shape
 *      at deploy time instead of at user runtime.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { extractBareSpecifiers } from "./build-extensions.ts";
import { evaluateExtModule } from "../../../pi-agent/src/sh/ext-loader.ts";
// The builtin list is the CORE's — a second copy here would drift, and the gate
// would then disagree with the runtime it is supposed to be simulating.
import { isBuiltinSpecifier } from "../../../pi-agent/src/sh/host-modules.ts";
import type { ShExtConfig } from "./sh-config.ts";

/**
 * Host modules are resolved from pi-agent's own package, not from the bundle's
 * output dir: the output lives in the deploy tree (or a temp dir) with no
 * node_modules, so resolving from there silently degrades every host module to
 * a stub and the probe stops proving anything.
 */
const PI_AGENT_DIR = resolve(import.meta.dir, "..", "..", "..", "pi-agent");

export interface BuildExtOptions {
	ext: ShExtConfig;
	/** Absolute path to bun-apps/. */
	bunAppsDir: string;
	/** Absolute path to the extension's output dir (…/ext/<name>). */
	outDir: string;
	hostApi: number;
	hostModules: readonly string[];
	sourceSha: string;
	builtAt: string;
}

export interface BuildExtResult {
	name: string;
	bytes: number;
	hostModules: string[];
}

/**
 * Does `spec` match one of the allowed entries? An entry ending in `/*` matches
 * any subpath of that package — the form bun's `--external` takes for a package
 * whose internals are unresolvable (`chromium-bidi/*`), where the specifier that
 * actually survives in the bundle is a deep path like
 * `chromium-bidi/lib/cjs/bidiMapper/BidiMapper`.
 */
export function matchesAllowed(spec: string, allowed: readonly string[]): boolean {
	for (const entry of allowed) {
		if (entry === spec) return true;
		if (entry.endsWith("/*") && spec.startsWith(entry.slice(0, -1))) return true;
	}
	return false;
}

/** Bare specifiers left in the bundle that neither the host nor the config allows. */
export function scanForeignSpecifiers(code: string, allowed: readonly string[]): string[] {
	const foreign = new Set<string>();
	for (const spec of extractBareSpecifiers(code)) {
		if (isBuiltinSpecifier(spec)) continue;
		if (matchesAllowed(spec, allowed)) continue;
		foreign.add(spec);
	}
	return [...foreign];
}

/**
 * Load the built bundle exactly as the runtime loader does. Throws on any problem.
 *
 * The probe hands over the REAL host modules, resolved from the build machine's
 * workspace. A stub object is not enough: extension bundles run top-level code
 * against these modules (typebox schema literals, pi's defineTool), so a fake
 * fails on code the deployed core executes fine. A host module that cannot be
 * resolved here is a hard error rather than a stub — degrading it silently is
 * what made an earlier version of this probe pass while proving nothing.
 */
export function loadProbe(
	cjsPath: string,
	hostModules: readonly string[],
	resolveFrom = PI_AGENT_DIR,
	hostModuleIds: readonly string[] = hostModules,
): void {
	const code = readFileSync(cjsPath, "utf8");
	const nodeRequire = createRequire(join(resolveFrom, "package.json"));
	const probeRequire = (spec: string): unknown => {
		// Node/Bun builtins are resolved for real: a minified bundle calls
		// require("module")/require("node:fs") for its own interop shims, and those
		// are not host modules — rejecting them would fail every real bundle.
		if (isBuiltinSpecifier(spec)) return nodeRequire(spec);
		if (!matchesAllowed(spec, hostModules)) throw new Error(`bundle required non-host module "${spec}"`);
		try {
			// Bun.resolveSync honors the workspace's isolated linker (packages live
			// in the global store, reachable only through that resolution), which a
			// bare createRequire from the package dir cannot follow.
			return nodeRequire(Bun.resolveSync(spec, resolveFrom));
		} catch (e) {
			// A declared runtime external is allowed to be unresolvable here: that is
			// precisely why it was left out of the bundle. Only a HOST module failing
			// to resolve means the build machine is broken.
			if (!hostModuleIds.includes(spec)) return new Proxy({}, { get: () => () => undefined });
			throw new Error(
				`host module "${spec}" could not be resolved from ${resolveFrom}: ${e instanceof Error ? e.message : String(e)}. ` +
					`The core embeds it, so the build machine must be able to resolve it too — run \`bun install\` in bun-apps/.`,
			);
		}
	};
	const exports = evaluateExtModule(code, cjsPath, join(cjsPath, ".."), probeRequire);
	if (typeof exports.default !== "function") {
		throw new Error(`${cjsPath}: bundle has no callable default export`);
	}
}

/** "@scope/name/sub" → "@scope/name"; "pkg/sub" → "pkg". */
function packageRoot(spec: string): string {
	const parts = spec.split("/");
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

export async function buildExtPackage(opts: BuildExtOptions): Promise<BuildExtResult> {
	const pkgDir = resolve(opts.bunAppsDir, opts.ext.package);
	const entryAbs = resolve(pkgDir, opts.ext.entry);
	if (!existsSync(entryAbs)) throw new Error(`entry not found: ${entryAbs}`);

	if (existsSync(opts.outDir)) rmSync(opts.outDir, { recursive: true, force: true });
	mkdirSync(opts.outDir, { recursive: true });

	const cjsPath = join(opts.outDir, "ext.cjs");
	// Host modules + the extension's own declared runtime externals. The two are
	// different promises: a host module IS provided by the core, a runtime
	// external is merely not bundled.
	const allExternals = [...opts.hostModules, ...opts.ext.externals];
	const externalFlags = allExternals.flatMap((m) => ["--external", m]);
	// Subpath imports need their own external pattern: "typebox" does not cover
	// "typebox/value" as a bundler external in every bun version.
	const wildcardFlags = [...new Set(allExternals.map((m) => `${packageRoot(m)}/*`))].flatMap((p) => [
		"--external",
		p,
	]);

	const proc = Bun.spawn(
		[
			"bun",
			"build",
			entryAbs,
			"--target=bun",
			"--format=cjs",
			`--outfile=${cjsPath}`,
			"--minify",
			...externalFlags,
			...wildcardFlags,
		],
		{ stdout: "pipe", stderr: "pipe", cwd: pkgDir },
	);
	const code = await proc.exited;
	if (code !== 0) {
		// Surface bun's own diagnostic: "bun build failed (exit 1)" alone gives the
		// operator nothing to act on, and the usual cause (an undeclared dep) is
		// named only in bun's stderr.
		const stderr = (await new Response(proc.stderr).text()).trim();
		throw new Error(`bun build failed for ${opts.ext.name} (exit ${code})${stderr ? `:\n${stderr}` : ""}`);
	}

	// ── Gate 1: nothing foreign may remain unresolved ────────────────────────
	const built = readFileSync(cjsPath, "utf8");
	const foreign = scanForeignSpecifiers(built, allExternals);
	if (foreign.length > 0) {
		throw new Error(
			`${opts.ext.name}: bundle references specifier(s) the host does not provide: ${foreign.join(", ")}. ` +
				`Either add them to hostModules (and to src/sh/host-modules.ts) or make the bundler inline them.`,
		);
	}

	// ── Gate 2: it loads the way the runtime loads it ─────────────────────────
	loadProbe(cjsPath, allExternals, PI_AGENT_DIR, opts.hostModules);

	// ── Skills ───────────────────────────────────────────────────────────────
	for (const rel of opts.ext.skills) {
		cpSync(resolve(pkgDir, rel), join(opts.outDir, rel), { recursive: true, dereference: true });
	}

	// ── Manifest ─────────────────────────────────────────────────────────────
	const usedHostModules = opts.hostModules.filter((m) => built.includes(`"${m}"`));
	const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
		name?: string;
		version?: string;
	};
	const manifest = {
		name: opts.ext.name,
		package: pkgJson.name ?? opts.ext.package,
		version: pkgJson.version ?? "0.0.0",
		hostApi: opts.hostApi,
		entry: "ext.cjs",
		order: opts.ext.order,
		enabled: true,
		skills: opts.ext.skills,
		hostModules: usedHostModules,
		runtimeExternals: opts.ext.externals,
		builtAt: opts.builtAt,
		sourceSha: opts.sourceSha,
	};
	writeFileSync(join(opts.outDir, "ext.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	return { name: opts.ext.name, bytes: statSync(cjsPath).size, hostModules: usedHostModules };
}
