/**
 * deploy-sh.ts — orchestrator for the pi-agent-sh deploy.
 *
 * Produces <outRoot>/<version>/ containing:
 *   pi-agent      minimal compiled core (zero extensions inside)
 *   run.sh        thin launcher
 *   deploy.json   provenance
 *   package.json  deploy version — pi reads its version from next to the exe
 *   ext/<name>/   independently built extension packages
 *
 * Everything is staged in <outRoot>/.staging-<version> and only renamed into
 * place after all gates pass, so a failed deploy never leaves a half-written
 * version dir and never repoints `current`.
 *
 * This file deliberately does NOT touch scripts/deploy.ts or any of its four
 * modes — the two pipelines are independent.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseShConfig, type ShConfig } from "./lib/sh-config.ts";
import { buildExtPackage } from "./lib/sh-ext-build.ts";
import { computeVersion, ensureOutRoot, resolveTargetDir, swapCurrent } from "./lib/sh-version.ts";
import { freezeTree, rmTree, unfreezeTree } from "./lib/sh-fs.ts";
import { stageGenerateEmbeddedAssets, stageGeneratePkgDir, stageGenerateRunDirBase } from "./lib/codegen.ts";

const PI_AGENT_DIR = resolve(import.meta.dir, "..", "..", "pi-agent");
const BUN_APPS_DIR = dirname(PI_AGENT_DIR);
const REPO_ROOT = dirname(BUN_APPS_DIR);
const DEFAULT_CONFIG = join(PI_AGENT_DIR, "deploy-config.yaml");

export interface DeployShOptions {
	configPath?: string;
	outRoot?: string;
	version?: string;
	/** Rebuild only these extensions into an EXISTING version dir. */
	onlyExt?: string[];
	freeze?: boolean;
	current?: boolean;
	force?: boolean;
}

export interface DeployShResult {
	version: string;
	target: string;
	extensions: Array<{ name: string; bytes: number }>;
	coreBytes: number;
	currentUpdated: boolean;
	mode: "full" | "ext-only";
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
	const { HOST_API, HOST_MODULE_IDS } = await import("../../pi-agent/src/sh/host-modules.ts");
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

/** Compile the minimal core into `outFile`. Returns its size in bytes. */
async function buildCore(outFile: string): Promise<number> {
	const piPkgDir = resolvePiPkgDir();
	// Same codegen the --exe mode uses: bake pi's package dir, an EMPTY run-dir
	// base (sh mode resolves nothing from the repo), and embed pi's own
	// theme/assets/export-html so the binary needs no repo on the target machine.
	//
	// codegen.ts writes to the CWD-relative "src/generated" and derives
	// BUN_APPS_DIR from process.cwd() (it was written for `bun run deploy` from
	// bun-apps/pi-agent). Called from anywhere else it silently writes the
	// generated files into the caller's directory — observed polluting the repo
	// root — so pin the cwd here and restore it after.
	const prevCwd = process.cwd();
	process.chdir(PI_AGENT_DIR);
	try {
		stageGeneratePkgDir(piPkgDir);
		stageGenerateRunDirBase([]);
		stageGenerateEmbeddedAssets(piPkgDir, BUN_APPS_DIR, [], true);
	} finally {
		process.chdir(prevCwd);
	}

	const entry = join(PI_AGENT_DIR, "src", "cli-sh.ts");
	// bun's build report is human progress. deploy-sh-cli promises stdout is
	// PURE JSON, and "inherit" here put the child's report on the same stdout
	// as the final JSON payload — so pipe it and re-emit on stderr.
	const p = Bun.spawn(["bun", "build", "--compile", entry, `--outfile=${outFile}`, "--minify"], {
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

	// Reset the embedded-asset manifest to its empty form now that the binary has
	// been compiled. The embedMode file imports .png/.map assets with
	// `with { type: "file" }`, which `tsc --noEmit` cannot resolve — leaving it in
	// place turns the repo's own typecheck gate red after every deploy. The
	// binary already carries the embedded copies, so this only affects the
	// working tree.
	process.chdir(PI_AGENT_DIR);
	try {
		stageGenerateEmbeddedAssets(piPkgDir, BUN_APPS_DIR, [], false);
	} finally {
		process.chdir(prevCwd);
	}

	chmodSync(outFile, 0o755);
	return Bun.file(outFile).size;
}

const RUN_SH = `#!/usr/bin/env bash
# run.sh — launcher for a pi-agent-sh deploy.
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

exec "\$SCRIPT_DIR/pi-agent" "\$@"
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
	const binary = join(stageDir, "pi-agent");
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

	// ── ext-only rebuild: patch an existing version dir in place ─────────────
	if (opts.onlyExt && opts.onlyExt.length > 0) {
		if (!existsSync(target)) throw new Error(`--ext requires an existing deploy at ${target}`);
		const unknown = opts.onlyExt.filter((n) => !cfg.extensions.some((e) => e.name === n));
		if (unknown.length > 0) throw new Error(`unknown extension(s) in config: ${unknown.join(", ")}`);
		const selected = cfg.extensions.filter((e) => opts.onlyExt!.includes(e.name));

		unfreezeTree(target);
		const built: Array<{ name: string; bytes: number }> = [];
		try {
			for (const ext of selected) {
				const r = await buildExtPackage({
					ext,
					bunAppsDir: BUN_APPS_DIR,
					outDir: join(target, "ext", ext.name),
					deployRoot: target,
					hostApi: cfg.hostApi,
					hostModules: cfg.hostModules,
					sourceSha,
					builtAt,
				});
				built.push({ name: r.name, bytes: r.bytes });
			}
			verifyDualState(
				target,
				enabled.map((e) => e.name),
			);
		} finally {
			if (freeze) freezeTree(target);
		}
		return {
			version,
			target,
			extensions: built,
			coreBytes: Bun.file(join(target, "pi-agent")).size,
			currentUpdated: false,
			mode: "ext-only",
		};
	}

	// ── full deploy ──────────────────────────────────────────────────────────
	if (existsSync(target) && !opts.force) {
		throw new Error(`${target} already exists — pass --force to replace it`);
	}
	const stage = join(outRoot, `.staging-${version}`);
	rmTree(stage);
	mkdirSync(join(stage, "ext"), { recursive: true });

	const built: Array<{ name: string; bytes: number }> = [];
	try {
		const coreBytes = await buildCore(join(stage, "pi-agent"));

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
		// pi resolves its version from <packageDir>/package.json, and in
		// compiled-binary mode packageDir = dirname(execPath) = this version
		// dir. Without this file VERSION falls back to "0.0.0" and the startup
		// banner reads "pi v0.0.0". Minimal file: no name/piConfig keys, so
		// PACKAGE_NAME / APP_NAME / CONFIG_DIR_NAME keep their defaults.
		writeFileSync(join(stage, "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
		writeFileSync(
			join(stage, "deploy.json"),
			`${JSON.stringify({ version, builtAt, sourceSha, bunVersion: Bun.version, configPath, config: cfg }, null, 2)}\n`,
		);

		verifyDualState(
			stage,
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
		return { version, target, extensions: built, coreBytes, currentUpdated, mode: "full" };
	} catch (e) {
		rmTree(stage); // never leave a half-written deploy behind
		throw e;
	}
}
