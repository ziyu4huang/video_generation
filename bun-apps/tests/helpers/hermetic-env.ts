/**
 * Shared hermetic-env helper for tests that assert on config-derived defaults.
 *
 * The agent harness + extensions inject config-mutating env vars into a LIVE
 * session (e.g. `PI_HERMES_CONSOLIDATING` flips hermes `loadConfig` to
 * consolidated defaults; `TOOL_GATE_LOG_PATH` changes tool-gate config). Tests
 * that pass in CI's clean env but FLAKE locally (the "#938 class") MUST run
 * with these cleared. This helper snapshots + deletes the known set in
 * beforeEach and restores them exactly in afterEach — runner-agnostic (pure
 * process.env manipulation; works under bun:test AND node:test).
 *
 * Usage:
 *   import { clearHarnessEnvVars, restoreHarnessEnvVars } from "../helpers/hermetic-env.js";
 *   let envSnap: Record<string, string | undefined>;
 *   beforeEach(() => { envSnap = clearHarnessEnvVars(); });
 *   afterEach(() => { restoreHarnessEnvVars(envSnap); });
 *
 * If a test legitimately needs one of these vars SET, set it in the test body
 * AFTER clearHarnessEnvVars — the clear only establishes a clean baseline; the
 * test's own assignment wins until afterEach restores the pre-test value.
 *
 * Wayfinder 2026-07-30-self-reflection-to-fix-these-error — the deferred gap
 * from ticket 01 (the env-var-mutating hermeticity class stayed convention-only
 * because it's false-positive-prone for a BLOCKING audit; this helper reduces
 * the friction of applying the proven snapshot+delete+restore convention).
 */

/**
 * The config-mutating env vars the harness / extensions inject into a live
 * session. Tests asserting on config-derived defaults must run with these
 * cleared. Extensible — append newly-discovered config-mutating vars here.
 */
export const HARNESS_CONFIG_ENV_VARS = [
	"PI_HERMES_CONSOLIDATING", // hermes loadConfig → consolidated defaults
	"TOOL_GATE_LOG_PATH", // tool-gate config (telemetry log path)
] as const;

export type EnvSnapshot = Record<string, string | undefined>;

/**
 * Snapshot the current value (string | undefined) of every harness config env
 * var, then delete them all. Returns the snapshot for `restoreHarnessEnvVars`.
 * Call in `beforeEach`.
 */
export function clearHarnessEnvVars(): EnvSnapshot {
	const snap: EnvSnapshot = {};
	for (const name of HARNESS_CONFIG_ENV_VARS) {
		snap[name] = process.env[name];
		delete process.env[name];
	}
	return snap;
}

/**
 * Restore the snapshot from `clearHarnessEnvVars` — a var that was `undefined`
 * is deleted (NOT set to the string "undefined"); a var that had a value is
 * restored exactly. Call in `afterEach`.
 */
export function restoreHarnessEnvVars(snap: EnvSnapshot): void {
	for (const name of HARNESS_CONFIG_ENV_VARS) {
		const val = snap[name];
		if (val === undefined) delete process.env[name];
		else process.env[name] = val;
	}
}
