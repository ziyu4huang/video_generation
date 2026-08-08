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
 * If `path` is a git diffstat rename like `{src/old.ts => src/new.ts}`, return
 * the NEW path (group 2); otherwise return `path` unchanged. Scope-checking keys
 * off the post-rename path, so an in-scope rename is CLEAN (without this, the
 * whole brace string would be captured and fail the `startsWith(scope)` check,
 * wrongly flagging an in-scope rename as CONTAMINATED).
 */
function resolveRename(path: string): string {
	const m = path.match(/^\{(.+) => (.+)\}$/);
	return m ? m[2] : path;
}

/**
 * Parse `git show --stat --format="" <sha>` output into {files, fileCount,
 * insertions, deletions}. Recognized line shapes:
 *   - ` <path> | <N> <symbols>`  → a touched file (path = text before `|`).
 *   - ` <path> | Bin …`          → a binary touched file.
 *   - ` <N> files changed[, <X> insertions(+)][, <Y> deletions(-)]` → the
 *     summary (drives fileCount/insertions/deletions; insertions/deletions are
 *     optional — a commit can change only additions or only deletions).
 *
 * `status` is best-effort "M": `--stat` exposes no M/A/D letter (that needs
 * `--name-status`, which drops the insertion/deletion summary). The verdict keys
 * off `path` only, so the default is harmless. If the summary line is missing,
 * `fileCount` falls back to the number of parsed file lines.
 */
export function parseShowStat(stdout: string): ShowStat {
	const files: VerifyFile[] = [];
	let fileCount = 0;
	let insertions = 0;
	let deletions = 0;
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) continue;
		// ` <path> | <N> <+- symbols>` (text file).
		const pipe = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s*([+-]*)\s*$/);
		if (pipe) {
			files.push({ path: resolveRename(pipe[1].trim()), status: "M" });
			continue;
		}
		// ` <path> | Bin <a> -> <b> bytes` (binary file).
		const bin = line.match(/^\s*(.+?)\s+\|\s+Bin\b/);
		if (bin) {
			files.push({ path: resolveRename(bin[1].trim()), status: "M" });
			continue;
		}
		// Summary: ` <N> files changed[, <X> insertions(+)][, <Y> deletions(-)]`.
		const sum = line.match(/(\d+)\s+files?\s+changed/);
		if (sum) {
			fileCount = Number.parseInt(sum[1], 10);
			const ins = line.match(/(\d+)\s+insertions?\(\+\)/);
			const del = line.match(/(\d+)\s+deletions?\(-\)/);
			if (ins) insertions = Number.parseInt(ins[1], 10);
			if (del) deletions = Number.parseInt(del[1], 10);
			continue;
		}
	}
	// Fallback: no summary line → count the parsed file lines.
	if (fileCount === 0 && files.length > 0) fileCount = files.length;
	return { files, fileCount, insertions, deletions };
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
			"show-stat",
			() => git(repoRoot, ["show", "--stat", "--format=", mergeSha]),
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
			warnings.push(`git show --stat ${mergeSha} failed: ${trim(r.stderr || r.stdout)}`);
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

	// --- 6. Branch-spent: head ref contained in the default branch. -----------
	// Primary: `git branch --merged <default>` lists branch names fully in
	// <default>; if the PR head ref is among them, it's spent. Fallback: a
	// SHA-equality sanity check via revParse (head tip == default tip).
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
		if (!branchSpent) {
			const headSha = await safe("revParse(headRef)", () => client.revParse(status.headRefName), undefined, warnings);
			const defSha = await safe("revParse(defaultBranch)", () => client.revParse(defaultBranch), undefined, warnings);
			if (headSha && defSha && headSha === defSha) branchSpent = true;
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
