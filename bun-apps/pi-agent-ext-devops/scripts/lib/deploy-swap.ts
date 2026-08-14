/**
 * deploy-swap — crash-safe directory swap helpers for deploy.ts.
 * Extracted so the self-heal logic is unit-testable without running a full
 * deploy.
 */
import { existsSync, renameSync, rmSync } from "node:fs";

/**
 * If a prior deploy.ts run crashed between the two renames of its atomic
 * swap (FINAL_OUTDIR -> FINAL_OUTDIR.prev, then OUTDIR -> FINAL_OUTDIR),
 * FINAL_OUTDIR is left missing while the last-good deploy sits at
 * FINAL_OUTDIR.prev. Detect that and restore it.
 *
 * A crash landing LATER — between the second rename succeeding and the
 * swap's own cleanup rm of `.prev` — leaves BOTH FINAL_OUTDIR (correct,
 * already-swapped) and `.prev` (stale) on disk. Left alone, the next
 * deploy's own swap would throw ENOTEMPTY trying to rename into a
 * non-empty `.prev`, permanently breaking every future deploy. Clean up
 * that stale `.prev` too.
 *
 * No-op when neither path exists (first-ever deploy). Returns true if it
 * healed anything.
 */
export function healInterruptedSwap(finalOutdir: string): boolean {
	const prev = `${finalOutdir}.prev`;
	if (!existsSync(finalOutdir) && existsSync(prev)) {
		renameSync(prev, finalOutdir);
		return true;
	}
	if (existsSync(finalOutdir) && existsSync(prev)) {
		rmSync(prev, { recursive: true, force: true });
		return true;
	}
	return false;
}
