/**
 * deploy.ts — unified build + deploy orchestrator for pi-agent.
 *
 * Four modes:
 *   --bundle (default)   Build pi-agent.js + thin ext bundles + skills + run.sh
 *   --snapshot           Copy source tree + node_modules (no bundling)
 *   --standalone         --bundle + copy $(which bun) binary alongside
 *   --exe                bun build --compile single-pass embed binary (no deps dir)
 *
 * USAGE
 *   bun scripts/deploy.ts [out-dir]                 # default: --bundle
 *   bun scripts/deploy.ts [out-dir] --bundle        # explicit (same as default)
 *   bun scripts/deploy.ts [out-dir] --snapshot      # source-copy deploy
 *   bun scripts/deploy.ts [out-dir] --standalone    # bundle + bundled bun
 *   bun scripts/deploy.ts [out-dir] --exe           # compiled binary
 *   bun scripts/deploy.ts [out-dir] --no-freeze     # skip chmod a-w
 *   bun scripts/deploy.ts [out-dir] --obfuscate     # + javascript-obfuscator on the bundle
 *                                                   #   (rejected with --exe: obfuscate forces a
 *                                                   #    bundle-then-compile order that strips
 *                                                   #    embedded assets — see the check below)
 *                                                   #   (rejected with --snapshot)
 *
 * Default out-dir: ../../dist/pi-agent
 */
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
	stageGeneratePkgDir,
	stageGenerateRunDirBase,
	stageGenerateEmbeddedAssets,
	type NpmExt,
} from "./lib/codegen.ts";
import { buildExtensions } from "./lib/build-extensions.ts";
import manifest from "../run-dir/manifest.json";

const APP_NAME = "pi-agent";

// External bare-specifier patterns for the bundle/compile steps.
//
// HISTORY: this was once `HERMES_OPTIONAL_EXTERNALS` — pi-agent-ext-hermes-
// memory's (since-removed) src/store/vault-converge.ts had OPTIONAL try/catch-
// guarded dynamic imports of pi-obsidian/pi-knowledge-card as bare specifiers,
// so they were marked external to let the try/catch degrade gracefully.
//
// That file no longer exists (hermes-memory imports neither package today),
// AND obsidian + knowledge-card are now STATIC extensions (static-extensions.ts)
// — bundled into every build. knowledge-card itself imports obsidian via the
// bare specifier `@repo/pi-agent-ext-obsidian/extensions/obsidian.ts` (a STATIC
// import, not optional). Leaving that pattern external would make the compiled
// binary crash at runtime (`Cannot find module ... from '/$bunfs/root/pi-agent'`)
// because $bunfs has no node_modules to resolve the bare specifier against. So
// the list is now EMPTY: every @repo/* sibling resolves at build time and is
// inlined (deduped by resolved path with the relative static import).
const OPTIONAL_EXTERNALS: string[] = [];

// ── Flag parsing ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set([
	"--bundle",
	"--snapshot",
	"--standalone",
	"--exe",
	"--no-freeze",
	"--obfuscate",
]);
{
	const unknown = argv.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
	if (unknown.length > 0) {
		console.error(`✗ unknown flag(s): ${unknown.join(", ")}\n  known: ${[...KNOWN_FLAGS].join(", ")}`);
		process.exit(1);
	}
}
const target = argv.find((a) => !a.startsWith("--")) || resolve(process.cwd(), "..", "..", "dist", APP_NAME);
const IS_SNAPSHOT = argv.includes("--snapshot");
const IS_STANDALONE = argv.includes("--standalone");
const IS_EXE = argv.includes("--exe");
const NO_FREEZE = argv.includes("--no-freeze");
const IS_OBFUSCATE = argv.includes("--obfuscate");
if (IS_OBFUSCATE && IS_SNAPSHOT) {
	// `die()` is a hoisted function declaration below — safe to call here.
	die("✗ --obfuscate is incompatible with --snapshot (a snapshot is a raw source copy — there is no bundle to obfuscate)");
}
if (IS_OBFUSCATE && IS_EXE) {
	// `die()` is a hoisted function declaration below — safe to call here.
	die(
		"✗ --obfuscate is incompatible with --exe: --obfuscate forces a bundle-then-compile order, and " +
			'bundling resolves `with { type: "file" }` asset imports down to bundle-relative paths — by the ' +
			"time `bun build --compile` runs on that bundle, there are no file imports left for it to embed, " +
			"so the resulting binary looks fine but fails at runtime when it looks for its assets " +
			"(e.g. src/generated/embedded-assets.ts, the mupdf wasm). Use plain --exe (its source-level " +
			"compile embeds assets correctly), or --obfuscate without --exe.",
	);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function clean(...files: string[]) {
	for (const f of files) if (existsSync(f)) rmSync(f, { recursive: true });
}

function formatSize(p: string): string {
	try {
		const bytes = Bun.file(p).size;
		if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
		if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
		return `${bytes} B`;
	} catch {
		return "?";
	}
}

function lstatSyncSafe(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function resolvePiPkgDir(): string {
	const pkgJsonUrl = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
	return dirname(new URL(pkgJsonUrl).pathname);
}

function assertWorkspaceDeps(): void {
	const pj = JSON.parse(readFileSync("package.json", "utf8")) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	const all = { ...pj.dependencies, ...pj.peerDependencies };
	const ws = Object.keys(all).filter((d) => d.startsWith("@repo/"));
	const missing = ws.filter((d) => !existsSync(`node_modules/${d}`));
	if (missing.length > 0) {
		console.error(
			`\n✗ missing workspace symlinks: ${missing.join(", ")}\n` +
				`  The monorepo's node_modules is stale. Fix:\n` +
				`    bun install            # at bun-apps/ (not here)\n` +
				`    bun scripts/deploy.ts  # then re-deploy\n`,
		);
		process.exit(1);
	}
}

// ── run.sh generator ─────────────────────────────────────────────────────────
// Writes a minimal launcher for non-exe modes.
// - `bunCmd`: the bun binary to invoke ("bun" for system PATH, "$DIR/bun" for
//   standalone — DIR-relative so run.sh works from ANY cwd, not just the deploy dir;
//   a bare "./bun" would be cwd-relative and break the documented foreign-cwd use)
// - `entry`: the entry point relative to the deploy root ("pi-agent.js" or "pi-agent/src/cli.ts")
function writeRunSh(outDir: string, bunCmd: string, entry: string) {
	const content = `#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
if [ -f "$DIR/.deploy-readonly" ]; then
  # Frozen deploy (chmod a-w): route jiti's fs cache + per-user state OFF the
  # read-only tree. See docs/deploy-readonly.md.
  export JITI_FS_CACHE="\${JITI_FS_CACHE:-0}"
  export PI_CODING_AGENT_DIR="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
fi
exec "${bunCmd}" run "$DIR/${entry}" "$@"
`;
	writeFileSync(join(outDir, "run.sh"), content, { mode: 0o755 });
	console.log(`  ✓ run.sh  (entry: ${entry}, bun: ${bunCmd})`);
}

// ── Stage: bundle pi-agent.js ────────────────────────────────────────────────
async function stageBundle(piPkgDir: string) {
	const outfile = join(target, `${APP_NAME}.js`);
	console.log(`▶ bundle → ${outfile}`);
	clean(outfile, `${outfile}.map`);

	const { build } = await import("bun");
	const result = await build({
		entrypoints: ["src/cli.ts"],
		outdir: target,
		target: "bun",
		format: "esm",
		naming: `${APP_NAME}.js`,
		minify: { whitespace: true, identifiers: true, syntax: true },
		sourcemap: "none",
		splitting: false,
		external: OPTIONAL_EXTERNALS,
	});

	if (!result.success) {
		for (const l of result.logs) console.error(l);
		process.exit(1);
	}
	console.log(`  ✓ ${outfile}  (${formatSize(outfile)})`);

	// Symlink node_modules for bundle-mode extension resolution.
	// The bundle keeps typebox + @earendil-works/* as bare peer-dep specifiers;
	// pi's extension loader resolves them via require.resolve relative to the
	// bundle file. Symlinking <target>/node_modules to the bun store makes
	// this work at any path on the same machine.
	linkNodeModules(piPkgDir);
}

function linkNodeModules(piPkgDir: string) {
	const storeNodeModules = resolve(piPkgDir, "..", ".."); // <store-root>/node_modules
	const link = join(target, "node_modules");
	if (!existsSync(storeNodeModules)) {
		console.log(`  · node_modules symlink skipped (store not found at ${storeNodeModules})`);
		return;
	}
	if (existsSync(link) || lstatSyncSafe(link)) rmSync(link, { recursive: true });
	symlinkSync(storeNodeModules, link);
	console.log(`  ✓ node_modules → ${storeNodeModules}`);
}

// ── Stage: obfuscate (moved from the deleted pi-agent-cli/scripts/build.ts) ──
async function stageObfuscate(file: string) {
	console.log(`▶ obfuscate → ${file}`);
	const { default: JavaScriptObfuscator } = await import("javascript-obfuscator");
	const code = readFileSync(file, "utf8");
	const out = JavaScriptObfuscator.obfuscate(code, {
		compact: true,
		controlFlowFlattening: true,
		controlFlowFlatteningThreshold: 0.75,
		deadCodeInjection: true,
		deadCodeInjectionThreshold: 0.4,
		stringArray: true,
		stringArrayEncoding: ["base64"],
		stringArrayThreshold: 0.75,
		identifierNamesGenerator: "hexadecimal",
		renameGlobals: false, // keep ESM safe
		selfDefending: true,
		disableConsoleOutput: false,
		sourceMap: false,
		// javascript-obfuscator's regex transformer is brittle on non-trivial
		// patterns (obsidian carries complex wiki-link/frontmatter regexes) and
		// has crashed on them in the past, so leave regex literals intact.
		regexObfuscation: false,
	});
	writeFileSync(file, out.getObfuscatedCode());
	console.log(`  ✓ obfuscated ${file}  (${formatSize(file)})`);
}

// ── Stage: --exe (compile single-pass embed binary from `input`) ─────────────
async function stageExe(input: string) {
	const outfile = join(target, APP_NAME);
	console.log(`▶ compile (single-pass embed) → ${outfile}`);
	clean(outfile);

	const externalFlags = OPTIONAL_EXTERNALS.flatMap((p) => ["--external", p]);
	const proc = Bun.spawn(
		["bun", "build", "--compile", input, `--outfile=${outfile}`, "--minify", ...externalFlags],
		{ stdout: "inherit", stderr: "inherit" },
	);
	const code = await proc.exited;
	if (code !== 0) die(`  ✗ bun build --compile exited ${code}`);
	console.log(`  ✓ ${outfile}  (${formatSize(outfile)})`);
}

// Every sibling package dir pi-agent's manifest (or static-extensions.ts)
// resolves via a relative/workspace path — mirrors the set build-extensions.ts
// and static-extensions.ts depend on. Snapshot mode runs raw, unbundled source
// (mode="source" per src/mode.ts), so resolve.ts computes bunAppsDir LIVE from
// the copied file's own on-disk location (dirname(fileURLToPath(url)), '..',
// '..') — it does NOT read the baked src/generated/run-dir-base.ts (that's
// bundle-mode-only). That means every one of these dirs must actually exist as
// a sibling of the copied `pi-agent/` under target/, or module resolution
// throws immediately (relative imports resolve against real on-disk paths).
function collectRequiredPkgDirs(): Set<string> {
	const dirs = new Set<string>();
	const addFromEntry = (e: string | { entry?: string } | undefined) => {
		const rel = typeof e === "string" ? e : e?.entry;
		if (rel) dirs.add(rel.split("/")[0]!);
	};
	for (const e of manifest.extensions ?? []) addFromEntry(e as any);
	for (const rel of manifest.skills ?? []) dirs.add(rel.split("/")[0]!);
	for (const rel of manifest.binarySkills ?? []) dirs.add(rel.split("/")[0]!);
	for (const pkg of manifest.staticExtensions ?? []) dirs.add(pkg);
	for (const e of Object.values(manifest.lazyExtensions ?? {})) addFromEntry(e as any);
	dirs.delete("pi-agent"); // copied separately, unconditionally
	return dirs;
}

// ── Stage: --snapshot (copy source + node_modules, no bundling) ──────────────
async function stageSnapshot(bunAppsDir: string) {
	console.log(`▶ snapshot → ${target}`);

	// Copy entire pi-agent source tree (including generated files from codegen)
	const piAgentSrc = join(bunAppsDir, "pi-agent");
	cpSync(piAgentSrc, join(target, "pi-agent"), { recursive: true, force: true });
	console.log(`  ✓ pi-agent/ source tree`);

	// Copy every sibling extension package pi-agent's manifest/static-extensions
	// reference — without these, resolve.ts's relative-path resolution (source
	// mode) throws "Cannot find module" on the very first import. Each package's
	// own node_modules/ IS copied (not filtered out): the isolated linker
	// (bunfig.toml) gives every workspace package its own node_modules/ of
	// symlinks into the machine-global store, and cpSync preserves symlinks
	// (dereference defaults to false) — the symlink TARGETS are absolute paths
	// into the global store, so this only works on the SAME machine (same
	// caveat bundle mode's node_modules symlink already documents).
	const pkgDirs = collectRequiredPkgDirs();
	for (const dir of pkgDirs) {
		const src = join(bunAppsDir, dir);
		if (!existsSync(src)) {
			console.log(`  · skipping missing package dir: ${dir}`);
			continue;
		}
		cpSync(src, join(target, dir), { recursive: true, force: true });
	}
	console.log(`  ✓ ${pkgDirs.size} sibling extension package dir(s)`);

	// Copy bun-apps node_modules (the workspace root — needed for dep resolution)
	console.log(`  · copying node_modules...`);
	const nmSrc = join(bunAppsDir, "node_modules");
	if (!existsSync(nmSrc)) die(`  ✗ node_modules not found at ${nmSrc} — run \`bun install\` in bun-apps/`);
	cpSync(nmSrc, join(target, "node_modules"), { recursive: true, force: true });
	console.log(`  ✓ node_modules/`);

	// Write run.sh pointing at pi-agent/src/cli.ts (uses system bun)
	writeRunSh(target, "bun", "pi-agent/src/cli.ts");
}

// ── Stage: copy bun binary alongside (--standalone) ──────────────────────────
async function stageCopyLocalBun() {
	const result = spawnSync("which", ["bun"], { stdio: "pipe" });
	if (result.status !== 0) die("  ✗ bun not found in PATH — cannot build --standalone");
	const bunPath = result.stdout.toString().trim();
	console.log(`  · copying bun binary: ${bunPath}`);
	cpSync(bunPath, join(target, "bun"));
	console.log(`  ✓ ${join(target, "bun")}`);
}

// ── Stage: freeze (read-only artifact) ───────────────────────────────────────
async function stageFreeze() {
	writeFileSync(
		join(target, ".deploy-readonly"),
		`read-only deploy\n` +
			`mode: ${IS_EXE ? "exe" : IS_SNAPSHOT ? "snapshot" : IS_STANDALONE ? "standalone" : "bundle"}\n` +
			`built: ${new Date().toISOString()}\n` +
			"run.sh applies JITI_FS_CACHE=0 + PI_CODING_AGENT_DIR=$HOME/.pi/agent so this runs as-is.\n",
	);
	const unfreeze = Bun.spawn(["chmod", "-R", "a-w", target], { stdout: "inherit", stderr: "inherit" });
	if ((await unfreeze.exited) !== 0) die("chmod -R a-w failed");
	console.log(`  ✓ frozen (chmod a-w + .deploy-readonly)`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	assertWorkspaceDeps();

	const piPkgDir = resolvePiPkgDir();
	const bunAppsDir = resolve(process.cwd(), "..");
	const npmExts: NpmExt[] = manifest.npmExtensions ?? [];
	const binarySkills: string[] = manifest.binarySkills ?? [];

	// Stage 1: Codegen (all modes — generates pi-pkg-dir.ts, run-dir-base.ts,
	// and embedded-assets.ts). The embed mode flag for embedded-assets is
	// IS_EXE: only --exe compiles with type:file imports.
	console.log(`▶ target: ${target}`);
	if (existsSync(target)) {
		// A previous freeze may have set a-w; unfreeze so rmSync works.
		if (existsSync(join(target, ".deploy-readonly"))) {
			const unfreeze = Bun.spawn(["chmod", "-R", "u+w", target], { stdout: "ignore", stderr: "ignore" });
			await unfreeze.exited;
		}
		rmSync(target, { recursive: true });
	}
	mkdirSync(target, { recursive: true });

	stageGeneratePkgDir(piPkgDir);
	stageGenerateRunDirBase(npmExts);
	stageGenerateEmbeddedAssets(piPkgDir, bunAppsDir, binarySkills, IS_EXE);

	if (IS_EXE) {
		// --exe: compile directly from source, skip bundle/ext-bundles/skills/run.sh
		// (--obfuscate is rejected above when combined with --exe, so this is
		// always a plain source-level compile that embeds assets correctly.)
		await stageExe("src/cli.ts");
	} else if (IS_SNAPSHOT) {
		// --snapshot: copy source + node_modules, no bundling
		await stageSnapshot(bunAppsDir);
	} else {
		// --bundle (default) or --standalone: bundle pi-agent.js + ext bundles + skills
		await stageBundle(piPkgDir);
		if (IS_OBFUSCATE) await stageObfuscate(join(target, `${APP_NAME}.js`));

		// Build thin extension bundles
		const extBundlesDir = join(target, "ext-bundles");
		mkdirSync(extBundlesDir, { recursive: true });
		console.log(`▶ build thin extension bundles → ${extBundlesDir}`);
		const { count } = await buildExtensions(extBundlesDir);
		console.log(`  ✓ ${count} extension bundle(s)`);

		// Copy skills
		if (manifest.skills?.length) {
			const skillsDir = join(target, "skills");
			mkdirSync(skillsDir, { recursive: true });
			const SKIP = new Set(["node_modules", "dist", ".git"]);
			for (const rel of manifest.skills) {
				const src = join(bunAppsDir, rel);
				if (!existsSync(src)) {
					console.log(`  · skipping missing skill: ${rel}`);
					continue;
				}
				const destName = rel.replace(/\//g, "-");
				cpSync(src, join(skillsDir, destName), {
					recursive: true,
					filter: (s) => !SKIP.has(basename(dirname(s))) || basename(s) === "",
				});
				console.log(`  ✓ skills/${destName}`);
			}
		}

		// Write marker and minimal package.json (resolve.ts DEPLOY-BUNDLE detection)
		writeFileSync(
			join(target, ".deploy-bundle"),
			`bundle deploy\nbuilt: ${new Date().toISOString()}\n`,
		);
		writeFileSync(
			join(target, "package.json"),
			JSON.stringify({ name: "pi-agent-bundle", private: true, type: "module" }, null, 2) + "\n",
		);

		// Write run.sh (always for non-exe modes)
		writeRunSh(target, IS_STANDALONE ? "$DIR/bun" : "bun", "pi-agent.js");

		// --standalone: also copy the bun binary
		if (IS_STANDALONE) {
			await stageCopyLocalBun();
		}
	}

	// Final stage: freeze (unless --no-freeze)
	if (!NO_FREEZE) {
		await stageFreeze();
	}

	console.log(`\n✓ deployed → ${target}${NO_FREEZE ? "" : " (read-only)"}`);
}

await main();
