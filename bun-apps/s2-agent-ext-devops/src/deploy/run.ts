/**
 * deploy.ts — orchestrator for the s2-agent-sh deploy.
 *
 * Produces <outRoot>/<target>/<version>/ containing (crossos-deploy t05,
 * D6: one complete immutable tree per cross-OS target, per-target `current`;
 * the .cores/.buns content-addressed caches stay shared at <outRoot>/):
 *   s2-agent.js   minimal core as a bun-run ESM bundle (zero extensions
 *                 inside), hardlinked from <outRoot>/.cores/<hash> when
 *                 frozen (Phase 3 §a; the core has been a `--target=bun`
 *                 bundle since 2026-08-23 — deploy-platform-neutral-core —
 *                 replacing the retired compiled-Mach-O artifact)
 *   dist/…        pi's theme/assets/export-html dirs copied at their Node
 *                 layout, where bundled pi resolves them from the deploy dir
 *   bin/bun       the shipped bun runtime, hardlinked from
 *                 <outRoot>/.buns/<hash> (ticket 02) — the launcher execs it
 *   s2-agent.sh   the launcher (execs bin/bun on s2-agent.js)
 *   s2-agent.ps1  the Windows launcher twin (crossos-deploy ticket 04),
 *                 plus s2-agent.cmd — the cmd.exe/double-click shim that
 *                 exec's the .ps1 with -ExecutionPolicy Bypass
 *   deploy.json   provenance
 *   package.json  deploy version — pi reads its version from beside the core
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
import { fileURLToPath } from "node:url";
import { APP_NAME } from "./lib/app-name.ts";
import { excludedExtensionsFromRegistry, filterForTarget, shConfig, type ShConfig } from "./lib/config.ts";
import { buildExtPackage } from "./lib/ext-build.ts";
import {
	collectModelFacts,
	writeDeployReport,
	writeDeployReportYaml,
	writeOutRootIndex,
	type GateRecord,
	type ReportExtension,
} from "./lib/deploy-report.ts";
import {
	scanBinaryForeignPaths,
	scanSymlinkEscapes,
	verifyVendoredClosure,
	verifyVendoredCompleteness,
	verifyAssetCompleteness,
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
import { ensureCachedBun, linkBun, type PrunedBun, pruneOrphanBuns } from "./lib/bun-cache.ts";
import { acquireBunBinary } from "./lib/bun-acquire.ts";
import { bunBinaryName, hostTargetName, isHostTarget, parseTargetName, type TargetSpec } from "./lib/targets.ts";
import { freezeTree, rmTree } from "./lib/fs.ts";

const PI_AGENT_DIR = resolve(import.meta.dir, "..", "..", "..", "s2-agent");
const BUN_APPS_DIR = dirname(PI_AGENT_DIR);
const REPO_ROOT = dirname(BUN_APPS_DIR);
const REGISTRY_MODULE = join(PI_AGENT_DIR, "src", "registry-config.ts");

export interface DeployShOptions {
	outRoot?: string;
	version?: string;
	freeze?: boolean;
	current?: boolean;
	force?: boolean;
	/**
	 * Cross-OS target (crossos-deploy t05, D6): `<platform>-<arch>` the tree
	 * is FOR. Default: the host. Routes version dirs + `current` under
	 * `<outRoot>/<target>/` (caches stay shared); non-host targets acquire
	 * their bun from a GitHub release (D7) and skip the boot gates (t06).
	 */
	target?: string;
}

export interface DeployShResult {
	version: string;
	target: string;
	/** The cross-OS target name this tree was packed for (D6; host name by default). */
	targetName: string;
	extensions: Array<{ name: string; bytes: number }>;
	coreBytes: number;
	/** True when the core came from <outRoot>/.cores without a recompile. */
	coreCached: boolean;
	currentUpdated: boolean;
	/** Version dirs removed by retention, oldest first. */
	pruned: string[];
	/** Cache entries in .cores/ collected because no version dir links them any more. */
	prunedCores: PrunedCore[];
	/** The shipped runtime this deploy linked (bin/bun). */
	runtime: { bunVersion: string; platform: string; arch: string; bytes: number; cached: boolean };
	/** Cache entries in .buns/ collected because no version dir links them any more. */
	prunedBuns: PrunedBun[];
}

function gitShortSha(): string | null {
	const p = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) return null;
	return p.stdout.toString().trim() || null;
}

export function resolvePiPkgDir(): string {
	const url = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
	// fileURLToPath, NOT url.pathname: on win32 the pathname keeps a posix
	// `/C:/…` spelling that later path.win32 joins turn into `\C:\…` —
	// unopenable (measured: crossos-deploy-verify windows row, run 33075359667).
	return dirname(fileURLToPath(url));
}

/** The config and the core must agree on the host contract, or every extension silently refuses to load. */
async function assertHostContract(cfg: ShConfig): Promise<void> {
	const { HOST_API, HOST_MODULE_IDS } = await import("../../../s2-agent/src/sh/host-modules.ts");
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
 * Produce the version dir's `s2-agent.js` core — a bun-run ESM bundle, NOT a
 * compiled binary (2026-08-23, deploy-platform-neutral-core ticket 01).
 *
 * The bundle carries no embedded assets at all: pi's theme/assets/
 * export-html dirs ship as plain copies at their Node layout inside the
 * version dir (stagePiAssets below), where bundled pi resolves them by
 * walking up from the bundle to the deploy package.json — no
 * `with { type: "file" }` imports, no hashed sidecars, and no
 * ~/.pi/agent/embedded-assets extraction (that mechanism was deleted with
 * the compiled core, ticket 03).
 *
 * Frozen deploys go through the content-addressed cache: hash the build
 * inputs (the src/ tree, the resolved pi-coding-agent version, Bun.version,
 * entry, flags), reuse <outRoot>/.cores/<hash> on hit, bundle-and-cache on
 * miss, and HARDLINK the entry into the version dir. A no-freeze deploy
 * bypasses the cache entirely (hardlinks share an inode; a writable cached
 * core would re-mode every frozen version sharing it) and builds a plain
 * private copy.
 */
async function buildCore(
	outFile: string,
	opts: { outRoot: string; freeze: boolean },
): Promise<{ bytes: number; cached: boolean }> {
	const piPkgDir = resolvePiPkgDir();

	const bundle = async (target: string): Promise<number> => {
		const entry = join(PI_AGENT_DIR, "src", "cli-sh.ts");
		// bun's build report is human progress. deploy-cli promises stdout is
		// PURE JSON, and "inherit" here put the child's report on the same stdout
		// as the final JSON payload — so pipe it and re-emit on stderr.
		const p = Bun.spawn(["bun", "build", entry, `--outfile=${target}`, "--target=bun", "--minify"], {
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
		if (code !== 0) throw new Error("bun build --target=bun failed for src/cli-sh.ts");
		return Bun.file(target).size;
	};

	if (opts.freeze) {
		const piPkgVersion = (JSON.parse(readFileSync(join(piPkgDir, "package.json"), "utf8")) as { version: string })
			.version;
		const hash = computeCoreHash({
			piAgentDir: PI_AGENT_DIR,
			piPkgVersion,
			bunVersion: Bun.version,
			entry: "src/cli-sh.ts",
			flags: ["--target=bun", "--minify"],
		});
		const core = await ensureCachedCore({
			outRoot: opts.outRoot,
			hash,
			build: async (target) => {
				await bundle(target);
			},
		});
		linkCore(core.cacheFile, outFile);
		return { bytes: core.bytes, cached: core.cached };
	}
	const bytes = await bundle(outFile);
	return { bytes, cached: false };
}

/**
 * Copy pi's shipped asset dirs into the version dir at their NODE layout
 * (`dist/modes/interactive/{theme,assets}`, `dist/core/export-html`).
 * Probe-verified (2026-08-23, effort map Context): bundled pi resolves
 * getPackageDir() by walking up from the bundle to the deploy package.json,
 * then reads these exact relpaths — zero env redirects, nothing written
 * under ~/.pi. Plain copies, so Gates 5a/5c/5d and Gate 6 relocation cover
 * them like every other tree file.
 */
function stagePiAssets(stageDir: string): void {
	const piPkgDir = resolvePiPkgDir();
	for (const rel of ["dist/modes/interactive/theme", "dist/modes/interactive/assets", "dist/core/export-html"]) {
		const src = join(piPkgDir, rel);
		if (!existsSync(src)) throw new Error(`pi asset dir not found: ${src}`);
		cpSync(src, join(stageDir, rel), { recursive: true });
	}
}

/**
 * The binary's agent-dir env var, derived EXACTLY like upstream config.js:
 * `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`. For "s2-agent" the name
 * contains a DASH — legal in env maps and via `env(1)` at exec time, illegal
 * as a bash `export` target (why the launcher passes it with `env`, not
 * `export`).
 */
const AGENT_DIR_ENV = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

/**
 * The launcher, as `s2-agent.sh`: execs the SHIPPED bun (./bin/bun, the
 * deploy's own copy — S2_AGENT_BUN still overrides, which is also the
 * documented cross-platform swap) on the core bundle. The old run.sh shim
 * was dropped 2026-08-23 (ticket 05) after its deprecation grace period.
 */
const S2_AGENT_SH = `#!/usr/bin/env bash
# s2-agent.sh — launcher for a s2-agent-sh deploy.
#
# The core beside this script is a bun-run ESM bundle (s2-agent.js) executed
# by the deploy's OWN bun at ./bin/bun — same version that built it, so the
# tree is self-contained (Gate 5) with no bun on PATH. Children spawned
# inside the session inherit that same bun too: the resolved bun's dir is
# prepended to PATH below, so shells and "bun ..." subprocesses resolve it,
# never a system bun. PLATFORM CONTRACT: the
# bundle is platform-neutral; bin/bun is this platform's. To relocate the
# deploy to another OS/arch, replace bin/bun with that platform's bun of the
# SAME Bun.version (or point S2_AGENT_BUN at one) — nothing else changes.
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
# The binary derives its agent-dir env var from piConfig.name — for this
# deploy that is ${AGENT_DIR_ENV} (the DASH is real: upstream builds
# \`\${APP_NAME.toUpperCase()}_CODING_AGENT_DIR\`). Plain PI_CODING_AGENT_DIR is
# IGNORED by the binary, so exporting it (as this script did before 2026-08-22)
# was inert: the per-user default held only by ~/.pi/agent coincidence. bash
# cannot \`export\` a dashed name — \`env\` at exec time can. PI_CODING_AGENT_DIR
# stays as the operator-facing input for backwards compatibility.
_agent_dir="\${PI_CODING_AGENT_DIR:-\$HOME/.pi/agent}"

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

# Self-containment for CHILDREN: the exec below runs the deploy's own bun
# directly, but anything the session spawns later (agent shells, tools that
# Bun.spawn(["bun", ...]), self-heal installs) resolves "bun" via PATH —
# prepend the resolved bun's dir so they get the SAME bun, not a system one.
_bun="\${S2_AGENT_BUN:-\$SCRIPT_DIR/bin/bun}"
export PATH="\$(cd "\$(dirname "\$_bun")" && pwd):\$PATH"

exec env "${AGENT_DIR_ENV}=\$_agent_dir" "\$_bun" "\$SCRIPT_DIR/${APP_NAME}.js" "\$@"
`;

/**
 * The Windows launcher, as `s2-agent.ps1` (crossos-deploy ticket 04): the
 * PowerShell twin of S2_AGENT_SH — SAME contract, native spellings. The
 * dashed agent-dir env var that forced `env(1)` in bash is native here
 * ([Environment]::SetEnvironmentVariable accepts any name); PATH prepends
 * with `;` on Windows; the Chrome probe walks the Windows install paths
 * (Edge ships with every Win10+). Execution-policy friction is absorbed by
 * the .cmd shim below, which launches this file with -ExecutionPolicy
 * Bypass — the .ps1 itself needs no policy change. PLATFORM CONTRACT is
 * identical to the .sh: the core bundle is platform-neutral, bin/bun.exe
 * is this platform's; S2_AGENT_BUN still overrides (swap escape hatch).
 * Measured friction on a real Windows box: DEFERRED (ticket 04 records the
 * blocker — no Windows host in this effort yet; CI has no windows runner
 * precedent as of 2026-08-27).
 */
const S2_AGENT_PS1 = `# s2-agent.ps1 - launcher for a s2-agent-sh deploy (Windows).
# PowerShell twin of s2-agent.sh: same contract - exec the SHIPPED bun
# (./bin/bun.exe) on the platform-neutral core bundle, prepend the resolved
# bun's dir to PATH so session-spawned children resolve the SAME bun, set
# the dashed agent-dir env var natively, and probe system Chrome/Edge for
# the (optional, hyperframes) puppeteer channel. No browser is bundled -
# no candidate found -> the var stays unset -> puppeteer fails with its
# own clear launch error.
# ASCII-only by design: powershell.exe 5.1 reads a BOM-less .ps1 as ANSI,
# so non-ASCII comment characters would mojibake (harmless in a comment,
# but pointless risk).
$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot
$_pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")

# Per-user state mirrors the .sh: the operator-facing input stays
# PI_CODING_AGENT_DIR; the binary's own dashed var (derived from
# piConfig.name, hyphens legal in env names but not as a bash export -
# native in PowerShell) is set per-process.
$_agent_dir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME ".pi\\agent" }
[Environment]::SetEnvironmentVariable("${AGENT_DIR_ENV}", $_agent_dir, "Process")

# The deploy tree is read-only; keep every per-user write under ~\\.pi\\agent.
if ($null -eq $env:JITI_FS_CACHE) { $env:JITI_FS_CACHE = "0" }

if (-not $env:PUPPETEER_EXECUTABLE_PATH) {
  # ProgramFiles(x86) is null on 32-bit Windows - Join-Path $null throws,
  # so each 32-bit-path candidate is guarded and yields $null instead.
  foreach ($_chrome in @(
    (Join-Path $env:LOCALAPPDATA "Google\\Chrome\\Application\\chrome.exe"),
    (Join-Path $env:ProgramFiles   "Google\\Chrome\\Application\\chrome.exe"),
    $(if ($_pf86) { Join-Path $_pf86 "Google\\Chrome\\Application\\chrome.exe" }),
    (Join-Path $env:ProgramFiles   "Microsoft\\Edge\\Application\\msedge.exe"),
    $(if ($_pf86) { Join-Path $_pf86 "Microsoft\\Edge\\Application\\msedge.exe" })
  )) {
    if ($_chrome -and (Test-Path $_chrome)) { $env:PUPPETEER_EXECUTABLE_PATH = $_chrome; break }
  }
}

# Self-containment for CHILDREN: anything the session spawns later (agent
# shells, tools that spawn "bun ...") resolves bun via PATH - prepend the
# resolved bun's dir so they get the SAME bun, not a system one.
$_bun = if ($env:S2_AGENT_BUN) { $env:S2_AGENT_BUN } else { Join-Path $dir "bin\\bun.exe" }
if (-not (Test-Path $_bun)) { $_bun = Join-Path $dir "bin\\bun" } # pre-bun.exe tree shape
$env:PATH = (Split-Path -Parent $_bun) + ";" + $env:PATH

& $_bun (Join-Path $dir "${APP_NAME}.js") @args
exit $LASTEXITCODE
`;

/**
 * The cmd.exe / double-click entry shim, as `s2-agent.cmd`: delegates to
 * the .ps1 through powershell.exe with -ExecutionPolicy Bypass, so the
 * Windows default (Restricted) policy cannot block the deploy's own
 * launcher and no one-time policy change is asked of the user. `%~dp0` is
 * the shim's own dir (the version dir), trailing backslash included.
 */
const S2_AGENT_CMD = `@echo off
rem s2-agent.cmd - entry shim for cmd.exe / double-click users; delegates
rem to s2-agent.ps1 with -ExecutionPolicy Bypass so the default Windows
rem execution policy (Restricted) cannot block the deploy's own launcher.
rem ASCII-only, like the .ps1 (ANSI-read on BOM-less files).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${APP_NAME}.ps1" %*
exit /b %ERRORLEVEL%
`;



interface ExtListPayload {
	loadedCount: number;
	loaded: string[];
	skipped: Array<{ name: string; reason: string }>;
}

/**
 * Run the core's --ext-list diagnostic and return the parsed payload. The
 * gates boot the tree the way the launcher does (ticket 03): the tree's OWN
 * shipped runtime, `<tree>/bin/bun`, executes `<tree>/s2-agent.js` — never
 * the deploy CLI's bun — so a gate pass is a statement about the artifact
 * that ships, not about the machine that built it.
 */
function extListOf(tree: string): ExtListPayload {
	// bunBinaryName: a win32 tree ships bin/bun.exe (crossos t06 review) —
	// gates only ever boot a HOST tree (3/6 skip non-host), so the runtime
	// name follows THIS machine's platform.
	const p = Bun.spawnSync([join(tree, "bin", bunBinaryName({ platform: process.platform, arch: process.arch })), join(tree, CORE_FILENAME), "--ext-list"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) {
		throw new Error(`--ext-list exited ${p.exitCode}: ${p.stderr.toString()}`);
	}
	return JSON.parse(p.stdout.toString()) as ExtListPayload;
}

/** The version dir's core artifact: a bun-run ESM bundle, not a Mach-O. */
const CORE_FILENAME = `${APP_NAME}.js`;

/** Gate 3: extensions load; with ext/ moved aside the core still exits 0 with none. */
function verifyDualState(stageDir: string, expected: string[]): void {
	const withExt = extListOf(stageDir);
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
		const without = extListOf(stageDir);
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
	opts: { binaries?: Array<{ label: string; path: string }>; finalTarget?: string } = {},
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

	const assetsMissing = verifyAssetCompleteness(tree);
	if (assetsMissing.length > 0) {
		problems.push(
			`declared deploy asset(s) not shipped: ${assetsMissing.map((m) => `${m.ext}:${m.to}`).join(", ")}`,
		);
	}

	if (opts.binaries && opts.finalTarget) {
		for (const artifact of opts.binaries) {
			const r = scanBinaryForeignPaths(artifact.path, opts.finalTarget);
			for (const allowed of r.allowed) {
				process.stderr.write(`gate5: allowlisted ${artifact.label} artifact: ${allowed}\n`);
			}
			if (r.foreign.length > 0) {
				problems.push(
					`${artifact.label} bakes build-machine path(s): ${r.foreign.slice(0, 5).join(", ")}${r.foreign.length > 5 ? ` (+${r.foreign.length - 5} more)` : ""}`,
				);
			}
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
 * drops extensions from the new location. The copied `bin/bun` relocates
 * trivially (it resolves no paths relative to its own location), so what this
 * gate really proves is the BUNDLE + pi assets resolving from the new path.
 * `cp -c` (APFS clone) keeps the copy ~free; cpSync is the portable fallback.
 */
function verifyRelocatable(stageDir: string, outRoot: string, expected: string[]): void {
	const relocRoot = mkdtempSync(join(outRoot, ".reloc-"));
	const copy = join(relocRoot, "tree");
	// `cp -cR` is the darwin fast path (APFS clone, ~free). It THROWS (not
	// exits non-zero) when the executable is missing — windows-latest has no
	// cp on PATH, GNU cp has no -c — so the try/catch is the real fallback
	// selector and cpSync is the portable truth (crossos t06 review).
	try {
		const clone = Bun.spawnSync(["cp", "-cR", stageDir, copy], { stdout: "pipe", stderr: "pipe" });
		if (clone.exitCode !== 0) cpSync(stageDir, copy, { recursive: true });
	} catch {
		cpSync(stageDir, copy, { recursive: true });
	}
	try {
		const there = extListOf(copy);
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

/**
 * Time a gate and record it for the deploy report. A failing gate still gets
 * its record (status "fail") before the throw propagates — in practice the
 * report is then never written because the deploy aborts, but the recorder
 * keeps pass/fail honest for any future use that renders earlier.
 */
function recordGate(
	gates: GateRecord[],
	id: string,
	title: string,
	scope: "per-ext" | "deploy",
	run: () => void,
): void {
	const t0 = performance.now();
	try {
		run();
		gates.push({ id, title, scope, status: "pass", ms: performance.now() - t0 });
	} catch (e) {
		gates.push({ id, title, scope, status: "fail", ms: performance.now() - t0 });
		throw e;
	}
}

/**
 * Record a deliberately-not-run gate (crossos t05): non-host targets skip the
 * boot gates with the t06 deferral note. One spelling for every skip site.
 */
function skipGate(gates: GateRecord[], id: string, title: string, targetName: string): void {
	gates.push({
		id,
		title,
		scope: "deploy",
		status: "skip",
		note: `crossos t05: non-host target ${targetName} — boot gates deferred to t06's verification channel`,
	});
}

export async function runShDeploy(opts: DeployShOptions = {}): Promise<DeployShResult> {
	// The registry is CODE now (registry-code-as-config t03): no config file
	// to read or override — shConfig() validates the typed REGISTRY and
	// projects the deploy set. The retired --config flag is gone with it.
	const cfg = shConfig({ bunAppsDir: BUN_APPS_DIR });
	await assertHostContract(cfg);

	const outRoot = opts.outRoot ? resolve(opts.outRoot) : cfg.outRoot;
	// Cross-OS target topology (crossos-deploy t05, D6): cacheRoot owns the
	// shared content-addressed caches (.cores/.buns — platform-neutral core
	// hash, platform-folded bun hash); targetRoot owns this target's version
	// dirs + `current`. swapCurrent/listVersions/pruneVersions/staging all
	// treat targetRoot as their outRoot, unchanged — the isolation falls out
	// of the directory shape rather than new code.
	const targetName = opts.target ?? hostTargetName();
	const targetSpec = parseTargetName(targetName);
	const hostTree = isHostTarget(targetSpec);
	const cacheRoot = outRoot;
	const targetRoot = join(outRoot, targetName);
	const pkgVersion = (JSON.parse(readFileSync(join(PI_AGENT_DIR, "package.json"), "utf8")) as { version: string })
		.version;
	const sha = gitShortSha();
	const version = opts.version ?? computeVersion({ pkgVersion, gitSha: sha, useGitSha: cfg.version.gitSha });
	const target = resolveTargetDir(targetRoot, version);
	const freeze = opts.freeze ?? cfg.freeze;
	const wantCurrent = opts.current ?? cfg.current;
	const builtAt = new Date().toISOString();
	const sourceSha = sha ?? "unknown";
	// crossos-deploy D5 (ticket 08): per-platform ext filtering. `enabled` is
	// the per-TREE set — portable entries plus entries whose registry
	// `platforms` lists this target; a platform-dropped entry never enters
	// the build loop NOR the tree's deploy.json config below, so Gate 3 and
	// the post-deploy E2E compare per-tree expected counts, not registry
	// totals. (Measured 2026-08-27: no shipped entry carries `platforms` yet —
	// every darwin-by-nature ext is already deploy-excluded — so today this
	// filter is the identity; it is the seam for the first platform-bound
	// SHIPPING ext.)
	const { shipped: enabled, dropped: platformDropped } = filterForTarget(cfg.extensions, targetSpec.platform);

	ensureOutRoot(targetRoot);

	// ── deploy (version dirs are immutable — the in-place ext rebuild is gone) ─
	if (existsSync(target) && !opts.force) {
		throw new DeployVersionExistsError(version, target);
	}
	const stage = join(targetRoot, `.staging-${version}`);
	rmTree(stage);
	mkdirSync(join(stage, "ext"), { recursive: true });

	const built: Array<{ name: string; bytes: number }> = [];
	// Gate rows for the report. Gates 1/1b/2/4 fire per extension inside
	// buildExtPackage (via onGate) and are accumulated across the loop; 3/5/6
	// are whole-deploy and recorded inline below.
	const gates: GateRecord[] = [];
	const EXT_GATE_TITLES: Record<string, string> = {
		"1": "scanForeignSpecifiers",
		"1b": "scanUnroutableDynamicImports",
		"2": "loadProbe",
		"4": "scanForeignPaths",
	};
	const extGateTotals = new Map<string, { ms: number; count: number }>();
	const onGate = (id: string, ms: number) => {
		const t = extGateTotals.get(id) ?? { ms: 0, count: 0 };
		t.ms += ms;
		t.count += 1;
		extGateTotals.set(id, t);
	};
	try {
		const { bytes: coreBytes, cached: coreCached } = await buildCore(join(stage, CORE_FILENAME), { outRoot: cacheRoot, freeze });
		stagePiAssets(stage);
		// The shipped runtime (ticket 02): the bundle is neutral, bin/bun is
		// the TARGET's — content-cached under the shared .buns, hardlinked per
		// version. Host target: lift it from process.execPath. Non-host target
		// (D7): fetch the same-Bun.version binary from the GitHub release
		// (SHASUMS256-verified) into the same content-addressed cache.
		const bun = hostTree
			? ensureCachedBun({ outRoot: cacheRoot })
			: await acquireBunBinary({
					outRoot: cacheRoot,
					bunVersion: Bun.version,
					spec: targetSpec,
					releaseBase: process.env.S2_AGENT_BUN_RELEASE_BASE,
				});
		const binBasename = bunBinaryName(targetSpec);
		mkdirSync(join(stage, "bin"), { recursive: true });
		linkBun(bun.cacheFile, join(stage, "bin", binBasename));

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
				onGate,
				// Cross-OS vendoring (t05): the closure filters native packages
				// for the TARGET (os/cpu/libc match, vendor-closure.ts), not the
				// build host. A HOST deploy passes libc undefined so the
				// closure's own detectLibc() stays authoritative (a musl host
				// must not be forced to glibc filtering); a cross target's
				// spec carries the flavor (bare linux implies glibc, D4).
				// Build-side only — the ext gates below still run the bundle
				// on the host bun, which is exactly what they prove.
				vendorPlatform: targetSpec.platform,
				vendorArch: targetSpec.arch,
				vendorLibc: hostTree ? undefined : targetSpec.libc,
			});
			built.push({ name: r.name, bytes: r.bytes });
		}
		for (const [id, title] of Object.entries(EXT_GATE_TITLES)) {
			const t = extGateTotals.get(id);
			gates.push({
				id,
				title,
				scope: "per-ext",
				status: "pass",
				ms: t?.ms,
				note: t ? `verified for ${t.count} extension(s)` : "no extensions built",
			});
		}

		writeFileSync(join(stage, `${APP_NAME}.sh`), S2_AGENT_SH);
		chmodSync(join(stage, `${APP_NAME}.sh`), 0o755);
		// Windows launchers (crossos-deploy ticket 04): text artifacts, shipped
		// in EVERY tree — a darwin/linux tree carrying them is inert weight,
		// and it keeps the run.ts:236-238 swap escape hatch usable in both
		// directions. No chmod equivalent: the .ps1 is exec'd via the .cmd
		// shim's -ExecutionPolicy Bypass, never by a POSIX exec.
		writeFileSync(join(stage, `${APP_NAME}.ps1`), S2_AGENT_PS1);
		writeFileSync(join(stage, `${APP_NAME}.cmd`), S2_AGENT_CMD);
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
			`${JSON.stringify(
				{
					version,
					builtAt,
					sourceSha,
					bunVersion: Bun.version,
					coreKind: "bun-bundle",
					// The TARGET the tree is packed for (D6) — platform/arch name
					// the bun binary shipped in bin/, NOT the machine that built
					// the tree. Acquisition provenance for a non-host runtime is
					// the GitHub release channel (D7).
					target: targetName,
					runtime: {
						bunVersion: Bun.version,
						platform: targetSpec.platform,
						arch: targetSpec.arch,
						bytes: bun.bytes,
						cached: bun.cached,
					},
					registryModule: REGISTRY_MODULE,
					// The PER-TREE extension set (D5 filter applied) — the list
					// Gate 3 / verify-deploy-e2e compare --ext-list against.
					config: { ...cfg, extensions: enabled },
					platformDropped: platformDropped.length > 0 ? platformDropped : undefined,
				},
				null,
				2,
			)}\n`,
		);

		// Gates 3 and 6 BOOT the tree with its own bin/bun — a non-host
		// target's bun cannot execute on this build host, so both are recorded
		// as skipped with the reason (cross-OS boot verification is ticket
		// 06's channel: CI windows/linux runner or a real box). Skipping here
		// is a topology statement, not a gate weakening: the host-target
		// deploy of the SAME core+exts runs them, and the artifacts are
		// byte-shared through the caches.
		if (hostTree) {
			recordGate(gates, "3", "verifyDualState", "deploy", () =>
				verifyDualState(
					stage,
					enabled.map((e) => e.name),
				));
		} else {
			skipGate(gates, "3", "verifyDualState", targetName);
		}

		// Gate 5 — BEFORE the rename/freeze/current swap, so a violation never
		// becomes the deployed version. The artifact scans key off the FINAL
		// version path: a baked `.staging-…` path is itself a violation (it
		// sits under $HOME and would break relocatability). 5b scans BOTH the
		// core bundle (plain text — foreign paths fully readable) and the
		// shipped bin/bun (a binary we did not build; see offline-gate.ts's
		// allowlist table for the only accepted strings).
		recordGate(gates, "5", "verifyOfflineContainment (5a symlinks · 5b core+runtime paths · 5c completeness · 5d closure)", "deploy", () =>
			verifyOfflineContainment(stage, {
				binaries: [
					{ label: "core bundle", path: join(stage, CORE_FILENAME) },
					{ label: "shipped bun", path: join(stage, "bin", binBasename) },
				],
				finalTarget: target,
			}));

		// Gate 6 — behavioural relocatability: boot a clone of the staged tree
		// from a different absolute path. Host target only (see Gate 3's note).
		if (hostTree) {
			recordGate(gates, "6", "verifyRelocatable", "deploy", () =>
				verifyRelocatable(
					stage,
					targetRoot,
					enabled.map((e) => e.name),
				));
		} else {
			skipGate(gates, "6", "verifyRelocatable", targetName);
		}

		// ── deploy-report.html + deploy-report.yaml — after the gates, before
		// the rename/freeze ──
		// The report freezes the gate matrix, the included/excluded table, the
		// vendored-closure stats and the baked provider catalog WITH the
		// version it describes; freezeTree then makes it immutable like the
		// rest of the tree. Closure facts come from the ext.json manifests the
		// builder just wrote — the same source Gate 5d verified against.
		// The YAML twin is the same DeployReportData serialized for machines
		// (deploy diffing, tooling over the gate matrix) — written together,
		// frozen together, never allowed to drift from the HTML.
		const extensionsReport: ReportExtension[] = built.map((b) => {
			const cfgExt = enabled.find((e) => e.name === b.name)!;
			const manifest = JSON.parse(readFileSync(join(stage, "ext", b.name, "ext.json"), "utf8")) as {
				vendoredClosure?: { count: number; pruned: string[]; excluded: string[] };
			};
			return {
				name: cfgExt.name,
				package: cfgExt.package,
				order: cfgExt.order,
				bytes: b.bytes,
				skills: cfgExt.skills,
				copy: cfgExt.copy,
				vendor: cfgExt.vendor,
				assets: cfgExt.assets,
				externals: cfgExt.externals,
				vendorExclude: cfgExt.vendorExclude,
				closure: manifest.vendoredClosure ?? { count: 0, pruned: [], excluded: [] },
			};
		});
		const reportData = {
			version,
			builtAt,
			sourceSha,
			bunVersion: Bun.version,
			registryModule: REGISTRY_MODULE,
			outRoot: targetRoot,
			target,
			freeze,
			current: wantCurrent,
			core: { bytes: coreBytes, cached: coreCached },
			runtime: { bunVersion: Bun.version, platform: targetSpec.platform, arch: targetSpec.arch, bytes: bun.bytes, cached: bun.cached },
			gates,
			extensions: extensionsReport,
			// Registry-never-ships rows PLUS this-tree platform drops (D5) —
			// both are "why is it not in this tree" answers.
			excluded: [
				...excludedExtensionsFromRegistry({ bunAppsDir: BUN_APPS_DIR }),
				...platformDropped.map((d) => ({
					name: d.name,
					package: d.package,
					reason: `platform filter (D5): entry platforms [${d.platforms.join(", ")}] exclude this tree's target ${targetSpec.platform}`,
				})),
			],
			providers: collectModelFacts(),
		};
		writeDeployReport(stage, reportData);
		writeDeployReportYaml(stage, reportData);

		if (existsSync(target)) rmTree(target);
		renameSync(stage, target);
		if (freeze) freezeTree(target);
		let currentUpdated = false;
		if (wantCurrent) {
			swapCurrent(targetRoot, version);
			currentUpdated = true;
		}
		const pruned = pruneVersions(targetRoot, { keep: cfg.keep ?? DEFAULT_KEEP });
		// crossos t05: retention must not stop at the subroot — a pre-t05
		// outRoot's flat version dirs would otherwise survive forever against
		// keep:N (the exact unbounded-disk class Phase 3 fixed). Prune the
		// legacy flat layer with target subroots EXCLUDED; a legacy top-level
		// `current` still protects its version via the same rule as ever.
		pruneVersions(cacheRoot, { keep: cfg.keep ?? DEFAULT_KEEP, excludeTargets: true });
		// Strictly after pruneVersions: dropping a version dir is what turns its
		// core into an orphan, and the core just linked above is protected by its
		// own link count either way. Cache pruning runs on the SHARED root —
		// orphan collection is cross-target (an entry lives while ANY target's
		// version links it).
		const prunedCores = pruneOrphanCores(cacheRoot);
		// Same rule for the shipped runtimes: a version dir dropping is what
		// orphans a .buns entry.
		const prunedBuns = pruneOrphanBuns(cacheRoot);
		// The outRoot index lists what retention left behind — strictly after
		// pruneVersions, so it never links a pruned version's report.
		writeOutRootIndex(targetRoot);
		return {
			version,
			target,
			targetName,
			extensions: built,
			coreBytes,
			coreCached,
			currentUpdated,
			pruned,
			prunedCores,
			runtime: { bunVersion: Bun.version, platform: targetSpec.platform, arch: targetSpec.arch, bytes: bun.bytes, cached: bun.cached },
			prunedBuns,
		};
	} catch (e) {
		rmTree(stage); // never leave a half-written deploy behind
		throw e;
	}
}
