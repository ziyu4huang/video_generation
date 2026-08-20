/**
 * runRetrospect — the PURE orchestration behind an ADVISORY post-run
 * retrospective. READ-ONLY by construction: it NEVER mutates the repo and NEVER
 * blocks a downstream step (no `aborted` field — it can't fail-block; the worst
 * it does is surface `warnings[]` + `anomalies[]` for the caller to render).
 *
 * After a mutating recipe (sync/prepare/merge) runs, the agent often wants a
 * quick "did anything look risky?" readout: a force-push / history rewrite in
 * the reflog, scope drift (recent commits touched paths outside the expected
 * scope), a branch checked out in >1 worktree, a dirty tree, or an unexpected
 * ahead+behind divergence. This recipe gathers those signals through the SAME
 * two injected seams every other recipe uses (a `Pick`-typed BranchClient for
 * reads + a `SpawnFn` for the read-only git history queries), records every git
 * invocation in `commands[]`, and returns a structured `anomalies[]` + a
 * human-readable one-line `summary`.
 *
 * Two seam-owned read-only git queries (kept LOCAL to this file so no shared
 * module has to learn them — `parseReflog` + `parseRecentFiles`):
 *   - `git -C <root> reflog -n <lookback> --format="%h %gs"`
 *       → recentOps: {ref, op}[] (ref = abbreviated SHA, op = reflog subject).
 *   - `git -C <root> log -n <lookback> --name-only --format=""`  (only when
 *       `expectedScope` is provided)
 *       → recent touched file paths, deduped.
 *
 * Throw-free discipline (mirrors sync-recipe.ts): a READ that throws (client or
 * spawn) is swallowed into a `warning` and a safe fallback — the recipe STILL
 * returns a full outcome (it is advisory, so a missing signal never blocks).
 */
import type { SpawnFn, SpawnResult } from "./spawn.js";
import type { BranchClient } from "./branch-recipe.js";
import { matchesScope } from "./scope-match.js";

/**
 * The read-only surface retrospect needs. A `Pick` of BranchClient so the live
 * `createBranchClient` (full BranchClient) satisfies it, while tests inject a
 * minimal fake covering only these five methods.
 */
export type RetrospectClient = Pick<
	BranchClient,
	"currentBranch" | "defaultBranch" | "aheadBehind" | "worktreeList" | "isClean"
>;

export type AnomalySeverity = "info" | "warn";

/** A single advisory finding. `severity:"warn"` is worth a human glance; "info"
 *  is purely informational (never blocks — there is no blocking path here). */
export interface Anomaly {
	kind: string;
	severity: AnomalySeverity;
	message: string;
}

/** One reflog entry: ref = abbreviated SHA (`%h`), op = reflog subject (`%gs`). */
export interface RecentOp {
	ref: string;
	op: string;
}

export interface RetrospectOutcome {
	branch: string;
	defaultBranch: string;
	divergence: { ahead: number; behind: number };
	clean: boolean;
	worktrees: { worktree: string; branch?: string; detached?: boolean }[];
	recentOps: RecentOp[];
	anomalies: Anomaly[];
	/** Human-readable one-liner (safe to echo to the agent/user verbatim). */
	summary: string;
	/** Every git invocation issued, rendered runnable (always read-only here). */
	commands: string[];
	/** Read failures (a thrown client/spawn call) — never aborts, just noted. */
	warnings: string[];
}

export interface RetrospectOptions {
	client: RetrospectClient;
	spawn: SpawnFn;
	repoRoot: string;
	/** How many reflog/log entries to scan. Default 12. */
	lookback?: number;
	/** Optional scope prefixes; when set, recent touched paths outside ANY
	 *  prefix surface as a `scope-drift` anomaly. */
	expectedScope?: string[];
	signal?: AbortSignal;
}

/** Reflog OPERATION prefixes (`%gs` is `<op>: <detail>`) that indicate the
 *  branch history was rewritten — reset / commit (amend) / rebase. Anchored on
 *  the OP prefix (not a keyword anywhere) so commit MESSAGES mentioning "rebase"
 *  and benign `pull --rebase` don't false-fire. The bare `force` keyword is
 *  dropped — it mostly caught commit-message noise. Advisory. */
const REWRITE_RE = /^(reset|commit \(amend\)|rebase)/i;

/** "Far behind" threshold for the unexpected-divergence info anomaly. */
const BEHIND_LARGE = 10;

/** Render a git invocation as a runnable, human-readable shell string. */
function renderGit(dir: string, args: string[]): string {
	return `git -C "${dir}" ${args.join(" ")}`;
}

function trim(s: string): string {
	return (s ?? "").trim();
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Run `fn`; on a thrown error, record a `warning` and return `fallback`.
 *  Keeps the advisory recipe throw-free (a missing read never blocks). */
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T, warnings: string[]): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		warnings.push(`${label} read failed: ${errMsg(err)}`);
		return fallback;
	}
}

/**
 * Parse `git reflog -n N --format="%h %gs"` into {ref, op} entries. `ref` is the
 * abbreviated commit SHA (`%h`, the value AFTER the entry); `op` is the reflog
 * subject (`%gs`, e.g. "checkout: moving from main to feat/x", "reset: moving
 * to HEAD~1", "commit (amend): …"). Defensive on garbage / blank lines.
 */
export function parseReflog(stdout: string): RecentOp[] {
	const out: RecentOp[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) continue;
		const sp = line.indexOf(" ");
		const ref = (sp === -1 ? line : line.slice(0, sp)).trim();
		const op = (sp === -1 ? "" : line.slice(sp + 1)).trim();
		if (ref) out.push({ ref, op });
	}
	return out;
}

/**
 * Parse `git log -n N --name-only --format=""` into the deduped set of touched
 * file paths (blank inter-commit separators are dropped). Defensive on garbage.
 */
export function parseRecentFiles(stdout: string): string[] {
	const set = new Set<string>();
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "").trim();
		if (line) set.add(line);
	}
	return [...set];
}

/**
 * Run the advisory retrospective. Never throws, never aborts (no `aborted`
 * field exists — it is advisory-only). Read failures become `warnings[]`; the
 * structured findings become `anomalies[]`; `summary` is a one-liner.
 */
export async function runRetrospect(opts: RetrospectOptions): Promise<RetrospectOutcome> {
	const { client, spawn, repoRoot } = opts;
	const lookback = opts.lookback ?? 12;
	const commands: string[] = [];
	const warnings: string[] = [];

	/** Read-only git: always record the invocation; always spawn (no dryRun —
	 *  every git call here is itself read-only). */
	const git = async (dir: string, args: string[]): Promise<SpawnResult> => {
		commands.push(renderGit(dir, args));
		return spawn("git", ["-C", dir, ...args]);
	};

	// --- 1. Gather read-only signals (each throw-free via safe()). -------------
	const branch = await safe("currentBranch", () => client.currentBranch(), "", warnings);
	const defaultBranch =
		(await safe("defaultBranch", () => client.defaultBranch(), undefined, warnings)) ?? "main";
	const divergence = await safe(
		"aheadBehind",
		() => client.aheadBehind(defaultBranch, branch),
		{ ahead: 0, behind: 0 },
		warnings,
	);
	const clean = await safe("isClean", () => client.isClean(repoRoot), true, warnings);
	const worktrees = await safe("worktreeList", () => client.worktreeList(), [], warnings);

	if (opts.signal?.aborted) {
		warnings.push("aborted before start.");
		return {
			branch,
			defaultBranch,
			divergence,
			clean,
			worktrees,
			recentOps: [],
			anomalies: [],
			summary: "aborted before start.",
			commands,
			warnings,
		};
	}

	// --- 2. Read-only git history queries (recorded in commands[]). -----------
	const reflogRes = await safe(
		"reflog",
		() => git(repoRoot, ["reflog", "-n", String(lookback), "--format=%h %gs"]),
		{ stdout: "", stderr: "", exitCode: 1 },
		warnings,
	);
	const recentOps = reflogRes.exitCode === 0 ? parseReflog(reflogRes.stdout) : [];

	let recentFiles: string[] = [];
	if (opts.expectedScope && opts.expectedScope.length > 0) {
		const logRes = await safe(
			"log",
			() => git(repoRoot, ["log", "-n", String(lookback), "--name-only", "--format="]),
			{ stdout: "", stderr: "", exitCode: 1 },
			warnings,
		);
		recentFiles = logRes.exitCode === 0 ? parseRecentFiles(logRes.stdout) : [];
	}

	// --- 3. Analyze → anomalies[] (ADVISORY; severities info/warn). ------------
	const anomalies: Anomaly[] = [];

	// history-rewrite-signature: a reflog OP prefix of reset / commit (amend) /
	// rebase — the local signature that precedes a force-push. A local reflog
	// can't PROVE a force-push (only a rewrite), so this is hedged + advisory.
	const rewriteOp = recentOps.find((o) => REWRITE_RE.test(o.op));
	if (rewriteOp) {
		anomalies.push({
			kind: "history-rewrite-signature",
			severity: "warn",
			message: `history rewrite (reset/amend/rebase) in recent ops ("${rewriteOp.op}") — possible force-push; verify if unexpected.`,
		});
	}

	// scope-drift: recent touched paths outside every expectedScope entry
	// (matchesScope semantics — the same entry forms verify_merge_landed uses;
	// the old literal startsWith had the same pseudo-prefix false-clean as
	// verify_merge did: `src` matching `srcx/…`).
	if (opts.expectedScope && opts.expectedScope.length > 0 && recentFiles.length > 0) {
		const outOfScope = recentFiles.filter((f) => !opts.expectedScope!.some((p) => matchesScope(f, p)));
		if (outOfScope.length > 0) {
			anomalies.push({
				kind: "scope-drift",
				severity: "warn",
				message: `recent commits touched ${outOfScope.length} path(s) outside expectedScope: ${outOfScope.join(", ")}.`,
			});
		}
	}

	// worktree-conflict-risk: the current branch checked out in >1 worktree.
	if (branch) {
		const wtCount = worktrees.filter((w) => w.branch === branch).length;
		if (wtCount > 1) {
			anomalies.push({
				kind: "worktree-conflict-risk",
				severity: "warn",
				message: `branch '${branch}' is checked out in ${wtCount} worktrees — concurrent mutations risk conflict.`,
			});
		}
	}

	// dirty-tree: uncommitted tracked changes.
	if (!clean) {
		anomalies.push({
			kind: "dirty-tree",
			severity: "info",
			message: `working tree at '${repoRoot}' has uncommitted tracked changes.`,
		});
	}

	// unexpected-divergence: both ahead and behind (forked), or far behind.
	if (divergence.ahead > 0 && divergence.behind > 0) {
		anomalies.push({
			kind: "unexpected-divergence",
			severity: "info",
			message: `branch '${branch}' is both ahead (${divergence.ahead}) and behind (${divergence.behind}) — diverged history.`,
		});
	} else if (divergence.behind >= BEHIND_LARGE) {
		anomalies.push({
			kind: "unexpected-divergence",
			severity: "info",
			message: `branch '${branch}' is ${divergence.behind} commits behind '${defaultBranch}' — far behind the base.`,
		});
	}

	const summary = `branch '${branch || "(detached)"}' vs '${defaultBranch}': ${anomalies.length} anomaly(ies), ${divergence.ahead} ahead / ${divergence.behind} behind, ${clean ? "clean" : "dirty"}.`;

	return {
		branch,
		defaultBranch,
		divergence,
		clean,
		worktrees,
		recentOps,
		anomalies,
		summary,
		commands,
		warnings,
	};
}
