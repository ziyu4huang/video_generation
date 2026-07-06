/**
 * deploy — package pi-agent + its extension set into a SELF-CONTAINED, runnable
 * directory that works from ANY cwd. Two modes:
 *
 *   bun scripts/deploy.ts [out-dir]              # DEFAULT: bundle deploy (THIN)
 *   bun scripts/deploy.ts [out-dir] --portable   # PORTABLE: FULL bundles + host node_modules (repo-independent)
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
 *     --portable      FULL-bundle exts + host node_modules subset + assets
 *                    (repo-independent, same machine)
 *     --no-build      reuse existing dist/pi-agent/pi-agent.js
 *     --no-install    skip `bun install` in out-dir (--release / --portable)
 *     --with-nm-copy  also copy the repo node_modules into out-dir (bundle mode;
 *                    redundant for resolution — opt-in fallback)
 *     --writable     opt OUT of the default read-only freeze (keep the tree
 *                    writable). The test harness uses this to clean up; a normal
 *                    deploy is frozen (chmod a-w + `.deploy-readonly` marker).
 *   Read-only is the DEFAULT: every deploy is frozen via chmod a-w + a marker;
 *   run.sh reads the marker and applies the env hardening that makes a frozen
 *   artifact run. Drop it on /opt or any read-only prefix as-is.
 *   Default out-dir: ../../dist/pi-agent-bundle (bundle) | ../../dist/pi-agent-deploy (release)
 */
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
if (argv.some((a) => a === "-h" || a === "--help")) {
	console.log((await Bun.file(import.meta.path).text()).split("*/")[0].replace(/^\/\*\*?|\*\/?$/gm, "").trim());
	process.exit(0);
}
const RELEASE = argv.includes("--release");
// --portable: FULL-bundle every ext (incl. npm exts) + `bun install` a host
// node_modules subset + copy assets + pin PI_PACKAGE_DIR via run.sh. Produces a
// repo-independent deploy (same machine — bun's global-store node_modules isn't
// relocatable across machines). Mutually exclusive with --release.
const PORTABLE = argv.includes("--portable");
const NO_BUILD = argv.includes("--no-build");
const NO_INSTALL = argv.includes("--no-install");
// node_modules copy is OPT-IN for the default (THIN) deploy. Everything (THIN
// ext bundles + pi-agent.js + npm exts) resolves deps via baked absolute paths
// into the repo's .bun store, so <outdir>/node_modules is NOT read at runtime —
// the deploy is same-machine-repo-present regardless. The copy exists only as a
// fallback / for inspection; opt in with --with-nm-copy. (--portable ALWAYS
// installs its own node_modules subset — FULL bundles have residual bare
// specifiers that resolve from it, and the host's getAliases() needs it.)
const WITH_NM_COPY = argv.includes("--with-nm-copy");
// READ-ONLY IS THE DEFAULT. A deploy is an immutable artifact: code + bundled
// extensions, with ALL per-user state routed to ~/.pi/agent (pi's sessions/auth
// + pi-hermes-memory's sqlite DB both honor PI_CODING_AGENT_DIR → ~/.pi/agent).
// So the deploy dir is never written to at runtime — freezing it costs nothing
// and makes the artifact safe to drop on /opt, an app bundle, or any read-only
// prefix. `--writable` opts out (the test harness uses it to clean up between
// runs). run.sh reads the `.deploy-readonly` marker and applies the env
// hardening (JITI_FS_CACHE=0 for --release's .ts extensions, PI_CODING_AGENT_DIR
// default) that makes a frozen deploy actually run.
const WRITABLE = argv.includes("--writable");
// --verify: after deploy, boot the deployed pi-agent.js from a FOREIGN cwd and
// probe pi.getAllTools() — catches resolve.ts mode bugs, broken bundles, and
// tool-conflicts at DEPLOY time, not at runtime. Adds ~3-5s (no model call;
// kills the instant the probe fires). Off by default; opt in with --verify.
const VERIFY = argv.includes("--verify");
const READONLY = !WRITABLE;
if (RELEASE && PORTABLE) die("--release and --portable are mutually exclusive");
const positionalOutdir = argv.find((a) => !a.startsWith("-"));
const OUTDIR = positionalOutdir
	? resolve(process.cwd(), positionalOutdir)
	: resolve(
			process.cwd(),
			"..",
			"..",
			"dist",
			RELEASE ? "pi-agent-deploy" : PORTABLE ? "pi-agent-portable" : "pi-agent-bundle",
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
/** True if `p` exists AND is a symlink (lstat, so symlinks to missing targets count). */
function lstatSyncSafeForBundle(p: string): string | null {
	try {
		return lstatSync(p).isSymbolicLink() ? p : null;
	} catch {
		return null;
	}
}
/**
 * Resolve the pi deps-store node_modules (the same target build.ts stageLinkDeps
 * symlinks dist/pi-agent/node_modules at) — the dir that holds typebox +
 * @earendil-works/* + jiti, which pi-agent.js's bare peer-dep specifiers resolve
 * from. Anchored at pi-agent's package.json so the workspace link is followed.
 */
function resolvePiStoreNodeModules(piAgentDir: string): string | null {
	try {
		const r = createRequire(join(piAgentDir, "package.json"));
		const pj = r.resolve("@earendil-works/pi-coding-agent/package.json");
		const piPkgDir = pj.replace(/\/package\.json$/, ""); // <store>/node_modules/@earendil-works/pi-coding-agent
		const storeNm = resolve(piPkgDir, "..", ".."); // <store>/node_modules
		return existsSync(storeNm) ? storeNm : null;
	} catch {
		return null;
	}
}

// ── reproducible dep pinning ─────────────────────────────────────────────────
//
// The deploy generates a `package.json` for the out-dir and runs `bun install`
// against it. If a dep is written as "latest" or "*", that install re-resolves
// to whatever the registry serves AT DEPLOY TIME — so two deploys from the same
// source tree can drift onto different versions. Pin those floating ranges to
// the EXACT version the repo's own `bun.lock` already resolved, so a deploy is
// reproducible from a given source tree. (Bounded "^x.y.z" ranges are left
// alone — they're already constrained; only unbounded floats are the problem.)
//
// `bun.lock` (text format, v1.2+) `packages` maps a dep key to
// ["<@scope/name>@<version>", "", { deps... }, "sha512-..."]. The version is the
// substring after the LAST "@" (scoped names start with "@").
//
// NOTE: bun.lock is JSON5-ish — it allows trailing commas, which JSON.parse
// rejects. Strip them before parsing (handles `,}` and `,]`). This is the
// documented text-lockfile shape; if Bun changes the format, pinRange degrades
// gracefully (returns the floating range unchanged with a warning).
function readLockPackages(): Record<string, unknown[]> {
	try {
		const raw = readFileSync(join(repoRoot, "bun.lock"), "utf8");
		const json = raw.replace(/,(\s*[}\]])/g, "$1");
		return (JSON.parse(json) as { packages?: Record<string, unknown[]> }).packages ?? {};
	} catch {
		return {};
	}
}
const lockPackages = readLockPackages();
function resolvedVersion(pkg: string): string | undefined {
	const entry = lockPackages[pkg];
	if (!Array.isArray(entry) || typeof entry[0] !== "string") return undefined;
	const id = entry[0] as string; // "<@scope/name>@<version>"
	const at = id.lastIndexOf("@");
	return at > 0 ? id.slice(at + 1) : undefined;
}
/** Pin a floating "latest"/"*" range to the exact resolved version; pass others through. */
function pinRange(range: string, pkg: string, warnFn: (m: string) => void = console.error): string {
	if (range !== "latest" && range !== "*") return range;
	const ver = resolvedVersion(pkg);
	if (!ver) {
		warnFn(`${Y("·")} could not pin ${pkg} (${range}) — not in bun.lock; leaving floating`);
		return range;
	}
	return `^${ver}`;
}

// ── manifest = the single source of truth for what to bundle ─────────────────
const manifestPath = join(piAgentDir, "run-dir", "manifest.json");
const manifest = readJson<{
	extensions?: (string | { entry: string })[];
	skills?: string[];
	npmExtensions?: { pkg: string; entry: string }[];
}>(manifestPath);
if (!manifest) die(`run-dir/manifest.json not found at ${manifestPath}`);

// Normalize manifest v2 entries: objects → their `entry` string, strings pass through.
const extEntries = (manifest.extensions ?? []).map((e) => (typeof e === "string" ? e : e.entry));

// Collect the package DIR names to copy (top-level segment of each ext/skill path).
const pkgDirs = new Set<string>();
for (const rel of [...extEntries, ...(manifest.skills ?? [])]) {
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
	`${G("▶")} out-dir  ${D(OUTDIR)}  ${D(`[${RELEASE ? "release" : PORTABLE ? "portable" : "bundle"}]`)}`,
);
if (existsSync(OUTDIR)) {
	// A previous deploy is FROZEN by default (chmod a-w + .deploy-readonly). rmSync
	// can't remove a-w entries, so unfreeze first. chmod -R u+w is a no-op if the
	// dir is already writable; the spawn is cheap and only runs on re-deploy.
	if (existsSync(join(OUTDIR, ".deploy-readonly"))) {
		const unfreeze = Bun.spawn(["chmod", "-R", "u+w", OUTDIR], { stdout: "ignore", stderr: "ignore" });
		await unfreeze.exited;
	}
	rmSync(OUTDIR, { recursive: true });
}
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
} else if (PORTABLE) {
	await portableDeploy();
} else {
	await bundleDeploy();
}

// ── --readonly: freeze the artifact for a read-only path ─────────────────────
if (READONLY) {
	// The marker is what run.sh keys off of to apply the env hardening. chmod is
	// the "make this tree immutable" convenience. A deploy dropped onto an
	// already-read-only fs (root-owned /opt run as a non-root user) needs only
	// the marker — the fs itself enforces immutability.
	writeFileSync(
		join(OUTDIR, ".deploy-readonly"),
		`read-only deploy\nmode: ${RELEASE ? "release" : PORTABLE ? "portable" : "bundle"}\nbuilt: ${new Date().toISOString()}\n` +
			"run.sh applies JITI_FS_CACHE=0 + PI_CODING_AGENT_DIR=$HOME/.pi/agent so this runs as-is.\n",
	);
	const chmod = Bun.spawn(["chmod", "-R", "a-w", OUTDIR], { stdout: "inherit", stderr: "inherit" });
	if ((await chmod.exited) !== 0) die("chmod -R a-w failed");
}

// ── --verify: boot the deployed artifact + probe getAllTools from a foreign cwd ─
// Catches resolve.ts mode bugs, broken extension bundles, and tool-conflicts at
// DEPLOY time. Writes a probe extension to /tmp, boots pi-agent.js with -ne -e
// <probe> -p, reads the [PROBE] output, kills the process (no model call).
if (VERIFY) {
	console.log(`\n${G("▶")} verify — boot deployed artifact + probe getAllTools`);
	const PROBE_TS = join(tmpdir(), `deploy-verify-${Date.now()}.ts`);
	writeFileSync(
		PROBE_TS,
		`export default (pi) => {
  pi.on("session_start", () => {
    const tools = pi.getAllTools();
    const names = tools.map((t) => t.name).sort();
    const dupes = names.filter((n, i) => n === names[i - 1]);
    const ok = names.length > 0 && dupes.length === 0;
    // console.log flushes synchronously in Bun; process.exit() would skip the flush.
    console.log("[PROBE] " + JSON.stringify({ toolCount: names.length, dupes, ok }));
    setTimeout(() => process.exit(ok ? 0 : 1), 100);
  });
};\n`,
	);
	const agentJs = join(OUTDIR, "pi-agent.js");
	if (!existsSync(agentJs)) {
		console.error(`${R("✗")} verify: ${agentJs} not found — nothing to probe`);
		process.exit(1);
	}
	// Boot from /tmp (foreign cwd) to catch cwd-coupled resolve.ts bugs.
	const proc = Bun.spawn(
		["bun", agentJs, "-ne", "-e", PROBE_TS, "-p", "verify"],
		{ cwd: tmpdir(), stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_VERIFY_MODE: "deploy" } },
	);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	rmSync(PROBE_TS, { force: true });
	const probeLine = stdout.split("\n").find((l) => l.startsWith("[PROBE]"));
	if (!probeLine) {
		console.error(`${R("✗")} verify: no [PROBE] line — agent failed to boot or probe never fired`);
		if (stderr) console.error(stderr.slice(0, 500));
		process.exit(1);
	}
	const probe = JSON.parse(probeLine.slice("[PROBE] ".length));
	if (!probe.ok) {
		console.error(`${R("✗")} verify FAILED: ${probe.toolCount} tools, dupes: ${JSON.stringify(probe.dupes)}`);
		process.exit(1);
	}
	console.log(`    ${G("✓")} deployed artifact booted from ${tmpdir()}: ${probe.toolCount} tools, 0 conflicts`);
}

// ── done ─────────────────────────────────────────────────────────────────────
console.log(`\n${G("✓ deployed")} → ${OUTDIR}${READONLY ? ` ${Y("(read-only)")}` : ""}`);
console.log(D(`    ${OUTDIR}/pi-agent.js --list-models   # smoke test`));
console.log(D(`    ${OUTDIR}/pi-agent.js -p "hello"      # print mode (any cwd)`));
if (READONLY) {
	console.log(D(`    (frozen via chmod a-w; invoke run.sh from a non-deploy cwd)`));
}

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
	// Pin floating "latest"/"*" ranges to the exact versions the repo's bun.lock
	// resolved, so the deploy is reproducible from this source tree (a fresh
	// `bun install` in OUTDIR would otherwise re-resolve "latest" to whatever the
	// registry serves at deploy time). Bounded ^ ranges pass through unchanged.
	for (const [dep, range] of Object.entries(rootDeps)) rootDeps[dep] = pinRange(range, dep);
	writeFileSync(
		join(OUTDIR, "package.json"),
		JSON.stringify(
			{ name: "pi-agent-deploy", private: true, type: "module", workspaces: ["packages/*"], dependencies: rootDeps },
			null,
			2,
		) + "\n",
	);

	if (!NO_INSTALL) {
		// `--production` skips devDependencies. The copied packages/<pkg>/ folders
		// retain their own devDependencies (typescript, javascript-obfuscator,
		// @types/bun, @biomejs/biome, …) — without --production the workspace
		// install materializes them into the deploy. They're build/test-only and
		// don't belong in a shipped runtime node_modules.
		console.log(`${G("▶")} bun install --production  ${D(`(cwd: ${OUTDIR})`)}`);
		const p = Bun.spawn(["bun", "install", "--production"], { cwd: OUTDIR, stdout: "inherit", stderr: "inherit" });
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

	// 4. node_modules — ALWAYS-ON symlink into the pi deps store. pi-agent.js
	// keeps typebox + @earendil-works/* as bare peer-dep specifiers (bun's bundler
	// externalizes them); pi's extension loader resolves them via require.resolve
	// from pi-agent.js's own dir. In dev, dist/pi-agent/node_modules (created by
	// build.ts stageLinkDeps) is that neighbor; a DEPLOY loses it, so a deploy
	// placed INSIDE the repo walks up to the repo's isolated-layout node_modules
	// and HARD-FAILS on typebox (ResolveMessage) for every extension. Symlinking
	// <outdir>/node_modules at the same store target makes resolution match dev
	// exactly. The link is an ABSOLUTE path into the machine-global .bun store, so
	// the bundle deploy runs at ANY path on the same machine (its stated model).
	// --with-nm-copy still opts in a real (recursive) copy for offline inspection.
	const storeNm = lstatSyncSafeForBundle(join(repoRoot, "dist", "pi-agent", "node_modules"));
	const nmTarget = storeNm
		? readlinkSync(storeNm)
		: resolvePiStoreNodeModules(piAgentDir);
	if (nmTarget) {
		const link = join(OUTDIR, "node_modules");
		if (existsSync(link) || lstatSyncSafeForBundle(link)) rmSync(link, { recursive: true, force: true });
		symlinkSync(nmTarget, link);
		console.log(`    ${G("✓")} node_modules → ${nmTarget}  ${D("(symlink — pi-agent.js peer-dep resolution)")}`);
	} else {
		console.log(`    ${Y("·")} node_modules symlink skipped (dist/pi-agent/node_modules + pi store not found)`);
	}
	if (WITH_NM_COPY) {
		const nmSrc = join(repoRoot, "node_modules");
		if (!existsSync(nmSrc)) die(`repo node_modules missing: ${nmSrc} (run \`bun install\` at repo root)`);
		console.log(`${G("▶")} copy node_modules  ${D("(--with-nm-copy — recursive copy over the symlink, for offline inspection)")}`);
		rmSync(join(OUTDIR, "node_modules"), { recursive: true, force: true });
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

// ════════════════════════════════════════════════════════════════════════════
// --portable: FULL-bundle every ext (incl. npm) + host node_modules subset
// (bun install) + assets + PI_PACKAGE_DIR pin via run.sh. Repo-independent
// (same machine — bun's global-store node_modules isn't cross-machine).
// ════════════════════════════════════════════════════════════════════════════
async function portableDeploy() {
	// 1. FULL-bundle extensions (incl. npm exts) → dist/pi-ext-bundles/*.full.js
	const extBundlesSrc = join(repoRoot, "dist", "pi-ext-bundles");
	console.log(`${G("▶")} build FULL extension bundles  ${D("(bun scripts/build-extensions.ts --portable)")}`);
	const be = Bun.spawn(["bun", "scripts/build-extensions.ts", "--portable"], {
		cwd: piAgentDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await be.exited) !== 0) die("build-extensions.ts --portable failed");
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

	// 4. assets (theme/export-html/assets): NO separate copy. They ship inside
	// node_modules/@earendil-works/pi-coding-agent/dist/{modes/interactive/{theme,
	// assets}, core/export-html}, installed in step 5. run.sh pins PI_PACKAGE_DIR
	// at that package dir so pi's getPackageDir() finds <pkgDir>/dist/... — no
	// duplication, and no dependency on build.ts's --compile-only asset staging.

	// 5. host node_modules subset via `bun install` against the machine-global
	// store. Covers: typebox + @earendil-works/* (getAliases require.resolve) +
	// jiti + any FULL-bundle residual bare specifiers (node-fetch, ws, …). The
	// deps list is pi-agent's own deps (which pull the pi-coding-agent graph) +
	// typebox explicitly + the npm-ext packages (in case a FULL bundle residual
	// references them). Same-machine: bun symlinks into its global store.
	const nmPkgs = readJson<{ dependencies?: Record<string, string> }>(join(piAgentDir, "package.json"))?.dependencies ?? {};
	const deps: Record<string, string> = { typebox: "latest", ...nmPkgs };
	// Pin floating "latest"/"*" to the exact resolved version (same reproducibility
	// rationale as releaseDeploy). typebox + pi-coding-agent ship as "latest" in
	// pi-agent's package.json — without pinning, every portable deploy re-resolves.
	for (const [dep, range] of Object.entries(deps)) deps[dep] = pinRange(range, dep);
	writeFileSync(
		join(OUTDIR, "package.json"),
		JSON.stringify({ name: "pi-agent-portable", private: true, type: "module", dependencies: deps }, null, 2) + "\n",
	);
	if (!NO_INSTALL) {
		// `--production` (same as releaseDeploy): portable's deps list is all
		// runtime (typebox, jiti, @earendil-works/*, npm-exts) — trim any devDeps
		// that leak via the pi-agent package.json (@types/bun). Smaller install,
		// faster, and consistent with --release.
		console.log(`${G("▶")} bun install --production  ${D("(host node_modules subset — repo-independent, same machine)")}`);
		const p = Bun.spawn(["bun", "install", "--production"], { cwd: OUTDIR, stdout: "inherit", stderr: "inherit" });
		if ((await p.exited) !== 0) die("bun install failed (portable)");
	} else {
		console.log(`${Y("·")} bun install skipped (--no-install)`);
	}

	// 6. markers — .deploy-bundle (resolve.ts DEPLOY-BUNDLE mode) + .deploy-portable
	// (resolve.ts skips the baked repo npm-abs-paths since npm exts are bundled).
	writeFileSync(join(OUTDIR, ".deploy-bundle"), `portable deploy\nbuilt: ${new Date().toISOString()}\n`);
	writeFileSync(join(OUTDIR, ".deploy-portable"), `repo-independent (same machine)\n`);
}
