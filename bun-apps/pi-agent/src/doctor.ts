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
import { existsSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import manifest from "../run-dir/manifest.json";
import { PATCH_TABLE, resolvePatchPlan } from "./patches/index.ts";
import { PROVIDERS, resolveApiKey, type ApiKey } from "./pre-load-providers.ts";

/**
 * Coarse mode from the module URL. NOTE: src/mode.ts's detectMode keys off a
 * "/run-dir/" marker (it's designed for resolve.ts); doctor.ts lives in src/,
 * so detect straight from the URL: source runs the .ts directly, a shipped
 * deploy is the bundled .js, the compiled binary is bun's virtual scheme.
 */
function coarseFromUrl(url: string): "source" | "bundle" | "binary" {
	if (url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN")) return "binary";
	return url.endsWith(".ts") ? "source" : "bundle";
}

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

/** The deploy mode doctor detects (finer than detectMode: splits bundle/release/portable). */
export type DeployMode = "source" | "bundle" | "portable" | "release" | "binary";

/** Classify the deploy mode from coarse mode + the layout markers. Pure. */
export function classifyMode(
	coarse: "source" | "bundle" | "binary",
	markers: { dotDeployBundle: boolean; dotDeployPortable: boolean; packages: boolean },
): DeployMode {
	if (coarse === "binary") return "binary";
	if (coarse === "source") return "source";
	// bundle coarse mode = a shipped pi-agent.js; sub-classify by markers
	if (markers.dotDeployPortable) return "portable";
	if (markers.packages) return "release";
	if (markers.dotDeployBundle) return "bundle";
	return "bundle"; // a pi-agent.js with no marker — treat as plain bundle
}

/** Injectable environment so checks are pure and unit-testable. */
export interface DoctorContext {
	mode: DeployMode;
	selfDir: string;
	entryPath: string;
	bunVersion: string;
	exists: (p: string) => boolean;
	/** Is a dep present under <selfDir>/node_modules? (dir existence — NOT
	 * require.resolve, which false-negatives on packages with an exports map.) */
	depInstalled: (spec: string) => boolean;
	/** List a dir (returns [] if absent). */
	listDir: (p: string) => string[];
	env: Record<string, string | undefined>;
}

export interface DoctorReport {
	mode: DeployMode;
	checks: CheckResult[];
	ok: boolean;
}

const expectedExtCount = (mode: DeployMode): number =>
	mode === "portable"
		? (manifest.extensions?.length ?? 0) + (manifest.npmExtensions?.length ?? 0)
		: manifest.extensions?.length ?? 0;

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
			hint: "rebuild: `bun scripts/deploy.ts` (source) or re-deploy",
		};
	}
	return { id: "entry", label: "pi-agent entry", status: "pass", detail: ctx.entryPath };
}

/**
 * ext-bundles / packages — the extension set is complete for the mode.
 *  - bundle/portable: ext-bundles/*.js count ≥ expected
 *  - release: packages/* non-empty
 *  - source: ext-bundles not expected (loads from bun-apps/); info only
 */
export function checkExtensions(ctx: DoctorContext): CheckResult {
	const id = "extensions";
	const label = "extension set";
	if (ctx.mode === "source" || ctx.mode === "binary") {
		return { id, label, status: "info", detail: `${ctx.mode} mode loads extensions from source/baked paths` };
	}
	if (ctx.mode === "release") {
		const pkgs = ctx.listDir(join(ctx.selfDir, "packages")).filter((d) => !d.startsWith("."));
		if (pkgs.length === 0) {
			return { id, label, status: "fail", detail: "packages/ empty", hint: "redeploy: `bun scripts/deploy.ts --release`" };
		}
		return { id, label, status: "pass", detail: `packages/${pkgs.length} (${pkgs.join(", ")})` };
	}
	// bundle / portable: ext-bundles/*.js
	const bundles = ctx.listDir(join(ctx.selfDir, "ext-bundles")).filter((f) => f.endsWith(".js"));
	const want = expectedExtCount(ctx.mode);
	if (bundles.length < want) {
		return {
			id,
			label,
			status: "fail",
			detail: `ext-bundles/ has ${bundles.length} .js, expected ≥ ${want}`,
			hint: ctx.mode === "portable"
				? "redeploy: `bun scripts/deploy.ts --portable`"
				: "redeploy: `bun scripts/deploy.ts` (default bundle)",
		};
	}
	return { id, label, status: "pass", detail: `ext-bundles/${bundles.length} .js (expected ≥ ${want})` };
}

/**
 * host-deps — can pi's loader resolve typebox/@earendil-works/* from the entry?
 * Severity is mode-aware because the failure modes differ:
 *  - source: pi resolves its OWN deps from the pi-coding-agent loader in
 *    node_modules, NOT from cli.ts — so this check is informational only.
 *  - portable: the host node_modules subset is ESSENTIAL (getAliases + FULL
 *    residual bare specifiers). Unresolvable → FAIL.
 *  - bundle (THIN default): works WITHOUT a node_modules (ext bundles bake abs
 *    paths; pi-agent.js's own deps are inlined) — so unresolvable is just a WARN.
 *  - release: `bun install` should have provided them — WARN if not.
 */
export function checkHostDeps(ctx: DoctorContext): CheckResult {
	if (ctx.mode === "source" || ctx.mode === "binary") {
		return { id: "host-deps", label: "host deps", status: "info", detail: `${ctx.mode} mode — pi resolves deps from its own loader` };
	}
	const need = [
		"typebox",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
	];
	const missing = need.filter((s) => !ctx.depInstalled(s));
	const failMode = ctx.mode === "portable";
	if (missing.length) {
		return {
			id: "host-deps",
			label: "host deps (typebox/@earendil-works/*)",
			status: failMode ? "fail" : "warn",
			detail: `unresolved from entry: ${missing.join(", ")}`,
			hint: failMode
				? "`bun install` in the deploy dir (portable needs its node_modules subset)"
				: "optional — THIN bundle works via abs paths; `--with-nm-copy` or `bun install` if extensions fail to load",
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

// ── auto-fix (opt-in: `doctor --fix`) ────────────────────────────────────────
//
// The pure checks above surface a broken/incomplete deploy but leave the user to
// fix it by hand. `--fix` closes the diagnose→fix loop: it derives a fix plan
// from the current report, applies it (mutating), and re-checks — the same
// create-then-recheck shape as bun-apps/pi-agent's `cli doctor --fix`.
//
// The decisive pi-agent-specific fix: in a `--portable` (repo-independent,
// same-machine) deploy that lands on a host without its `node_modules` subset,
// `checkHostDeps` FAILs (typebox/@earendil-works/* are essential there). `--fix`
// runs `bun install` in the deploy dir to self-heal it. Applies to `release`
// too (same — ships a deps/workspaces package.json). The default THIN `bundle`
// is skipped: its package.json is minimal {name,private,type} with no deps, so
// `bun install` is a no-op there (it stays hint-only WARN). source/binary are
// skipped (host-deps is INFO — pi resolves its own).
//
// Shape mirrors `--smoke`: a PURE planner (planFixes) separable from an
// imperative applier (applyFixes) behind an injectable spawn seam (FixSpawn),
// so the decision + outcome-mapping are unit-testable without spawning bun.

/** One auto-fix that WOULD apply (or just applied) for the current report. */
export interface FixAction {
	id: string;
	label: string;
	reason: string;
}

/**
 * PURE. Which fixes WOULD apply for this report + context, without executing
 * any. Currently the only fix is `bun install` for an unresolved `host-deps`
 * check in a mode that ships an installable package.json (portable/release).
 * Returns [] when there is nothing to fix.
 */
export function planFixes(report: DoctorReport, ctx: DoctorContext): FixAction[] {
	const plan: FixAction[] = [];
	const hostDeps = report.checks.find((c) => c.id === "host-deps");
	if (
		hostDeps &&
		(hostDeps.status === "fail" || hostDeps.status === "warn") &&
		(ctx.mode === "portable" || ctx.mode === "release")
	) {
		plan.push({
			id: "host-deps",
			label: "bun install (host deps)",
			reason: `${ctx.mode} mode: ${hostDeps.detail ?? "host deps unresolvable"}`,
		});
	}
	return plan;
}

/** Injectable spawn seam so applyFixes' outcome-mapping is unit-testable. */
export interface FixSpawn {
	(args: { cwd: string; env: Record<string, string | undefined> }): Promise<{
		code: number | null;
		stderr: string;
	}>;
}

/** Real spawn helper — `bun install` in a dir. Exported for tests. */
export async function defaultFixSpawn(args: {
	cwd: string;
	env: Record<string, string | undefined>;
}): Promise<{ code: number | null; stderr: string }> {
	const proc = Bun.spawn(["bun", "install"], {
		cwd: args.cwd,
		env: args.env,
		stdout: "inherit",
		stderr: "pipe",
	});
	let stderr = "";
	try {
		const reader = proc.stderr.getReader();
		const dec = new TextDecoder();
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			stderr += dec.decode(value, { stream: true });
		}
	} catch {
		/* stderr is best-effort */
	}
	const code = await proc.exited;
	return { code, stderr };
}

/**
 * Apply a fix plan (imperative: spawns). Returns one CheckResult per applied
 * fix so the caller can print/aggregate them. No-op (returns []) for an empty
 * plan. Maps each action's spawn outcome → pass/fail CheckResult.
 */
export async function applyFixes(
	plan: FixAction[],
	ctx: DoctorContext,
	opts: { spawn?: FixSpawn } = {},
): Promise<CheckResult[]> {
	const spawn = opts.spawn ?? defaultFixSpawn;
	const results: CheckResult[] = [];
	for (const action of plan) {
		if (action.id === "host-deps") {
			const r = await spawn({ cwd: ctx.selfDir, env: ctx.env });
			const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trim();
			results.push(
				r.code === 0
					? { id: "fix:host-deps", label: action.label, status: "pass", detail: "`bun install` ok — re-checking" }
					: {
							id: "fix:host-deps",
							label: action.label,
							status: "fail",
							detail: `\`bun install\` exited ${r.code}`,
							hint: clean(r.stderr).slice(-300) || undefined,
						},
			);
		}
	}
	return results;
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
 *  - bundle / portable: <selfDir>/ext-bundles
 *  - release: <selfDir>/packages
 *  - binary:  "<inline:" — static-factory tools report sourceInfo.path
 *             "<inline:<pkg-name>>"; the probe itself loading via -e also
 *             proves the upstream jiti binary path works (0.80.10+).
 */
export function smokeMarker(mode: DeployMode, selfDir: string): string {
	if (mode === "binary") return "<inline:";
	if (mode === "source") return resolve(selfDir, "..", "..");
	if (mode === "release") return join(selfDir, "packages");
	return join(selfDir, "ext-bundles"); // bundle + portable
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
	// Binary mode: selfDir is the non-existent $bunfs virtual dir — cwd there
	// would fail the spawn. Use the exe's real on-disk dir instead.
	const cwd = ctx.mode === "binary" ? dirname(ctx.entryPath) : ctx.selfDir;
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
					exeDirect: ctx.mode === "binary",
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
		return { id, label, status: "pass", detail: `total=${total} matched=${matched} — run-dir extensions loaded` };
	}
	return {
		id,
		label,
		status: "fail",
		detail: `total=${total} matched=0 — NO run-dir extension tools registered`,
		hint: "silent load failure (the slice-bug class): verify cli.ts passes process.argv.slice(2) to main() AFTER applyPatches(), then re-run `./run-test.sh high`.",
	};
}

// ── real wiring ──────────────────────────────────────────────────────────────
export interface RunOptions {
	json?: boolean;
	fix?: boolean;
	fixSpawn?: FixSpawn;
	smoke?: boolean;
	smokeTimeoutMs?: number;
}

/** Build the real DoctorContext from process state + the module's location. */
export function realContext(moduleUrl: string, env: Record<string, string | undefined>): DoctorContext {
	const coarse = coarseFromUrl(moduleUrl);
	const selfDir = dirname(fileURLToPath(moduleUrl));
	// Binary mode has no separate entry FILE to verify — the compiled exe IS
	// the entry (there's no sibling pi-agent.js shipped alongside `--compile`
	// output). Point at process.execPath so checkEntry's existsSync trivially
	// passes instead of always failing against a pi-agent.js that never ships
	// in this mode (a pre-existing gap: this branch was never binary-mode-aware
	// before the compiled binary shipped real extensions worth doctoring).
	const entryPath =
		coarse === "source" ? join(selfDir, "cli.ts") : coarse === "binary" ? process.execPath : join(selfDir, "pi-agent.js");
	const markers = {
		dotDeployBundle: existsSync(join(selfDir, ".deploy-bundle")),
		dotDeployPortable: existsSync(join(selfDir, ".deploy-portable")),
		packages: existsSync(join(selfDir, "packages")),
	};
	const mode = classifyMode(coarse, markers);
	return {
		mode,
		selfDir,
		entryPath,
		bunVersion: process.versions.bun ?? "unknown",
		exists: existsSync,
		depInstalled: (spec) => existsSync(join(selfDir, "node_modules", spec)),
		listDir: (p) => (existsSync(p) ? readdirSync(p) : []),
		env,
	};
}

/** Run doctor against real process state, print, and return the report. */
export async function runDoctor(opts: RunOptions = {}, out: (s: string) => void = console.log): Promise<DoctorReport> {
	const ctx = realContext(import.meta.url, process.env);
	let report = runChecks(ctx);

	// `--fix`: derive a fix plan from the report, apply it (mutating — runs `bun
	// install` etc.), then re-check. Same create-then-recheck shape as
	// pi-agent-cli's doctor --fix. The default doctor stays pure/offline/fast;
	// --fix is opt-in. Applied fixes are printed before the re-checked report.
	let appliedFixes: CheckResult[] = [];
	if (opts.fix) {
		const plan = planFixes(report, ctx);
		if (plan.length === 0) {
			out("\x1b[2m--fix: nothing to fix (no auto-remediable check failed)\x1b[0m");
		} else {
			appliedFixes = await applyFixes(plan, ctx, { spawn: opts.fixSpawn });
			// re-check after the fix mutated the deploy dir. depInstalled reads the
			// fs live, so the same ctx sees the new node_modules.
			report = runChecks(ctx);
		}
	}

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
		if (appliedFixes.length) {
			out("  \x1b[2m--fix applied:\x1b[0m");
			for (const f of appliedFixes) {
				out(`  ${color(f.status)}  ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
				if (f.hint) out(`         \x1b[2m↳ ${f.hint}\x1b[0m`);
			}
		}
		for (const c of report.checks) {
			out(`  ${color(c.status)}  ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
			if (c.hint) out(`         \x1b[2m↳ ${c.hint}\x1b[0m`);
		}
		out(report.ok ? "\n\x1b[32m✓ all hard checks passed\x1b[0m" : "\n\x1b[31m✗ one or more hard checks failed\x1b[0m");
	}
	return report;
}
