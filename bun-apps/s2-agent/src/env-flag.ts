/**
 * env-flag.ts — the one boolean-env-flag leaf (effort
 * 2026-08-25-s2-agent-simplify-round2 ticket 05).
 *
 * envFlag lived as the exported decision primitive of patches/index.ts, while
 * narrower hand-rolls drifted into cli/sessions/shared.ts (PI_SKIP_MODELS_JSON)
 * and __tests__/e2e-harness.ts (PI_AGENT_E2E) — places that cannot import the
 * patches index (it pulls the whole PATCH_TABLE graph; the harness must stay
 * loadable before any patch runs). Re-hosted here with ZERO imports so every
 * consumer shares one definition; patches/index.ts re-exports it unchanged.
 *
 * Deliberate semantic widening accepted at migration (flagged in the ticket-05
 * PR): the two former hand-rolls matched "1"/"true" (and "yes") case-SENSITIVELY
 * only — envFlag also accepts "TRUE"/"Yes" etc. Opt-in boolean flags only; no
 * caller ever distinguished case.
 */

/**
 * Read a boolean env flag. Accepts "1" / "true" / "yes" (case-insensitive) as
 * truthy; any other set value is false; undefined → fallback. Pure given `env`.
 * This is the decision primitive for every patch gate — exactly the logic that
 * silently breaks.
 */
export function envFlag(
	name: string,
	fallback: boolean,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const v = env[name];
	if (v === undefined) return fallback;
	return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}
