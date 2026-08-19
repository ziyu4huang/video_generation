/**
 * default-model-env — bridge pi-agent-cli's PI_MODEL / PI_PROVIDER /
 * PI_THINKING env overrides into the real pi TUI's argv.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The real pi TUI resolves its default model ONLY from
 * `~/.pi/agent/settings.json` (defaultModel / defaultProvider); it does NOT
 * read PI_MODEL / PI_PROVIDER / PI_THINKING (confirmed: zero hits for those
 * names in the pi-coding-agent dist). pi-agent-cli (the reimplementation in
 * this repo) DOES honor those env vars. So the same `PI_MODEL=...` that works
 * for pi-agent-cli was silently ignored by pi-agent — the wrapper kept
 * falling back to whatever pi's settings.json default was, defeating the
 * custom-provider ergonomics for anyone who lives in the interactive TUI.
 *
 * This patch closes that asymmetry: when the user hasn't passed the flag
 * explicitly, splice the env value into argv so pi honors it. The values pass
 * through pi's own parser, so pi still validates them (e.g. a bad --thinking
 * level is rejected by pi, not silently accepted here).
 *
 * MODE GATING
 * -----------
 * Mode-agnostic (source + bundle + binary): unlike skip-update-check (an
 * artifact-noise concern), an env model override is useful in every mode.
 * No-op when none of the three env vars are set, or when the corresponding
 * flag is already on the command line.
 *
 * TESTABILITY
 * -----------
 * resolveEnvBridges() is pure (argv + env in, tokens out); the import-time
 * side effect just calls it and splices. Mirrors the resolvePatchPlan split.
 */
export interface BridgeEntry {
	/** env var to read (e.g. "PI_MODEL"). */
	env: string;
	/** argv flag to emit (e.g. "--model"). */
	flag: string;
}

/**
 * The three env overrides pi-agent-cli honors, bridged to the real pi TUI.
 * pi accepts all three long flags and the `provider/id:thinking` shorthand.
 */
export const BRIDGES: readonly BridgeEntry[] = [
	{ env: "PI_MODEL", flag: "--model" },
	{ env: "PI_PROVIDER", flag: "--provider" },
	{ env: "PI_THINKING", flag: "--thinking" },
];

/**
 * Pure: which argv tokens WOULD be spliced for a given env + argv, without
 * touching process.argv. Returns a flat array (flag, value, flag, value, …).
 * Skips a bridge when its env var is unset OR the flag is already present in
 * either space form (`--model x`) or `=` form (`--model=x`).
 */
export function resolveEnvBridges(
	argv: readonly string[],
	env: Record<string, string | undefined> = process.env,
	bridges: readonly BridgeEntry[] = BRIDGES,
): string[] {
	const extra: string[] = [];
	for (const { env: key, flag } of bridges) {
		const val = env[key];
		if (!val) continue;
		const prefix = flag + "=";
		// argv is scanned as-is; the flag can't appear in nodePath/scriptPath.
		if (argv.some((a) => a === flag || a.startsWith(prefix))) continue;
		extra.push(flag, val);
	}
	return extra;
}

// Import-time side effect: splice the bridged flags into argv before main()
// reads it. Position 2 = just after [nodePath, scriptPath], ahead of any user
// args (pi parses flags position-independently, so splice order is cosmetic).
const extra = resolveEnvBridges(process.argv);
if (extra.length) {
	process.argv.splice(2, 0, ...extra);
}

if (
	extra.length &&
	(process.env.BUN_PI_DEBUG_PATCHES === "1" ||
		process.env.BUN_PI_DEBUG_PATCHES === "true")
) {
	console.error("[bun-pi] default-model-env spliced argv:", extra);
}
