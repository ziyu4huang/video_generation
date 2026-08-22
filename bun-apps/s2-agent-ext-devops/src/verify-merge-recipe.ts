/**
 * runVerifyMerge — the PURE orchestration behind a post-merge verification.
 * After a PR merges, confirm (a) it actually merged, (b) the merge touched ONLY
 * paths within an optional `expectedScope`, and (c) whether the PR's head branch
 * is now "spent" (fully contained in the default branch).
 *
 * READ-ONLY by default: the only git call is `git show --numstat`, a history
 * query. The single exception is opt-in `allowFetch`, which permits one
 * `git fetch origin <mergeSha>` to pull the merge commit into the local object
 * store — object store only: no ref moves, no index or working-tree change.
 * Nothing here ever mutates the repo's state.
 *
 * Verdict (the headline result):
 *   - "NOT-MERGED"   — gh says the PR is not MERGED (OPEN/CLOSED/unknown).
 *   - "CLEAN"        — merged, the touched files WERE inspected, AND (no
 *                      expectedScope given, OR every touched file matches an
 *                      expectedScope entry per matchesScope, src/scope-match.ts).
 *   - "CONTAMINATED" — merged AND at least one touched file matches no
 *                      expectedScope entry (scope drift into the merge).
 *   - "UNVERIFIED"   — merged but the touched files could NOT be inspected
 *                      (no mergeSha, or `git show` failed). See below.
 *
 * WHY "UNVERIFIED" EXISTS (issue #1439)
 *   CLEAN used to be the else-branch of the scope check, so ANY failure to read
 *   the merge's files produced an empty `files` list, an empty `outOfScope`
 *   list, and therefore a CLEAN verdict with `fileCount: 0`. The scope gate
 *   silently degraded to a pass exactly when it could not do its job.
 *
 *   The common trigger is mundane and hit on essentially every merge: right
 *   after `gh pr merge`, the squash commit exists on the remote but not in the
 *   local object store, so `git show <sha>` fails with `fatal: bad object` —
 *   and verify_merge_landed reported CLEAN having inspected zero files. `allowFetch`
 *   removes the cause; UNVERIFIED makes the symptom impossible to miss even
 *   when the cause is something else.
 *
 *   CLEAN now REQUIRES a successful inspection. "I could not check" and
 *   "I checked and it was fine" are no longer the same answer.
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
import { matchesScope } from "./scope-match.js";

/**
 * The read-only git surface verify-merge needs. A `Pick` of BranchClient so the
 * live `createBranchClient` satisfies it; tests inject a minimal fake.
 */
export type VerifyMergeClient = Pick<BranchClient, "defaultBranch" | "containedBranches" | "revParse">;

export type VerifyVerdict = "CLEAN" | "CONTAMINATED" | "NOT-MERGED" | "UNVERIFIED";

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
	/**
	 * True iff the merge's touched files were actually READ. When false the
	 * scope check had no input and the verdict is UNVERIFIED — never CLEAN.
	 * Callers gating on "CLEAN" get the right answer from the verdict alone;
	 * this field is here so a caller can say WHY without parsing warnings.
	 */
	inspected: boolean;
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
	/**
	 * Optional scope entries; touched files outside ALL entries → CONTAMINATED.
	 * Entry semantics (src/scope-match.ts): `x/**` directory prefix (any
	 * depth), `x/*` one segment, `x/` prefix, bare `x` exact-or-directory.
	 */
	expectedScope?: string[];
	/**
	 * Permit ONE `git fetch origin <mergeSha>` when the merge commit is not in
	 * the local object store, then retry the inspection.
	 *
	 * Default false, which keeps the documented read-only contract intact for
	 * plain `verify_merge_landed` callers. It exists because the object is missing on
	 * essentially every post-merge call — `gh pr merge` lands the squash commit
	 * on the remote, and nothing has fetched it locally yet — so without this
	 * the caller must remember to fetch first, and forgetting used to look like
	 * a pass. Callers that already mutate (pr_finish, which just merged) pass
	 * true. Fetching a single object updates the object store only: no ref
	 * moves, no index or working-tree change.
	 */
	allowFetch?: boolean;
	/** Remote name for the allowed fetch + `origin/<D>` ref (default `origin`;
	 *  resolve via src/remote.ts and pass down). */
	remoteName?: string;
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
 *   `verify_merge_landed` over hand-rolled `git show --stat` parsing: the same disease,
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
 * The CONTAMINATED remedy line: the corrected `--scope`/`expectedScope` list
 * (current entries ∪ out-of-scope paths, first-seen order) plus how to use it.
 * Pure — exported for unit tests and for callers that render it standalone.
 */
export function scopeRemedyWarning(expectedScope: string[], outOfScopePaths: string[]): string {
	const corrected = [...new Set([...expectedScope, ...outOfScopePaths])];
	return (
		`scope remedy: if the out-of-scope file(s) are INTENTIONAL, the corrected scope is ` +
		`--scope ${corrected.join(",")} — re-run verify-merge-cli <pr> with it (or pass the same ` +
		`expectedScope to verify_merge_landed) to re-adjudicate CLEAN. Doc files (CLAUDE.md, docs/) ` +
		`ride along with code PRs: list every touched root up front, not just the package.`
	);
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
			inspected: false,
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
			inspected: false,
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
			inspected: false,
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
	let inspected = false;
	if (mergeSha) {
		const showNumstat = () =>
			safe(
				"show-numstat",
				() => git(repoRoot, ["show", "--numstat", "--format=", mergeSha]),
				{ stdout: "", stderr: "", exitCode: 1 },
				warnings,
			);
		let r = await showNumstat();
		// The squash commit lands on the remote first, so immediately after a
		// merge the object is simply absent here (`fatal: bad object`). One
		// targeted fetch of that single object fixes it; refs are untouched.
		if (r.exitCode !== 0 && opts.allowFetch) {
			const remote = opts.remoteName ?? "origin";
			const f = await safe(
				"fetch-merge-sha",
				() => git(repoRoot, ["fetch", remote, mergeSha]),
				{ stdout: "", stderr: "", exitCode: 1 },
				warnings,
			);
			if (f.exitCode !== 0) {
				warnings.push(`git fetch ${remote} ${mergeSha} failed: ${trim(f.stderr || f.stdout)}`);
			}
			r = await showNumstat();
		}
		if (r.exitCode === 0) {
			const parsed = parseShowStat(r.stdout);
			files = parsed.files;
			fileCount = parsed.fileCount;
			insertions = parsed.insertions;
			deletions = parsed.deletions;
			inspected = true;
		} else {
			warnings.push(
				`git show --numstat ${mergeSha} failed: ${trim(r.stderr || r.stdout)}` +
					(opts.allowFetch ? "" : " — pass allowFetch (or fetch first) if the merge sha is simply not local yet"),
			);
		}
	} else {
		warnings.push("PR is MERGED but gh returned no mergeSha — cannot inspect touched files.");
	}

	// --- 4. Scope check → outOfScope (only when expectedScope given). ----------
	let outOfScope: VerifyFile[] = [];
	if (opts.expectedScope && opts.expectedScope.length > 0) {
		// matchesScope (not bare startsWith): glob-style entries (`x/**`) must
		// match, and bare entries must not swallow pseudo-prefix siblings.
		// Literal startsWith made every `**` invocation report CONTAMINATED.
		outOfScope = files.filter((f) => !opts.expectedScope!.some((p) => matchesScope(f.path, p)));
	}

	// --- 5. Verdict. -----------------------------------------------------------

	// Scope-drift remedy (2026-08-22, PR #1802 lesson): a CONTAMINATED verdict
	// is usually not a rogue merge — the caller forgot a touched file ROOT in
	// expectedScope (that merge: `bun-apps/s2-agent-ext-devops` passed, the
	// intentional one-line CLAUDE.md edit wasn't). Print the exact corrected
	// scope so the fix is a copy-paste re-verify, not warning archaeology.
	// Doc files are the systematic case — they ride along with code PRs.
	// `inspected` is checked FIRST and CLEAN is no longer the else-branch: an
	// unreadable merge must never be reported as a checked-and-fine merge
	// (issue #1439). CONTAMINATED still outranks nothing here — it can only be
	// reached when files were actually read.
	let verdict: VerifyVerdict;
	if (!inspected) {
		verdict = "UNVERIFIED";
		warnings.push(
			`UNVERIFIED: PR #${pr} merged, but its touched files could not be inspected — the scope check did not run.`,
		);
	} else if (opts.expectedScope && opts.expectedScope.length > 0 && outOfScope.length > 0) {
		verdict = "CONTAMINATED";
		warnings.push(scopeRemedyWarning(opts.expectedScope, outOfScope.map((f) => f.path)));
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
		inspected,
		branchSpent,
		commands,
		warnings,
	};
}
