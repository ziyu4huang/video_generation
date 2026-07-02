/**
 * deploy — package pi-agent + its extension set into a SELF-CONTAINED, runnable
 * directory that works from ANY cwd. Two modes:
 *
 *   bun scripts/deploy.ts [out-dir]              # DEFAULT: bundle deploy
 *   bun scripts/deploy.ts [out-dir] --release    # RELEASE: source-copy deploy
 *
 * ── DEFAULT (bundle deploy) ────────────────────────────────────────────────
 * Ships pi-agent.js + every extension pre-bundled into a single `.js`
 * (scripts/build-extensions.ts, THIN mode) + a COPIED monorepo node_modules.
 * No per-extension source folder, no `bun install` at deploy time. Target:
 * `bun <outdir>/pi-agent.js` (bun runtime required on the host — the compiled
 * binary cannot load `-e` extensions).
 *
 *   <outdir>/
 *   ├── pi-agent.js            # bundle (from dist/pi-agent/)
 *   ├── ext-bundles/*.thin.js  # pre-bundled extensions (THIN — shared deps)
 *   ├── skills/<…>/            # copied skill dirs
 *   ├── run-dir/manifest.json  # compat/debug (resolve.ts uses dir listings)
 *   ├── .deploy-bundle         # marker — resolve.ts DEPLOY-BUNDLE detection
 *   ├── package.json           # minimal {name,private,type} — NO workspaces
 *   └── run.sh                 # layout-aware launcher
 *   (node_modules is NOT copied by default — everything resolves via baked
 *   repo .bun-store abs paths; opt in with --with-nm-copy for a fallback copy)
 *
 * ── --release (source-copy deploy; the ORIGINAL behavior) ──────────────────
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
 * `ext-bundles/` → DEPLOY-BUNDLE mode (this default); `packages/` +
 * `run-dir/manifest.json` → DEPLOY-PACKAGE mode (--release). Both inject `-ne`
 * + the resolved `-e`/`--skill` paths so the package is self-contained.
 *
 * USAGE
 *   bun scripts/deploy.ts [options] [out-dir]
 *     --release       use the source-copy deploy (the original behavior)
 *     --no-build      reuse existing dist/pi-agent/pi-agent.js
 *     --no-install    skip `bun install` in out-dir (--release only)
 *     --with-nm-copy  also copy the repo node_modules into out-dir (bundle mode;
 *                    redundant for resolution — opt-in fallback)
 *   Default out-dir: ../../dist/pi-agent-bundle (bundle) | ../../dist/pi-agent-deploy (release)
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
const NO_BUILD = argv.includes("--no-build");
const NO_INSTALL = argv.includes("--no-install");
// node_modules copy is OPT-IN. Everything (THIN ext bundles + pi-agent.js + npm
// exts) resolves deps via baked absolute paths into the repo's .bun store, so
// <outdir>/node_modules is NOT read at runtime — the deploy is same-machine-
// repo-present regardless (THIN bundles are machine-specific by design). The
// copy exists only as a fallback / for inspection; opt in with --with-nm-copy.
const WITH_NM_COPY = argv.includes("--with-nm-copy");
const positionalOutdir = argv.find((a) => !a.startsWith("-"));
const OUTDIR = positionalOutdir
	? resolve(process.cwd(), positionalOutdir)
	: resolve(process.cwd(), "..", "..", "dist", RELEASE ? "pi-agent-deploy" : "pi-agent-bundle");

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
console.log(`${G("▶")} out-dir  ${D(OUTDIR)}  ${D(`[${RELEASE ? "release" : "bundle"}]`)}`);
if (existsSync(OUTDIR)) rmSync(OUTDIR, { recursive: true });
mkdirSync(OUTDIR, { recursive: true });
mkdirSync(join(OUTDIR, "run-dir"), { recursive: true });

cpSync(bundleSrc, join(OUTDIR, "pi-agent.js"));
cpSync(manifestPath, join(OUTDIR, "run-dir", "manifest.json"));
const runSh = join(piAgentDir, "run.sh");
if (existsSync(runSh)) {
	cpSync(runSh, join(OUTDIR, "run.sh"));
	chmodSync(join(OUTDIR, "run.sh"), 0o755);
}

if (RELEASE) {
	await releaseDeploy();
} else {
	await bundleDeploy();
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
// default: pre-bundle extensions + copy monorepo node_modules. No install.
// ════════════════════════════════════════════════════════════════════════════
async function bundleDeploy() {
	// 1. build extension bundles
	const extBundlesSrc = join(repoRoot, "dist", "pi-ext-bundles");
	console.log(`${G("▶")} build extension bundles  ${D("(bun scripts/build-extensions.ts)")}`);
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

	// 3. copy skill dirs → <outdir>/skills/<name>
	if (manifest.skills?.length) {
		mkdirSync(join(OUTDIR, "skills"), { recursive: true });
		const SKIP = new Set(["node_modules", "dist", ".git"]);
		for (const rel of manifest.skills) {
			const src = join(repoRoot, "bun-apps", rel);
			if (!existsSync(src)) {
				console.log(`${Y("·")} skip missing skill ${rel}`);
				continue;
			}
			const destName = rel.replace(/\//g, "-"); // pi-obsidian/skills → pi-obsidian-skills
			cpSync(src, join(OUTDIR, "skills", destName), {
				recursive: true,
				filter: (s) => !SKIP.has(basename(dirname(s))) || basename(s) === "",
			});
			console.log(`    ${G("✓")} skills/${destName}`);
		}
	}

	// 4. node_modules copy (opt-in via --with-nm-copy). Redundant for resolution
	// (see WITH_NM_COPY comment above) — everything resolves via baked repo .bun
	// store abs paths. The deploy is same-machine-repo-present regardless.
	if (WITH_NM_COPY) {
		const nmSrc = join(repoRoot, "node_modules");
		if (!existsSync(nmSrc)) die(`repo node_modules missing: ${nmSrc} (run \`bun install\` at repo root)`);
		console.log(`${G("▶")} copy node_modules  ${D("(--with-nm-copy — fallback; redundant for runtime resolution)")}`);
		cpSync(nmSrc, join(OUTDIR, "node_modules"), { recursive: true });
		console.log(`    ${G("✓")} node_modules/`);
	}

	// 5. marker (resolve.ts DEPLOY-BUNDLE detection) + minimal package.json
	writeFileSync(join(OUTDIR, ".deploy-bundle"), `bundle deploy\nbuilt: ${new Date().toISOString()}\n`);
	writeFileSync(
		join(OUTDIR, "package.json"),
		JSON.stringify({ name: "pi-agent-bundle", private: true, type: "module" }, null, 2) + "\n",
	);
}
