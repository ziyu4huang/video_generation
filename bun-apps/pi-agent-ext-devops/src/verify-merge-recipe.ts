/**
 * runVerifyMerge — the PURE orchestration behind a post-merge verification.
 * After a PR merges, confirm (a) it actually merged, (b) the merge touched ONLY
 * paths within an optional `expectedScope`, and (c) whether the PR's head branch
 * is now "spent" (fully contained in the default branch). READ-ONLY: the only
 * mutation-adjacent call is a `git show --stat` (read-only history query); it
 * never mutates the repo.
 *
 * Verdict (the headline result):
 *   - "NOT-MERGED"   — gh says the PR is not MERGED (OPEN/CLOSED/unknown).
 *   - "CLEAN"        — merged AND (no expectedScope given, OR every touched
 *                      file lives under an expectedScope prefix).
 *   - "CONTAMINATED" — merged AND at least one touched file is outside every
 *                      expectedScope prefix (scope drift into the merge).
 *
 * Two injected seams (mirrors every other recipe): a full `GhClient` (gh reads)
 * + a `Pick`-typed BranchClient (git reads) + a `SpawnFn` (the read-only
 * `git show --stat`). One LOCAL pure parser, `parseShowStat`, owns the diffstat
 * shape (kept in this file — no shared module learns it).
 *
 * Throw-free discipline (mirrors sync-recipe.ts): a `gh.prStatus` throw is
 * swallowed into `warnings[]` + a structured `aborted` (we cannot determine
 * merge state without it). A non-zero `git show` becomes a warning + empty
 * file list (best-effort) rather than a crash.
 *
 * Status-letter note: `git show --stat` exposes per-file +/- counts but NOT the
 * M/A/D status letter (that needs `--name-status`). The recipe deliberately
 * uses `--stat` so it can report `insertions`/`deletions` from the summary line
 * (the scope check only needs `path`). `status` is therefore best-effort and
 * defaults to "M" for every parsed file — documented, and irrelevant to the
 * verdict (which keys off `path` alone).
 */
import type { SpawnFn, SpawnResult } from "./spawn.js";
import type { BranchClient } from "./branch-recipe.js";
import type { GhClient } from "./recipe.js";
import type { PrState } from "./pr-logic.js";

/**
 * The read-only git surface verify-merge needs. A `Pick` of BranchClient so the
 * live `createBranchClient` satisfies it; tests inject a minimal fake.
 */
export type VerifyMergeClient = Pick<BranchClient, "defaultBranch" | "containedBranches" | "revParse">;

export type VerifyVerdict = "CLEAN" | "CONTAMINATED" | "NOT-MERGED";

/** One touched file from `git show --stat`. `status` is best-effort ("M"). */
export interface VerifyFile {
	path: string;
	status: string;
}

export interface VerifyMergeAbort {
	/** Always true — discriminator. */
	aborted: true;
	/** Machine reason: "aborted-before-start" | "pr-status-failed". */
	reason: "aborted-before-start" | "pr-status-failed";
	/** Human-readable summary. */
	message: string;
}

export interface VerifyMergeOutcome {
	pr: number;
	state: PrState;
	mergeSha?: string;
	merged: boolean;
	verdict: VerifyVerdict;
	files: VerifyFile[];
	fileCount: number;
	insertions: number;
	deletions: number;
	/** Files outside every expectedScope prefix (empty when no scope given). */
	outOfScope: VerifyFile[];
	/** True iff the PR head ref is contained in the default branch (spent). */
	branchSpent: boolean;
	/** Every git invocation issued, rendered runnable (always read-only here). */
	commands: string[];
	warnings: string[];
	/** Present only when prStatus itself failed (cannot determine merge state). */
	aborted?: VerifyMergeAbort;
}

export interface VerifyMergeOptions {
	gh: GhClient;
	client: VerifyMergeClient;
	spawn: SpawnFn;
	repoRoot: string;
	pr: number;
	/** Optional scope prefixes; touched files outside ALL prefixes → CONTAMINATED. */
	expectedScope?: string[];
	signal?: AbortSignal;
}

/** One parsed diffstat. */
export interface ShowStat {
	files: VerifyFile[];
	fileCount: number;
	insertions: number;
	deletions: number;
}

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

/** Run `fn`; on a thrown error, record a `warning` and return `fallback`. */
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T, warnings: string[]): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		warnings.push(`${label} read failed: ${errMsg(err)}`);
		return fallback;
	}
}

/**
 * Resolve git's compacted rename notation to the NEW path. Scope-checking keys
 * off the post-rename path, so an in-scope rename must read as CLEAN.
 *
 * Git compacts a rename against the common prefix/suffix:
 *   `bun-apps/{pkg-a => pkg-b}/src/x.ts`  → `bun-apps/pkg-b/src/x.ts`
 *   `src/{ => nested}/a.ts`               → `src/nested/a.ts`  (empty old side)
 *   `src/{nested => }/a.ts`               → `src/a.ts`         (empty new side)
 * and falls back to a whole-path form when there is nothing in common:
 *   `src/a.ts => other/b.ts`              → `other/b.ts`
 *
 * The braces are NOT anchored to the whole string — an earlier version required
 * that, so every deep rename (the common case in this monorepo) fell through
 * unresolved and failed its `startsWith(scope)` check.
 *
 * The empty-side forms leave a doubled slash (`src//a.ts`); collapse it so the
 * result is a real path a prefix match can be trusted against.
 */
function resolveRename(path: string): string {
	const braced = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
	if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, "/");
	const plain = path.match(/^(.+) => (.+)$/);
	return plain ? plain[2] : path;
}

/**
 * Parse `git show --numstat --format="" <sha>` into {files, fileCount,
 * insertions, deletions}. One line per file:
 *   `<added>\t<deleted>\t<path>`   — a text file
 *   `-\t-\t<path>`                 — a binary file (counts as a file, adds 0/0)
 *
 * WHY NOT `--stat`
 *   `--stat` renders for a terminal: it pads to a width and ABBREVIATES any long
 *   path as `.../tail`. Every `startsWith(expectedScope)` check then fails, so a
 *   perfectly in-scope merge is reported CONTAMINATED and the CLI exits 1 on a
 *   clean merge. Real case: verifying PR #1360 flagged 10 files that were all
 *   inside the scope prefix. `--numstat` is the machine-readable form — full
 *   paths, never abbreviated, and per-file counts we can sum instead of scraping
 *   a prose summary line.
 *
 *   This is the mirror of the failure the devops SKILL cites as the reason to use
 *   `verify_merge` over hand-rolled `git show --stat` parsing: the same disease,
 *   opposite sign (false CONTAMINATED rather than false CLEAN).
 *
 * `status` stays best-effort "M" — numstat exposes no M/A/D letter (that needs
 * `--name-status`, which drops the counts). The verdict keys off `path` alone.
 */
export function parseShowStat(stdout: string): ShowStat {
	const files: VerifyFile[] = [];
	let insertions = 0;
	let deletions = 0;
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) continue;
		// `<added>\t<deleted>\t<path>`; a binary file uses "-" for both counts.
		const m = line.match(/^\s*(\d+|-)\t(\d+|-)\t(.+)$/);
		if (!m) continue;
		if (m[1] !== "-") insertions += Number.parseInt(m[1], 10);
		if (m[2] !== "-") deletions += Number.parseInt(m[2], 10);
		files.push({ path: resolveRename(m[3].trim()), status: "M" });
	}
	return { files, fileCount: files.length, insertions, deletions };
}

/**
 * Run the verify-merge recipe. Never throws — a `gh.prStatus` failure surfaces
 * as `warnings[]` + a structured `aborted`; a failed `git show` becomes a
 * warning + an empty file list (best-effort). The verdict is always populated.
 */
export async function runVerifyMerge(opts: VerifyMergeOptions): Promise<VerifyMergeOutcome> {
	const { gh, client, spawn, repoRoot, pr } = opts;
	const commands: string[] = [];
	const warnings: string[] = [];

	/** Read-only git: always record the invocation; always spawn. */
	const git = async (dir: string, args: string[]): Promise<SpawnResult> => {
		commands.push(renderGit(dir, args));
		return spawn("git", ["-C", dir, ...args]);
	};

	if (opts.signal?.aborted) {
		warnings.push("aborted before start.");
		return {
			pr,
			state: "OPEN",
			merged: false,
			verdict: "NOT-MERGED",
			files: [],
			fileCount: 0,
			insertions: 0,
			deletions: 0,
			outOfScope: [],
			branchSpent: false,
			commands,
			warnings,
			aborted: { aborted: true, reason: "aborted-before-start", message: "aborted before start." },
		};
	}

	// --- 1. PR snapshot (the authoritative merge signal). ---------------------
	let status;
	try {
		status = await gh.prStatus(pr);
	} catch (err) {
		warnings.push(`gh.prStatus failed: ${errMsg(err)}`);
		return {
			pr,
			state: "OPEN",
			merged: false,
			verdict: "NOT-MERGED",
			files: [],
			fileCount: 0,
			insertions: 0,
			deletions: 0,
			outOfScope: [],
			branchSpent: false,
			commands,
			warnings,
			aborted: { aborted: true, reason: "pr-status-failed", message: `gh.prStatus(${pr}) failed: ${errMsg(err)}` },
		};
	}

	// --- 2. Not merged → NOT-MERGED (no file inspection). ---------------------
	if (status.state !== "MERGED") {
		return {
			pr,
			state: status.state,
			mergeSha: status.mergeSha,
			merged: false,
			verdict: "NOT-MERGED",
			files: [],
			fileCount: 0,
			insertions: 0,
			deletions: 0,
			outOfScope: [],
			branchSpent: false,
			commands,
			warnings,
		};
	}

	// --- 3. Merged → inspect the merge's touched files (read-only). -----------
	const mergeSha = status.mergeSha;
	let files: VerifyFile[] = [];
	let fileCount = 0;
	let insertions = 0;
	let deletions = 0;
	if (mergeSha) {
		const r = await safe(
			"show-numstat",
			() => git(repoRoot, ["show", "--numstat", "--format=", mergeSha]),
			{ stdout: "", stderr: "", exitCode: 1 },
			warnings,
		);
		if (r.exitCode === 0) {
			const parsed = parseShowStat(r.stdout);
			files = parsed.files;
			fileCount = parsed.fileCount;
			insertions = parsed.insertions;
			deletions = parsed.deletions;
		} else {
			warnings.push(`git show --numstat ${mergeSha} failed: ${trim(r.stderr || r.stdout)}`);
		}
	} else {
		warnings.push("PR is MERGED but gh returned no mergeSha — cannot inspect touched files.");
	}

	// --- 4. Scope check → outOfScope (only when expectedScope given). ----------
	let outOfScope: VerifyFile[] = [];
	if (opts.expectedScope && opts.expectedScope.length > 0) {
		outOfScope = files.filter((f) => !opts.expectedScope!.some((p) => f.path.startsWith(p)));
	}

	// --- 5. Verdict. -----------------------------------------------------------
	let verdict: VerifyVerdict;
	if (opts.expectedScope && opts.expectedScope.length > 0 && outOfScope.length > 0) {
		verdict = "CONTAMINATED";
	} else {
		verdict = "CLEAN";
	}

	// --- 6. Branch-spent: is there anything on the head ref left to lose? -----
	// Primary: `git branch --merged <default>` lists branch names fully contained
	// in <default>. That is ANCESTRY — and a SQUASH merge rewrites the branch into
	// one NEW commit, so the head ref is never an ancestor of the base. Under this
	// repo's squash convention `branchSpent` was therefore permanently false: the
	// field carried no information in the only strategy actually used.
	//
	// The strategy-independent signal is gh's `headRefOid` — the SHA that actually
	// got merged. If the branch still points there, everything on it landed and
	// deleting it loses nothing; if it moved, someone pushed after the merge and
	// those commits are NOT in the base.
	//
	// NB: a tree comparison against the merge commit does NOT work here, however
	// tempting. The merge commit's tree is all of <default> at merge time, which
	// includes every unrelated PR that landed between this branch's last rebase
	// and its merge — so the trees differ for reasons that have nothing to do with
	// this branch. Verified empirically on PR #1360.
	let branchSpent = false;
	const defaultBranch =
		(await safe("defaultBranch", () => client.defaultBranch(), undefined, warnings)) ?? "";
	if (defaultBranch && status.headRefName) {
		const contained = await safe(
			"containedBranches",
			() => client.containedBranches(defaultBranch),
			new Set<string>(),
			warnings,
		);
		branchSpent = contained.has(status.headRefName);
		if (!branchSpent && status.headRefOid) {
			const headSha = await safe("revParse(headRef)", () => client.revParse(status.headRefName), undefined, warnings);
			if (!headSha) {
				// The ref does not resolve here — already deleted, or never fetched.
				// Either way there is nothing local left to lose.
				warnings.push(`head ref '${status.headRefName}' does not resolve locally — treating as spent (nothing to delete).`);
				branchSpent = true;
			} else {
				branchSpent = headSha === status.headRefOid;
			}
		}
	}

	return {
		pr,
		state: status.state,
		mergeSha,
		merged: true,
		verdict,
		files,
		fileCount,
		insertions,
		deletions,
		outOfScope,
		branchSpent,
		commands,
		warnings,
	};
}
