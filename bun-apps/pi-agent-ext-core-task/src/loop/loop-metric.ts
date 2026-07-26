/**
 * Loop 3 metric execution. parseMetric is pure; runMeasure is the pi.exec
 * boundary (the agent never self-reports a number — the orchestrator measures).
 */

export const MEASURE_TIMEOUT_MS = 60_000;
const LAST_NUMBER_RE = /-?\d+(?:\.\d+)?/g;

/** Extract the last numeric token from stdout (audit project's parseMetric rule). */
export function parseMetric(stdout: string): number | null {
	const matches = stdout.match(LAST_NUMBER_RE);
	if (!matches || matches.length === 0) return null;
	return Number(matches[matches.length - 1]);
}

/**
 * Minimal slice of ExtensionAPI that runMeasure needs. Kept local (rather than
 * importing ExtensionAPI from @earendil-works/pi-coding-agent) so this module —
 * and its tests — stay decoupled from pi and trivially fakeable.
 * (Mirrors the GoalPersistenceApi pattern in goal/persistence.ts.)
 */
export interface LoopMetricApi {
	exec: (
		prog: string,
		args: string[],
		opts: { cwd: string; timeout: number },
	) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
}

/**
 * Run the user's measure command and parse a metric from stdout.
 * Returns null on exec failure, non-zero exit, or no number — caller treats
 * null per the measure-failure policy (≥3 consecutive -> stop).
 */
export async function runMeasure(
	api: LoopMetricApi | undefined,
	cmd: string,
	cwd: string,
): Promise<number | null> {
	if (!api?.exec) return null;
	try {
		const result = await api.exec("bash", ["-c", cmd], { cwd, timeout: MEASURE_TIMEOUT_MS });
		if (result.exitCode !== undefined && result.exitCode !== 0) return null;
		return parseMetric(result.stdout ?? "");
	} catch {
		return null;
	}
}
