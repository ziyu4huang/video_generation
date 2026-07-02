/**
 * deploy — package pi-agent + its extension set into a SELF-CONTAINED, runnable
 * directory that works from ANY cwd. Two modes:
 *
 *   bun scripts/deploy.ts [out-dir]              # DEFAULT: FULL bundles + host node_modules
 *   bun scripts/deploy.ts [out-dir] --release    # RELEASE: source-copy deploy
 *
 * ── DEFAULT (bundle deploy ──────────────────────────────────────────────────
 * Ships pi-agent.js + every extension FULL-bundled (all deps inlined) into
 * `.full.js`, plus a host node_modules subset via `bun install`. Standalone
 * on the same machine.
 *
 *   <outdir>/
 *   ├── pi-agent.js            # bundle (from dist/pi-agent/)
 *   ├── ext-bundles/*.full.js  # pre-bundled extensions (FULL — self-contained)
 *   ├── skills/<…>/            # copied skill dirs
 *   ├── node_modules/          # host subset (bun install)
 *   ├── run-dir/manifest.json  # compat/debug (resolve.ts uses dir listings)
 *   ├── .deploy-bundle         # marker — resolve.ts DEPLOY-BUNDLE detection
 *   ├── .deploy-portable       # marker — skip npm abs paths (already bundled)
 *   ├── package.json           # minimal {name,private,type} + runtime deps
 *   └── run.sh                 # layout-aware launcher
 *
 * ── --release (source-copy deploy) ─────────────────────────────────────────
 * Copies every extension's source folder into packages/<pkg>/, generates a
 * workspaces package.json, and runs `bun install`. Self-contained workspace.
 * Heavier; ships readable source; intended for protected/release distribution.
 *
 *   <outdir>/
 *   ├── pi-agent.js, run-dir/manifest.json, run.sh
 *   ├── packages/<pkg>/…       # copied extension source
 *   ├── package.json           # workspaces root + npm-ext deps
 *   └── node_modules/          # wired by `bun install`
 *
 * run-dir/resolve.ts detects the layout at runtime: `.deploy-bundle` +
 * `ext-bundles/` → DEPLOY-BUNDLE mode; `packages/` + `run-dir/manifest.json`
 * → DEPLOY-PACKAGE mode (--release). Both inject `-ne` + the resolved
 * `-e`/`--skill` paths so the package is self-contained.
 *
 * USAGE
 *   bun scripts/deploy.ts [options] [out-dir]
 *     --release       use the source-copy deploy
 *     --portable      no-op (the default is already portable/FULL)
 *     --no-build      reuse existing dist/pi-agent/pi-agent.js
 *     --no-install    skip `bun install` in out-dir (--release / default)
 *   Default out-dir: ../../dist/pi-agent-bundle | ../../dist/pi-agent-deploy (release)
 */
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
if (argv.some((a) => a === "-h" || a === "--help")) {
	console.log((await Bun.file(import.meta.path).text()).split("*/")[0].replace(/^\/\*\*?|\*\/?$/gm, "").trim());
	process.exit(0);
}
const RELEASE = argv.includes("--release");
// --portable kept as no-op (was the THIN→FULL switch; FULL is now the default).
const _PORTABLE_NOOP = argv.includes("--portable");
const NO_BUILD = argv.includes("--no-build");
const NO_INSTALL = argv.includes("--no-install");
const positionalOutdir = argv.find((a) => !a.startsWith("-"));
const OUTDIR = positionalOutdir
	? resolve(process.cwd(), positionalOutdir)
	: resolve(
			process.cwd(),
			"..",
			"..",
			"dist",
			RELEASE ? "pi-agent-deploy" : "pi-agent-bundle",
		);

const piAgentDir = dirname(import.meta.dir); // bun-apps/pi-agent
const repoRoot = dirname(dirname(piAgentDir));
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
function die(msg: string): never {
	console.error(R(`error: ${msg}`));
	process.exit(1);
}
function readJson<T>(p: string): T | null {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return null;
	}
}

// ── manifest = the single source of truth for what to bundle ─────────────────
const manifestPath = join(piAgentDir, "run-dir", "manifest.json");
const manifest = readJson<{
	extensions?: string[];
	skills?: string[];
	npmExtensions?: { pkg: string; entry: string }[];
}>(manifestPath);
if (!manifest) die(`run-dir/manifest.json not found at ${manifestPath}`);

// Collect the package DIR names to copy (top-level segment of each ext/skill path).
const pkgDirs = new Set<string>();
for (const rel of [...(manifest.extensions ?? []), ...(manifest.skills ?? [])]) {
	const seg = rel.split("/")[0];
	if (seg) pkgDirs.add(seg);
}
if (pkgDirs.size === 0 && RELEASE) die("manifest lists no extensions/skills to bundle.");

// ── build pi-agent bundle (shared by both modes) ─────────────────────────────
const bundleSrc = join(repoRoot, "dist", "pi-agent", "pi-agent.js");
if (!NO_BUILD || !existsSync(bundleSrc)) {
	console.log(`${G("▶")} build bundle  ${D("(bun scripts/build.ts)")}`);
	const b = Bun.spawn(["bun", "scripts/build.ts"], { cwd: piAgentDir, stdout: "inherit", stderr: "inherit" });
	if ((await b.exited) !== 0) die("build.ts failed");
} else {
	console.log(`${G("▶")} build bundle  ${D("(skipped --no-build)")}`);
}
if (!existsSync(bundleSrc)) die(`bundle missing: ${bundleSrc}`);

// ── materialize out-dir ──────────────────────────────────────────────────────
console.log(
	`${G("▶")} out-dir  ${D(OUTDIR)}  ${D(`[${RELEASE ? "release" : "bundle"}]`)}`,
);
if (existsSync(OUTDIR)) rmSync(OUTDIR, { recursive: true });
mkdirSync(OUTDIR, { recursive: true });
mkdirSync(join(OUTDIR, "run-dir"), { recursive: true });

cpSync(bundleSrc, join(OUTDIR, "pi-agent.js"));
cpSync(manifestPath, join(OUTDIR, "run-dir", "manifest.json"));
// Copy obsidian_config.json + workflows/ (consolidated runtime config)
const obsConfig = join(piAgentDir, "run-dir", "obsidian_config.json");
if (existsSync(obsConfig)) cpSync(obsConfig, join(OUTDIR, "run-dir", "obsidian_config.json"));
const workflowsDir = join(piAgentDir, "run-dir", "workflows");
if (existsSync(workflowsDir)) cpSync(workflowsDir, join(OUTDIR, "run-dir", "workflows"), { recursive: true });
const runSh = join(piAgentDir, "run.sh");
if (existsSync(runSh)) {
	cpSync(runSh, join(OUTDIR, "run.sh"));
	chmodSync(join(OUTDIR, "run.sh"), 0o755);
}

if (RELEASE) {
	await releaseDeploy();
} else {
	await portableDeploy();
}

// ── done ─────────────────────────────────────────────────────────────────────
console.log(`\n${G("✓ deployed")} → ${OUTDIR}`);
console.log(D(`    ${OUTDIR}/pi-agent.js --list-models   # smoke test`));
console.log(D(`    ${OUTDIR}/pi-agent.js -p "hello"      # print mode (any cwd)`));

// ════════════════════════════════════════════════════════════════════════════
// --release: copy every extension source folder + workspaces + bun install.
// (The ORIGINAL deploy behavior, preserved verbatim behind the flag.)
// ════════════════════════════════════════════════════════════════════════════
async function releaseDeploy() {
	mkdirSync(join(OUTDIR, "packages"), { recursive: true });

	const SKIP = new Set(["node_modules", "dist", ".git", "__tests__"]);
	for (const dir of [...pkgDirs].sort()) {
		const src = join(repoRoot, "bun-apps", dir);
		if (!existsSync(src)) {
			console.log(`${Y("·")} skip missing ${dir}`);
			continue;
		}
		cpSync(src, join(OUTDIR, "packages", dir), {
			recursive: true,
			filter: (s) => !SKIP.has(basename(dirname(s))) || basename(s) === "",
		});
		console.log(`    ${G("✓")} ${dir}  ${D("(copied)")}`);
	}

	// workspace root package.json (workspaces + npm-ext deps)
	const rootDeps: Record<string, string> = {};
	const localNames = new Set(pkgDirs);
	for (const dir of pkgDirs) {
		const m = readJson<any>(join(repoRoot, "bun-apps", dir, "package.json"));
		if (!m) continue;
		for (const f of ["dependencies", "peerDependencies"] as const) {
			for (const [dep, ver] of Object.entries<any>(m[f] ?? {})) {
				if (!localNames.has(dep) && !pkgDirs.has(dep) && !rootDeps[dep]) rootDeps[dep] = String(ver);
			}
		}
	}
	for (const { pkg } of manifest.npmExtensions ?? []) rootDeps[pkg] = "latest";
	if (!rootDeps["@earendil-works/pi-coding-agent"]) rootDeps["@earendil-works/pi-coding-agent"] = "latest";
	writeFileSync(
		join(OUTDIR, "package.json"),
		JSON.stringify(
			{ name: "pi-agent-deploy", private: true, type: "module", workspaces: ["packages/*"], dependencies: rootDeps },
			null,
			2,
		) + "\n",
	);

	if (!NO_INSTALL) {
		console.log(`${G("▶")} bun install  ${D(`(cwd: ${OUTDIR})`)}`);
		const p = Bun.spawn(["bun", "install"], { cwd: OUTDIR, stdout: "inherit", stderr: "inherit" });
		if ((await p.exited) !== 0) die("bun install failed");
	} else {
		console.log(`${Y("·")} bun install skipped (--no-install)`);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// default: FULL-bundle every ext (incl. npm) + host node_modules subset
// (bun install) + assets + PI_PACKAGE_DIR pin via run.sh. Repo-independent
// (same machine — bun's global-store node_modules isn't cross-machine).
// ════════════════════════════════════════════════════════════════════════════
async function portableDeploy() {
	// 1. FULL-bundle extensions (incl. npm exts) → dist/pi-ext-bundles/*.full.js
	const extBundlesSrc = join(repoRoot, "dist", "pi-ext-bundles");
	console.log(`${G("▶")} build FULL extension bundles  ${D("(bun scripts/build-extensions.ts)")}`);
	const be = Bun.spawn(["bun", "scripts/build-extensions.ts"], {
		cwd: piAgentDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await be.exited) !== 0) die("build-extensions.ts failed");
	if (!existsSync(extBundlesSrc)) die(`ext bundles missing: ${extBundlesSrc}`);

	// 2. copy bundles → <outdir>/ext-bundles/
	mkdirSync(join(OUTDIR, "ext-bundles"), { recursive: true });
	for (const f of readdirSync(extBundlesSrc).filter((f) => f.endsWith(".js"))) {
		cpSync(join(extBundlesSrc, f), join(OUTDIR, "ext-bundles", f));
		console.log(`    ${G("✓")} ext-bundles/${f}`);
	}

	// 3. copy skill dirs → <outdir>/skills/<name> (same as default bundle)
	if (manifest.skills?.length) {
		mkdirSync(join(OUTDIR, "skills"), { recursive: true });
		const SKIP = new Set(["node_modules", "dist", ".git"]);
		for (const rel of manifest.skills) {
			const src = join(repoRoot, "bun-apps", rel);
			if (!existsSync(src)) continue;
			const destName = rel.replace(/\//g, "-");
			cpSync(src, join(OUTDIR, "skills", destName), {
				recursive: true,
				filter: (s) => !SKIP.has(basename(dirname(s))) || basename(s) === "",
			});
			console.log(`    ${G("✓")} skills/${destName}`);
		}
	}

	// 4. assets (theme/export-html/assets) — build.ts stages them in dist/pi-agent/.
	// PI_PACKAGE_DIR is pinned to <outdir> by run.sh so getPackageDir() finds these.
	const distAgent = join(repoRoot, "dist", "pi-agent");
	for (const asset of ["theme", "export-html", "assets"]) {
		const src = join(distAgent, asset);
		if (existsSync(src)) {
			cpSync(src, join(OUTDIR, asset), { recursive: true });
			console.log(`    ${G("✓")} ${asset}/`);
		}
	}

	// 5. host node_modules subset via `bun install` against the machine-global
	// store. Covers: typebox + @earendil-works/* (getAliases require.resolve) +
	// jiti + any FULL-bundle residual bare specifiers (node-fetch, ws, …). The
	// deps list is pi-agent's own deps (which pull the pi-coding-agent graph) +
	// typebox explicitly + the npm-ext packages (in case a FULL bundle residual
	// references them). Same-machine: bun symlinks into its global store.
	const nmPkgs = readJson<{ dependencies?: Record<string, string> }>(join(piAgentDir, "package.json"))?.dependencies ?? {};
	const deps: Record<string, string> = { typebox: "latest", ...nmPkgs };
	writeFileSync(
		join(OUTDIR, "package.json"),
		JSON.stringify({ name: "pi-agent-portable", private: true, type: "module", dependencies: deps }, null, 2) + "\n",
	);
	if (!NO_INSTALL) {
		console.log(`${G("▶")} bun install  ${D("(host node_modules subset — repo-independent, same machine)")}`);
		const p = Bun.spawn(["bun", "install"], { cwd: OUTDIR, stdout: "inherit", stderr: "inherit" });
		if ((await p.exited) !== 0) die("bun install failed (portable)");
	} else {
		console.log(`${Y("·")} bun install skipped (--no-install)`);
	}

	// 6. markers — .deploy-bundle (resolve.ts DEPLOY-BUNDLE mode) + .deploy-portable
	// (resolve.ts skips the baked repo npm-abs-paths since npm exts are bundled).
	writeFileSync(join(OUTDIR, ".deploy-bundle"), `portable deploy\nbuilt: ${new Date().toISOString()}\n`);
	writeFileSync(join(OUTDIR, ".deploy-portable"), `repo-independent (same machine)\n`);
}
