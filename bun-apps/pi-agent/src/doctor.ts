/**
 * `doctor` — pi-agent self-check.
 *
 * Runs offline (no model call, no network). Answers: which deploy mode am I,
 * is the entry present, are the extension bundles / packages complete, can the
 * host resolve the deps pi's loader needs (typebox/@earendil-works/*), are the
 * configured providers' API keys available, and which patches would apply. A
 * fresh-machine or broken-deploy failure usually surfaces as an opaque error
 * deep in a run; doctor checks the boundary conditions up front and prints an
 * actionable checklist.
 *
 * Design (mirrors bun-apps/pi-agent/src/cli/commands/doctor.ts): each check is
 * a PURE function over an injectable `DoctorContext`, so the classification is
 * unit-testable without spawning or touching the real fs. `run()` wires real
 * process state. Invoke via `bun src/cli.ts doctor [--json]` or `./run.sh doctor`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import manifest from "../run-dir/manifest.json";
import { PATCH_TABLE, resolvePatchPlan } from "./patches/index.ts";
import { PROVIDERS, resolveApiKey, type ApiKey } from "./pre-load-providers.ts";
import { detectMode } from "./mode.ts";
import { HOST_API, HOST_MODULE_IDS } from "./sh/host-modules.ts";
import { parseExtManifest } from "./sh/ext-manifest.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface CheckResult {
	id: string;
	label: string;
	status: CheckStatus;
	detail?: string;
	hint?: string;
}

/** A `fail` fails the aggregate; `warn`/`info` never do. */
export function isFailing(r: CheckResult): boolean {
	return r.status === "fail";
}

/**
 * The deploy mode doctor detects.
 *
 * `portable` and `release` used to be here. Nothing could ever return them:
 * deploy.ts accepts only --bundle/--snapshot/--standalone/--exe and writes only
 * `.deploy-bundle`; no code path writes `.deploy-portable` or a `packages/` dir.
 * They were left behind by a rename the docs and deploy.ts completed and
 * doctor.ts did not, and they took real behaviour down with them — see
 * checkHostDeps.
 */
export type DeployMode = "source" | "bundle" | "binary" | "sh";

/**
 * Classify the deploy mode from coarse mode + the layout markers. Pure.
 *
 * `.deploy-bundle` is currently the only marker any deploy writes, so the
 * marker argument exists for the next sub-classification rather than for a
 * live branch. A `--snapshot` deploy ships raw source and correctly reports
 * `source`; a `--standalone` deploy is a bundle plus a bun binary and reports
 * `bundle`.
 */
export interface LayoutMarkers {
	dotDeployBundle: boolean;
	/**
	 * A pi-agent-sh deploy: `deploy.json` beside the executable. `ext/` alone is
	 * not the marker — deleting it is a SUPPORTED state (the core boots with no
	 * extensions), and a deploy that lost its extensions must still be
	 * recognisable as an sh deploy or doctor reports the wrong mode exactly when
	 * something is wrong.
	 */
	shDeploy: boolean;
}

export function classifyMode(coarse: "source" | "bundle" | "binary", markers: LayoutMarkers): DeployMode {
	if (coarse === "binary") return markers.shDeploy ? "sh" : "binary";
	if (coarse === "source") return "source";
	// bundle coarse mode = a shipped pi-agent.js
	if (markers.dotDeployBundle) return "bundle";
	return "bundle"; // a pi-agent.js with no marker — treat as plain bundle
}

/** Injectable environment so checks are pure and unit-testable. */
export interface DoctorContext {
	mode: DeployMode;
	selfDir: string;
	/**
	 * The directory the DEPLOY lives in. Same as selfDir everywhere except a
	 * compiled binary, where selfDir points inside bun's virtual fs ($bunfs) and
	 * only process.execPath's dir names anything on the real filesystem — which
	 * is where an sh deploy keeps ext/ and deploy.json.
	 */
	deployDir: string;
	entryPath: string;
	bunVersion: string;
	exists: (p: string) => boolean;
	/** Is a dep present under <selfDir>/node_modules? (dir existence — NOT
	 * require.resolve, which false-negatives on packages with an exports map.) */
	depInstalled: (spec: string) => boolean;
	/** List a dir (returns [] if absent). */
	listDir: (p: string) => string[];
	/** Read a file as utf8. Throws if absent — callers decide what that means. */
	readFile: (p: string) => string;
	env: Record<string, string | undefined>;
}

export interface DoctorReport {
	mode: DeployMode;
	checks: CheckResult[];
	ok: boolean;
}

/** Every mode ships the same manifest, so this is mode-independent — it took a
 *  `mode` argument only while `release` counted `packages/` instead. */
const expectedExtCount = (): number => manifest.extensions?.length ?? 0;

/** runtime — bun version. Always info. */
export function checkRuntime(ctx: DoctorContext): CheckResult {
	return { id: "runtime", label: "runtime", status: "info", detail: `bun ${ctx.bunVersion}` };
}

/** mode — which deploy layout this is. Always info. */
export function checkMode(ctx: DoctorContext): CheckResult {
	return { id: "mode", label: "deploy mode", status: "info", detail: ctx.mode };
}

/** entry — the pi-agent entry file exists + is non-trivial. */
export function checkEntry(ctx: DoctorContext): CheckResult {
	if (!ctx.exists(ctx.entryPath)) {
		return {
			id: "entry",
			label: "pi-agent entry",
			status: "fail",
			detail: `not found: ${ctx.entryPath}`,
			hint: "rebuild: `bun ../pi-agent-ext-devops/scripts/deploy.ts` (source) or re-deploy",
		};
	}
	return { id: "entry", label: "pi-agent entry", status: "pass", detail: ctx.entryPath };
}

/**
 * ext-bundles — the extension set is complete for the mode.
 *  - bundle: ext-bundles/*.js count ≥ expected
 *  - source / binary: ext-bundles not expected (loads from bun-apps/ or baked); info
 *
 * The `release` branch that read `packages/` is gone with the mode — no deploy
 * has ever produced that layout.
 */
export function checkExtensions(ctx: DoctorContext): CheckResult {
	const id = "extensions";
	const label = "extension set";
	if (ctx.mode === "sh") return checkShExtensions(ctx);
	if (ctx.mode === "source" || ctx.mode === "binary") {
		return { id, label, status: "info", detail: `${ctx.mode} mode loads extensions from source/baked paths` };
	}
	const bundles = ctx.listDir(join(ctx.selfDir, "ext-bundles")).filter((f) => f.endsWith(".js"));
	const want = expectedExtCount();
	if (bundles.length < want) {
		return {
			id,
			label,
			status: "fail",
			detail: `ext-bundles/ has ${bundles.length} .js, expected ≥ ${want}`,
			hint: "redeploy: `bun ../pi-agent-ext-devops/scripts/deploy.ts` (default bundle)",
		};
	}
	return { id, label, status: "pass", detail: `ext-bundles/${bundles.length} .js (expected ≥ ${want})` };
}

/**
 * extension set, sh mode — validate the DEPLOYED ext/ tree.
 *
 * The repo manifest that `expectedExtCount()` reads means nothing here: an sh
 * deploy has no manifest and its extension set is whatever deploy-config.yaml
 * shipped. So this reads each `<deployDir>/ext/<name>/ext.json` through the
 * SAME parser the loader uses — a manifest that doctor accepts but the loader
 * rejects would be worse than no check at all.
 *
 * An absent ext/ is `info`, not `fail`: booting with zero extensions is a
 * designed, gated state.
 */
export function checkShExtensions(ctx: DoctorContext): CheckResult {
	const id = "extensions";
	const label = "extension set";
	const extRoot = join(ctx.deployDir, "ext");
	if (!ctx.exists(extRoot)) {
		return { id, label, status: "info", detail: "no ext/ — core runs with zero extensions (supported)" };
	}
	const host = { hostApi: HOST_API, hostModules: HOST_MODULE_IDS };
	const ok: string[] = [];
	const bad: string[] = [];
	for (const name of ctx.listDir(extRoot).sort()) {
		const manifestPath = join(extRoot, name, "ext.json");
		if (!ctx.exists(manifestPath)) continue; // not an extension dir
		let parsed: ReturnType<typeof parseExtManifest>;
		try {
			parsed = parseExtManifest(JSON.parse(ctx.readFile(manifestPath)), name, host);
		} catch (e) {
			bad.push(`${name} (unreadable ext.json: ${e instanceof Error ? e.message : String(e)})`);
			continue;
		}
		if (!parsed.ok) bad.push(`${name} (${parsed.reason})`);
		else if (!ctx.exists(join(extRoot, name, parsed.manifest.entry))) bad.push(`${name} (entry missing)`);
		else ok.push(name);
	}
	if (bad.length > 0) {
		return {
			id,
			label,
			status: "fail",
			detail: `${ok.length} loadable, ${bad.length} would be SKIPPED at boot: ${bad.join(", ")}`,
			hint: "rebuild that extension: `bun run --cwd bun-apps/pi-agent deploy:sh --ext <name>`",
		};
	}
	return { id, label, status: "pass", detail: `${ok.length} extension(s) loadable: ${ok.join(", ") || "none"}` };
}

/**
 * host-deps — can pi's loader resolve typebox/@earendil-works/* from the entry?
 *  - source / binary: pi resolves its OWN deps from the pi-coding-agent loader
 *    in node_modules, not from cli.ts — informational only.
 *  - bundle (THIN default): works WITHOUT a node_modules (ext bundles bake abs
 *    paths; pi-agent.js's own deps are inlined) — unresolvable is a WARN.
 *
 * There is deliberately no `fail` path left. The only one there ever was keyed
 * on `portable`, a mode nothing can produce, so this check has been warn-or-info
 * in practice since that rename. Stating it plainly beats an unreachable branch
 * that makes the check look stricter than it is: for every mode this function
 * can DISTINGUISH, missing host deps are recoverable (bundle) or irrelevant
 * (source/binary resolve their own).
 *
 * KNOWN GAP — not "every deploy mode", only every mode doctor can tell apart.
 * A `--snapshot` deploy ships raw `.ts`, so detectMode(…, "/src/") calls it `source` and
 * it takes the INFO branch — yet host deps are genuinely essential there
 * (deploy.ts's stageSnapshotHostDeps exists for exactly that reason: the
 * snapshot's own root is `target/`, so without those links the first sibling
 * import throws). Closing this needs a marker that distinguishes a snapshot
 * deploy from a repo checkout; `depInstalled` would have to move off
 * `<selfDir>/node_modules` too, which in source mode points at `src/`.
 */
export function checkHostDeps(ctx: DoctorContext): CheckResult {
	if (ctx.mode === "source" || ctx.mode === "binary" || ctx.mode === "sh") {
		return { id: "host-deps", label: "host deps", status: "info", detail: `${ctx.mode} mode — pi resolves deps from its own loader` };
	}
	const need = [
		"typebox",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
	];
	const missing = need.filter((s) => !ctx.depInstalled(s));
	if (missing.length) {
		return {
			id: "host-deps",
			label: "host deps (typebox/@earendil-works/*)",
			status: "warn",
			detail: `unresolved from entry: ${missing.join(", ")}`,
			hint: "optional — THIN bundle works via abs paths; re-deploy if extensions fail to load",
		};
	}
	return { id: "host-deps", label: "host deps (typebox/@earendil-works/*)", status: "pass", detail: "resolve from entry" };
}

/** providers — each configured provider's apiKey is available (literal or env). */
export function checkProviders(ctx: DoctorContext): CheckResult {
	const entries = Object.entries(PROVIDERS);
	if (entries.length === 0) {
		return { id: "providers", label: "providers", status: "info", detail: "none configured (pre-load-providers.ts PROVIDERS empty)" };
	}
	const missingEnv: string[] = [];
	for (const [name, entry] of entries) {
		const key = entry.apiKey as ApiKey;
		if (typeof key === "object" && !resolveApiKey(key, ctx.env)) missingEnv.push(`${name} (\${${key.env}})`);
	}
	if (missingEnv.length) {
		return {
			id: "providers",
			label: "providers",
			status: "warn",
			detail: `${entries.length} configured; apiKey env unset: ${missingEnv.join(", ")}`,
			hint: "set the listed env vars (local servers with literal keys are fine)",
		};
	}
	return { id: "providers", label: "providers", status: "pass", detail: `${entries.length} configured, all apiKeys available` };
}

/** patches — which env-gated patches WOULD apply. Pure over a precomputed plan. */
export function checkPatches(plan: { name: string; applied: boolean }[]): CheckResult {
	const on = plan.filter((p) => p.applied).map((p) => p.name);
	return {
		id: "patches",
		label: `patches (${on.length}/${plan.length} applied)`,
		status: "info",
		detail: on.join(", ") || "none",
	};
}

/** Run all checks against a context. Pure. */
export function runChecks(ctx: DoctorContext): DoctorReport {
	const plan = resolvePatchPlan(PATCH_TABLE, ctx.env).map((p) => ({ name: p.name, applied: p.applied }));
	const checks: CheckResult[] = [
		checkRuntime(ctx),
		checkMode(ctx),
		checkEntry(ctx),
		checkExtensions(ctx),
		checkHostDeps(ctx),
		checkProviders(ctx),
		checkPatches(plan),
	];
	return { mode: ctx.mode, checks, ok: !checks.some(isFailing) };
}

// ── auto-fix: REMOVED ────────────────────────────────────────────────
//
// `doctor --fix` used to derive a fix plan and run `bun install` in the deploy
// dir. It never ran: planFixes gated on `portable`/`release`, modes nothing can
// produce, so --fix always printed "nothing to fix" — which reads as "your
// deploy is healthy". ~95 LOC of planner/applier/spawn-seam plus ~15 tests
// exercised only unreachable branches.
//
// Re-homing it onto a mode that DOES exist was tried and rejected on evidence.
// The README documented the target as `--snapshot`; a snapshot is not a
// workspace, so running `bun install` from inside its deploy dir fails on every
// `workspace:*` dependency — measured, 20 of them:
//
//   error: @repo/pi-agent-ext-webui@workspace:* failed to resolve
//
// A deploy artifact is not repairable in place — the repair is to re-deploy.
// Every check that can detect a broken deploy now says exactly that in its
// hint. If an auto-fix is wanted later, it needs an action that works on a
// build artifact, not a package manager pointed at one.

/**
 * Notice for a flag this command used to accept, or null.
 *
 * `--fix` was silently ignored the moment the planner went: doctor takes no
 * flag-spec, so an unrecognised token just falls through and the report prints
 * as if nothing was asked for. A user following a stale doc — and one shipped
 * for a while, `docs/deploy-readonly.md` — would read a clean report as
 * confirmation that `--fix` ran. Say so instead.
 *
 * Deliberately a notice rather than a hard error: `doctor` is the command you
 * reach for when a deploy is already broken, so a `--fix` left in someone's
 * script should still produce a diagnosis, not an exit 1.
 */
export function removedFlagNotice(argv: readonly string[]): string | null {
	if (!argv.includes("--fix")) return null;
	return "note: `doctor --fix` was removed — a deploy artifact is not repairable in place; re-deploy it. Running the checks only.";
}

// ── runtime smoke (opt-in: `doctor --smoke`) ─────────────────────────────────
//
// The pure checks above are filesystem/static — they verify the extension FILES
// exist, not that pi actually LOADS them. The #182 regression (cli.ts sliced
// argv before the run-dir patch spliced it in) silently dropped EVERY run-dir
// extension while every static check stayed green. The smoke check spawns a
// throwaway probe that calls `pi.getAllTools()` at session_start and counts how
// many tools came from the run-dir extension root — catching that silent-no-op
// class on any deployed artifact, offline, without the model call (the probe
// exits at session_start, before main() reaches the provider).

/**
 * The marker the smoke probe greps tool sourceInfo.path for, per mode.
 * Pure (no fs).
 *  - source:  the bun-apps dir (selfDir is .../pi-agent/src → ../.. = bun-apps)
 *  - bundle:  <selfDir>/ext-bundles
 *  - binary:  "<inline:" — static-factory tools report sourceInfo.path
 *             "<inline:<pkg-name>>"; the probe itself loading via -e also
 *             proves the upstream jiti binary path works (0.80.10+).
 *  - sh:      also "<inline:". sh loads each ext.cjs off disk but hands the
 *             factories to main({extensionFactories}), and pi labels a factory
 *             it did not resolve itself as inline — measured
 *             `{"path":"<inline:power-tool>","source":"inline"}` against a real
 *             deploy. The marker is right for the wrong-sounding reason, so it
 *             is written down rather than left to look like a copy-paste.
 */
export function smokeMarker(mode: DeployMode, selfDir: string): string {
	if (mode === "binary" || mode === "sh") return "<inline:";
	if (mode === "source") return resolve(selfDir, "..", "..");
	return join(selfDir, "ext-bundles"); // bundle
}

const SMOKE_PROBE = [
	'export default (pi) => {',
	'  pi.on("session_start", () => {',
	'    const tools = pi.getAllTools();',
	'    const marker = process.env.PI_SMOKE_MARKER ?? "";',
	'    let matched = 0;',
	'    for (const t of tools) {',
	'      if (marker && String(t.sourceInfo?.path ?? "").includes(marker)) matched++;',
	'    }',
	'    process.stderr.write("[SMOKE] total=" + tools.length + " matched=" + matched + "\\n");',
	'    process.exit(0);', // exit at session_start → before the model call → offline
	'  });',
	'};',
].join("\n");

/** Injectable spawn seam so runSmokeCheck's logic is unit-testable without bun. */
export interface SmokeSpawn {
	(args: { entry: string; probe: string; cwd: string; env: Record<string, string | undefined> }): Promise<{
		stderr: string;
		code: number | null;
	}>;
}

export interface SmokeOptions {
	timeoutMs?: number;
	spawn?: SmokeSpawn; // default: Bun.spawn against the real entry
}

/**
 * Spawn the smoke probe against the entry and parse its [SMOKE] line.
 * Real spawn helper — exported for tests that want to exercise the timeout path.
 */
export async function defaultSmokeSpawn(args: {
	entry: string;
	probe: string;
	cwd: string;
	env: Record<string, string | undefined>;
	timeoutMs?: number;
	/** Binary mode: `entry` IS the compiled exe — spawn it directly, not `bun <entry>`. */
	exeDirect?: boolean;
}): Promise<{ stderr: string; code: number | null }> {
	const timeoutMs = args.timeoutMs ?? 30_000;
	const cmd = args.exeDirect
		? [args.entry, "-e", args.probe, "-p", "hi"]
		: ["bun", args.entry, "-e", args.probe, "-p", "hi"];
	const proc = Bun.spawn(cmd, {
		cwd: args.cwd,
		env: args.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = proc.stderr.getReader();
	const dec = new TextDecoder();
	let buf = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (true) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const readP = reader.read();
			const timeoutP = new Promise<{ timedOut: true }>((r) => setTimeout(() => r({ timedOut: true }), remaining));
			const res = (await Promise.race([readP, timeoutP])) as { timedOut?: true; value?: Uint8Array; done?: boolean };
			if (res.timedOut) break;
			if (res.done) break;
			buf += dec.decode(res.value, { stream: true });
			if (/\[SMOKE\]/.test(buf)) break; // got it — no need to wait for exit
		}
	} finally {
		try {
			proc.kill();
		} catch {
			/* already exited */
		}
	}
	let code: number | null = null;
	try {
		code = await Promise.race([proc.exited as Promise<number>, new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
	} catch {
		code = null;
	}
	return { stderr: buf, code };
}

/**
 * Run the runtime-smoke check. Imperative (fs + spawn). Returns a CheckResult:
 *  - binary mode → spawns the exe directly; marker "<inline:" counts
 *    static-factory tools (and the -e probe loading proves the jiti binary path)
 *  - matched > 0 → PASS (run-dir extensions loaded)
 *  - matched = 0 → FAIL (silent no-op class; the slice-bug regression)
 *  - no [SMOKE] line → FAIL (probe never fired — entry error or a heavy
 *    extension's session_start handler blocked it past the timeout)
 */
export async function runSmokeCheck(ctx: DoctorContext, opts: SmokeOptions = {}): Promise<CheckResult> {
	const id = "runtime-smoke";
	const label = "runtime smoke (extension load)";
	const marker = smokeMarker(ctx.mode, ctx.selfDir);
	// Compiled modes (binary AND sh): selfDir is the non-existent $bunfs virtual
	// dir — spawning with that cwd fails before the probe ever runs, and the
	// failure surfaces as a raw stack rather than a check result. deployDir is
	// the exe's real on-disk dir.
	const compiled = ctx.mode === "binary" || ctx.mode === "sh";
	const cwd = compiled ? ctx.deployDir : ctx.selfDir;
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-smoke-"));
	const probePath = join(dir, "smoke-probe.ts");
	writeFileSync(probePath, SMOKE_PROBE);
	const env = { ...ctx.env, PI_SMOKE_MARKER: marker };
	let result: { stderr: string; code: number | null };
	try {
		result = opts.spawn
			? await opts.spawn({ entry: ctx.entryPath, probe: probePath, cwd, env })
			: await defaultSmokeSpawn({
					entry: ctx.entryPath,
					probe: probePath,
					cwd,
					env,
					timeoutMs: opts.timeoutMs,
					exeDirect: compiled,
				});
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* */
		}
	}
	const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trim();
	const m = result.stderr.match(/\[SMOKE\] total=(\d+) matched=(\d+)/);
	if (!m) {
		return {
			id,
			label,
			status: "fail",
			detail: `probe did not report (exit ${result.code})`,
			hint: `entry failed early, or an extension's session_start handler blocked past the timeout. stderr tail: ${clean(result.stderr).slice(-180)}`,
		};
	}
	const total = +(m[1] ?? "");
	const matched = +(m[2] ?? "");
	if (matched > 0) {
		// "run-dir" is the source of extensions in source/bundle mode only; an sh
		// deploy has no run-dir at all, and a detail line naming one sends the
		// operator to a directory that does not exist.
		const from = ctx.mode === "sh" ? "ext/ extensions loaded" : "run-dir extensions loaded";
		return { id, label, status: "pass", detail: `total=${total} matched=${matched} — ${from}` };
	}
	return {
		id,
		label,
		status: "fail",
		detail: `total=${total} matched=0 — NO run-dir extension tools registered`,
		hint: "silent load failure (the slice-bug class): verify cli.ts passes process.argv.slice(2) to main() AFTER applyPatches(), then re-run `./run-test.sh medium`.",
	};
}

// ── real wiring ──────────────────────────────────────────────────────────────
export interface RunOptions {
	json?: boolean;
	smoke?: boolean;
	smokeTimeoutMs?: number;
}

/** Build the real DoctorContext from process state + the module's location. */
export function realContext(moduleUrl: string, env: Record<string, string | undefined>): DoctorContext {
	const selfDir = dirname(fileURLToPath(moduleUrl));
	// Binary mode has no separate entry FILE to verify — the compiled exe IS
	// the entry (there's no sibling pi-agent.js shipped alongside `--compile`
	// output). Point at process.execPath so checkEntry's existsSync trivially
	// passes instead of always failing against a pi-agent.js that never ships
	// in this mode (a pre-existing gap: this branch was never binary-mode-aware
	// before the compiled binary shipped real extensions worth doctoring).
	// detectMode's source marker is "/src/" — doctor.ts's own dir — which also
	// matches a --snapshot deploy (it ships raw .ts under src/), mirroring the
	// old coarseFromUrl's `.endsWith(".ts")` rule.
	const coarse = detectMode(moduleUrl, "/src/");
	const entryPath =
		coarse === "source" ? join(selfDir, "cli.ts") : coarse === "binary" ? process.execPath : join(selfDir, "pi-agent.js");
	// Annotated (not inferred) so an unused marker is a tsc error rather than an
	// excess property TypeScript silently tolerates on a variable. `.deploy-portable`
	// and `packages/` were still probed here after their modes were removed
	// precisely because an inferred object type made the leftovers invisible.
	// In a compiled binary selfDir is inside $bunfs; only the executable's own
	// directory names anything on the real filesystem.
	const deployDir = coarse === "binary" ? dirname(process.execPath) : selfDir;
	const markers: LayoutMarkers = {
		dotDeployBundle: existsSync(join(selfDir, ".deploy-bundle")),
		shDeploy: coarse === "binary" && existsSync(join(deployDir, "deploy.json")),
	};
	const mode = classifyMode(coarse, markers);
	return {
		mode,
		selfDir,
		deployDir,
		entryPath,
		bunVersion: process.versions.bun ?? "unknown",
		exists: existsSync,
		depInstalled: (spec) => existsSync(join(selfDir, "node_modules", spec)),
		listDir: (p) => (existsSync(p) ? readdirSync(p) : []),
		readFile: (p) => readFileSync(p, "utf8"),
		env,
	};
}

/** Run doctor against real process state, print, and return the report. */
export async function runDoctor(opts: RunOptions = {}, out: (s: string) => void = console.log): Promise<DoctorReport> {
	const ctx = realContext(import.meta.url, process.env);
	let report = runChecks(ctx);

	// The smoke check is opt-in (it spawns a subprocess, so the default doctor
	// stays pure/offline/fast). A smoke FAIL is a hard failure (like other fails).
	if (opts.smoke) {
		const smoke = await runSmokeCheck(ctx, { timeoutMs: opts.smokeTimeoutMs });
		report = { mode: report.mode, checks: [...report.checks, smoke], ok: report.ok && !isFailing(smoke) };
	}
	if (opts.json) {
		out(JSON.stringify(report, null, 2));
	} else {
		const color = (s: CheckStatus): string => {
			const c = { pass: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", info: "\x1b[2m" }[s];
			return `${c}${s.toUpperCase().padEnd(4)}\x1b[0m`;
		};
		out(`\x1b[1mpi-agent doctor\x1b[0m  (mode: ${report.mode})`);
		for (const c of report.checks) {
			out(`  ${color(c.status)}  ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
			if (c.hint) out(`         \x1b[2m↳ ${c.hint}\x1b[0m`);
		}
		out(report.ok ? "\n\x1b[32m✓ all hard checks passed\x1b[0m" : "\n\x1b[31m✗ one or more hard checks failed\x1b[0m");
	}
	return report;
}
