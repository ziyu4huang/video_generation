/**
 * `doctor` — cross-machine portability self-check.
 *
 * A fresh-machine failure in the pi-* stack usually surfaces as an opaque
 * `ENOENT` / `ECONNREFUSED` deep in a run. `doctor` checks the boundary
 * conditions up front (runtime, repo layout, run-dir manifest, model/output
 * dirs, flux2 binary, vault, LM Studio, ~/.pi/agent) and prints an actionable
 * checklist so the user knows exactly what to set.
 *
 * Design: each check is a PURE function over an injectable `DoctorContext`,
 * so the classification logic is unit-testable without spawning processes or
 * touching the real filesystem. `run()` wires the real process state in.
 *
 * The path/env resolution intentionally REPLICATES s2-agent-ext-flux2's
 * `resolveOutputDir` / `resolveModelsRoot` contract (env override → computed
 * default) rather than importing it: a diagnostic tool must run even when the
 * packages it diagnoses are broken, and an independent copy doubles as a
 * contract check (doctor confirms the env vars resolve the same way flux2
 * would resolve them).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import type { ParsedArgs } from "../args.ts";
// The doctor result contract (CheckStatus / CheckResult / isFailing) is shared
// with the package-level doctor two directories up (src/doctor.ts) — same
// shape, single source of truth. The CHECK surfaces differ (this doctor =
// fresh-machine MLX/flux2/vault/LM-Studio portability; the package-level one =
// deploy-mode/patch health), so the check functions + DoctorContext stay local.
// Re-exported here so existing imports from `../commands/doctor.ts`
// (doctor.test.ts) keep resolving.
import {
	isFailing,
	type CheckStatus,
	type CheckResult,
} from "../../doctor.ts";

export { isFailing, type CheckStatus, type CheckResult };

/** Injectable environment so checks are pure and unit-testable. */
export interface DoctorContext {
	cwd: string;
	env: Record<string, string | undefined>;
	bunVersion: string;
	/** Path-existence probe (override in tests). */
	exists: (p: string) => boolean;
	/** LM Studio reachability probe (override in tests). */
	probeLmStudio: (baseUrl: string) => Promise<boolean>;
}

export interface DoctorReport {
	checks: CheckResult[];
	ok: boolean;
}

/** Walk up from `start` to the nearest dir containing a `bun-apps/` subdir. */
export function findRepoRoot(start: string, exists: (p: string) => boolean): string | undefined {
	let dir = resolve(start);
	for (;;) {
		if (exists(join(dir, "bun-apps"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Replicate flux2 resolveOutputDir (env MLX_OUTPUT_DIR → repo/../video_generation__output). */
function resolveOutputDir(repoRoot: string, env: Record<string, string | undefined>): string {
	const override = env.MLX_OUTPUT_DIR;
	if (override && override.length > 0) return resolve(override);
	return resolve(repoRoot, "..", "video_generation__output");
}

/** Replicate flux2 resolveModelsRoot (env MLX_MODELS_DIR → repo/mmlx-models). */
function resolveModelsRoot(repoRoot: string, env: Record<string, string | undefined>): string {
	const override = env.MLX_MODELS_DIR;
	if (override && override.length > 0) return resolve(override);
	return resolve(repoRoot, "mlx-models");
}

/** Read + parse a JSON file, returning undefined on any error. */
function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

// --- individual checks (pure, return CheckResult) ----------------------------

export function checkRuntime(ctx: DoctorContext): CheckResult {
	const v = ctx.bunVersion;
	if (!v || v.length === 0) {
		return { id: "runtime", label: "Bun runtime", status: "fail", hint: "Bun.version is empty — are you running under Bun?" };
	}
	return { id: "runtime", label: "Bun runtime", status: "pass", detail: `Bun ${v}` };
}

export function checkRepoRoot(ctx: DoctorContext): { result: CheckResult; repoRoot?: string } {
	const root = findRepoRoot(ctx.cwd, ctx.exists);
	if (!root) {
		return {
			result: {
				id: "repo-root",
				label: "Repo root (bun-apps/)",
				status: "fail",
				detail: `cwd: ${ctx.cwd}`,
				hint: "Run from the repo, or set MLX_MODELS_DIR / MLX_OUTPUT_DIR to absolute paths.",
			},
		};
	}
	return { result: { id: "repo-root", label: "Repo root (bun-apps/)", status: "pass", detail: root }, repoRoot: root };
}

export function checkRunDir(ctx: DoctorContext, repoRoot: string): CheckResult {
	const manifestPath = join(repoRoot, "bun-apps", "s2-agent", "run-dir", "manifest.json");
	const raw = readJson(manifestPath);
	if (!raw || typeof raw !== "object") {
		return {
			id: "run-dir",
			label: "run-dir manifest",
			status: "warn",
			detail: `not found / unreadable: ${manifestPath}`,
			hint: "Extensions will only load if explicitly passed -e/--skill.",
		};
	}
	// The manifest's `extensions` array is MIXED-TYPE: plain strings (most
	// entries) AND objects ({ name, entry, version }) for entries that
	// carry declared metadata. The canonical resolver
	// (s2-agent/run-dir/resolve.ts) normalizes via `typeof e === "string" ? e :
	// e?.entry`; doctor must do the same or `join(bunApps, <object>)` throws.
	// Skills are always plain strings (no metadata objects today).
	const m = raw as {
		extensions?: (string | { entry?: string; name?: string })[];
		skills?: string[];
	};
	const bunApps = join(repoRoot, "bun-apps");
	const missing: string[] = [];
	for (const entry of m.extensions ?? []) {
		const rel = typeof entry === "string" ? entry : entry?.entry;
		if (!rel) continue; // malformed object without `entry` — skip, don't crash
		if (!ctx.exists(join(bunApps, rel))) missing.push(rel);
	}
	for (const rel of m.skills ?? []) {
		if (!ctx.exists(join(bunApps, rel))) missing.push(rel + "/");
	}
	if (missing.length === 0) {
		return { id: "run-dir", label: "run-dir manifest", status: "pass", detail: `${(m.extensions?.length ?? 0) + (m.skills?.length ?? 0)} entries resolve` };
	}
	return {
		id: "run-dir",
		label: "run-dir manifest",
		status: "warn",
		detail: `missing: ${missing.join(", ")}`,
		hint: "These extensions/skills won't load. Rebuild or restore the bun-apps/ tree.",
	};
}

export function checkOutputDir(ctx: DoctorContext, repoRoot: string): CheckResult {
	const dir = resolveOutputDir(repoRoot, ctx.env);
	if (ctx.exists(dir)) return { id: "output-dir", label: "MLX output dir", status: "pass", detail: dir };
	return {
		id: "output-dir",
		label: "MLX output dir",
		status: "warn",
		detail: `${dir} (absent — will be auto-created on first write)`,
		hint: "Set MLX_OUTPUT_DIR, or `doctor --fix` to create the default now.",
	};
}

export function checkModelsDir(ctx: DoctorContext, repoRoot: string): CheckResult {
	const dir = resolveModelsRoot(repoRoot, ctx.env);
	if (ctx.exists(dir)) return { id: "models-dir", label: "MLX models dir", status: "pass", detail: dir };
	return {
		id: "models-dir",
		label: "MLX models dir",
		status: "fail",
		detail: `${dir} (absent — generation cannot run)`,
		hint: "Set MLX_MODELS_DIR to your model tree, or place it at <repo>/mlx-models.",
	};
}

export function checkFlux2Binary(ctx: DoctorContext, repoRoot: string): CheckResult {
	const binEnv = ctx.env.FLUX2_BIN;
	if (binEnv) {
		return ctx.exists(binEnv)
			? { id: "flux2-binary", label: "flux2 binary", status: "pass", detail: `$FLUX2_BIN → ${binEnv}` }
			: { id: "flux2-binary", label: "flux2 binary", status: "warn", detail: `$FLUX2_BIN → ${binEnv} (absent)`, hint: "Unset FLUX2_BIN or point it at the binary." };
	}
	const defaultBin = join(repoRoot, "swift", "flux2-image-director", ".build", "release", "flux2");
	if (ctx.exists(defaultBin)) return { id: "flux2-binary", label: "flux2 binary", status: "pass", detail: defaultBin };
	return {
		id: "flux2-binary",
		label: "flux2 binary",
		status: "warn",
		detail: "not built",
		hint: "Optional — auto-builds on first flux2 use (slow). Set FLUX2_BIN to skip discovery.",
	};
}

export function checkVault(ctx: DoctorContext): CheckResult {
	const vaultPath = ctx.env.OB_VAULT_PATH;
	const vaultDir = ctx.env.OB_VAULT_DIR ?? "vault";
	if (vaultPath) {
		return ctx.exists(vaultPath)
			? { id: "vault", label: "Obsidian vault", status: "pass", detail: `$OB_VAULT_PATH → ${vaultPath}` }
			: { id: "vault", label: "Obsidian vault", status: "warn", detail: `$OB_VAULT_PATH → ${vaultPath} (absent)`, hint: "Point OB_VAULT_PATH at an existing vault." };
	}
	const local = resolve(ctx.cwd, vaultDir);
	if (ctx.exists(local)) return { id: "vault", label: "Obsidian vault", status: "info", detail: `./${vaultDir} (fallback-create tier)` };
	return { id: "vault", label: "Obsidian vault", status: "info", detail: `none — ./${vaultDir} auto-created on first use` };
}

export async function checkLmStudio(ctx: DoctorContext): Promise<CheckResult> {
	const baseUrl = ctx.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234/v1";
	const ok = await ctx.probeLmStudio(baseUrl);
	if (ok) return { id: "lm-studio", label: "LM Studio", status: "pass", detail: `${baseUrl} reachable` };
	return {
		id: "lm-studio",
		label: "LM Studio",
		status: "warn",
		detail: `${baseUrl} not reachable`,
		hint: "Optional — only needed for local VLM / distill. Start LM Studio or set LM_STUDIO_BASE_URL.",
	};
}

export function checkProvider(ctx: DoctorContext): CheckResult {
	const provider = ctx.env.PI_PROVIDER ?? "(baked default)";
	const model = ctx.env.PI_MODEL ?? "(baked default)";
	return { id: "provider", label: "LLM provider/model", status: "info", detail: `${provider} / ${model}` };
}

export function checkPiHome(ctx: DoctorContext): CheckResult {
	const agentDir = ctx.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	if (!ctx.exists(agentDir)) {
		return {
			id: "pi-home",
			label: "~/.pi/agent",
			status: "warn",
			detail: `${agentDir} (absent — created on first run)`,
			hint: "`doctor --fix` will create it now.",
		};
	}
	return { id: "pi-home", label: "~/.pi/agent", status: "pass", detail: agentDir };
}

// --- orchestration ------------------------------------------------------------

/** Run all checks against a context. Order is the display order. */
export async function runAllChecks(ctx: DoctorContext): Promise<CheckResult[]> {
	const out: CheckResult[] = [];
	out.push(checkRuntime(ctx));
	const { result: repoResult, repoRoot } = checkRepoRoot(ctx);
	out.push(repoResult);
	if (repoRoot) {
		out.push(checkRunDir(ctx, repoRoot));
		out.push(checkOutputDir(ctx, repoRoot));
		out.push(checkModelsDir(ctx, repoRoot));
		out.push(checkFlux2Binary(ctx, repoRoot));
	}
	out.push(checkVault(ctx));
	out.push(await checkLmStudio(ctx));
	out.push(checkProvider(ctx));
	out.push(checkPiHome(ctx));
	return out;
}

const SYMBOL: Record<CheckStatus, string> = {
	pass: "✓",
	warn: "✗",
	fail: "✗",
	info: "·",
};

/** Print the human-readable checklist (status lines to stderr, summary to stdout). */
function printReport(results: CheckResult[]): void {
	for (const r of results) {
		const tag = r.status.toUpperCase().padEnd(4);
		console.error(`${SYMBOL[r.status]} [${tag}] ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
		if (r.hint) console.error(`          ↳ ${r.hint}`);
	}
	const fails = results.filter(isFailing).length;
	const warns = results.filter((r) => r.status === "warn").length;
	if (fails === 0 && warns === 0) {
		console.log(`\nAll checks passed (${results.length}).`);
	} else {
		console.log(`\n${fails} failing, ${warns} warning(s), ${results.length} total.`);
	}
}

/** Real LM Studio reachability probe: GET /models with a short timeout. */
async function realProbeLmStudio(baseUrl: string): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 1500);
		const url = baseUrl.replace(/\/$/, "") + "/models";
		// bun-types' ambient `Response` interface falls back to a stripped
		// BunResponseOverride (no `.ok`/`.status`) unless "DOM" is in tsconfig
		// lib — this package's `lib: ["ESNext"]` doesn't include it. Narrow to
		// the one field we need instead of widening the whole package's lib.
		const res = (await fetch(url, { signal: ctrl.signal })) as unknown as { status: number };
		clearTimeout(timer);
		return res.status >= 200 && res.status < 300;
	} catch {
		return false;
	}
}

/** Apply `--fix`: create the output dir and ~/.pi/agent if missing. */
function applyFix(results: CheckResult[], ctx: DoctorContext): string[] {
	const fixed: string[] = [];
	const repo = findRepoRoot(ctx.cwd, ctx.exists);
	if (results.find((r) => r.id === "output-dir" && r.status === "warn") && repo) {
		try {
			mkdirSync(resolveOutputDir(repo, ctx.env), { recursive: true });
			fixed.push("output-dir");
		} catch { /* ignore — recheck reports it */ }
	}
	if (results.find((r) => r.id === "pi-home" && r.status === "warn")) {
		try {
			const dir = ctx.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
			mkdirSync(dir, { recursive: true });
			fixed.push("pi-home");
		} catch { /* ignore */ }
	}
	return fixed;
}

export const doctorCommand = {
	name: "doctor",
	summary: "meta: cross-machine portability self-check (env, paths, deps)",
	details: `Usage:
  s2-agent cli doctor [--json] [--fix]

Checks the boundary conditions the pi-* stack needs on a fresh machine:
runtime, repo layout, run-dir manifest, MLX output/models dirs, flux2 binary,
Obsidian vault, LM Studio reachability, LLM provider/model, ~/.pi/agent.

Exit code is 1 if any check FAILS (warnings do not fail). 'info' lines are
purely informational.

Options:
  --json    Emit a single JSON object { checks, ok } to stdout (no checklist)
  --fix     Auto-create the MLX output dir and ~/.pi/agent if missing, then re-check`,
	async run(parsed: ParsedArgs): Promise<void> {
		const json = parsed.rest.includes("--json");
		const fix = parsed.rest.includes("--fix");

		const ctx: DoctorContext = {
			cwd: process.cwd(),
			env: process.env as Record<string, string | undefined>,
			bunVersion: String(Bun.version),
			exists: existsSync,
			probeLmStudio: realProbeLmStudio,
		};

		let results = await runAllChecks(ctx);
		if (fix) {
			applyFix(results, ctx);
			results = await runAllChecks(ctx);
		}
		const ok = !results.some(isFailing);

		if (json) {
			console.log(JSON.stringify({ checks: results, ok }));
		} else {
			printReport(results);
		}
		if (!ok) process.exitCode = 1;
	},
};
