/**
 * oneshot-smoke — an ADAPTIVE boot-hang gate for the local CI suite.
 *
 * WHY THIS GATE EXISTS
 *   A one-shot `bun bun-apps/pi-agent/src/cli.ts -p '<prompt>'` hung 6+ minutes
 *   with the log frozen and CPU idle: static extension hermes-memory ran its
 *   startup `syncMarkdownMemories` (70 HTTP round-trips into a wedged surrealdb
 *   backend) BEFORE any model call. Three subagent dispatches (~1.5M tokens)
 *   were burned discovering what a 90-second capped probe would have caught.
 *   The known-good fast path is `-ne -ns` (cli-argv.ts `userSuppressFlags`
 *   suppresses run-dir extensions/skills AND the static factories incl.
 *   hermes; an explicit `-e <path>` still loads). This gate encodes that
 *   knowledge as two bounded probes so run_local_ci pays seconds, not sessions:
 *
 *   - FAST probe (default, ≤90s): boot with `-ne -ns` — proves the CLI core
 *     reaches a model call. This is the invocation every quick one-shot should
 *     use, so it is the invocation the gate asserts.
 *   - CANARY probe (≤180s, NO `-ne`): bare boot through the real static
 *     factories — the regression catcher for slow/wedged startup work like the
 *     hermes sync. Runs only when a boot input's hash changed, the last canary
 *     is >24h old, or force.
 *
 * ADAPTIVE, NOT ALWAYS-ON
 *   A boot probe costs real seconds, so the gate keeps a tiny state file
 *   (default bun-apps/pi-agent-ext-devops/.cache/oneshot-smoke.state.json,
 *   gitignored). Same input hash + a pass within 6h → SKIP(cached-pass) with
 *   zero spawns; steady-state cost is one sha256 over ~6 small files. Boot
 *   inputs that change the hash: pi-agent cli.ts / cli-argv.ts /
 *   static-extensions.ts, the hermes-memory entry (+impl), and this gate file.
 *
 * HANG-DETECTION MUST NOT FAIL ON MISSING CREDENTIALS
 *   A provider/API-key/model/auth failure that arrives FAST (≤10s, nonzero
 *   exit) means the boot itself completed — classify SKIP(provider-unavailable),
 *   never FAIL. Only timeouts and non-provider crashes fail the gate; a timeout
 *   FAIL carries the known root cause + the `-ne -ns -e <ext>` mitigation
 *   recipe and points at docs/agents/learnings.md.
 *
 * SEAMS (everything spawnable is injected; tests never spawn or touch network)
 *   - `classifyRun` / `shouldRun` are pure and exported for unit tests.
 *   - `runOneshotSmoke` takes the shared `SpawnFn` seam (src/spawn.ts), whose
 *     live impl carries the `timeoutMs` process-group kill this gate relies on.
 *   - Env overrides: DEVOPS_ONESHOT_SMOKE=force (rerun fast+canary now) or
 *     =skip (stand down entirely, exit 0). local-ci-cli has no generic --force
 *     flag, so the env var is the wired-in override.
 */
import { mkdir } from "node:fs/promises";
import type { SpawnFn } from "./spawn.js";

export const ONESHOT_SMOKE_GATE_NAME = "oneshot-smoke";

/** Bump to invalidate every cached state file (shape/semantics change). */
export const STATE_VERSION = 1;

/** A fast-probe pass is trusted for 6h before the gate re-probes. */
export const PASS_TTL_MS = 6 * 60 * 60 * 1000;
/** A canary (bare-boot) pass is trusted for 24h before it reruns. */
export const CANARY_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard wall-clock caps (ms) — the whole point of the gate. */
export const FAST_CAP_MS = 90_000;
export const CANARY_CAP_MS = 180_000;
/** A nonzero exit this fast whose output smells like provider/config = boot OK. */
export const PROVIDER_FAIL_FAST_MS = 10_000;

/** The prompt both probes send; the reply content is irrelevant, the boot is. */
export const SMOKE_PROMPT = "Reply with exactly: ok";

/**
 * Boot inputs hashed into `inputHash` (paths relative to the repo root).
 * `*` hermes entry: static-extensions.ts imports extensions/hermes-memory.ts
 * (a 1-line re-export shim), so BOTH the shim and the implementation are
 * hashed — a change to src/index.ts must flip the hash even though the shim's
 * own bytes never move. `resolveHermesInputs` picks whichever of the two
 * exists; zero existing is a hard input error.
 */
const PI_AGENT_CLI = "bun-apps/pi-agent/src/cli.ts";
const PI_AGENT_ARGV = "bun-apps/pi-agent/src/cli-argv.ts";
const PI_AGENT_STATIC = "bun-apps/pi-agent/src/static-extensions.ts";
const HERMES_SHIM = "bun-apps/pi-agent-ext-hermes-memory/extensions/hermes-memory.ts";
const HERMES_IMPL = "bun-apps/pi-agent-ext-hermes-memory/src/index.ts";
const SELF = "bun-apps/pi-agent-ext-devops/src/oneshot-smoke.ts";
/** This monorepo's marker: without it the gate is not applicable (foreign repoRoot). */
const DEVOPS_PKG = "bun-apps/pi-agent-ext-devops/package.json";

const PROVIDER_RE = /provider|api.?key|model|auth/i;

/** Persisted TTL cache. Times are epoch ms. */
export interface OneshotSmokeState {
	version: number;
	inputHash: string;
	lastPassTs: number;
	lastCanaryTs: number;
	lastDurationMs: number;
}

export type SmokeVerdict = "pass" | "skip" | "fail";

/** One probe outcome, already normalized from SpawnFn + a clock. */
export interface SmokeRun {
	exitCode: number;
	timedOut?: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface SmokeClassification {
	verdict: SmokeVerdict;
	/** Stable machine reason: ok | provider-unavailable | timeout | nonzero-exit | empty-stdout. */
	reason: string;
	/** Human-readable detail; on FAIL carries the diagnostic/tail. */
	detail?: string;
}

/**
 * The FAIL text attached to a timeout — the incident's known root cause, the
 * one-shot mitigation recipe, and the durable write-up. Printed by run_local_ci
 * gate output so the next session reads the fix instead of rediscovering it.
 */
export const BOOT_HANG_DIAGNOSTIC = [
	"BOOT HANG: the probe hit its wall-clock cap and was SIGKILLed.",
	"Known root cause (2026-08-15 incident): static extension hermes-memory runs startup",
	"syncMarkdownMemories (70 HTTP round-trips into a wedged surrealdb backend) BEFORE any",
	"model call, so the log freezes with CPU idle.",
	"Mitigation for one-shot runs: add `-ne -ns -e <ext>` — suppress run-dir extensions/skills",
	"AND static factories, then re-enable only the extension you need, e.g.",
	"  bun bun-apps/pi-agent/src/cli.ts -p '<prompt>' -ne -ns -e bun-apps/pi-agent-ext-<X>/extensions/<X>.ts",
	"Full incident + recipe: docs/agents/learnings.md (pi-agent one-shot boot hang).",
].join("\n");

/** Classify one probe outcome. Pure — no spawns, no clock, no filesystem. */
export function classifyRun(run: SmokeRun): SmokeClassification {
	if (run.timedOut) {
		return { verdict: "fail", reason: "timeout", detail: BOOT_HANG_DIAGNOSTIC };
	}
	if (run.exitCode === 0) {
		if (run.stdout.trim().length > 0) return { verdict: "pass", reason: "ok" };
		// Exit 0 with zero stdout is not a boot we can vouch for — fail loud
		// rather than trust silence.
		return { verdict: "fail", reason: "empty-stdout", detail: tail(run) };
	}
	if (
		run.durationMs <= PROVIDER_FAIL_FAST_MS &&
		PROVIDER_RE.test(`${run.stdout}\n${run.stderr}`)
	) {
		return {
			verdict: "skip",
			reason: "provider-unavailable",
			detail: "fast provider/auth failure — boot itself completed (hang detector must not fail on missing credentials)",
		};
	}
	return { verdict: "fail", reason: "nonzero-exit", detail: tail(run) };
}

function tail(run: SmokeRun): string {
	const out = `${run.stdout}\n${run.stderr}`.trim();
	return out.length > 2000 ? `…${out.slice(-2000)}` : out;
}

export type SmokeMode = "skip-cached" | "fast-only" | "fast+canary";

export interface ShouldRunResult {
	mode: SmokeMode;
	reason: string;
}

/**
 * Decide what to run, cheapest-safe-first. Pure — the entire adaptive policy
 * in one function:
 *   1. force                → fast+canary
 *   2. no/foreign/stale-hash state → fast+canary (inputs changed: re-canary)
 *   3. canary >24h old      → fast+canary (wedges develop without code changes)
 *   4. pass ≤6h old         → skip-cached (the CI-fast path)
 *   5. else                 → fast-only (pass expired, canary still fresh)
 * Canary conditions outrank the pass cache on purpose: a fresh fast-pass must
 * never silence a stale canary — the hermes wedge lived exactly there.
 */
export function shouldRun(
	state: OneshotSmokeState | null,
	currentHash: string,
	now: number,
	opts: { force?: boolean } = {},
): ShouldRunResult {
	if (opts.force) return { mode: "fast+canary", reason: "forced" };
	if (!state) return { mode: "fast+canary", reason: "no prior state" };
	if (state.version !== STATE_VERSION) return { mode: "fast+canary", reason: "state version mismatch" };
	if (state.inputHash !== currentHash) return { mode: "fast+canary", reason: "boot inputs changed since last pass" };
	if (now - state.lastCanaryTs > CANARY_TTL_MS) {
		return { mode: "fast+canary", reason: `canary stale (>${Math.round(CANARY_TTL_MS / 3_600_000)}h old)` };
	}
	if (now - state.lastPassTs <= PASS_TTL_MS) {
		const h = ((now - state.lastPassTs) / 3_600_000).toFixed(1);
		return { mode: "skip-cached", reason: `cached-pass ${h}h ago, ${state.lastDurationMs}ms` };
	}
	return { mode: "fast-only", reason: "pass-cache expired, canary fresh" };
}

export interface OneshotSmokeResult {
	/** 0 for pass/skip, 1 for fail — the run_local_ci gates-table contract. */
	exitCode: number;
	verdict: SmokeVerdict;
	mode: SmokeMode | "env-skip" | "not-applicable";
	/** One-liner for the gates table (e.g. `skip (cached-pass 2.1h ago, 4103ms)`). */
	note: string;
	/** Multi-line diagnostics on FAIL (timeout recipe / captured tail). */
	detail?: string;
	durationMs: number;
}

export interface OneshotSmokeOptions {
	repoRoot: string;
	spawn: SpawnFn;
	/** Injectable clock (default Date.now). */
	now?: () => number;
	/** State-file path (default `<repoRoot>/bun-apps/pi-agent-ext-devops/.cache/oneshot-smoke.state.json`). */
	statePath?: string;
	/** Env to read DEVOPS_ONESHOT_SMOKE from (default process.env). */
	env?: Record<string, string | undefined>;
	force?: boolean;
}

class InputError extends Error {}

/** sha256 over `path\0content` of every existing input (deterministic order). */
export async function computeInputHash(repoRoot: string): Promise<string> {
	const paths = [PI_AGENT_CLI, PI_AGENT_ARGV, PI_AGENT_STATIC, ...resolveHermesInputs(), SELF];
	const hasher = new Bun.CryptoHasher("sha256");
	for (const rel of paths) {
		const file = Bun.file(`${repoRoot}/${rel}`);
		if (!(await file.exists())) throw new InputError(`oneshot-smoke input missing: ${rel}`);
		hasher.update(rel);
		hasher.update("\0");
		hasher.update(await file.text());
		hasher.update("\0");
	}
	return hasher.digest("hex");
}

function resolveHermesInputs(): string[] {
	// Both are hashed when both exist (shim content never moves; impl does).
	return [HERMES_SHIM, HERMES_IMPL];
}

export async function readState(path: string): Promise<OneshotSmokeState | null> {
	try {
		const raw = JSON.parse(await Bun.file(path).text()) as Partial<OneshotSmokeState>;
		if (
			typeof raw.version !== "number" ||
			typeof raw.inputHash !== "string" ||
			typeof raw.lastPassTs !== "number" ||
			typeof raw.lastCanaryTs !== "number" ||
			typeof raw.lastDurationMs !== "number"
		) {
			return null;
		}
		return raw as OneshotSmokeState;
	} catch {
		// Missing or garbage state = no state: rerun the probes.
		return null;
	}
}

export async function writeState(path: string, state: OneshotSmokeState): Promise<void> {
	const dir = path.slice(0, path.lastIndexOf("/"));
	await mkdir(dir, { recursive: true });
	await Bun.write(path, `${JSON.stringify(state, null, "\t")}\n`);
}

/**
 * Run the adaptive gate. Returns null when `repoRoot` is not this monorepo
 * (no pi-agent-ext-devops package) — the gate is simply not applicable there,
 * which also keeps runLocalCi's foreign-repoRoot unit tests spawn-free. Never
 * throws: every failure is a structured FAIL result.
 */
export async function runOneshotSmoke(opts: OneshotSmokeOptions): Promise<OneshotSmokeResult | null> {
	const now = opts.now ?? Date.now;
	const startedAt = now();

	// Not this monorepo → not applicable (no boot target to guard).
	if (!(await Bun.file(`${opts.repoRoot}/${DEVOPS_PKG}`).exists())) return null;

	const env = opts.env ?? process.env;
	const envFlag = env.DEVOPS_ONESHOT_SMOKE;
	if (envFlag === "skip") {
		return { exitCode: 0, verdict: "skip", mode: "env-skip", note: "skip (DEVOPS_ONESHOT_SMOKE=skip)", durationMs: now() - startedAt };
	}

	const statePath =
		opts.statePath ?? `${opts.repoRoot}/bun-apps/pi-agent-ext-devops/.cache/oneshot-smoke.state.json`;

	try {
		const tHash = now();
		const inputHash = await computeInputHash(opts.repoRoot);
		const state = await readState(statePath);
		const plan = shouldRun(state, inputHash, now(), { force: opts.force || envFlag === "force" });

		if (plan.mode === "skip-cached") {
			return {
				exitCode: 0,
				verdict: "skip",
				mode: plan.mode,
				note: `skip (${plan.reason})`,
				durationMs: now() - startedAt,
			};
		}

		const cli = `${opts.repoRoot}/${PI_AGENT_CLI}`;
		const parts: string[] = [];
		let next = state ? { ...state } : null;

		// FAST probe — the `-ne -ns` known-good one-shot invocation.
		{
			const t0 = now();
			const r = await opts.spawn("bun", [cli, "-p", SMOKE_PROMPT, "-ne", "-ns"], {
				cwd: opts.repoRoot,
				timeoutMs: FAST_CAP_MS,
			});
			const fastMs = now() - t0;
			const c = classifyRun({ ...r, durationMs: fastMs });
			if (c.verdict === "fail") {
				return failResult("fast", c, plan, now() - startedAt);
			}
			parts.push(c.verdict === "pass" ? `fast ${fmtMs(fastMs)}` : `fast ${c.reason} ${fmtMs(fastMs)}`);
			// A fast pass OR a fast provider-skip both prove the boot completed.
			next = {
				version: STATE_VERSION,
				inputHash,
				lastPassTs: now(),
				lastCanaryTs: state?.lastCanaryTs ?? 0,
				lastDurationMs: fastMs,
			};
		}

		// CANARY probe — bare boot (NO `-ne`): static factories load for real.
		// `-ns` stays: run-dir skills are session config, not boot code under test.
		if (plan.mode === "fast+canary") {
			const t0 = now();
			const r = await opts.spawn("bun", [cli, "-p", SMOKE_PROMPT, "-ns"], {
				cwd: opts.repoRoot,
				timeoutMs: CANARY_CAP_MS,
			});
			const canaryMs = now() - t0;
			const c = classifyRun({ ...r, durationMs: canaryMs });
			if (c.verdict === "fail") {
				return failResult("canary", c, plan, now() - startedAt);
			}
			parts.push(c.verdict === "pass" ? `canary ${fmtMs(canaryMs)}` : `canary ${c.reason} ${fmtMs(canaryMs)}`);
			// Only a CLEAN canary pass refreshes lastCanaryTs — a provider-skip
			// leaves it stale so the next run retries the bare boot (bounded by
			// CANARY_CAP_MS; a provider-down day costs seconds per run, not truth).
			if (c.verdict === "pass" && next) {
				next.lastCanaryTs = now();
			}
		}

		if (next) await writeState(statePath, next);

		const verdict: SmokeVerdict = parts.every((p) => !p.includes("provider-unavailable")) ? "pass" : "skip";
		return {
			exitCode: 0,
			verdict,
			mode: plan.mode,
			note: `${verdict} (${parts.join("; ")})`,
			durationMs: now() - startedAt,
		};
	} catch (e) {
		// e.g. a hashed input disappeared (rename) — fail loud with the path so
		// the list gets fixed instead of the gate silently going blind.
		return {
			exitCode: 1,
			verdict: "fail",
			mode: "fast+canary",
			note: "fail (gate inputs unreadable)",
			detail: (e as Error).message,
			durationMs: now() - startedAt,
		};
	}
}

function failResult(kind: string, c: SmokeClassification, plan: ShouldRunResult, durationMs: number): OneshotSmokeResult {
	return {
		exitCode: 1,
		verdict: "fail",
		mode: plan.mode,
		note: `fail (${kind} probe: ${c.reason})`,
		detail: c.detail,
		durationMs,
	};
}

function fmtMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
