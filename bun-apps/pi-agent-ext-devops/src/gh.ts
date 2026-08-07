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
import type { BranchClient } from "./branch-recipe.js";
import type { PrState, MergeState, CheckTally } from "./pr-logic.js";
import type { SpawnFn } from "./spawn.js";

// SpawnFn / SpawnResult / SpawnOptions are defined in src/spawn.ts (the shared,
// cycle-free home for the spawn abstraction + live factory) and re-exported
// here so existing `from "../src/gh.js"` imports keep working.
export type { SpawnResult, SpawnFn, SpawnOptions } from "./spawn.js";

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
 * Parse `gh pr view --json state,mergeStateStatus,mergeCommit,baseRefName,headRefName`
 * into our domain types. The base/head refs drive the local_ci gate (diff
 * origin/<base>..origin/<head>); mergeCommit feeds mergeSha. Defensive:
 * unknown/garbage → OPEN/UNKNOWN defaults + empty ref names (never throws).
 */
export function parsePrView(raw: unknown): {
	state: PrState;
	mergeState: MergeState;
	mergeSha?: string;
	baseRefName: string;
	headRefName: string;
} {
	const r = (raw ?? {}) as Record<string, unknown>;
	const rawState = typeof r.state === "string" ? (r.state as PrState) : "OPEN";
	const rawMerge = typeof r.mergeStateStatus === "string" ? (r.mergeStateStatus as MergeState) : "UNKNOWN";
	const mc = r.mergeCommit as { oid?: string } | null | undefined;
	const baseRefName = typeof r.baseRefName === "string" ? r.baseRefName : "";
	const headRefName = typeof r.headRefName === "string" ? r.headRefName : "";
	return {
		state: VALID_STATES.has(rawState) ? rawState : "OPEN",
		mergeState: VALID_MERGE_STATES.has(rawMerge) ? rawMerge : "UNKNOWN",
		mergeSha: mc?.oid ?? undefined,
		baseRefName,
		headRefName,
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
		// gates on local_ci), but `pr_status` reports it, so classify conservatively:
		// unknown states default to pending — never claim success.
		const state = typeof row?.state === "string" ? row.state.toUpperCase() : "";
		if (FAIL_STATES.has(state)) fail++;
		else if (PASS_STATES.has(state)) pass++;
		else pending++;
	}
	return { pass, fail, pending };
}

/**
 * Build a `GhClient` backed by a `SpawnFn`. The live adapter
 * (src/spawn.ts `createLiveSpawn`) passes a Bun.spawn wrapper that sets the
 * repo cwd; tests pass a recording fake. All gh output is parsed as JSON.
 */
export function createGhClient(spawn: SpawnFn): GhClient {
	return {
		async prStatus(n) {
			const view = await spawn("gh", ["pr", "view", String(n), "--json", "state,mergeStateStatus,mergeCommit,baseRefName,headRefName"]);
			const checks = await spawn("gh", ["pr", "checks", String(n), "--json", "name,state,completedAt"]);
			const parsed = parsePrView(safeJson(view.stdout));
			const tally = parseChecks(safeJson(checks.stdout));
			return { ...parsed, checks: tally };
		},
		async mergeNow(n, strategy, deleteBranch) {
			// Direct (synchronous) merge — NO --auto. Used once the local_ci gate is
			// green + mergeState is CLEAN: the merge completes here, so success IS
			// the confirmation (there's no remote CI to wait on). Throw on non-zero
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

/** JSON.parse that returns null on empty/garbage (never throws). */
function safeJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/**
 * Extract the first branch-name token from a `git branch`-style line, skipping
 * the optional marker char (`*` current / `+` linked-worktree / `-` bisect) and
 * detached-HEAD pseudo-entries like `(HEAD detached …)`. Returns undefined if
 * the line has no branch name. Shared by parseBranchVv + parseContained.
 */
function firstBranchName(line: string): string | undefined {
	const trimmed = line.trimStart();
	const rest = ("*+-".includes(trimmed[0] ?? "") ? trimmed.slice(1) : trimmed).trimStart();
	const name = rest.split(/\s+/)[0] ?? "";
	return name && !name.startsWith("(") ? name : undefined;
}

/**
 * Parse `git branch -vv` lines into {name, goneRemote}. `goneRemote` is true
 * when the upstream shows `[origin/…: gone]` (remote deleted — a HINT, not
 * merge proof). Detached-HEAD pseudo-entries are skipped. Defensive on garbage.
 */
export function parseBranchVv(stdout: string): { name: string; goneRemote: boolean }[] {
	const out: { name: string; goneRemote: boolean }[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) continue;
		const name = firstBranchName(line);
		if (!name) continue;
		out.push({ name, goneRemote: line.includes(": gone]") });
	}
	return out;
}

/** Parse `git branch -r` into remote branch names (strips `origin/`, drops `HEAD ->`). */
export function parseRemoteBranches(stdout: string): string[] {
	const out: string[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "").trim();
		if (!line || line.includes("->")) continue;
		const m = line.match(/^origin\/(.+)$/);
		if (m) out.push(m[1]);
	}
	return out;
}

/** Parse `git worktree list --porcelain` into the branch names each worktree has
 *  checked out (from `branch refs/heads/<name>` lines; detached worktrees are skipped). */
export function parseWorktrees(stdout: string): string[] {
	const out: string[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "").trim();
		const m = line.match(/^branch refs\/heads\/(.+)$/);
		if (m) out.push(m[1]);
	}
	return out;
}

/** Parse `gh pr list --state merged --json headRefName,number` into ref→prNumber.
 *  Defensive: non-array → empty map; rows missing fields are skipped. */
export function parseMergedPrs(raw: unknown): Map<string, number> {
	const map = new Map<string, number>();
	const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
	for (const row of list) {
		const ref = typeof row?.headRefName === "string" ? row.headRefName : "";
		const num = typeof row?.number === "number" ? row.number : undefined;
		if (ref && num !== undefined) map.set(ref, num);
	}
	return map;
}

/** Parse `gh pr list --state open --json headRefName` into a ref set (name-conflict source). */
export function parseOpenPrRefs(raw: unknown): Set<string> {
	const set = new Set<string>();
	const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
	for (const row of list) {
		const ref = typeof row?.headRefName === "string" ? row.headRefName : "";
		if (ref) set.add(ref);
	}
	return set;
}

/** Parse `git branch --merged <default>` into the set of fully-contained branch names.
 *  Info-only corroboration (squash merges are missed — that's why gh is authoritative). */
export function parseContained(stdout: string): Set<string> {
	const set = new Set<string>();
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) continue;
		const name = firstBranchName(line);
		if (name) set.add(name);
	}
	return set;
}

/**
 * Build a `BranchClient` backed by a `SpawnFn` (the live Bun.spawn adapter in
 * src/spawn.ts `createLiveSpawn` sets the repo cwd; tests pass a recording fake).
 * All git/gh output is parsed as structured text/JSON — no grep footguns.
 */
export function createBranchClient(spawn: SpawnFn): BranchClient {
	return {
		async branchVv() {
			const r = await spawn("git", ["branch", "-vv"]);
			return parseBranchVv(r.stdout);
		},
		async remoteBranches() {
			const r = await spawn("git", ["branch", "-r"]);
			return parseRemoteBranches(r.stdout);
		},
		async worktrees() {
			const r = await spawn("git", ["worktree", "list", "--porcelain"]);
			return parseWorktrees(r.stdout);
		},
		async currentBranch() {
			const r = await spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
			return r.exitCode === 0 ? r.stdout.trim() : "";
		},
		async mergedPrRefs(limit) {
			const r = await spawn("gh", ["pr", "list", "--state", "merged", "--json", "headRefName,number", "--limit", String(limit)]);
			return parseMergedPrs(safeJson(r.stdout));
		},
		async openPrRefs() {
			const r = await spawn("gh", ["pr", "list", "--state", "open", "--json", "headRefName", "--limit", "200"]);
			return parseOpenPrRefs(safeJson(r.stdout));
		},
		async containedBranches(defaultBranch) {
			const r = await spawn("git", ["branch", "--merged", defaultBranch]);
			return parseContained(r.stdout);
		},
		async defaultBranch() {
			const r = await spawn("git", ["symbolic-ref", "refs/remotes/origin/HEAD"]);
			if (r.exitCode !== 0) return undefined;
			const m = r.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
			return m ? m[1] : undefined;
		},
		async fetchPrune() {
			await spawn("git", ["fetch", "--prune"]);
		},
		async deleteLocalBranch(name) {
			await spawn("git", ["branch", "-D", name]);
		},
		async deleteRemoteBranch(name) {
			await spawn("git", ["push", "origin", "--delete", name]);
		},
	};
}
