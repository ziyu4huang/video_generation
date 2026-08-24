/**
 * `doctor` — s2-agent self-check.
 *
 * Runs offline (no model call, no network). Answers: which deploy mode am I,
 * is the entry present, are the extension bundles / packages complete, can the
 * host resolve the deps pi's loader needs (typebox/@earendil-works/*), are the
 * configured providers' API keys available, and which patches would apply. A
 * fresh-machine or broken-deploy failure usually surfaces as an opaque error
 * deep in a run; doctor checks the boundary conditions up front and prints an
 * actionable checklist.
 *
 * Design (mirrors bun-apps/s2-agent/src/cli/commands/doctor.ts): each check is
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
import { detectMode, type BundlerMode } from "./mode.ts";
import { HOST_API, HOST_MODULE_IDS } from "./sh/host-modules.ts";
import { parseExtManifest } from "./sh/ext-manifest.ts";
// Cross-package relative import (static-extensions.ts precedent): the smoke
// probe is SHARED with deploy-e2e's tools-probe so the dev-side and deploy-side
// gates can never drift — same probe, same [TOOLS] payload, same core builtin
// assertion. See that module's header for the handler-ordering contract.
import { parseToolsProbeLine, TOOLS_ACTIVE_PROBE } from "../../s2-agent-ext-devops/src/tools-active-probe.ts";

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
 * `portable`, `release` and `bundle` were all here once, and none of them
 * survived contact with what the pipeline could actually produce. The first two
 * were left behind by a rename deploy.ts completed and doctor.ts did not; the
 * third outlived its producer by one release, when #1740 retired deploy.ts
 * altogether. Each took real behaviour down with it — see checkHostDeps, which
 * had no reachable failure path for as long as its only `fail` keyed on
 * `portable`.
 *
 * The lesson is written down rather than re-learned: a mode belongs here only
 * while something can produce it.
 */
export type DeployMode = "source" | "sh";

/**
 * Classify the deploy mode from coarse mode + the layout markers. Pure.
 *
 * One marker left, and it is the one that matters: a bundle core is either an
 * sh deploy or a stray copy, and only `deploy.json` tells them apart.
 */
export interface LayoutMarkers {
	/**
	 * A s2-agent-sh deploy: `deploy.json` beside the core bundle. `ext/` alone
	 * is not the marker — deleting it is a SUPPORTED state (the core boots with
	 * no extensions), and a deploy that lost its extensions must still be
	 * recognisable as an sh deploy or doctor reports the wrong mode exactly
	 * when something is wrong.
	 */
	shDeploy: boolean;
}

export function classifyMode(coarse: BundlerMode, markers: LayoutMarkers): DeployMode {
	// A bun-run bundle with a deploy.json beside it is an sh deploy. A bundle
	// WITHOUT deploy.json (a stray copied s2-agent.js) falls through to the
	// "source" checks: coarse file layout, but the entry check below still
	// points at the bundle itself, so it reports honestly instead of failing
	// on a cli.ts that does not exist.
	if (coarse === "bundle") return markers.shDeploy ? "sh" : "source";
	return "source";
}

/** Injectable environment so checks are pure and unit-testable. */
export interface DoctorContext {
	mode: DeployMode;
	selfDir: string;
	/**
	 * The directory the DEPLOY lives in — where an sh deploy keeps ext/ and
	 * deploy.json. Same as selfDir in every mode that exists (a bundle's
	 * selfDir IS the deploy dir); kept a separate field so sh-mode checks
	 * state what they read rather than leaning on the coincidence.
	 */
	deployDir: string;
	entryPath: string;
	/** True when the core artifact is a bun-run `.js` bundle (not a compiled
	 * exe): the smoke check must spawn `bun <entry>`, not `<entry>` directly. */
	bundleCore: boolean;
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

/** runtime — bun version. Always info. */
export function checkRuntime(ctx: DoctorContext): CheckResult {
	return { id: "runtime", label: "runtime", status: "info", detail: `bun ${ctx.bunVersion}` };
}

/** mode — which deploy layout this is. Always info. */
export function checkMode(ctx: DoctorContext): CheckResult {
	return { id: "mode", label: "deploy mode", status: "info", detail: ctx.mode };
}

/** entry — the s2-agent entry file exists + is non-trivial. */
export function checkEntry(ctx: DoctorContext): CheckResult {
	if (!ctx.exists(ctx.entryPath)) {
		return {
			id: "entry",
			label: "s2-agent entry",
			status: "fail",
			detail: `not found: ${ctx.entryPath}`,
			hint: "rebuild: `bun run --cwd bun-apps/s2-agent deploy` or re-deploy",
		};
	}
	return { id: "entry", label: "s2-agent entry", status: "pass", detail: ctx.entryPath };
}

/**
 * extension set — complete for the mode.
 *
 * Only the sh deploy has a tree to count: source loads from bun-apps/, so
 * there is nothing on disk that being wrong would show up here. The `bundle`
 * branch that counted `ext-bundles/*.js` — and the `release` one that read
 * `packages/` before it — went with the layouts they described.
 */
export function checkExtensions(ctx: DoctorContext): CheckResult {
	if (ctx.mode === "sh") return checkShExtensions(ctx);
	return {
		id: "extensions",
		label: "extension set",
		status: "info",
		detail: `${ctx.mode} mode loads extensions from source paths`,
	};
}

/**
 * extension set, sh mode — validate the DEPLOYED ext/ tree.
 *
 * The repo's run-dir manifest means nothing here: an sh deploy has no manifest
 * and its extension set is whatever the registry shipped. So this reads
 * each `<deployDir>/ext/<name>/ext.json` through the
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
			hint: "redeploy: `bun run --cwd bun-apps/s2-agent deploy` (version dirs are immutable — no in-place rebuild)",
		};
	}
	return { id, label, status: "pass", detail: `${ok.length} extension(s) loadable: ${ok.join(", ") || "none"}` };
}

/**
 * host-deps — can pi's loader resolve typebox/@earendil-works/* from the entry?
 *
 * Informational in every mode that exists: source resolves its own
 * deps from the pi-coding-agent loader in node_modules, and an sh deploy's
 * extensions are served by the host registry (host-modules.ts), which the
 * deploy hard-fails on rather than discovering here.
 *
 * This check once had a `fail` path. It keyed on `portable`, a mode nothing
 * could produce, so it had been unreachable for its whole life; the `warn` path
 * that replaced it keyed on `bundle` and became unreachable the same way when
 * Phase 1b retired that mode. What is left is honest about what it can tell
 * you, which is nothing — kept as an `info` row so `doctor` still reports the
 * mode's dependency story rather than silently omitting the line.
 */
export function checkHostDeps(ctx: DoctorContext): CheckResult {
	return {
		id: "host-deps",
		label: "host deps",
		status: "info",
		detail: `${ctx.mode} mode — pi resolves deps from its own loader`,
	};
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
//   error: @repo/s2-agent-ext-webui@workspace:* failed to resolve
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
 * for a while, in the retired `docs/deploy.md` — would read a clean report as
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
// throwaway probe (TOOLS_ACTIVE_PROBE, shared with deploy-e2e's tools-probe)
// that reads the session's toolset at before_agent_start — catching BOTH the
// #182 silent-no-op class (matched = 0: no run-dir extension tools registered)
// AND the #1946 class (core builtins missing from the ACTIVE set, e.g. a
// setActiveTools([]) wipe) on any deployed artifact, offline, without awaiting
// a model round trip.

/**
 * The marker the smoke probe greps tool sourceInfo.path for, per mode.
 * Pure (no fs).
 *  - source:  the bun-apps dir (selfDir is .../s2-agent/src → ../.. = bun-apps)
 *  - sh:      "<inline:". sh loads each ext.cjs off disk but hands the
 *             factories to main({extensionFactories}), and pi labels a factory
 *             it did not resolve itself as inline — measured
 *             `{"path":"<inline:power-tool>","source":"inline"}` against a real
 *             deploy. The marker is right for the wrong-sounding reason, so it
 *             is written down rather than left to look like a copy-paste.
 */
export function smokeMarker(mode: DeployMode, selfDir: string): string {
	if (mode === "sh") return "<inline:";
	return resolve(selfDir, "..", ".."); // source
}

// The probe source itself lives in s2-agent-ext-devops (tools-active-probe.ts)
// — shared verbatim with deploy-e2e's tools-probe so the two gates assert the
// same payload. It exits at before_agent_start (deferred 250ms so every
// later-loaded handler has run), before any provider response is awaited.

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
 * Spawn the smoke probe against the entry and parse its [TOOLS] line.
 * Real spawn helper — exported for tests that want to exercise the timeout path.
 */
export async function defaultSmokeSpawn(args: {
	entry: string;
	probe: string;
	cwd: string;
	env: Record<string, string | undefined>;
	timeoutMs?: number;
}): Promise<{ stderr: string; code: number | null }> {
	const timeoutMs = args.timeoutMs ?? 30_000;
	const cmd = [process.execPath, args.entry, "-e", args.probe, "-p", "hi"];
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
			if (/\[TOOLS\]/.test(buf)) break; // got it — no need to wait for exit
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
 *  - matched > 0 AND no missing core → PASS (extensions loaded AND active)
 *  - matched = 0 → FAIL (silent no-op class; the #182 slice-bug regression)
 *  - missing core builtins → FAIL (the #1946 setActiveTools([]) class)
 *  - activeCount = 0 → FAIL (the active toolset is empty)
 *  - no [TOOLS] line → FAIL (probe never fired — entry error or a heavy
 *    extension's handler blocked it past the timeout)
 */
export async function runSmokeCheck(ctx: DoctorContext, opts: SmokeOptions = {}): Promise<CheckResult> {
	const id = "runtime-smoke";
	const label = "runtime smoke (extension load + core tools active)";
	const marker = smokeMarker(ctx.mode, ctx.selfDir);
	const cwd = ctx.selfDir;
	const dir = mkdtempSync(join(tmpdir(), "s2-agent-smoke-"));
	const probePath = join(dir, "smoke-probe.ts");
	writeFileSync(probePath, TOOLS_ACTIVE_PROBE);
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
				});
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* */
		}
	}
	const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trim();
	const p = parseToolsProbeLine(result.stderr);
	if (!p.ok) {
		return {
			id,
			label,
			status: "fail",
			detail: `probe did not report (exit ${result.code})`,
			hint: `entry failed early, or an extension's handler blocked past the timeout. stderr tail: ${clean(result.stderr).slice(-180)}`,
		};
	}
	const v = p.value;
	if (v.matched > 0 && v.missing.length === 0 && v.activeCount > 0 && v.getActiveTools && v.getError === undefined) {
		// "run-dir" is the source of extensions in source/bundle mode only; an sh
		// deploy has no run-dir at all, and a detail line naming one sends the
		// operator to a directory that does not exist.
		const from = ctx.mode === "sh" ? "ext/ extensions loaded" : "run-dir extensions loaded";
		return { id, label, status: "pass", detail: `total=${v.total} matched=${v.matched} active=${v.activeCount} — ${from}` };
	}
	if (v.missing.length > 0 || v.activeCount === 0 || !v.getActiveTools || v.getError !== undefined) {
		return {
			id,
			label,
			status: "fail",
			detail: `total=${v.total} matched=${v.matched} active=${v.activeCount}${
				v.missing.length ? ` — core builtins MISSING from the active set: ${v.missing.join(", ")}` : ""
			}${v.activeCount === 0 && v.missing.length === 0 ? " — active toolset EMPTY" : ""}`,
			hint: "the #1946 class: something called setActiveTools with an empty/partial set (e.g. tool-gate's discovery read failing) — the model would have no read/write/edit/bash. Check the __s2GetAllToolDefinitions__ bridge and any before_agent_start mutator.",
		};
	}
	return {
		id,
		label,
		status: "fail",
		detail: `total=${v.total} matched=0 — NO run-dir extension tools registered`,
		hint: "silent load failure (the slice-bug class): verify cli.ts passes process.argv.slice(2) to main() AFTER applyPatches(), then re-run `bun bun-apps/s2-agent-ext-devops/scripts/run-test.ts medium`.",
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
	// A bun-run bundle IS its own entry file — every bundled module's
	// rewritten URL points at the one shipped s2-agent.js, so fileURLToPath
	// gives the real entry and selfDir gives the real deploy dir.
	// A `--snapshot` deploy shipping raw .ts also lands on "source", which
	// matches a --snapshot deploy (it ships raw .ts under src/), mirroring the
	// old coarseFromUrl's `.endsWith(".ts")` rule.
	const coarse = detectMode(moduleUrl);
	const entryPath = coarse === "bundle" ? fileURLToPath(moduleUrl) : join(selfDir, "cli.ts");
	// Annotated (not inferred) so an unused marker is a tsc error rather than an
	// excess property TypeScript silently tolerates on a variable. `.deploy-portable`
	// and `packages/` were still probed here after their modes were removed
	// precisely because an inferred object type made the leftovers invisible.
	// In a bundle selfDir IS the deploy dir already.
	const deployDir = selfDir;
	const markers: LayoutMarkers = {
		shDeploy: coarse === "bundle" && existsSync(join(deployDir, "deploy.json")),
	};
	const mode = classifyMode(coarse, markers);
	return {
		mode,
		selfDir,
		deployDir,
		entryPath,
		bundleCore: coarse === "bundle",
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
		out(`\x1b[1ms2-agent doctor\x1b[0m  (mode: ${report.mode})`);
		for (const c of report.checks) {
			out(`  ${color(c.status)}  ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
			if (c.hint) out(`         \x1b[2m↳ ${c.hint}\x1b[0m`);
		}
		out(report.ok ? "\n\x1b[32m✓ all hard checks passed\x1b[0m" : "\n\x1b[31m✗ one or more hard checks failed\x1b[0m");
	}
	return report;
}
