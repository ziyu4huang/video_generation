import type { ConvergeMetrics } from "./types.ts";

const MIN_N = 20;
const MAX_N = 200;

export function adjustThreshold(
	metrics: ConvergeMetrics,
	currentN: number,
	converged: number,
): { newN: number; delta: number; reason: string } {
	const killRate = metrics.candidates > 0 ? metrics.killed / metrics.candidates : 0;
	const passRate = metrics.survivors > 0 ? converged / metrics.survivors : 1;

	let delta: number;
	let reason: string;

	if (metrics.survivors === 0) {
		delta = 0;
		reason = "stable (all killed at gate, nothing converged)";
	} else if (killRate > 0.7 && passRate > 0.8) {
		delta = -5;
		reason = "efficient (high kill rate + high pass rate → distill sooner)";
	} else if (passRate < 0.5) {
		delta = 10;
		reason = "conservative (low pass rate → let memories mature longer)";
	} else {
		delta = 0;
		reason = "stable (rates within normal bounds)";
	}

	const newN = Math.max(MIN_N, Math.min(MAX_N, currentN + delta));
	return { newN, delta: newN - currentN, reason };
}
