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
 *   - **Observable** (Track 1, Phase 1.2) — every run writes a health record
 *     (`.vault-converge-health.json`) recording per-target status + counts, so a
 *     broken vault resolution or a missing knowledge-card peer is VISIBLE
 *     instead of silently converging to nothing. Read it via `/memory-health`.
 *
 * The state file (`~/.pi/agent/pi-hermes-memory/.vault-converge-state.json`)
 * records the hash of every converged entry per target. A new or edited entry
 * has a different hash → it's converged again; an unchanged entry is skipped.
 */
import type { MemoryStore } from "../store/memory-store.js";
import { convergeToVault } from "../store/vault-converge.js";
import {
	entryHash,
	loadConvergeState,
	saveConvergeState,
	saveHealth,
	aggregateOverall,
	type ConvergeState,
	type ConvergeStatus,
	type ConvergeTargetHealth,
	type ConvergeHealthRecord,
} from "../store/converge-health.js";

const DEFAULT_TIMEOUT_MS = 5000;

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
 * throws — safe to call from a `session_shutdown` handler. Writes a per-run
 * health record so the outcome is observable via `/memory-health`.
 *
 * @param store       the memory store (failure/memory/user entries).
 * @param cwd         the agent's working directory (vault resolution Tier 1b).
 * @param stateDir    directory for the convergence state + health files (the global memory dir).
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

	const state = loadConvergeState(stateDir);
	let converged = 0;
	let skipped = 0;
	let timedOut = false;
	const targetHealth: ConvergeTargetHealth[] = [];
	let lastVaultPath: string | undefined;

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
		let targetSkipped = 0;
		for (const entry of entries) {
			const hash = entryHash(entry);
			if (convergedHashes.has(hash)) {
				targetSkipped++;
			} else {
				newEntries.push(entry);
				newHashes.push(hash);
			}
		}
		skipped += targetSkipped;

		// Nothing new for this target → record a healthy no-op and move on.
		if (newEntries.length === 0) {
			targetHealth.push({
				target,
				seen: entries.length,
				newEntries: 0,
				converged: 0,
				skipped: targetSkipped,
				status: "ok",
			});
			continue;
		}

		let status: ConvergeStatus = "failed";
		let reason: string | undefined;
		let targetConverged = 0;
		try {
			const result = await convergeToVault(newEntries, target, cwd, projectName);
			if (result.unavailable) {
				// Peer not installed — record hashes so we don't retry every session
				// (the wiki-aware matcher is idempotent anyway), but flag the run as
				// `unavailable` so the user KNOWS convergence isn't actually happening.
				status = "unavailable";
				reason = result.reason;
				state[target] = [...convergedHashes, ...newHashes];
			} else if (result.ok) {
				status = "ok";
				converged += newEntries.length;
				targetConverged = (result.created ?? 0) + (result.updated ?? 0);
				state[target] = [...convergedHashes, ...newHashes];
				if (result.vaultPath) lastVaultPath = result.vaultPath;
			} else {
				// Vault resolution / ingest error — DON'T record the hashes so the
				// entries are retried next session.
				status = "failed";
				reason = result.reason;
			}
		} catch (err) {
			// Never throw from a shutdown handler — best effort only.
			status = "failed";
			reason = err instanceof Error ? err.message : String(err);
		}

		targetHealth.push({
			target,
			seen: entries.length,
			newEntries: newEntries.length,
			converged: targetConverged,
			skipped: targetSkipped,
			status,
			reason,
		});

		if (Date.now() > deadline) {
			timedOut = true;
			break;
		}
	}

	saveConvergeState(stateDir, state);

	const overall = targetHealth.length > 0
		? aggregateOverall(targetHealth.map((t) => t.status))
		: "ok";
	const healthRecord: ConvergeHealthRecord = {
		lastRunAt: new Date().toISOString(),
		triggeredBy: "passive",
		overall,
		timedOut,
		targets: targetHealth,
		vaultPath: lastVaultPath,
		reason: overall === "ok" ? undefined : overallReason(targetHealth),
	};
	saveHealth(stateDir, healthRecord);

	return { converged, skipped, timedOut };
}

function overallReason(targets: ConvergeTargetHealth[]): string {
	const first = targets.find((t) => t.status !== "ok");
	return first?.reason ?? first?.status ?? "unknown";
}

/** Reset the convergence state (used by `pipeline run --reconverge` to force a
 *  full re-convergence). Removes the state file so every entry is treated as new. */
export function resetConvergeState(stateDir: string): void {
	try {
		saveConvergeState(stateDir, {});
	} catch {
		// best effort
	}
}
