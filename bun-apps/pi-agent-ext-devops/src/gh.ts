/**
 * gh-CLI wrapper: the real `GhClient` impl (used by extensions/devops.ts).
 *
 * Robustness note: this exists to KILL the brittle agent-side bash polling
 * loops (the `gh pr checks | grep -c ...` footguns). All gh output is parsed
 * as STRUCTURED JSON (`gh ... --json`), never text grep.
 *
 * Parsers are pure + fully tested; the GhClient glue is tested with a
 * recording fake spawn. The live `Bun.spawn` adapter is the only untested
 * seam (it's a thin stdlib passthrough).
 */
import type { GhClient } from "./recipe.js";
import type { PrState, MergeState, CheckTally } from "./pr-logic.js";

export interface SpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}
export type SpawnFn = (cmd: string, args: string[]) => Promise<SpawnResult>;

const VALID_STATES = new Set<PrState>(["OPEN", "MERGED", "CLOSED"]);
const VALID_MERGE_STATES = new Set<MergeState>([
	"CLEAN", "BEHIND", "BLOCKED", "UNKNOWN", "DIRTY", "HAS_HOOKS", "UNSTABLE",
]);
const FAIL_STATES = new Set([
	"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED",
]);

/**
 * Parse `gh pr view --json state,mergeStateStatus,mergeCommit` into our domain
 * types. Defensive: unknown/garbage → OPEN/UNKNOWN defaults (never throws).
 */
export function parsePrView(raw: unknown): {
	state: PrState;
	mergeState: MergeState;
	mergeSha?: string;
} {
	const r = (raw ?? {}) as Record<string, unknown>;
	const rawState = typeof r.state === "string" ? (r.state as PrState) : "OPEN";
	const rawMerge = typeof r.mergeStateStatus === "string" ? (r.mergeStateStatus as MergeState) : "UNKNOWN";
	const mc = r.mergeCommit as { oid?: string } | null | undefined;
	return {
		state: VALID_STATES.has(rawState) ? rawState : "OPEN",
		mergeState: VALID_MERGE_STATES.has(rawMerge) ? rawMerge : "UNKNOWN",
		mergeSha: mc?.oid ?? undefined,
	};
}

/**
 * Parse `gh pr checks --json name,state,completedAt` rows into a tally. A check
 * with no `completedAt` is still running → pending. Among completed: a known
 * failure-state → fail, else → pass (SUCCESS/SKIPPED/NEUTRAL/...).
 */
export function parseChecks(rows: unknown): CheckTally {
	const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
	let pass = 0;
	let fail = 0;
	let pending = 0;
	for (const row of list) {
		const completedAt = row?.completedAt;
		if (completedAt == null || completedAt === "") {
			pending++;
			continue;
		}
		const state = typeof row.state === "string" ? row.state.toUpperCase() : "";
		if (FAIL_STATES.has(state)) fail++;
		else pass++;
	}
	return { pass, fail, pending };
}

/**
 * Build a `GhClient` backed by a `SpawnFn`. The live adapter (in
 * extensions/devops.ts) passes a Bun.spawn wrapper that sets the repo cwd;
 * tests pass a recording fake. All gh output is parsed as structured JSON.
 */
export function createGhClient(spawn: SpawnFn): GhClient {
	return {
		async prStatus(n) {
			const view = await spawn("gh", ["pr", "view", String(n), "--json", "state,mergeStateStatus,mergeCommit"]);
			const checks = await spawn("gh", ["pr", "checks", String(n), "--json", "name,state,completedAt"]);
			const parsed = parsePrView(safeJson(view.stdout));
			const tally = parseChecks(safeJson(checks.stdout));
			return { ...parsed, checks: tally };
		},
		async enableAutoMerge(n, strategy, deleteBranch) {
			const args = ["pr", "merge", String(n), `--${strategy}`, "--auto"];
			if (deleteBranch) args.push("--delete-branch");
			await spawn("gh", args);
		},
		async rebaseAndForcePush(branch) {
			await spawn("git", ["fetch", "origin", "main"]);
			await spawn("git", ["rebase", "origin/main"]);
			await spawn("git", ["push", "--force-with-lease", "origin", branch]);
		},
	};
}

/** JSON.parse that returns null on empty/garbage (never throws). */
function safeJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
