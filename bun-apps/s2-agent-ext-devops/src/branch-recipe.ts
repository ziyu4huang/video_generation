/**
 * sweep_merged_branches orchestration types + the `BranchClient` IoC contract.
 *
 * Mirrors the merge_pr_after_local_ci split: the decision logic is PURE
 * (src/branch-logic.ts → classifyBranch), the I/O is behind an injectable
 * `BranchClient` (real impl: src/gh.ts → createBranchClient; tests inject
 * fakes), and `buildSweepPlan` / `executeSweep` here orchestrate the two.
 *
 * CONSERVATIVE: a branch is deleted only on positive gh merge evidence
 * (confidence=high); uncertain cases (medium/low) land in `review` and are
 * NEVER auto-deleted — only via explicit `confirm: [...]`, re-guarded.
 */
import { classifyBranch } from "./branch-logic.js";
import type { BranchKind, Confidence } from "./branch-logic.js";
import type { ForgeClient } from "./forge/types.js";

/**
 * Injectable branch/git operations. Real impl: src/gh.ts
 * `createBranchClient(spawn, remoteName)` — the remote-facing methods are
 * scoped to that remote (src/remote.ts; default `origin`). Tests inject fakes.
 * Pure git — a PR listing is a FORGE query and lives on ForgeClient.prList
 * (see SweepClient below).
 */
export interface BranchClient {
	branchVv(): Promise<{ name: string; goneRemote: boolean }[]>;
	remoteBranches(): Promise<string[]>;
	worktrees(): Promise<string[]>;
	currentBranch(): Promise<string>;
	containedBranches(defaultBranch: string): Promise<Set<string>>;
	defaultBranch(): Promise<string | undefined>;
	/** All worktrees with their checked-out branch (porcelain records). */
	worktreeList(): Promise<{ worktree: string; branch?: string; detached?: boolean }[]>;
	/** Resolve a ref to its SHA, or undefined if the ref is missing. */
	revParse(rev: string): Promise<string | undefined>;
	/** True iff <dir> has no TRACKED changes vs HEAD (untracked files ignored). */
	isClean(dir: string): Promise<boolean>;
	/** TRACKED dirty paths (repo-relative) in <dir> — staged + unstaged
	 *  (modified/added/deleted/renamed/typechange); EXCLUDES untracked (`??`)
	 *  and ignored. Empty when clean. */
	dirtyPaths(dir: string): Promise<string[]>;
	/** Unmerged (conflicted) index entries in <dir>, repo-relative, unique.
	 *  Live impl: `git -C <dir> ls-files -u` → split tab, take path column, dedupe. */
	unmergedPaths(dir: string): Promise<string[]>;
	/** ahead/behind commit counts between two refs (0 when a ref is missing). */
	aheadBehind(base: string, head: string): Promise<{ ahead: number; behind: number }>;
	/** Subject lines of the commits in `from..to` (newest first), capped at
	 *  `limit`. Read-only; [] when the range fails to resolve. */
	logSubjects(from: string, to: string, limit: number): Promise<string[]>;
	fetchPrune(): Promise<void>;
	/**
	 * Detach HEAD onto `ref` in THIS worktree (`git checkout --detach <ref>`).
	 *
	 * Exists so a spent branch can be deleted after it has been merged: git
	 * refuses `branch -D` on a branch that is checked out anywhere, and the
	 * worktree that ran the merge is usually still sitting on it. Callers must
	 * establish a clean tree first — this moves HEAD.
	 */
	detachHead(ref: string): Promise<void>;
	deleteLocalBranch(name: string): Promise<void>;
	deleteRemoteBranch(name: string): Promise<void>;
}

/**
 * What sweep_merged_branches actually drives: the git surface PLUS the one
 * forge query it needs (the PR listing). Compose at the wiring layer:
 * `const sweep: SweepClient = { ...createBranchClient(spawn), prList: forge.prList }`
 * — or spread a selected ForgeClient, which is a superset.
 */
export type SweepClient = BranchClient & Pick<ForgeClient, "prList">;

/** Corroborating evidence surfaced on each plan entry (info; does not gate deletion). */
export interface BranchSignals {
	mergedPr?: number;
	gone?: boolean;
	containedInDefault?: boolean;
	openPr?: boolean;
}

export interface BranchPlan {
	name: string;
	kind: BranchKind;
	confidence: Confidence;
	reason: string;
	signals: BranchSignals;
}

export interface SweepPlan {
	fetched: boolean;
	mergedRefNames: string[];
	openRefNames: string[];
	deleteLocal: BranchPlan[];
	deleteRemote: BranchPlan[];
	review: BranchPlan[];
	keep: { name: string; reason: string }[];
}

export interface SweepOptions {
	client: SweepClient;
	/** Dry-run by default: build the plan only, delete nothing. */
	execute?: boolean;
	/** Branches the human reviewed + approved (must have been in `review`); re-guarded. */
	confirm?: string[];
	includeLocal?: boolean;
	includeRemote?: boolean;
	/** Extra protected names (main/master + repo default are always protected). */
	protected?: string[];
	/** Run `git fetch --prune` first so [gone] hints are fresh. Default true. */
	prune?: boolean;
	/** `gh pr list --limit N`. Default 200. */
	limit?: number;
}

export interface SweepOutcome extends SweepPlan {
	executed?: {
		deletedLocal: string[];
		deletedRemote: string[];
		skipped: { name: string; reason: string }[];
	};
}

/** Default-protected names: always main + master, plus the repo default + any extras. */
export function resolveProtected(opts: { protected?: string[]; default?: string }): Set<string> {
	const s = new Set<string>(["main", "master"]);
	if (opts.default) s.add(opts.default);
	for (const p of opts.protected ?? []) s.add(p);
	return s;
}

export interface BuildPlanOpts {
	protectedSet: Set<string>;
	limit: number;
	fetched: boolean;
	includeLocal?: boolean;
	includeRemote?: boolean;
	/** Pre-resolved default branch (avoids a re-query); else fetched from the client. */
	defaultBranch?: string;
}

/**
 * Read-only: gather every signal via the client, classify each branch (pure
 * classifyBranch), and assemble the four-bucket plan. Deletes NOTHING.
 *
 * The worktree guard covers BOTH kinds. Deleting `origin/x` does not touch a
 * local checkout of `x` — that is why remotes used to be exempt — but the guard
 * protects the PERSON in that worktree, not the checkout: their push target and
 * upstream tracking disappear mid-session. A live sweep put
 * `origin/refactor/c1-residual-planning-parse` in the auto-delete set while a
 * sibling worktree was sitting on it, which is what closed this exemption.
 */
export async function buildSweepPlan(client: SweepClient, opts: BuildPlanOpts): Promise<SweepPlan> {
	const includeLocal = opts.includeLocal !== false;
	const includeRemote = opts.includeRemote !== false;
	const defaultBranch = opts.defaultBranch ?? (await client.defaultBranch());

	const [locals, remotes, worktrees, current, mergedRows, openRows, contained] = await Promise.all([
		client.branchVv(),
		client.remoteBranches(),
		client.worktrees(),
		client.currentBranch(),
		client.prList("merged", opts.limit),
		client.prList("open", 200),
		defaultBranch ? client.containedBranches(defaultBranch) : Promise.resolve(new Set<string>()),
	]);
	// The forge listing is rows; sweep reasons over ref→prNumber (merge
	// evidence) and a ref set (name-conflict guard). Same shapes the old
	// BranchClient.mergedPrRefs/openPrRefs returned.
	const merged = new Map(mergedRows.map((r) => [r.headRefName, r.number]));
	const open = new Set(openRows.map((r) => r.headRefName));

	const wtSet = new Set(worktrees);
	const deleteLocal: BranchPlan[] = [];
	const deleteRemote: BranchPlan[] = [];
	const review: BranchPlan[] = [];
	const keep: { name: string; reason: string }[] = [];

	const route = (name: string, kind: BranchKind, signals: BranchSignals) => {
		const v = classifyBranch({
			kind,
			mergedPr: merged.has(name),
			gone: kind === "local" && signals.gone === true,
			contained: contained.has(name),
			openPr: open.has(name),
			inWorktree: wtSet.has(name),
			isProtected: opts.protectedSet.has(name),
			isCurrent: kind === "local" && name === current,
		});
		const plan: BranchPlan = { name, kind, confidence: v.confidence, reason: v.reason, signals };
		if (v.bucket === "delete") (kind === "local" ? deleteLocal : deleteRemote).push(plan);
		else if (v.bucket === "review") review.push(plan);
		else keep.push({ name, reason: v.reason });
	};

	if (includeLocal) {
		for (const { name, goneRemote } of locals) {
			route(name, "local", {
				mergedPr: merged.get(name),
				gone: goneRemote || undefined,
				containedInDefault: contained.has(name) || undefined,
				openPr: open.has(name) || undefined,
			});
		}
	}
	if (includeRemote) {
		for (const name of remotes) {
			route(name, "remote", { mergedPr: merged.get(name), openPr: open.has(name) || undefined });
		}
	}

	return {
		fetched: opts.fetched,
		mergedRefNames: [...merged.keys()],
		openRefNames: [...open],
		deleteLocal,
		deleteRemote,
		review,
		keep,
	};
}

export interface ExecuteOpts {
	protectedSet: Set<string>;
	confirm?: string[];
}

export interface Executed {
	deletedLocal: string[];
	deletedRemote: string[];
	skipped: { name: string; reason: string }[];
}

/**
 * Perform deletions, re-guarding every branch against FRESH state (race safety):
 * re-query current/worktree/open right before deleting. Auto-deletes only the
 * high-confidence deleteLocal/deleteRemote; `confirm` additionally deletes
 * reviewed branches (must be in `review`, still re-guarded). Returns what was
 * deleted vs skipped (with reason). Never deletes a guarded branch.
 */
export async function executeSweep(plan: SweepPlan, client: SweepClient, opts: ExecuteOpts): Promise<Executed> {
	const deletedLocal: string[] = [];
	const deletedRemote: string[] = [];
	const skipped: { name: string; reason: string }[] = [];

	// Re-query the DYNAMIC guards once (the static protected set is passed in).
	const [current, worktrees, openRows] = await Promise.all([client.currentBranch(), client.worktrees(), client.prList("open", 200)]);
	const wtSet = new Set(worktrees);
	const openSet = new Set(openRows.map((r) => r.headRefName));

	const localBlock = (name: string): string | undefined => {
		if (wtSet.has(name)) return "worktree-locked";
		if (opts.protectedSet.has(name)) return "protected";
		if (name === current) return "current";
		return undefined;
	};
	const remoteBlock = (name: string): string | undefined => {
		// Same worktree guard as the local path (see buildSweepPlan): a sibling
		// worktree sitting on this branch would lose its push target.
		if (wtSet.has(name)) return "worktree-locked";
		if (opts.protectedSet.has(name)) return "protected";
		if (openSet.has(name)) return "open-PR-active";
		return undefined;
	};

	// 1. High-confidence auto-deletes (re-guarded). Delete failures (non-zero
	// exit) are routed to `skipped` with a reason — `deleted*` holds only
	// branches actually deleted (no false-success). Mirrors the merge_pr_after_local_ci
	// recipe's throw-and-surface discipline.
	for (const p of plan.deleteLocal) {
		const why = localBlock(p.name);
		if (why) skipped.push({ name: p.name, reason: why });
		else {
			try {
				await client.deleteLocalBranch(p.name);
				deletedLocal.push(p.name);
			} catch (err) {
				skipped.push({ name: p.name, reason: `delete failed: ${errMsg(err)}` });
			}
		}
	}
	for (const p of plan.deleteRemote) {
		const why = remoteBlock(p.name);
		if (why) skipped.push({ name: p.name, reason: why });
		else {
			try {
				await client.deleteRemoteBranch(p.name);
				deletedRemote.push(p.name);
			} catch (err) {
				skipped.push({ name: p.name, reason: `delete failed: ${errMsg(err)}` });
			}
		}
	}

	// 2. Human-confirmed reviewed branches (must be in `review`; re-guarded).
	const reviewByName = new Map<string, BranchPlan[]>();
	for (const p of plan.review) {
		const arr = reviewByName.get(p.name) ?? [];
		arr.push(p);
		reviewByName.set(p.name, arr);
	}
	for (const name of opts.confirm ?? []) {
		const entries = reviewByName.get(name);
		if (!entries?.length) {
			skipped.push({ name, reason: "not in review" });
			continue;
		}
		for (const entry of entries) {
			const why = entry.kind === "local" ? localBlock(name) : remoteBlock(name);
			if (why) skipped.push({ name, reason: why });
			else if (entry.kind === "local") {
				try {
					await client.deleteLocalBranch(name);
					deletedLocal.push(name);
				} catch (err) {
					skipped.push({ name, reason: `delete failed: ${errMsg(err)}` });
				}
			} else {
				try {
					await client.deleteRemoteBranch(name);
					deletedRemote.push(name);
				} catch (err) {
					skipped.push({ name, reason: `delete failed: ${errMsg(err)}` });
				}
			}
		}
	}

	return { deletedLocal, deletedRemote, skipped };
}

/**
 * Top-level orchestration (the tool's execute path). Dry-run by default:
 * prune → resolve protected → build plan → (execute/confirm ? executeSweep : noop).
 */
/** Normalize an unknown thrown value into a message string (mirrors src/recipe.ts). */
function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function runSweep(opts: SweepOptions): Promise<SweepOutcome> {
	const limit = opts.limit ?? 200;
	const doPrune = opts.prune !== false;
	if (doPrune) await opts.client.fetchPrune();
	const defaultBranch = await opts.client.defaultBranch();
	const protectedSet = resolveProtected({ protected: opts.protected, default: defaultBranch });
	const plan = await buildSweepPlan(opts.client, {
		protectedSet,
		limit,
		fetched: doPrune,
		includeLocal: opts.includeLocal,
		includeRemote: opts.includeRemote,
		defaultBranch,
	});
	const wantExec = opts.execute === true || (!!opts.confirm && opts.confirm.length > 0);
	const executed = wantExec ? await executeSweep(plan, opts.client, { protectedSet, confirm: opts.confirm }) : undefined;
	return { ...plan, executed };
}
