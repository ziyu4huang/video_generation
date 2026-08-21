/**
 * deploy.ts — orchestrator for the s2-agent-sh deploy.
 *
 * Produces <outRoot>/<version>/ containing:
 *   s2-agent      minimal compiled core (zero extensions inside), hardlinked
 *                 from <outRoot>/.cores/<hash> when frozen (Phase 3 §a)
 *   run.sh        thin launcher
 *   deploy.json   provenance
 *   package.json  deploy version — pi reads its version from next to the exe
 *   ext/<name>/   independently built extension packages
 *
 * Everything is staged in <outRoot>/.staging-<version> and only renamed into
 * place after all six gates pass, so a failed deploy never leaves a
 * half-written version dir and never repoints `current`. Version dirs are
 * immutable — the in-place `--ext` rebuild was deleted in Phase 3 §b; an
 * extension-only change is just an ordinary deploy (the core cache makes it
 * skip the compile). After `current` flips, old versions are pruned oldest-
 * first down to the registry's `keep` (§c), and the .cores entries that
 * pruning just left unreferenced are collected with them.
 *
 * This is the ONLY deploy pipeline. The four legacy modes it used to sit beside
 * (scripts/deploy.ts --bundle / --snapshot / --standalone / --exe) were retired
 * in the deploy-architecture consolidation — see
 * .planning/specs/2026-08-20-deploy-architecture-consolidation-design.md.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { APP_NAME } from "./lib/app-name.ts";
import { parseShConfig, type ShConfig } from "./lib/config.ts";
import { buildExtPackage } from "./lib/ext-build.ts";
import {
	scanBinaryForeignPaths,
	scanSymlinkEscapes,
	verifyVendoredClosure,
	verifyVendoredCompleteness,
} from "./lib/offline-gate.ts";
import {
	DEFAULT_KEEP,
	computeVersion,
	ensureOutRoot,
	pruneVersions,
	resolveTargetDir,
	swapCurrent,
} from "./lib/version.ts";
import { computeCoreHash, ensureCachedCore, linkCore, type PrunedCore, pruneOrphanCores } from "./lib/core-cache.ts";
import { freezeTree, rmTree } from "./lib/fs.ts";
import { stageGenerateEmbeddedAssets } from "./lib/codegen.ts";

const PI_AGENT_DIR = resolve(import.meta.dir, "..", "..", "s2-agent");
const BUN_APPS_DIR = dirname(PI_AGENT_DIR);
const REPO_ROOT = dirname(BUN_APPS_DIR);
const DEFAULT_CONFIG = join(PI_AGENT_DIR, "s2-agent.registry.yaml");

export interface DeployShOptions {
	configPath?: string;
	outRoot?: string;
	version?: string;
	freeze?: boolean;
	current?: boolean;
	force?: boolean;
}

export interface DeployShResult {
	version: string;
	target: string;
	extensions: Array<{ name: string; bytes: number }>;
	coreBytes: number;
	/** True when the core came from <outRoot>/.cores without a recompile. */
	coreCached: boolean;
	currentUpdated: boolean;
	/** Version dirs removed by retention, oldest first. */
	pruned: string[];
	/** Cache entries in .cores/ collected because no version dir links them any more. */
	prunedCores: PrunedCore[];
}

function gitShortSha(): string | null {
	const p = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) return null;
	return p.stdout.toString().trim() || null;
}

function resolvePiPkgDir(): string {
	const url = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
	return dirname(new URL(url).pathname);
}

/** The config and the core must agree on the host contract, or every extension silently refuses to load. */
async function assertHostContract(cfg: ShConfig): Promise<void> {
	const { HOST_API, HOST_MODULE_IDS } = await import("../../s2-agent/src/sh/host-modules.ts");
	if (cfg.hostApi !== HOST_API) {
		throw new Error(`deploy-config hostApi ${cfg.hostApi} != core HOST_API ${HOST_API} (src/sh/host-modules.ts)`);
	}
	const missing = cfg.hostModules.filter((m) => !HOST_MODULE_IDS.includes(m));
	const extra = HOST_MODULE_IDS.filter((m) => !cfg.hostModules.includes(m));
	if (missing.length > 0 || extra.length > 0) {
		throw new Error(
			`deploy-config hostModules disagree with core HOST_MODULE_IDS — ` +
				`only in config: [${missing.join(", ")}], only in core: [${extra.join(", ")}]`,
		);
	}
}

/**
 * Produce the version dir's `s2-agent` core (Phase 3 §a).
 *
 * Frozen deploys go through the content-addressed cache: hash the build
 * inputs (the src/ tree as it sits AFTER the embedded-assets codegen, the
 * resolved pi-coding-agent version, Bun.version, entry, flags), reuse
 * <outRoot>/.cores/<hash> on hit, compile-and-cache on miss, and HARDLINK
 * the entry into the version dir. A no-freeze deploy bypasses the cache
 * entirely (hardlinks share an inode; a writable cached core would re-mode
 * every frozen version sharing it) and compiles a plain private copy.
 */
async function buildCore(
	outFile: string,
	opts: { outRoot: string; freeze: boolean },
): Promise<{ bytes: number; cached: boolean }> {
	const piPkgDir = resolvePiPkgDir();
	// Embed pi's own theme/assets/export-html so the binary needs no repo on the
	// target machine. Two sibling stages used to run here — pi-pkg-dir.ts and an
	// EMPTY run-dir-base.ts — writing constants only the retired "bundle" mode
	// ever read. Phase 1b removed the readers, so these writers went too;
	// resolvePiPkgDir() is still needed, as an ARGUMENT to the asset embedder.
	//
	// codegen.ts writes to the CWD-relative "src/generated" and derives
	// BUN_APPS_DIR from process.cwd() (it was written for `bun run deploy` from
	// bun-apps/s2-agent). Called from anywhere else it silently writes the
	// generated files into the caller's directory — observed polluting the repo
	// root — so pin the cwd here and restore it after.
	const prevCwd = process.cwd();
	const withPinnedCwd = (embed: boolean) => {
		process.chdir(PI_AGENT_DIR);
		try {
			stageGenerateEmbeddedAssets(piPkgDir, BUN_APPS_DIR, [], embed);
		} finally {
			process.chdir(prevCwd);
		}
	};

	const compile = async (target: string): Promise<number> => {
		const entry = join(PI_AGENT_DIR, "src", "cli-sh.ts");
		// bun's build report is human progress. deploy-cli promises stdout is
		// PURE JSON, and "inherit" here put the child's report on the same stdout
		// as the final JSON payload — so pipe it and re-emit on stderr.
		const p = Bun.spawn(["bun", "build", "--compile", entry, `--outfile=${target}`, "--minify"], {
			cwd: PI_AGENT_DIR,
			stdout: "pipe",
			stderr: "inherit",
		});
		const report = new Response(p.stdout)
			.text()
			.then((t) => {
				if (t) process.stderr.write(t);
			});
		const code = await p.exited;
		await report;
		if (code !== 0) throw new Error("bun build --compile failed for src/cli-sh.ts");
		chmodSync(target, 0o755);
		return Bun.file(target).size;
	};

	withPinnedCwd(true);
	try {
		if (opts.freeze) {
			const piPkgVersion = (JSON.parse(readFileSync(join(piPkgDir, "package.json"), "utf8")) as { version: string })
				.version;
			const hash = computeCoreHash({
				piAgentDir: PI_AGENT_DIR,
				piPkgVersion,
				bunVersion: Bun.version,
				entry: "src/cli-sh.ts",
				flags: ["--minify"],
			});
			const core = await ensureCachedCore({
				outRoot: opts.outRoot,
				hash,
				compile: async (target) => {
					await compile(target);
				},
			});
			linkCore(core.cacheFile, outFile);
			return { bytes: core.bytes, cached: core.cached };
		}
		const bytes = await compile(outFile);
		return { bytes, cached: false };
	} finally {
		// Reset the embedded-asset manifest to its empty form now that the
		// binary has been compiled (or the cache made compiling unnecessary).
		// The embedMode file imports .png/.map assets with
		// `with { type: "file" }`, which `tsc --noEmit` cannot resolve —
		// leaving it in place turns the repo's own typecheck gate red after
		// every deploy. The binary already carries the embedded copies, so
		// this only affects the working tree.
		withPinnedCwd(false);
	}
}

const RUN_SH = `#!/usr/bin/env bash
# run.sh — launcher for a s2-agent-sh deploy.
#
# The binary beside this script is self-contained: it discovers extensions from
# ./ext/<name>/ at runtime and runs normally when that directory is absent.
set -euo pipefail
SOURCE="\${BASH_SOURCE[0]}"
while [ -L "\$SOURCE" ]; do
  DIR="\$(cd -P "\$(dirname "\$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="\$(readlink "\$SOURCE")"
  [[ \$SOURCE != /* ]] && SOURCE="\$DIR/\$SOURCE"
done
SCRIPT_DIR="\$(cd -P "\$(dirname "\$SOURCE")" >/dev/null 2>&1 && pwd)"

# The deploy tree is chmod a-w; keep every per-user write under ~/.pi/agent.
export JITI_FS_CACHE="\${JITI_FS_CACHE:-0}"
export PI_CODING_AGENT_DIR="\${PI_CODING_AGENT_DIR:-\$HOME/.pi/agent}"

# Offline dist: no browser is bundled. The vendored puppeteer (hyperframes
# frame capture) launches SYSTEM Chrome — the same machine dependency
# power-tool's playwright channel:"chrome" already makes. No candidate
# found → var stays unset → puppeteer fails with its own clear launch error.
if [ -z "\${PUPPETEER_EXECUTABLE_PATH:-}" ]; then
  for _chrome in \\
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \\
    "/usr/bin/google-chrome" \\
    "/usr/bin/google-chrome-stable" \\
    "/usr/bin/chromium" \\
    "/usr/bin/chromium-browser"; do
    [ -x "\$_chrome" ] && export PUPPETEER_EXECUTABLE_PATH="\$_chrome" && break
  done
fi

exec "\$SCRIPT_DIR/${APP_NAME}" "\$@"
`;

interface ExtListPayload {
	loadedCount: number;
	loaded: string[];
	skipped: Array<{ name: string; reason: string }>;
}

/** Run the binary's --ext-list diagnostic and return the parsed payload. */
function extListOf(binary: string): ExtListPayload {
	const p = Bun.spawnSync([binary, "--ext-list"], { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) {
		throw new Error(`--ext-list exited ${p.exitCode}: ${p.stderr.toString()}`);
	}
	return JSON.parse(p.stdout.toString()) as ExtListPayload;
}

/** Gate 3: extensions load; with ext/ moved aside the core still exits 0 with none. */
function verifyDualState(stageDir: string, expected: string[]): void {
	const binary = join(stageDir, APP_NAME);
	const withExt = extListOf(binary);
	const missing = expected.filter((n) => !withExt.loaded.includes(n));
	if (missing.length > 0) {
		throw new Error(
			`smoke: expected extension(s) not loaded: ${missing.join(", ")}; skipped=${JSON.stringify(withExt.skipped)}`,
		);
	}

	const extDir = join(stageDir, "ext");
	const parked = join(stageDir, ".ext-parked");
	renameSync(extDir, parked);
	try {
		const without = extListOf(binary);
		if (without.loadedCount !== 0) {
			throw new Error(`smoke: core loaded ${without.loadedCount} extension(s) with ext/ removed`);
		}
	} finally {
		renameSync(parked, extDir);
	}
}

/**
 * Gate 5: the tree is offline-contained (see lib/offline-gate.ts for the four
 * checks and the defect each closes). The scan keys off the FINAL version
 * path — a baked staging path is itself a violation. Allowlisted binary
 * artifacts print as warnings, never block.
 */
function verifyOfflineContainment(
	tree: string,
	opts: { binary?: string; finalTarget?: string } = {},
): void {
	const problems: string[] = [];

	const escapes = scanSymlinkEscapes(tree);
	if (escapes.length > 0) {
		problems.push(`symlink(s) escape the deploy tree: ${escapes.slice(0, 5).join("; ")}${escapes.length > 5 ? ` (+${escapes.length - 5} more)` : ""}`);
	}

	const incomplete = verifyVendoredCompleteness(tree);
	if (incomplete.length > 0) {
		problems.push(
			`declared vendor package(s) not shipped: ${incomplete.map((m) => `${m.ext}:${m.pkg}`).join(", ")}`,
		);
	}

	const dangling = verifyVendoredClosure(tree);
	if (dangling.length > 0) {
		problems.push(
			`vendored package(s) with hard deps missing from the tree: ${dangling
				.map((v) => `${v.pkg} → ${v.missing.join(", ")}`)
				.join("; ")}`,
		);
	}

	if (opts.binary && opts.finalTarget) {
		const r = scanBinaryForeignPaths(opts.binary, opts.finalTarget);
		for (const allowed of r.allowed) {
			process.stderr.write(`gate5: allowlisted binary artifact: ${allowed}\n`);
		}
		if (r.foreign.length > 0) {
			problems.push(`binary bakes build-machine path(s): ${r.foreign.slice(0, 5).join(", ")}${r.foreign.length > 5 ? ` (+${r.foreign.length - 5} more)` : ""}`);
		}
	}

	if (problems.length > 0) {
		throw new Error(
			`Gate 5 (offline containment) failed — the deploy tree must be self-contained and relocatable:\n  ${problems.join("\n  ")}`,
		);
	}
}

/**
 * Gate 6: relocation smoke. Gate 4 (foreign-path scan) is a string heuristic
 * that deliberately accepts false negatives; this is the behavioural proof —
 * clone the staged tree to a DIFFERENT absolute path and boot it there. If
 * anything baked the builder's layout into the tree, `--ext-list` fails or
 * drops extensions from the new location. `cp -c` (APFS clone) keeps the copy
 * ~free; cpSync is the portable fallback.
 */
function verifyRelocatable(stageDir: string, outRoot: string, expected: string[]): void {
	const relocRoot = mkdtempSync(join(outRoot, ".reloc-"));
	const copy = join(relocRoot, "tree");
	const clone = Bun.spawnSync(["cp", "-cR", stageDir, copy], { stdout: "pipe", stderr: "pipe" });
	if (clone.exitCode !== 0) cpSync(stageDir, copy, { recursive: true });
	try {
		const there = extListOf(join(copy, "s2-agent"));
		const missing = expected.filter((n) => !there.loaded.includes(n));
		if (there.loadedCount !== expected.length || missing.length > 0) {
			throw new Error(
				`relocation smoke: booted from ${copy} loaded [${there.loaded.join(", ")}], ` +
					`expected [${expected.join(", ")}]; skipped=${JSON.stringify(there.skipped)}`,
			);
		}
	} finally {
		rmTree(relocRoot);
	}
}

/**
 * Thrown when the target version dir already exists and --force was not
 * passed. Carries the deploy identity so callers can classify a re-deploy of
 * the current tree state as a NO-OP success (version dirs are immutable and
 * content-addressed by git sha — same version, same content) instead of a
 * failure that sends someone to diagnose a perfectly healthy deploy.
 */
export class DeployVersionExistsError extends Error {
	constructor(
		readonly version: string,
		readonly target: string,
	) {
		super(`${target} already exists — pass --force to replace it`);
		this.name = "DeployVersionExistsError";
	}
}

export async function runShDeploy(opts: DeployShOptions = {}): Promise<DeployShResult> {
	const configPath = opts.configPath ? resolve(opts.configPath) : DEFAULT_CONFIG;
	if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
	const cfg = parseShConfig(readFileSync(configPath, "utf8"), { bunAppsDir: BUN_APPS_DIR });
	await assertHostContract(cfg);

	const outRoot = opts.outRoot ? resolve(opts.outRoot) : cfg.outRoot;
	const pkgVersion = (JSON.parse(readFileSync(join(PI_AGENT_DIR, "package.json"), "utf8")) as { version: string })
		.version;
	const sha = gitShortSha();
	const version = opts.version ?? computeVersion({ pkgVersion, gitSha: sha, useGitSha: cfg.version.gitSha });
	const target = resolveTargetDir(outRoot, version);
	const freeze = opts.freeze ?? cfg.freeze;
	const wantCurrent = opts.current ?? cfg.current;
	const builtAt = new Date().toISOString();
	const sourceSha = sha ?? "unknown";
	const enabled = cfg.extensions.filter((e) => e.enabled);

	ensureOutRoot(outRoot);

	// ── deploy (version dirs are immutable — the in-place ext rebuild is gone) ─
	if (existsSync(target) && !opts.force) {
		throw new DeployVersionExistsError(version, target);
	}
	const stage = join(outRoot, `.staging-${version}`);
	rmTree(stage);
	mkdirSync(join(stage, "ext"), { recursive: true });

	const built: Array<{ name: string; bytes: number }> = [];
	try {
		const { bytes: coreBytes, cached: coreCached } = await buildCore(join(stage, APP_NAME), { outRoot, freeze });

		for (const ext of enabled) {
			const r = await buildExtPackage({
				ext,
				bunAppsDir: BUN_APPS_DIR,
				outDir: join(stage, "ext", ext.name),
				deployRoot: stage,
				hostApi: cfg.hostApi,
				hostModules: cfg.hostModules,
				sourceSha,
				builtAt,
			});
			built.push({ name: r.name, bytes: r.bytes });
		}

		writeFileSync(join(stage, "run.sh"), RUN_SH);
		chmodSync(join(stage, "run.sh"), 0o755);
		// pi resolves its version AND branding from <packageDir>/package.json,
		// and in compiled-binary mode packageDir = dirname(execPath) = this
		// version dir. Without this file VERSION falls back to "0.0.0", and
		// without piConfig.name APP_NAME falls back to "pi" — which used to
		// make the banner read "pi v0.0.0" and, worse, the exit hint print
		// "To resume this session: pi --session …" (a binary that does not
		// exist on the deploy target). piConfig.name = APP_NAME brands both;
		// configDir stays pinned to ".pi" so CONFIG_DIR_NAME and the
		// ~/.pi/agent state dir are deterministic. NOTE: ENV_AGENT_DIR becomes
		// "<APP_NAME uppercased>_CODING_AGENT_DIR" (hyphenated for "s2-agent" —
		// bash cannot `export` that name; override via `env` if ever needed).
		writeFileSync(
			join(stage, "package.json"),
			`${JSON.stringify({ version, piConfig: { name: APP_NAME, configDir: ".pi" } }, null, 2)}\n`,
		);
		writeFileSync(
			join(stage, "deploy.json"),
			`${JSON.stringify({ version, builtAt, sourceSha, bunVersion: Bun.version, configPath, config: cfg }, null, 2)}\n`,
		);

		verifyDualState(
			stage,
			enabled.map((e) => e.name),
		);

		// Gate 5 — BEFORE the rename/freeze/current swap, so a violation never
		// becomes the deployed version. The binary scan keys off the FINAL
		// version path: a baked `.staging-…` path is itself a violation (it
		// sits under $HOME and would break relocatability).
		verifyOfflineContainment(stage, { binary: join(stage, APP_NAME), finalTarget: target });

		// Gate 6 — behavioural relocatability: boot a clone of the staged tree
		// from a different absolute path.
		verifyRelocatable(
			stage,
			outRoot,
			enabled.map((e) => e.name),
		);

		if (existsSync(target)) rmTree(target);
		renameSync(stage, target);
		if (freeze) freezeTree(target);
		let currentUpdated = false;
		if (wantCurrent) {
			swapCurrent(outRoot, version);
			currentUpdated = true;
		}
		const pruned = pruneVersions(outRoot, { keep: cfg.keep ?? DEFAULT_KEEP });
		// Strictly after pruneVersions: dropping a version dir is what turns its
		// core into an orphan, and the core just linked above is protected by its
		// own link count either way.
		const prunedCores = pruneOrphanCores(outRoot);
		return { version, target, extensions: built, coreBytes, coreCached, currentUpdated, pruned, prunedCores };
	} catch (e) {
		rmTree(stage); // never leave a half-written deploy behind
		throw e;
	}
}
