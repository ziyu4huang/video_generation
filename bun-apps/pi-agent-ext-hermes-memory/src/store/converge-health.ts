/**
 * Convergence health + state — the observability layer for the
 * working-memory → durable-vault flow (Track 1, Phase 1.2).
 *
 * Two sibling JSON files live in the global memory dir
 * (`~/.pi/agent/pi-hermes-memory/`):
 *
 *   `.vault-converge-state.json`   — idempotency: target → converged entry hashes
 *   `.vault-converge-health.json`  — observability: last run + rolling history
 *
 * Before this module, `passive-converge` wrote the *state* file (so it knew
 * which entries to skip) but **swallowed every outcome** — a broken vault
 * resolution or a missing knowledge-card peer converged silently to nothing,
 * with no signal anywhere. This module persists a per-run health record so a
 * stale/broken convergence is **visible** (SAG idea ③ — observability).
 *
 * Design constraints (mirrors the rest of the convergence code):
 *   - **Never throws** — every read/write is best-effort; a corrupt/missing
 *     file degrades to empty state. Convergence must never block shutdown.
 *   - **Ground truth = the `.md` files**, not the SQLite index. The `seen`
 *     counts come from the `MemoryStore` getters (which read the `.md`); this
 *     module only owns its own JSON bookkeeping.
 *   - **Tolerates concurrent modification** — working memory is under write
 *     pressure from other sessions / self-improve loops. A health snapshot is a
 *     best-effort point-in-time read; re-run to refresh.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** DJB2 string hash → base36. **Identical** to `vault-converge.ts`'s `shortHash`
 *  so the same entry text → the same hash here and the same card id there. */
export function entryHash(entry: string): string {
	let h = 5381;
	for (let i = 0; i < entry.length; i++) {
		h = ((h << 5) + h + entry.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36);
}

// ─── Idempotency state (target → converged entry hashes) ────────────────────

export const STATE_FILENAME = ".vault-converge-state.json";

export interface ConvergeState {
	/** target → array of converged entry hashes */
	[target: string]: string[];
}

export function loadConvergeState(dir: string): ConvergeState {
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

export function saveConvergeState(dir: string, state: ConvergeState): void {
	try {
		writeFileSync(join(dir, STATE_FILENAME), JSON.stringify(state, null, 2), "utf8");
	} catch {
		// Best effort — a failed state save just means a re-converge next time (harmless)
	}
}

// ─── Health observability (last run + rolling history) ──────────────────────

export const HEALTH_FILENAME = ".vault-converge-health.json";
export const MAX_HISTORY = 10;

export type ConvergeStatus = "ok" | "failed" | "unavailable";

export interface ConvergeTargetHealth {
	/** "failure" | "memory" | "user" */
	target: string;
	/** Total entries in the store for this target (the `.md` ground truth). */
	seen: number;
	/** Entries not yet in the idempotency state (convergence candidates). */
	newEntries: number;
	/** Entries successfully ingested into the vault this run. */
	converged: number;
	/** Entries skipped because already converged (unchanged). */
	skipped: number;
	/** Per-target outcome. */
	status: ConvergeStatus;
	/** Failure / unavailable reason (present when status != ok). */
	reason?: string;
}

export interface ConvergeHealthRecord {
	/** ISO timestamp of the run. */
	lastRunAt: string;
	/** What triggered the convergence. */
	triggeredBy: "passive" | "transfer";
	/** Worst-case status across all targets that ran. */
	overall: ConvergeStatus;
	/** True if the timeout fired before all targets were processed. */
	timedOut: boolean;
	/** Per-target breakdown. Targets not reached (timeout) are omitted. */
	targets: ConvergeTargetHealth[];
	/** Resolved vault path (present on success). */
	vaultPath?: string;
	/** Overall reason (e.g. the unavailable message). */
	reason?: string;
}

export interface ConvergeHealthState {
	latest: ConvergeHealthRecord | null;
	/** Newest-first, capped at {@link MAX_HISTORY}. */
	history: ConvergeHealthRecord[];
}

export function loadHealth(dir: string): ConvergeHealthState {
	try {
		const p = join(dir, HEALTH_FILENAME);
		if (existsSync(p)) {
			const parsed = JSON.parse(readFileSync(p, "utf8"));
			if (parsed && typeof parsed === "object" && "history" in parsed) {
				return {
					latest: Array.isArray(parsed.history) && parsed.history.length > 0 ? parsed.history[0] : null,
					history: Array.isArray(parsed.history) ? parsed.history.slice(0, MAX_HISTORY) : [],
				};
			}
		}
	} catch {
		// Corrupt/missing → empty
	}
	return { latest: null, history: [] };
}

/** Persist a health record as the new `latest` + prepend to history (capped).
 *  Never throws. */
export function saveHealth(dir: string, record: ConvergeHealthRecord): void {
	try {
		const prev = loadHealth(dir);
		const history = [record, ...prev.history].slice(0, MAX_HISTORY);
		writeFileSync(join(dir, HEALTH_FILENAME), JSON.stringify({ latest: record, history }, null, 2), "utf8");
	} catch {
		// Best effort — a failed health save must not block shutdown.
	}
}

/** Worst-case status across targets: failed beats unavailable beats ok. */
export function aggregateOverall(statuses: ConvergeStatus[]): ConvergeStatus {
	if (statuses.includes("failed")) return "failed";
	if (statuses.includes("unavailable")) return "unavailable";
	return "ok";
}

// ─── Live reconciliation (current entries vs converged hashes) ──────────────

export interface ReconcileTarget {
	target: string;
	/** Total entries currently in the store (`.md` ground truth). */
	total: number;
	/** Entries whose hash is in the idempotency state (already converged). */
	converged: number;
	/** Entries whose hash is NOT in the state (never converged / changed since). */
	unconverged: number;
}

/** Compare live store entries against the idempotency state to surface the
 *  convergence gap — "how many lessons are sitting in working memory but not
 *  yet in the vault?". Pure: takes entries + state, returns counts. */
export function computeReconciliation(
	entriesByTarget: Record<string, string[]>,
	state: ConvergeState,
): ReconcileTarget[] {
	return Object.entries(entriesByTarget).map(([target, entries]) => {
		const hashes = new Set(state[target] ?? []);
		let converged = 0;
		for (const entry of entries) {
			if (hashes.has(entryHash(entry))) converged++;
		}
		return {
			target,
			total: entries.length,
			converged,
			unconverged: entries.length - converged,
		};
	});
}

// ─── Human-readable report (for the /memory-health command) ─────────────────

function ageLabel(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return iso;
	const secs = Math.round((Date.now() - then) / 1000);
	if (secs < 60) return `${secs}s ago`;
	if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
	if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
	return `${Math.round(secs / 86400)}d ago`;
}

const STATUS_ICON: Record<ConvergeStatus, string> = {
	ok: "✅",
	failed: "❌",
	unavailable: "⚠️",
};

/** Format the health state + a live reconciliation into a command report. */
export function formatHealthReport(
	health: ConvergeHealthState,
	recon: ReconcileTarget[],
): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("  ╔══════════════════════════════════════════════╗");
	lines.push("  ║        🔄 Memory → Vault Convergence         ║");
	lines.push("  ╚══════════════════════════════════════════════╝");
	lines.push("");

	const latest = health.latest;
	if (!latest) {
		lines.push("  No convergence run recorded yet.");
		lines.push("  (passive-converge fires on session_shutdown; 'memory transfer' is manual.)");
		lines.push("");
	} else {
		lines.push(`  Last run: ${STATUS_ICON[latest.overall]} ${latest.overall.toUpperCase()}  ·  ${ageLabel(latest.lastRunAt)}  ·  via ${latest.triggeredBy}`);
		if (latest.timedOut) lines.push("  ⏱  timed out before finishing all targets");
		if (latest.vaultPath) lines.push(`  vault: ${latest.vaultPath}`);
		if (latest.reason) lines.push(`  reason: ${latest.reason}`);
		lines.push("");
		lines.push("  target     status         seen   new   conv   skip");
		lines.push("  ───────    ───────────    ────   ───   ─────   ────");
		for (const t of latest.targets) {
			lines.push(
				`  ${t.target.padEnd(9)}  ${STATUS_ICON[t.status]} ${t.status.padEnd(9)}` +
				`  ${String(t.seen).padStart(4)}   ${String(t.newEntries).padStart(3)}   ${String(t.converged).padStart(5)}   ${String(t.skipped).padStart(4)}`,
			);
			if (t.reason) lines.push(`            └ ${t.reason}`);
		}
		lines.push("");
	}

	// Live reconciliation — the "is the flow keeping up?" signal.
	const totalUnconverged = recon.reduce((s, r) => s + r.unconverged, 0);
	lines.push("  ── Live reconciliation (now) ────────────────────");
	if (recon.length === 0 || totalUnconverged === 0) {
		lines.push("  ✅ All working-memory entries are converged into the vault.");
	} else {
		lines.push(`  ⚠️  ${totalUnconverged} entr${totalUnconverged === 1 ? "y" : "ies"} in working memory NOT yet in the vault:`);
		for (const r of recon) {
			if (r.unconverged > 0) {
				lines.push(`     · ${r.target}: ${r.unconverged}/${r.total} unconverged`);
			}
		}
		lines.push("  (run 'memory transfer', or end the session to let passive-converge catch up.)");
	}
	lines.push("");
	return lines.join("\n");
}
