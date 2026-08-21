/**
 * gh.ts — the git/porcelain client + compatibility re-exports.
 *
 * The forge-facing half of this module (the gh-CLI `ForgeClient` impl +
 * parsePrView/parseChecks) now lives in src/forge/gh-cli.ts — REST-first is
 * the backend policy (src/forge/select.ts); the gh CLI client is the
 * fallback. Everything moved is re-exported below so historical
 * `from "../src/gh.js"` imports (tests, docs, sibling modules) keep working.
 *
 * What remains OWNED here: createBranchClient — the git operations shared by
 * every forge (fetch/push/branch/worktree; Renovate's PlatformScm split: git
 * never goes through a forge adapter).
 */
import type { BranchClient } from "./branch-recipe.js";
import type { SpawnFn } from "./spawn.js";

// SpawnFn / SpawnResult / SpawnOptions are defined in src/spawn.ts (the shared,
// cycle-free home for the spawn abstraction + live factory) and re-exported
// here so existing `from "../src/gh.js"` imports keep working.
export type { SpawnResult, SpawnFn, SpawnOptions } from "./spawn.js";

// The gh-CLI ForgeClient + its parsers moved to src/forge/gh-cli.ts.
export { createGhClient, parsePrView, parseChecks } from "./forge/gh-cli.js";

/** Parse a `git rev-list --count` line to a non-negative int (0 on garbage / a
 *  failed/missing ref, where git exits non-zero with empty stdout). */
function intOr0(s: string): number {
	const n = Number.parseInt((s ?? "").trim(), 10);
	return Number.isFinite(n) && n >= 0 ? n : 0;
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

/** A single `git worktree list --porcelain` record: the worktree path + the
 *  branch checked out there (undefined for a detached worktree). */
export interface WorktreeRecord {
	worktree: string;
	branch?: string;
	detached?: boolean;
}

/**
 * Parse `git worktree list --porcelain` into one record per worktree. Each
 * porcelain record is `worktree <path>` then `HEAD <sha>` + either `branch
 * refs/heads/<name>` or `detached` (+ optional `locked`/`bare`), records
 * separated by blank lines. Robust to a missing trailing blank line. Drives
 * sync_default_branch's worktree-aware default-branch advancement — find the worktree
 * that holds <D> so we advance it THERE rather than hijacking <D> into this
 * worktree (which would fatal on `git checkout`).
 */
export function parseWorktreeList(stdout: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let cur: WorktreeRecord | null = null;
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "").replace(/\s+$/, "");
		if (!line.trim()) {
			if (cur) {
				records.push(cur);
				cur = null;
			}
			continue;
		}
		const sp = line.indexOf(" ");
		const key = sp === -1 ? line : line.slice(0, sp);
		const val = sp === -1 ? "" : line.slice(sp + 1);
		if (key === "worktree") {
			if (cur) records.push(cur);
			cur = { worktree: val };
		} else if (cur && key === "branch") {
			cur.branch = val.replace(/^refs\/heads\//, "");
		} else if (cur && key === "detached") {
			cur.detached = true;
		}
	}
	if (cur) records.push(cur);
	return records;
}

/** One row of `git submodule status --recursive`: status flag + pinned SHA + path. */
export interface SubmoduleStatus {
	/** ` ` matches the recorded gitlink, `+` SHA differs from the recorded
	 *  pointer, `-` not initialized, `U` merge conflict. */
	flag: " " | "+" | "-" | "U";
	sha: string;
	path: string;
}

/**
 * Parse `git submodule status --recursive` lines (`<flag><40-hex> <path>`, path
 * shell-quoted when it contains special chars) into structured rows. Used by
 * sync_default_branch's full-mode submodule report (flag `" "` = the checked-out SHA
 * matches the HEAD-recorded gitlink).
 */
export function parseSubmoduleStatus(stdout: string): SubmoduleStatus[] {
	const out: SubmoduleStatus[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) continue;
		const m = line.match(/^([-+ U])([0-9a-f]{40}) (.+)$/);
		if (!m) continue;
		let path = m[3];
		if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\(.)/g, "$1");
		// NOTE: the flag is kept verbatim — a leading SPACE means "in sync with
		// the recorded gitlink" and must not be trimmed away.
		out.push({ flag: m[1] as SubmoduleStatus["flag"], sha: m[2], path });
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

/** Unquote a `git` core.quotePath-quoted path: strip the surrounding `"..."` and
 *  unescape C-style sequences (`\"`, `\\`, `\n`, `\t`, and best-effort for
 *  `\NNN` octal bytes). Returns the input unchanged when it isn't quoted. */
function unquoteGitPath(s: string): string {
	if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
	const inner = s.slice(1, -1);
	let out = "";
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = inner[i + 1];
		if (next === '"') { out += '"'; i++; }
		else if (next === "\\") { out += "\\"; i++; }
		else if (next === "n") { out += "\n"; i++; }
		else if (next === "t") { out += "\t"; i++; }
		else if (next && /[0-7]/.test(next) && /[0-7]/.test(inner[i + 2] ?? "") && /[0-7]/.test(inner[i + 3] ?? "")) {
			// `\NNN` octal byte → the raw byte char (best-effort; UTF-8 reconstruction
			// is out of scope — path matching against ASCII preserve lists is unaffected).
			out += String.fromCharCode(Number.parseInt(inner.slice(i + 1, i + 4), 8));
			i += 3;
		} else {
			out += ch; // keep the backslash for anything unrecognized
		}
	}
	return out;
}

/** Parse `git status --porcelain=v1` lines into the list of TRACKED dirty paths
 *  (repo-relative — porcelain is always repo-root-relative regardless of cwd).
 *  EXCLUDES untracked (`??`) and ignored (`!!`) entries. For renames/copies
 *  (`R`/`C`), takes the POST-rename (destination) path. Strips the optional
 *  `"..."` core.quotePath quoting. Empty when clean. */
export function parseDirtyPaths(stdout: string): string[] {
	const out: string[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (line.length < 3) continue; // need at least XY + space + a path char
		const xy = line.slice(0, 2);
		if (xy === "??" || xy === "!!") continue; // untracked / ignored — not dirty tracked
		let path = line.slice(3); // after the "XY " prefix
		const arrow = path.indexOf(" -> ");
		if (arrow !== -1) path = path.slice(arrow + 4); // rename/copy → keep destination
		path = unquoteGitPath(path);
		if (path) out.push(path);
	}
	return out;
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
		async worktreeList() {
			const r = await spawn("git", ["worktree", "list", "--porcelain"]);
			return parseWorktreeList(r.stdout);
		},
		async revParse(rev) {
			// --verify -q: on a missing ref prints nothing + exits non-zero (a bare
			// `git rev-parse <ref>` would echo the ref NAME, masking the missing case).
			const r = await spawn("git", ["rev-parse", "--verify", "-q", rev]);
			return r.exitCode === 0 ? r.stdout.trim() : undefined;
		},
		async isClean(dir) {
			// `git diff --quiet HEAD` exits non-zero on ANY tracked change (staged OR
			// unstaged) vs HEAD — the combined equivalent of the bash
			// `diff --quiet || diff --cached --quiet` gate. Untracked files do NOT
			// count (reset --hard / checkout never removes them) — matches bash.
			const r = await spawn("git", ["-C", dir, "diff", "--quiet", "HEAD"]);
			return r.exitCode === 0;
		},
		async dirtyPaths(dir) {
			// `git status --porcelain=v1` lists every TRACKED change (staged +
			// unstaged: modified/added/deleted/renamed/typechange), repo-relative,
			// EXCLUDING untracked (`??`) and ignored. parseDirtyPaths strips
			// untracked/ignored + rename `orig -> dest` prefixes + core.quotePath.
			const r = await spawn("git", ["-C", dir, "status", "--porcelain=v1"]);
			return parseDirtyPaths(r.stdout);
		},
		async unmergedPaths(dir) {
			// `git ls-files -u` lists every CONFLICTED index entry (one row per
			// stage, so a path can appear up to 3×): format "<mode> <sha> <stage>\t<path>"
			// — take the path column after the tab, dedupe. Empty ⇒ no conflict.
			const r = await spawn("git", ["-C", dir, "ls-files", "-u"]);
			if (r.exitCode !== 0) return [];
			const paths = new Set(
				r.stdout
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean)
					.map((l) => l.split("\t")[1] ?? ""),
			);
			return [...paths].filter(Boolean);
		},
		async aheadBehind(base, head) {
			// A missing ref → rev-list exits non-zero with empty stdout → intOr0 → 0.
			const ahead = await spawn("git", ["rev-list", "--count", `${base}..${head}`]);
			const behind = await spawn("git", ["rev-list", "--count", `${head}..${base}`]);
			return { ahead: intOr0(ahead.stdout), behind: intOr0(behind.stdout) };
		},
		async logSubjects(from, to, limit) {
			// Read-only commit-subject listing (`git log --format=%s from..to`),
			// newest first, capped at `limit`. An unresolvable range (missing ref,
			// empty `from`) exits non-zero with empty stdout → [].
			const r = await spawn("git", ["log", "--format=%s", "-n", String(limit), `${from}..${to}`]);
			if (r.exitCode !== 0) return [];
			return r.stdout
				.split("\n")
				.map((l) => l.replace(/\r$/, ""))
				.filter((l) => l.length > 0);
		},
		async fetchPrune() {
			await spawn("git", ["fetch", "--prune"]);
		},
		async detachHead(ref) {
			const r = await spawn("git", ["checkout", "--detach", ref]);
			if (r.exitCode !== 0)
				throw new Error(`git checkout --detach ${ref} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
		},
		async deleteLocalBranch(name) {
			const r = await spawn("git", ["branch", "-D", name]);
			if (r.exitCode !== 0) throw new Error(`git branch -D ${name} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
		},
		async deleteRemoteBranch(name) {
			const r = await spawn("git", ["push", "origin", "--delete", name]);
			if (r.exitCode !== 0) throw new Error(`git push origin --delete ${name} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
		},
	};
}
