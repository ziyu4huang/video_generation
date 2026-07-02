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
 * Design (mirrors bun-apps/pi-agent-cli/src/commands/doctor.ts): each check is
 * a PURE function over an injectable `DoctorContext`, so the classification is
 * unit-testable without spawning or touching the real fs. `run()` wires real
 * process state. Invoke via `bun src/cli.ts doctor [--json]` or `./run.sh doctor`.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
			hint: "rebuild: `bun scripts/build.ts` (source) or re-deploy",
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
	const need = ["typebox", "@earendil-works/pi-coding-agent"];
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

// ── real wiring ──────────────────────────────────────────────────────────────
export interface RunOptions {
	json?: boolean;
}

/** Build the real DoctorContext from process state + the module's location. */
export function realContext(moduleUrl: string, env: Record<string, string | undefined>): DoctorContext {
	const coarse = coarseFromUrl(moduleUrl);
	const selfDir = dirname(fileURLToPath(moduleUrl));
	const entryPath =
		coarse === "source"
			? join(selfDir, "cli.ts")
			: join(selfDir, "pi-agent.js");
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
	const report = runChecks(realContext(import.meta.url, process.env));
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
