/**
 * /memory-health — observability for the working-memory → durable-vault flow.
 *
 * Shows (1) the last convergence run (status, per-target counts, reason) from
 * `.vault-converge-health.json`, and (2) a LIVE reconciliation: how many
 * working-memory entries are NOT yet converged into the vault right now. This
 * makes a stale/broken convergence VISIBLE — previously it failed silently.
 *
 * No-LLM, no-network. Reads the `.md` ground truth via the store getters (NOT
 * the lagging SQLite index). Best-effort snapshot — working memory is under
 * concurrent modification; re-run to refresh.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "../store/memory-store.js";
import {
	loadHealth,
	loadConvergeState,
	computeReconciliation,
	formatHealthReport,
} from "../store/converge-health.js";

export function registerConvergeHealthCommand(
	pi: ExtensionAPI,
	store: MemoryStore,
	projectStore: MemoryStore | null,
	globalDir: string,
	projectName: string,
): void {
	pi.registerCommand("memory-health", {
		description: "Show memory → vault convergence health + live reconciliation",
		handler: async (_args, _ctx) => {
			// Global store entries (.md ground truth).
			const entriesByTarget: Record<string, string[]> = {
				failure: safeGet(store.getAllFailureEntries.bind(store)),
				memory: safeGet(store.getMemoryEntries.bind(store)),
				user: safeGet(store.getUserEntries.bind(store)),
			};

			const health = loadHealth(globalDir);
			const state = loadConvergeState(globalDir);
			const recon = computeReconciliation(entriesByTarget, state);

			// Project-scoped reconciliation, if a project store exists.
			let projectBlock = "";
			if (projectStore) {
				const projEntries: Record<string, string[]> = {
					"project:failure": safeGet(projectStore.getAllFailureEntries.bind(projectStore)),
					"project:memory": safeGet(projectStore.getMemoryEntries.bind(projectStore)),
					"project:user": safeGet(projectStore.getUserEntries.bind(projectStore)),
				};
				const projRecon = computeReconciliation(projEntries, state);
				const projUnconverged = projRecon.reduce((s, r) => s + r.unconverged, 0);
				if (projUnconverged > 0) {
					projectBlock = `\n  ── Project (${projectName}) ─────────────────────\n` +
						projRecon
							.filter((r) => r.unconverged > 0)
							.map((r) => `     · ${r.target}: ${r.unconverged}/${r.total} unconverged`)
							.join("\n") +
						"\n";
				}
			}

			const report = formatHealthReport(health, recon) + projectBlock;
			_ctx.ui.notify(report, "info");
		},
	});
}

/** Call a store getter defensively — a not-yet-loaded store throws, which we
 *  treat as "0 entries" rather than crashing the command. */
function safeGet(fn: () => string[]): string[] {
	try {
		return fn();
	} catch {
		return [];
	}
}
