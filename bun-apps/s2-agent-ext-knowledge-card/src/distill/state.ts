import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DistillState, DistillDiff } from "./types.ts";

const STATE_FILE = ".distill-state.json";
const DIFF_FILE = ".distill-diff.json";
const MAX_HISTORY = 50;
const DEFAULT_THRESHOLD = 50;

export function readState(vaultPath: string): DistillState {
	const p = join(vaultPath, STATE_FILE);
	if (!existsSync(p)) {
		return { threshold: DEFAULT_THRESHOLD, history: [], lastRun: null };
	}
	// A corrupt state file (concurrent write, crash mid-write, disk issue) must
	// not crash converge — cards are already written by the time readState runs,
	// so a throw here leaves a partial converge + no result returned to the
	// caller. Treat an unreadable/unparseable file the same as a missing one:
	// reset to the empty default state. The subsequent writeState() in runConverge
	// overwrites the corrupt file with a valid one, so this is self-healing.
	try {
		const raw = JSON.parse(readFileSync(p, "utf-8"));
		return {
			threshold: raw.threshold ?? DEFAULT_THRESHOLD,
			history: raw.history ?? [],
			lastRun: raw.lastRun ?? null,
		};
	} catch {
		return { threshold: DEFAULT_THRESHOLD, history: [], lastRun: null };
	}
}

export function writeState(vaultPath: string, state: DistillState): void {
	const trimmed: DistillState = {
		threshold: state.threshold,
		history: state.history.slice(-MAX_HISTORY),
		lastRun: state.lastRun,
	};
	writeFileSync(join(vaultPath, STATE_FILE), JSON.stringify(trimmed, null, 2));
}

/** Write the per-run memory diff ATOMICALLY (tmp + rename, the checkpoint
 *  pattern): a crash mid-write never leaves a torn `.distill-diff.json` —
 *  the previous run's diff stays intact until the rename lands. */
export function writeDiff(vaultPath: string, diff: DistillDiff): void {
	const final = join(vaultPath, DIFF_FILE);
	const tmp = `${final}.tmp`;
	writeFileSync(tmp, JSON.stringify(diff, null, 2), "utf8");
	renameSync(tmp, final);
}

/** Read the latest run's diff; null when absent or corrupt (same
 *  self-healing read contract as readState — never throws). */
export function readDiff(vaultPath: string): DistillDiff | null {
	const p = join(vaultPath, DIFF_FILE);
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as DistillDiff;
	} catch {
		return null;
	}
}
