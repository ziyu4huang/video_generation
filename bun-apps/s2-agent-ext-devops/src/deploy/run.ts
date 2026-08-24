/**
 * deploy.ts — orchestrator for the s2-agent-sh deploy.
 *
 * Produces <outRoot>/<version>/ containing:
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
import { APP_NAME } from "./lib/app-name.ts";
import { excludedExtensions, parseShConfig, type ShConfig } from "./lib/config.ts";
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
import { freezeTree, rmTree } from "./lib/fs.ts";

const PI_AGENT_DIR = resolve(import.meta.dir, "..", "..", "..", "s2-agent");
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

function resolvePiPkgDir(): string {
	const url = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
	return dirname(new URL(url).pathname);
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
	const p = Bun.spawnSync([join(tree, "bin", "bun"), join(tree, CORE_FILENAME), "--ext-list"], {
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
	const clone = Bun.spawnSync(["cp", "-cR", stageDir, copy], { stdout: "pipe", stderr: "pipe" });
	if (clone.exitCode !== 0) cpSync(stageDir, copy, { recursive: true });
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

export async function runShDeploy(opts: DeployShOptions = {}): Promise<DeployShResult> {
	const configPath = opts.configPath ? resolve(opts.configPath) : DEFAULT_CONFIG;
	if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
	const configText = readFileSync(configPath, "utf8");
	const cfg = parseShConfig(configText, { bunAppsDir: BUN_APPS_DIR });
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
		const { bytes: coreBytes, cached: coreCached } = await buildCore(join(stage, CORE_FILENAME), { outRoot, freeze });
		stagePiAssets(stage);
		// The shipped runtime (ticket 02): the bundle is neutral, bin/bun is
		// this platform's — content-cached under .buns, hardlinked per version.
		const bun = ensureCachedBun({ outRoot });
		mkdirSync(join(stage, "bin"), { recursive: true });
		linkBun(bun.cacheFile, join(stage, "bin", "bun"));

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
					runtime: {
						bunVersion: Bun.version,
						platform: process.platform,
						arch: process.arch,
						bytes: bun.bytes,
						cached: bun.cached,
					},
					configPath,
					config: cfg,
				},
				null,
				2,
			)}\n`,
		);

		recordGate(gates, "3", "verifyDualState", "deploy", () =>
			verifyDualState(
				stage,
				enabled.map((e) => e.name),
			));

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
					{ label: "shipped bun", path: join(stage, "bin", "bun") },
				],
				finalTarget: target,
			}));

		// Gate 6 — behavioural relocatability: boot a clone of the staged tree
		// from a different absolute path.
		recordGate(gates, "6", "verifyRelocatable", "deploy", () =>
			verifyRelocatable(
				stage,
				outRoot,
				enabled.map((e) => e.name),
			));

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
			configPath,
			outRoot,
			target,
			freeze,
			current: wantCurrent,
			core: { bytes: coreBytes, cached: coreCached },
			runtime: { bunVersion: Bun.version, platform: process.platform, arch: process.arch, bytes: bun.bytes, cached: bun.cached },
			gates,
			extensions: extensionsReport,
			excluded: excludedExtensions(configText, { bunAppsDir: BUN_APPS_DIR }),
			providers: collectModelFacts(),
		};
		writeDeployReport(stage, reportData);
		writeDeployReportYaml(stage, reportData);

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
		// Same rule for the shipped runtimes: a version dir dropping is what
		// orphans a .buns entry.
		const prunedBuns = pruneOrphanBuns(outRoot);
		// The outRoot index lists what retention left behind — strictly after
		// pruneVersions, so it never links a pruned version's report.
		writeOutRootIndex(outRoot);
		return {
			version,
			target,
			extensions: built,
			coreBytes,
			coreCached,
			currentUpdated,
			pruned,
			prunedCores,
			runtime: { bunVersion: Bun.version, platform: process.platform, arch: process.arch, bytes: bun.bytes, cached: bun.cached },
			prunedBuns,
		};
	} catch (e) {
		rmTree(stage); // never leave a half-written deploy behind
		throw e;
	}
}
