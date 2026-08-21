/**
 * forge/gh-cli.ts — the gh-CLI ForgeClient impl (the FALLBACK backend).
 *
 * REST-first is the selection policy (select.ts): this client is used when no
 * token is obtainable but the `gh` binary is authenticated on PATH. It is the
 * historical implementation, moved verbatim from src/gh.ts (which re-exports
 * it so existing imports keep working).
 *
 * Robustness note: this exists to KILL the brittle agent-side bash polling
 * loops (the `gh pr checks | grep -c ...` footguns). All gh output is parsed
 * as STRUCTURED JSON (`gh ... --json`), never text grep.
 *
 * Parsers are pure + fully tested; the client glue is tested with a recording
 * fake spawn. The live spawn adapter is the only untested seam.
 */
import type { ForgeClient, MergeStrategy } from "./types.js";
import type { PrState, MergeState, CheckTally } from "../pr-logic.js";
import type { SpawnFn } from "../spawn.js";

const VALID_STATES = new Set<PrState>(["OPEN", "MERGED", "CLOSED"]);
const VALID_MERGE_STATES = new Set<MergeState>([
	"CLEAN", "BEHIND", "BLOCKED", "UNKNOWN", "DIRTY", "HAS_HOOKS", "UNSTABLE",
]);
const FAIL_STATES = new Set([
	"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED",
]);
/** Known non-failure, completed states. Anything NOT in PASS or FAIL defaults to
 *  pending (running/queued/unknown) — never claim success for an unrecognized state. */
const PASS_STATES = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * Parse `gh pr view --json state,…,headRefName,headRefOid`
 * into our domain types. The base/head refs drive the run_local_ci gate (diff
 * origin/<base>..origin/<head>); mergeCommit feeds mergeSha. Defensive:
 * unknown/garbage → OPEN/UNKNOWN defaults + empty ref names (never throws).
 */
export function parsePrView(raw: unknown): {
	state: PrState;
	mergeState: MergeState;
	mergeSha?: string;
	baseRefName: string;
	headRefName: string;
	/** The head ref's SHA at the time gh answered — what actually got merged. */
	headRefOid?: string;
} {
	const r = (raw ?? {}) as Record<string, unknown>;
	const rawState = typeof r.state === "string" ? (r.state as PrState) : "OPEN";
	const rawMerge = typeof r.mergeStateStatus === "string" ? (r.mergeStateStatus as MergeState) : "UNKNOWN";
	const mc = r.mergeCommit as { oid?: string } | null | undefined;
	const baseRefName = typeof r.baseRefName === "string" ? r.baseRefName : "";
	const headRefName = typeof r.headRefName === "string" ? r.headRefName : "";
	const headRefOid = typeof r.headRefOid === "string" && r.headRefOid ? r.headRefOid : undefined;
	return {
		state: VALID_STATES.has(rawState) ? rawState : "OPEN",
		mergeState: VALID_MERGE_STATES.has(rawMerge) ? rawMerge : "UNKNOWN",
		mergeSha: mc?.oid ?? undefined,
		baseRefName,
		headRefName,
		headRefOid,
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
		// Classify by STATE, not completedAt: a re-triggered check can carry a prior
		// run's completedAt while its new run is WAITING/IN_PROGRESS. Relying on
		// completedAt would wrongly count such a check as pass, masking a still-running
		// check as complete+green. The merge recipe no longer consumes this tally (it
		// gates on run_local_ci), but `show_pr_status` reports it, so classify conservatively:
		// unknown states default to pending — never claim success.
		const state = typeof row?.state === "string" ? row.state.toUpperCase() : "";
		if (FAIL_STATES.has(state)) fail++;
		else if (PASS_STATES.has(state)) pass++;
		else pending++;
	}
	return { pass, fail, pending };
}

/** JSON.parse that returns null on empty/garbage (never throws). */
function safeJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/**
 * Build a `ForgeClient` backed by a `SpawnFn` driving the `gh` CLI. The live
 * adapter (src/spawn.ts `createLiveSpawn`) passes a Bun.spawn wrapper that
 * sets the repo cwd; tests pass a recording fake. All gh output is parsed as
 * JSON.
 */
export function createGhClient(spawn: SpawnFn): ForgeClient {
	return {
		async prStatus(n) {
			const view = await spawn("gh", ["pr", "view", String(n), "--json", "state,mergeStateStatus,mergeCommit,baseRefName,headRefName,headRefOid"]);
			const checks = await spawn("gh", ["pr", "checks", String(n), "--json", "name,state,completedAt"]);
			const parsed = parsePrView(safeJson(view.stdout));
			const tally = parseChecks(safeJson(checks.stdout));
			return { ...parsed, checks: tally };
		},
		async mergeNow(n, strategy: MergeStrategy, deleteBranch) {
			// Direct (synchronous) merge — NO --auto. Used once the run_local_ci gate is
			// green + mergeState is CLEAN: the merge completes here, so success IS the
			// confirmation (there's no remote CI to wait on). Throw on non-zero
			// exit so the recipe surfaces a clean block outcome.
			const args = ["pr", "merge", String(n), `--${strategy}`];
			if (deleteBranch) args.push("--delete-branch");
			const r = await spawn("gh", args);
			if (r.exitCode !== 0) {
				throw new Error(`gh pr merge ${n} (direct) failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
			}
		},
	};
}
