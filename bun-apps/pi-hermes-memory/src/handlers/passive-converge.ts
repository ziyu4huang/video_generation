/**
 * Passive session-end convergence — closes the knowledge pipeline loop.
 *
 * On `session_shutdown`, new/changed memory entries are converged to the
 * durable vault automatically (no manual `memory transfer` needed). This makes
 * the memory→knowledge-card→obsidian flow PASSIVE: "your sessions save
 * themselves" (the Alluvium doctrine).
 *
 * Properties (mirrors Alluvium's e2e contracts):
 *   - **Idempotent** — tracks converged entry hashes in a state file; re-runs
 *     / crash-replay converge the SAME entries to `unchanged`, not duplicates
 *     (plus the wiki-aware matcher in `convergeToVault` makes the same lesson
 *     → the same card regardless of namespace).
 *   - **Fast + non-blocking** — bounded by a timeout (default 5s); never throws
 *     (best-effort — shutdown must not be held up by a convergence error).
 *   - **Gated** — only converges entries actually stored by the detectors
 *     (which already severity-gate + dedup at capture time).
 *
 * The state file (`~/.pi/agent/pi-hermes-memory/.vault-converge-state.json`)
 * records the hash of every converged entry per target. A new or edited entry
 * has a different hash → it's converged again; an unchanged entry is skipped.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryStore } from "../store/memory-store.js";
import { convergeToVault } from "../store/vault-converge.js";

const STATE_FILENAME = ".vault-converge-state.json";
const DEFAULT_TIMEOUT_MS = 5000;

/** Stable hash of an entry text (DJB2 → base36). Matches the hash used in
 *  vault-converge.ts so the same entry → the same converge id. */
function entryHash(entry: string): string {
	let h = 5381;
	for (let i = 0; i < entry.length; i++) {
		h = ((h << 5) + h + entry.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36);
}

interface ConvergeState {
	/** target → array of converged entry hashes */
	[target: string]: string[];
}

function loadState(dir: string): ConvergeState {
	try {
		const p = join(dir, STATE_FILENAME);
		if (existsSync(p)) {
			const parsed = JSON.parse(readFileSync(p, "utf8"));
			if (parsed && typeof parsed === "object") return parsed as ConvergeState;
		}
	} catch {
		// Corrupt/missing state → start fresh (idempotent convergence handles re-runs)
	}
	return {};
}

function saveState(dir: string, state: ConvergeState): void {
	try {
		writeFileSync(join(dir, STATE_FILENAME), JSON.stringify(state, null, 2), "utf8");
	} catch {
		// Best effort — a failed state save just means a re-converge next time (harmless)
	}
}

export interface PassiveConvergeResult {
	/** Total entries converged this run (across all targets). */
	converged: number;
	/** Entries skipped because they were already converged (unchanged). */
	skipped: number;
	/** True if convergence hit the timeout before finishing all targets. */
	timedOut: boolean;
	/** Error message if convergence failed entirely (never thrown). */
	error?: string;
}

/**
 * Converge new/changed memory entries to the vault. Idempotent (skips
 * already-converged entries via hash tracking), bounded (timeout), and never
 * throws — safe to call from a `session_shutdown` handler.
 *
 * @param store       the memory store (failure/memory/user entries).
 * @param cwd         the agent's working directory (vault resolution Tier 1b).
 * @param stateDir    directory for the convergence state file (the global memory dir).
 * @param projectName optional project name tag for converged cards.
 * @param timeoutMs   hard deadline (default 5s); remaining targets are deferred.
 */
export async function passiveConverge(
	store: Pick<MemoryStore, "getAllFailureEntries" | "getMemoryEntries" | "getUserEntries">,
	cwd: string,
	stateDir: string,
	projectName?: string | null,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PassiveConvergeResult> {
	const targets: Array<{
		target: "failure" | "memory" | "user";
		getEntries: () => string[];
	}> = [
		{ target: "failure", getEntries: () => store.getAllFailureEntries() },
		{ target: "memory", getEntries: () => store.getMemoryEntries() },
		{ target: "user", getEntries: () => store.getUserEntries() },
	];

	const state = loadState(stateDir);
	let converged = 0;
	let skipped = 0;
	let timedOut = false;

	const deadline = Date.now() + timeoutMs;

	for (const { target, getEntries } of targets) {
		if (Date.now() > deadline) {
			timedOut = true;
			break;
		}

		let entries: string[];
		try {
			entries = getEntries();
		} catch {
			continue; // store not loaded — skip this target
		}

		const convergedHashes = new Set(state[target] ?? []);
		const newEntries: string[] = [];
		const newHashes: string[] = [];
		for (const entry of entries) {
			const hash = entryHash(entry);
			if (convergedHashes.has(hash)) {
				skipped++;
			} else {
				newEntries.push(entry);
				newHashes.push(hash);
			}
		}

		if (newEntries.length === 0) continue;

		try {
			const result = await convergeToVault(newEntries, target, cwd, projectName);
			if (result.ok || result.unavailable) {
				// Record converged hashes even if the knowledge-card extension was
				// unavailable — we don't want to retry every session when the peer
				// isn't installed. The wiki-aware matcher is idempotent anyway.
				converged += newEntries.length;
				state[target] = [...convergedHashes, ...newHashes];
			} else if (!result.ok) {
				// Convergence failed (vault resolution / ingest error) — DON'T record
				// the hashes so the entries are retried next session.
			}
		} catch {
			// Never throw from a shutdown handler — best effort only.
		}

		if (Date.now() > deadline) {
			timedOut = true;
			break;
		}
	}

	saveState(stateDir, state);
	return { converged, skipped, timedOut };
}

/** Reset the convergence state (used by `pipeline run --reconverge` to force a
 *  full re-convergence). Removes the state file so every entry is treated as new. */
export function resetConvergeState(stateDir: string): void {
	try {
		const p = join(stateDir, STATE_FILENAME);
		if (existsSync(p)) writeFileSync(p, JSON.stringify({}, null, 2), "utf8");
	} catch {
		// best effort
	}
}
