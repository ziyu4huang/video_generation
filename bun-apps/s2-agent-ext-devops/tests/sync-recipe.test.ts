/**
 * Tests for runSync — the pure orchestration behind the `sync_default_branch` tool (a TS
 * port of scripts/sync-repo.sh). Mirrors the dual-seam style of recipe.test.ts
 * (fake client) + ci-recipe.test.ts (recording SpawnFn): a minimal `SyncClient`
 * fake feeds canned read-only git state, a recording `SpawnFn` captures every
 * MUTATING command (and feeds canned output for the submodule-status parse).
 * No real git / filesystem.
 *
 * Coverage (ticket 02.1 follow-up — full-mode ff-only-by-default hardening):
 *  (a) full-mode DEFAULT advance in the CURRENT worktree → merge --ff-only
 *      (NOT reset --hard), no checkout;
 *  (b) full-mode DEFAULT advance in ANOTHER worktree → merge --ff-only targets
 *      the OTHER worktree;
 *  (c) full-mode DEFAULT divergent default branch → ABORT (no reset, no
 *      submodule), structured { aborted:true, reason:"divergent", … };
 *  (d) full-mode force:true → reset --hard origin/<D> IS issued (the only path
 *      that still issues reset) + a force warning;
 *  (e) rebase mode;
 *  (f) pull mode (real merge, --no-ff);
 *  (g) dryRun returns commands without mutating (zero spawns) — ff-only plan;
 *  (h) dirty-tree pre-flight abort;
 *  + the default-branch-detection assertions ported from scripts/sync-repo.test.ts
 *    (origin/HEAD → main / master / develop / release-v2 / fallback).
 */
import { test, expect, describe } from "bun:test";
import { runSync, deriveWorktreeBranchName, type SyncClient } from "../src/sync-recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const REPO = "/repo";
const OTHER = "/repo-main-wt";

/** A 40-hex SHA repeated for the canned revParse/submodule-status fixtures. */
const sha = (c: string) => c.repeat(40);

/** Minimal SyncClient fake. `dirty`/`revs`/`aheadBehind` default to safe values.
 *  `dirty` is per-target: a map of worktree dir → list of dirty tracked paths
 *  (repo-relative); omitted ⇒ [] (clean). `subjects` feeds logSubjects. */
function fakeClient(s: {
	defaultBranch?: string;
	current?: string;
	worktrees?: { worktree: string; branch?: string; detached?: boolean }[];
	dirty?: Record<string, string[]>;
	/** Unmerged (conflicted) index entries, per worktree dir; omitted ⇒ []. */
	unmerged?: Record<string, string[]>;
	revs?: Record<string, string>;
	aheadBehind?: Record<string, { ahead: number; behind: number }>;
	subjects?: string[];
}): SyncClient {
	return {
		defaultBranch: async () => s.defaultBranch,
		currentBranch: async () => s.current ?? "",
		worktreeList: async () => s.worktrees ?? [],
		dirtyPaths: async (dir: string) => s.dirty?.[dir] ?? [],
		unmergedPaths: async (dir: string) => s.unmerged?.[dir] ?? [],
		revParse: async (rev: string) => s.revs?.[rev],
		aheadBehind: async (base: string, head: string) => s.aheadBehind?.[`${base}..${head}`] ?? { ahead: 0, behind: 0 },
		logSubjects: async () => s.subjects ?? [],
	};
}

/** Recording SpawnFn. Returns canned results by matching the args (post `-C <dir>`),
 *  defaulting to a quiet success. Records every call so dryRun can assert ZERO spawns. */
function fakeSpawn(canned?: Array<{ match: (args: string[]) => boolean; result: SpawnResult }>) {
	const calls: { cmd: string; args: string[] }[] = [];
	const fn: SpawnFn = async (cmd, args) => {
		calls.push({ cmd, args });
		return canned?.find((c) => c.match(args))?.result ?? { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

/** argsOf: drop the leading `-C <dir>` so matchers read the real git subcommand. */
const realArgs = (a: string[]) => a.filter((_, i) => !(i === 0 && _ === "-C") && !(i === 1 && a[0] === "-C"));

/** Canned successful `git submodule status --recursive` output (sub-a clean, sub-b dirty). */
const SUBMODULE_STATUS: SpawnResult = {
	stdout: ` ${sha("a")} sub-a\n+${sha("b")} sub-b\n`,
	stderr: "",
	exitCode: 0,
};

/** parkPreserve's pairing probe: the top stash entry right after a successful
 *  preserve push — carries OUR tag, so it provably is the entry WE created. */
const STASH_TOP: SpawnResult = { stdout: `${sha("5")} On main: sync_default_branch preserve\n`, stderr: "", exitCode: 0 };
const isStashTopProbe = (a: string[]) => realArgs(a).join(" ") === "stash list --format=%H %gs -n 1";
/** restorePreserve's drop-position probe: the full stash list; our parked
 *  entry (sha "5") sits above a foreign one (sha "f"). */
const STASH_INDEX: SpawnResult = { stdout: `${sha("5")}\n${sha("f")}\n`, stderr: "", exitCode: 0 };
const isStashIndexProbe = (a: string[]) => realArgs(a).join(" ") === "stash list --format=%H";

describe("runSync — full mode DEFAULT (current worktree holds the default branch)", () => {
	test("(a) advances <D> in THIS worktree: fetch + merge --ff-only, NO reset, no checkout", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
			// the advance moved 2 commits with these subjects (advanced[] enrichment)
			aheadBehind: { [`${sha("a")}..${sha("b")}`]: { ahead: 2, behind: 0 } },
			subjects: ["feat: one", "feat: two"],
		});
		const { fn, calls } = fakeSpawn([
			{
				// canned `git submodule status --recursive` output → parsed into the report
				match: (a) => realArgs(a).join(" ").startsWith("submodule status"),
				result: SUBMODULE_STATUS,
			},
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined();
		expect(out.defaultBranch).toBe("main");
		expect(out.advanced).toEqual([
			{ worktree: REPO, branch: "main", from: sha("a"), to: sha("b"), count: 2, subjects: ["feat: one", "feat: two"] },
		]);
		// fetch + merge --ff-only in THIS worktree; NO checkout (main already here).
		expect(out.commands).toContain(`git -C "${REPO}" fetch origin`);
		expect(out.commands).toContain(`git -C "${REPO}" merge --ff-only origin/main`);
		// DEFAULT full-mode issues NO reset --hard.
		expect(out.commands.some((c) => c.includes("reset --hard"))).toBe(false);
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false);
		// merge --ff-only was actually spawned (non-dry), targeting THIS worktree.
		expect(calls.some((c) => c.cmd === "git" && c.args.includes(REPO) && c.args.includes("merge"))).toBe(true);
		expect(calls.some((c) => c.args.includes("reset"))).toBe(false);
		// submodule report parsed from the canned status output: per-row flag +
		// matchesRecordedGitlink (NOT the old `clean` boolean), tagged with the
		// worktree the status was evaluated in.
		expect(out.submodules).toEqual([
			{ worktree: REPO, path: "sub-a", sha: sha("a"), flag: " ", matchesRecordedGitlink: true },
			{ worktree: REPO, path: "sub-b", sha: sha("b"), flag: "+", matchesRecordedGitlink: false },
		]);
	});
});

describe("runSync — full mode DEFAULT (default branch lives in ANOTHER worktree)", () => {
	test("(b) advances <D> in the OTHER worktree via merge --ff-only; leaves this one untouched", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
				{ worktree: OTHER, branch: "main" },
			],
			revs: { "origin/main": sha("c"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined();
		expect(out.advanced).toEqual([{ worktree: OTHER, branch: "main", from: sha("a"), to: sha("c"), count: 0, subjects: [] }]);
		// merge --ff-only targets the OTHER worktree, NOT this one; NO reset anywhere.
		expect(out.commands).toContain(`git -C "${OTHER}" merge --ff-only origin/main`);
		expect(out.commands.some((c) => c.includes("reset --hard"))).toBe(false);
		expect(out.commands.some((c) => c.includes(`-C "${REPO}"`) && c.includes("merge"))).toBe(false);
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false); // main not free → no checkout
		// fetch still happens from this worktree (shared refs).
		expect(out.commands).toContain(`git -C "${REPO}" fetch origin`);
		// the actual merge spawn hit the OTHER worktree dir.
		expect(calls.some((c) => c.args.includes(OTHER) && c.args.includes("merge"))).toBe(true);
		expect(calls.some((c) => c.args.includes(REPO) && c.args.includes("merge"))).toBe(false);
		expect(calls.some((c) => c.args.includes("reset"))).toBe(false);
	});

	test("dirty OTHER worktree → aborted, no merge/reset anywhere", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
				{ worktree: OTHER, branch: "main" },
			],
			dirty: { [OTHER]: ["src/foo.ts"] }, // the worktree holding <D> is dirty (a REAL, non-preserve path)
			revs: { "origin/main": sha("c"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted?.reason).toBe("dirty_tree");
		expect(out.aborted?.message).toMatch(/dirty tree/);
		expect(out.advanced).toEqual([]);
		// aborted BEFORE fetch → nothing mutated.
		expect(calls.length).toBe(0);
		expect(out.commands.some((c) => c.includes("merge"))).toBe(false);
		expect(out.commands.some((c) => c.includes("reset"))).toBe(false);
	});
});

describe("runSync — full mode DEFAULT divergent (the safety guard)", () => {
	test("(c) divergent default branch → git refuses ff → ABORT, no reset, no submodule update", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
			// local main has commits not on origin/main → not fast-forwardable.
			aheadBehind: { "origin/main..main": { ahead: 2, behind: 1 } },
		});
		const { fn, calls } = fakeSpawn([
			{
				// git refuses the fast-forward (divergent) → exit non-zero.
				match: (a) => realArgs(a).join(" ").startsWith("merge --ff-only"),
				result: { stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.", exitCode: 128 },
			},
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		// structured divergent abort descriptor.
		expect(out.aborted?.aborted).toBe(true);
		expect(out.aborted?.reason).toBe("divergent");
		expect(out.aborted?.defaultBranch).toBe("main");
		expect(out.aborted?.hint).toMatch(/refusing to fast-forward/);
		expect(out.aborted?.hint).toMatch(/force:true/);
		// the pre-flight detection still surfaced the unpushed commits as a warning.
		expect(out.warnings.some((w) => /default branch 'main' is 2 commit\(s\) ahead/.test(w))).toBe(true);
		expect(out.advanced).toEqual([]);
		expect(out.submodules).toEqual([]);
		// NO reset, NO submodule update issued (the merge attempt refused).
		expect(out.commands.some((c) => c.includes("reset --hard"))).toBe(false);
		expect(out.commands.some((c) => c.includes("submodule"))).toBe(false);
		// the ff-only attempt DID fire (and refused) — that's the abort trigger.
		expect(calls.some((c) => c.args.includes("merge") && c.args.includes("--ff-only"))).toBe(true);
		expect(calls.some((c) => c.args.includes("reset"))).toBe(false);
	});
});

describe("runSync — full mode force:true (explicit destructive opt-in)", () => {
	test("(d) force:true → reset --hard origin/<D> issued + a force warning (discards divergent)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
			// divergent: would ABORT under the default; force:true overrides.
			aheadBehind: { "origin/main..main": { ahead: 2, behind: 1 } },
		});
		const { fn, calls } = fakeSpawn([
			{
				match: (a) => realArgs(a).join(" ").startsWith("submodule status"),
				result: SUBMODULE_STATUS,
			},
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", force: true });

		expect(out.aborted).toBeUndefined();
		expect(out.advanced).toEqual([{ worktree: REPO, branch: "main", from: sha("a"), to: sha("b"), count: 0, subjects: [] }]);
		// THIS is the only path that issues reset --hard.
		expect(out.commands).toContain(`git -C "${REPO}" reset --hard origin/main`);
		expect(out.commands.some((c) => c.includes("merge --ff-only"))).toBe(false);
		expect(calls.some((c) => c.args.includes(REPO) && c.args.includes("reset"))).toBe(true);
		// force is warned + the divergent pre-flight warning still present.
		expect(out.warnings.some((w) => /force:true/.test(w) && /reset --hard/.test(w))).toBe(true);
		expect(out.warnings.some((w) => /default branch 'main' is 2 commit\(s\) ahead/.test(w))).toBe(true);
		// submodule sync still runs after the reset.
		expect(out.commands.some((c) => c.includes("submodule update"))).toBe(true);
	});
});

describe("runSync — rebase mode", () => {
	test("(e) fetches then rebases the current branch onto origin/<D>", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/y",
			worktrees: [{ worktree: REPO, branch: "feat/y" }],
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase" });

		expect(out.aborted).toBeUndefined();
		expect(out.advanced[0].branch).toBe("feat/y");
		expect(out.advanced[0].worktree).toBe(REPO);
		expect(out.commands).toContain(`git -C "${REPO}" fetch origin`);
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main`);
		// full-only commands do NOT appear.
		expect(out.commands.some((c) => c.includes("reset --hard"))).toBe(false);
		expect(out.commands.some((c) => c.includes("merge --ff-only"))).toBe(false);
		expect(out.commands.some((c) => c.includes("submodule"))).toBe(false);
		expect(out.submodules).toEqual([]);
		expect(calls.some((c) => c.args.includes("rebase"))).toBe(true);
	});
});

describe("runSync — pull mode", () => {
	test("(f) fetches then MERGES origin/<D> (real merge, --no-ff — never ff)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/z",
			worktrees: [{ worktree: REPO, branch: "feat/z" }],
			revs: { "origin/main": sha("m"), HEAD: sha("h") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "pull" });

		expect(out.aborted).toBeUndefined();
		expect(out.advanced[0].branch).toBe("feat/z");
		expect(out.commands).toContain(`git -C "${REPO}" merge --no-edit --no-ff origin/main`);
		expect(out.commands.some((c) => c.includes("rebase"))).toBe(false);
		expect(out.commands.some((c) => c.includes("reset --hard"))).toBe(false);
		expect(calls.some((c) => c.args.includes("merge") && c.args.includes("--no-ff"))).toBe(true);
	});

	test("rebase/pull on a detached HEAD → aborted (cannot advance detached)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "HEAD", // detached
			revs: { "origin/main": sha("r") },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase" });
		expect(out.aborted?.reason).toBe("detached_head");
		expect(out.aborted?.message).toMatch(/detached HEAD/);
		// the abort now carries the recovery hint (branch option).
		expect(out.aborted?.hint).toMatch(/branch/);
		expect(out.advanced).toEqual([]);
	});
});

describe("runSync — rebase/pull detached-HEAD branch recovery (`branch` option)", () => {
	test("creates the named branch at HEAD, then rebases IT onto origin/<D>", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "HEAD",
			worktrees: [{ worktree: REPO, detached: true }],
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase", branch: "feat/wf" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" checkout -b feat/wf`);
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main`);
		// the advance is attributed to the NEW branch, from the detached HEAD.
		expect(out.advanced[0].branch).toBe("feat/wf");
		expect(out.advanced[0].from).toBe(sha("h"));
		expect(out.warnings.some((w) => /created branch 'feat\/wf'/.test(w))).toBe(true);
	});

	test("'auto' derives the branch name from the worktree folder suffix", async () => {
		const WT = "/Users/x/proj/video_generation__memory";
		const client = fakeClient({
			defaultBranch: "main",
			current: "HEAD",
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: WT, mode: "rebase", branch: "auto" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${WT}" checkout -b memory`);
		expect(out.advanced[0].branch).toBe("memory");
	});

	test("ATTACHES an existing branch pointing at the EXACT HEAD (plain checkout, no -b)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "HEAD",
			revs: { "origin/main": sha("r"), HEAD: sha("h"), "refs/heads/feat/wf": sha("h") },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase", branch: "feat/wf" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" checkout feat/wf`);
		expect(out.commands.some((c) => c.includes("checkout -b"))).toBe(false);
	});

	test("aborts branch_exists when the name exists at a DIFFERENT commit (nothing moved)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "HEAD",
			revs: { "origin/main": sha("r"), HEAD: sha("h"), "refs/heads/feat/wf": sha("o") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase", branch: "feat/wf" });

		expect(out.aborted?.reason).toBe("branch_exists");
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false);
		expect(calls.length).toBe(0);
	});

	test("aborts worktree_conflict when the name is checked out in ANOTHER worktree", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "HEAD",
			worktrees: [
				{ worktree: REPO, detached: true },
				{ worktree: OTHER, branch: "feat/wf" },
			],
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase", branch: "feat/wf" });

		expect(out.aborted?.reason).toBe("worktree_conflict");
		expect(calls.length).toBe(0);
	});

	test("aborts branch_name_invalid when the name IS the default branch, or 'auto' slugs to empty", async () => {
		const mk = () =>
			fakeClient({ defaultBranch: "main", current: "HEAD", revs: { "origin/main": sha("r"), HEAD: sha("h") } });
		const a = await runSync({ client: mk(), spawn: fakeSpawn().fn, repoRoot: REPO, mode: "rebase", branch: "main" });
		expect(a.aborted?.reason).toBe("branch_name_invalid");

		// a folder name that slugs to "" — unresolvable, never a silent default.
		const b = await runSync({
			client: mk(),
			spawn: fakeSpawn().fn,
			repoRoot: "/x/!!!",
			mode: "rebase",
			branch: "auto",
		});
		expect(b.aborted?.reason).toBe("branch_name_invalid");
	});

	test("branch is ignored (warned, never fatal) when the caller is already on a branch or in full mode", async () => {
		const onBranch = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const out = await runSync({ client: onBranch, spawn: fakeSpawn().fn, repoRoot: REPO, mode: "rebase", branch: "feat/y" });
		expect(out.aborted).toBeUndefined();
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false);
		expect(out.warnings.some((w) => /branch option ignored/.test(w))).toBe(true);

		const full = fakeClient({
			defaultBranch: "main",
			current: "HEAD",
			revs: { "origin/main": sha("r") },
		});
		const out2 = await runSync({ client: full, spawn: fakeSpawn().fn, repoRoot: REPO, mode: "full", branch: "feat/y" });
		expect(out2.aborted).toBeUndefined();
		expect(out2.warnings.some((w) => /branch option ignored in full mode/.test(w))).toBe(true);
	});

	test("dryRun RECORDS the checkout -b plan without spawning it", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "HEAD",
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase", branch: "feat/wf", dryRun: true });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" checkout -b feat/wf`);
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main`);
		expect(out.advanced[0].branch).toBe("feat/wf");
		expect(calls.length).toBe(0);
	});

	test("a REAL dirty path aborts BEFORE any branch creation — aborting runs mutate nothing", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "HEAD",
			dirty: { [REPO]: ["src/foo.ts"] }, // real (non-preserve) dirty path
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase", branch: "feat/wf" });

		expect(out.aborted?.reason).toBe("dirty_tree");
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false);
		expect(calls.length).toBe(0);
	});
});

describe("deriveWorktreeBranchName — 'auto' name derivation", () => {
	test("session-worktree suffix, bare folder, agent worktree, and slugification", () => {
		expect(deriveWorktreeBranchName("/Users/x/proj/video_generation__memory")).toBe("memory");
		expect(deriveWorktreeBranchName("/repo")).toBe("repo");
		expect(deriveWorktreeBranchName("/repo/.claude/worktrees/agent-adcb08ef619f83c96")).toBe("agent-adcb08ef619f83c96");
		expect(deriveWorktreeBranchName("/x/video_generation__My Branch!")).toBe("my-branch");
		expect(deriveWorktreeBranchName("/x/proj__")).toBe("proj"); // trailing separator falls back to the stem
		expect(deriveWorktreeBranchName("/x/!!!")).toBe(""); // unsluggable → caller aborts
		expect(deriveWorktreeBranchName("/x/__Memory__")).toBe("memory");
	});
});

describe("runSync — dryRun", () => {
	test("(g) computes + returns the full ff-only command plan WITHOUT spawning any mutation", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", dryRun: true });

		expect(out.dryRun).toBe(true);
		expect(out.aborted).toBeUndefined();
		// from/to resolved by read-only queries (real SHAs), so the plan is accurate;
		// the commit enrichment is NOT computed under dryRun (count 0, subjects []).
		expect(out.advanced).toEqual([{ worktree: REPO, branch: "main", from: sha("a"), to: sha("b"), count: 0, subjects: [] }]);
		// the full happy-path command set is present — ff-only, NOT reset --hard …
		expect(out.commands).toContain(`git -C "${REPO}" fetch origin`);
		expect(out.commands).toContain(`git -C "${REPO}" merge --ff-only origin/main`);
		expect(out.commands.some((c) => c.includes("reset --hard"))).toBe(false);
		expect(out.commands.some((c) => c.includes("submodule update"))).toBe(true);
		// … but ZERO mutating spawns fired.
		expect(calls.length).toBe(0);
	});

	test("dryRun on a dirty tree does NOT abort (plan still returned) + warns", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: ["src/foo.ts"] }, // a REAL (non-preserve) dirty path
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", dryRun: true });

		expect(out.aborted).toBeUndefined(); // dry-run never aborts
		expect(out.warnings.some((w) => /uncommitted tracked change/.test(w))).toBe(true);
		expect(out.commands.some((c) => c.includes("merge --ff-only"))).toBe(true); // plan still shown
		expect(out.commands.some((c) => c.includes("reset --hard"))).toBe(false);
		expect(calls.length).toBe(0);
	});
});

describe("runSync — pre-flight abort (dirty tree)", () => {
	test("(h) mutating full run on a dirty tree → aborted before fetch, no commands", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: ["src/foo.ts"] }, // a REAL (non-preserve) dirty path → still aborts
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted?.reason).toBe("dirty_tree");
		expect(out.aborted?.message).toMatch(/dirty tree/);
		expect(out.advanced).toEqual([]);
		expect(out.commands).toEqual([]); // aborted before any git() log
		expect(calls.length).toBe(0); // nothing mutated
	});
});

// --- unmerged-index pre-flight (preserve-flow hardening): a conflicted stash
// pop leaves unmerged index entries; the NEXT sync's preserve `stash push`
// then died with a cryptic "could not write index" (observed 2026-08-19/20 on
// both worktrees via MEMORY.md). runSync must refuse EARLY, before any stash
// or fetch, with the concrete recovery commands.
describe("runSync — unmerged-index pre-flight (preserve-flow hardening)", () => {
	test("(i) unmerged entries abort 'unmerged_index' BEFORE any stash push — zero mutating spawns", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] }, // preserve-listed → NOT a dirty_tree abort
			unmerged: { [REPO]: [".agents/memory/MEMORY.md"] },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted?.aborted).toBe(true);
		expect(out.aborted?.reason).toBe("unmerged_index");
		expect(out.aborted?.message).toMatch(/unmerged index entries/);
		expect(out.aborted?.message).toMatch(/stash pop/); // recovery hint present
		expect(out.advanced).toEqual([]);
		// No stash, no fetch, no merge — died in pre-flight.
		expect(calls.some((c) => c.args.includes("stash"))).toBe(false);
		expect(calls.some((c) => c.args.includes("fetch"))).toBe(false);
		expect(calls.some((c) => c.args.includes("merge"))).toBe(false);
		expect(calls.length).toBe(0);
	});

	test("(ii) dryRun with unmerged entries: warning, no abort, zero spawns", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			unmerged: { [REPO]: ["a.ts"] },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", dryRun: true });

		expect(out.aborted).toBeUndefined();
		expect(out.warnings.join(" ")).toContain("unmerged");
		expect(calls.length).toBe(0);
	});

	test("(iii) clean index proceeds normally (unmergedPaths consulted, no regression)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			unmerged: {},
			revs: { "origin/main": sha("b"), main: sha("a") },
			aheadBehind: { [`${sha("a")}..${sha("b")}`]: { ahead: 2, behind: 0 } },
			subjects: ["feat: one", "feat: two"],
		});
		const { fn } = fakeSpawn([
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" fetch origin`);
		expect(out.commands).toContain(`git -C "${REPO}" merge --ff-only origin/main`);
	});

	test("(iv) rebase mode with unmerged entries → abort 'unmerged_index' BEFORE the preserve stash push", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/y",
			worktrees: [{ worktree: REPO, branch: "feat/y" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] }, // preserve-listed → NOT a dirty_tree abort
			unmerged: { [REPO]: [".agents/memory/MEMORY.md"] },
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase" });

		expect(out.aborted?.aborted).toBe(true);
		expect(out.aborted?.reason).toBe("unmerged_index");
		expect(out.aborted?.message).toMatch(/unmerged index entries/);
		expect(out.advanced).toEqual([]);
		// No stash push, no fetch, no rebase — died in pre-flight like full mode.
		expect(calls.some((c) => c.args.includes("stash"))).toBe(false);
		expect(calls.some((c) => c.args.includes("fetch"))).toBe(false);
		expect(calls.some((c) => c.args.includes("rebase"))).toBe(false);
		expect(calls.length).toBe(0);
	});

	test("(v) rebase dryRun with unmerged entries: warning, no abort, zero spawns", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/y",
			worktrees: [{ worktree: REPO, branch: "feat/y" }],
			unmerged: { [REPO]: ["a.ts"] },
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase", dryRun: true });

		expect(out.aborted).toBeUndefined();
		expect(out.warnings.join(" ")).toContain("unmerged");
		expect(calls.length).toBe(0);
	});
});

// --- preserve pop-conflict aftermath warning: when `git stash pop` conflicts,
// the worktree is left MID-CONFLICT (unmerged index entries + conflict markers
// in the parked paths) and the stash is KEPT — the warning must state that
// aftermath AND the manual recovery, plus that the next sync will refuse with
// 'unmerged_index' by design (the 2026-08-19/20 incident: the old one-line
// warning hid the state that broke the NEXT day's sync).
describe("runSync — preserve pop-conflict aftermath warning", () => {
	test("pop conflict warning names the CONFLICTED SUBSET (parsed from pop output), the kept stash's identifier, and manual recovery", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			// THREE parked paths; the canned pop output conflicts on only TWO.
			dirty: { [REPO]: ["a.md", "b.md", "c.md"] },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn } = fakeSpawn([
			{ match: isStashTopProbe, result: STASH_TOP },
			{
				match: (a) => realArgs(a).join(" ").startsWith("stash apply"),
				result: {
					stdout: "",
					// git's REAL casing: "Merge conflict in" (capital M). The lowercase
					// shape below never occurs in real git output — a canned lowercase
					// stderr silently passes even when the parser only matches it.
					stderr: "CONFLICT (content): Merge conflict in a.md\nCONFLICT (content): Merge conflict in b.md",
					exitCode: 1,
				},
			},
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", preserve: ["a.md", "b.md", "c.md"] });

		expect(out.aborted).toBeUndefined(); // the advance itself succeeded
		expect(out.preserved?.restored).toBe(false);
		const w = out.warnings.join(" ");
		expect(w).toContain("unmerged index entries"); // states the aftermath
		// conflicted SUBSET only — c.md parked clean, must NOT be listed.
		expect(w).toContain("a.md, b.md");
		expect(w).not.toContain("c.md");
		// the kept stash is identified by its push message.
		expect(w).toContain("stash list | grep 'sync_default_branch preserve'");
		expect(w).toContain("git -C"); // recovery commands
		expect(w).toContain("stash drop"); // stash retention + drop guidance
	});

	test("pop output without parsable CONFLICT lines → warning falls back to ALL parked paths", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: ["a.md", "b.md"] },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn } = fakeSpawn([
			{ match: isStashTopProbe, result: STASH_TOP },
			{ match: (a) => realArgs(a).join(" ").startsWith("stash apply"), result: { stdout: "", stderr: "error: could not restore untracked files", exitCode: 1 } },
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", preserve: ["a.md", "b.md"] });

		expect(out.preserved?.restored).toBe(false);
		const w = out.warnings.join(" ");
		expect(w).toContain("a.md, b.md"); // fallback: all parked paths listed
	});
});

// --- default-branch detection: ported from scripts/sync-repo.test.ts ---------
// The bash suite asserted detect_default_branch() honored origin/HEAD for
// main / master / develop / release-v2 and fell back to "main" offline. The TS
// port centralizes detection in BranchClient.defaultBranch() (origin/HEAD only);
// these assert runSync surfaces the SAME name in `outcome.defaultBranch`.
describe("runSync — default-branch detection (ported from sync-repo.test.ts)", () => {
	const base = (db?: string) => fakeClient({ defaultBranch: db, current: "main", revs: { "origin/main": sha("b"), main: sha("a") } });

	test("origin/HEAD → main", async () => {
		const out = await runSync({ client: base("main"), spawn: fakeSpawn().fn, repoRoot: REPO, mode: "full", dryRun: true });
		expect(out.defaultBranch).toBe("main");
	});

	test("origin/HEAD → master (NOT hardcoded to main)", async () => {
		const out = await runSync({
			client: fakeClient({ defaultBranch: "master", current: "master", revs: { "origin/master": sha("b"), master: sha("a") } }),
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			mode: "full",
			dryRun: true,
		});
		expect(out.defaultBranch).toBe("master");
	});

	test("origin/HEAD → develop", async () => {
		const out = await runSync({
			client: fakeClient({ defaultBranch: "develop", current: "develop", revs: { "origin/develop": sha("b"), develop: sha("a") } }),
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			mode: "full",
			dryRun: true,
		});
		expect(out.defaultBranch).toBe("develop");
	});

	test("origin/HEAD → release/v2 strips only the remote prefix (slash preserved)", async () => {
		const out = await runSync({
			client: fakeClient({
				defaultBranch: "release/v2",
				current: "release/v2",
				revs: { "origin/release/v2": sha("b"), "release/v2": sha("a") },
			}),
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			mode: "full",
			dryRun: true,
		});
		expect(out.defaultBranch).toBe("release/v2");
	});

	test("no origin/HEAD → fallback 'main' + a warning", async () => {
		const out = await runSync({ client: base(undefined), spawn: fakeSpawn().fn, repoRoot: REPO, mode: "full", dryRun: true });
		expect(out.defaultBranch).toBe("main");
		expect(out.warnings.some((w) => /falling back to 'main'/.test(w))).toBe(true);
	});
});

describe("runSync — pre-flight warnings (unpushed commits)", () => {
	test("unpushed commits on current + default branch → two warnings, no abort", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }, { worktree: OTHER, branch: "main" }],
			revs: { "origin/main": sha("c"), main: sha("a") },
			aheadBehind: {
				"origin/feat/x..feat/x": { ahead: 2, behind: 0 },
				"origin/main..main": { ahead: 1, behind: 3 },
			},
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", dryRun: true });
		expect(out.warnings.some((w) => /feat\/x is 2 commit\(s\) ahead/.test(w))).toBe(true);
		expect(out.warnings.some((w) => /default branch 'main' is 1 commit\(s\) ahead/.test(w))).toBe(true);
		expect(out.aborted).toBeUndefined();
	});
});

// --- preserve hot files (zk-spawn): auto-managed files stashed+restored ----
// The default sync must SUCCEED when the only uncommitted changes are
// preserve-listed "hot files" (hermes .agents/memory/MEMORY.md), stashing them
// before the advance and restoring after — without weakening the dirty_tree
// safety gate for genuinely uncommitted work.
describe("runSync — preserve hot files (stash before, restore after)", () => {
	const STASH_PUSH = `git -C "${OTHER}" stash push -m sync_default_branch preserve -- .agents/memory/MEMORY.md`;
	// restore applies the tagged entry the park's OWN push created (pairing), by SHA.
	const STASH_APPLY = `git -C "${OTHER}" stash apply ${sha("5")}`;

	test("(a) preservable-only dirty (MEMORY.md) in the OTHER worktree → stash + advance + pop, NOT aborted", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
				{ worktree: OTHER, branch: "main" },
			],
			dirty: { [OTHER]: [".agents/memory/MEMORY.md"] }, // only the default preserve file is dirty
			revs: { "origin/main": sha("c"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn([
			{ match: isStashTopProbe, result: STASH_TOP },
			{ match: isStashIndexProbe, result: STASH_INDEX },
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined();
		expect(out.advanced).toEqual([{ worktree: OTHER, branch: "main", from: sha("a"), to: sha("c"), count: 0, subjects: [] }]);
		// the full park→advance→restore command sequence, targeting the OTHER worktree.
		expect(out.commands).toContain(STASH_PUSH);
		expect(out.commands).toContain(`git -C "${OTHER}" merge --ff-only origin/main`);
		expect(out.commands).toContain(STASH_APPLY);
		// applied cleanly → the parked entry is dropped at its CONTENT-matched position.
		expect(out.commands).toContain(`git -C "${OTHER}" stash drop stash@{0}`);
		expect(out.preserved).toEqual({ paths: [".agents/memory/MEMORY.md"], restored: true });
		// submodule sync still runs after the advance.
		expect(out.commands.some((c) => c.includes("submodule update"))).toBe(true);
		// stash push + apply were actually spawned (non-dry), on the OTHER worktree.
		expect(calls.some((c) => c.args.includes(OTHER) && c.args.includes("stash") && c.args.includes("push"))).toBe(true);
		expect(calls.some((c) => c.args.includes(OTHER) && c.args.includes("stash") && c.args.includes("apply"))).toBe(true);
	});

	test("(b) dirty with BOTH MEMORY.md AND src/foo.ts (real present) → abort dirty_tree, no stash push", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
				{ worktree: OTHER, branch: "main" },
			],
			dirty: { [OTHER]: [".agents/memory/MEMORY.md", "src/foo.ts"] },
			revs: { "origin/main": sha("c"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted?.reason).toBe("dirty_tree");
		expect(out.aborted?.message).toMatch(/outside the preserve list/);
		expect(out.advanced).toEqual([]);
		// genuine uncommitted work → no stash, no merge, no spawn.
		expect(out.commands.some((c) => c.includes("stash"))).toBe(false);
		expect(out.commands.some((c) => c.includes("merge"))).toBe(false);
		expect(calls.length).toBe(0);
	});

	test("(c1) preserve: ['build/'] dirty build/out.json → advances (preserved)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: ["build/out.json"] }, // dir-prefix preserve match
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn } = fakeSpawn([
			{ match: isStashTopProbe, result: STASH_TOP },
			{ match: isStashIndexProbe, result: STASH_INDEX },
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", preserve: ["build/"] });

		expect(out.aborted).toBeUndefined();
		expect(out.preserved).toEqual({ paths: ["build/out.json"], restored: true });
		expect(out.commands).toContain(`git -C "${REPO}" stash push -m sync_default_branch preserve -- build/out.json`);
		expect(out.commands).toContain(`git -C "${REPO}" stash apply ${sha("5")}`);
	});

	test("(c2) preserve: ['build/'] dirty README.md → abort dirty_tree (not preserved)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: ["README.md"] }, // outside the build/ preserve prefix
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", preserve: ["build/"] });

		expect(out.aborted?.reason).toBe("dirty_tree");
		expect(out.commands.some((c) => c.includes("stash"))).toBe(false);
	});

	test("(d) preserve: [] (disable) → MEMORY.md is now REAL → abort dirty_tree", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", preserve: [] });

		expect(out.aborted?.reason).toBe("dirty_tree");
		expect(out.commands.some((c) => c.includes("stash"))).toBe(false);
	});

	test("(e) stash apply conflict → restored:false + warn, stash KEPT (no drop)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn } = fakeSpawn([
			{ match: isStashTopProbe, result: STASH_TOP },
			{ match: (a) => realArgs(a).join(" ").startsWith("stash apply"), result: { stdout: "", stderr: "CONFLICT (content): Merge conflict in .agents/memory/MEMORY.md", exitCode: 1 } },
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined(); // the advance itself succeeded
		expect(out.preserved?.restored).toBe(false);
		expect(out.preserved?.conflict).toMatch(/CONFLICT/);
		expect(out.warnings.some((w) => /stash apply CONFLICTED/.test(w))).toBe(true);
		// Explicit subset pin: the aftermath names the PARSED conflicted path in
		// git's real casing (single parked file, so the multi-path discrimination
		// lives in the pop-conflict-warning suite above — this asserts the shape).
		expect(out.warnings.some((w) => w.includes("conflict markers in: .agents/memory/MEMORY.md"))).toBe(true);
		// we KEEP the stash on apply conflict (never drop it).
		expect(out.commands.some((c) => c.includes("stash drop"))).toBe(false);
	});

	test("(f) stash push failure → abort preserve_failed, no merge/reset", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn } = fakeSpawn([
			{ match: (a) => realArgs(a).join(" ").startsWith("stash push"), result: { stdout: "", stderr: "fatal: bad revision", exitCode: 128 } },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted?.reason).toBe("preserve_failed");
		expect(out.aborted?.message).toMatch(/stash push of preserve paths failed/);
		// push failed BEFORE the advance → no merge, no reset, no pop.
		expect(out.commands.some((c) => c.includes("merge"))).toBe(false);
		expect(out.commands.some((c) => c.includes("reset"))).toBe(false);
		expect(out.commands.some((c) => c.includes("stash pop"))).toBe(false);
		expect(out.advanced).toEqual([]);
	});

	test("(g) rebase mode with preservable dirty → stash + rebase + pop", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/y",
			worktrees: [{ worktree: REPO, branch: "feat/y" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] },
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn, calls } = fakeSpawn([
			{ match: isStashTopProbe, result: STASH_TOP },
			{ match: isStashIndexProbe, result: STASH_INDEX },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" stash push -m sync_default_branch preserve -- .agents/memory/MEMORY.md`);
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main`);
		expect(out.commands).toContain(`git -C "${REPO}" stash apply ${sha("5")}`);
		expect(out.preserved).toEqual({ paths: [".agents/memory/MEMORY.md"], restored: true });
		expect(calls.some((c) => c.args.includes("rebase"))).toBe(true);
	});

	test("(h) dryRun preservable-only dirty → plan shows stash/merge/pop, no abort, zero spawns", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", dryRun: true });

		expect(out.aborted).toBeUndefined();
		// the planned park→advance→restore sequence is recorded (but not spawned).
		expect(out.commands).toContain(`git -C "${REPO}" stash push -m sync_default_branch preserve -- .agents/memory/MEMORY.md`);
		expect(out.commands).toContain(`git -C "${REPO}" merge --ff-only origin/main`);
		expect(out.commands).toContain(`git -C "${REPO}" stash pop`);
		// warnings mention the preserve split; preserved is unset under dryRun.
		expect(out.warnings.some((w) => /preserve-listed/.test(w))).toBe(true);
		expect(out.preserved).toBeUndefined();
		expect(calls.length).toBe(0); // zero mutating spawns
	});
});

// --- push→pop pairing (2026-08-22 incident): `git stash push -- <gitlink>` ---
// exits 0 while creating NO stash entry (git cannot stash a bare submodule
// gitlink) — the old code then blind-popped stash@{0}, which in a
// multi-session repo was ANOTHER session's day-old stash (applied onto the
// tree as a phantom conflict in an unrelated file). The park must verify its
// push created an entry and the restore must pop ONLY that entry (by SHA,
// position-independent even if a concurrent session pushes on top).
describe("runSync — preserve stash push→pop pairing (gitlink incident)", () => {
	/** The incident's exact probe result: the push created nothing, so the top
	 *  stash is a FOREIGN day-old entry (untagged by us). */
	const FOREIGN_TOP: SpawnResult = { stdout: `${sha("f")} On main: s2-agent-rename-presync-20260821\n`, stderr: "", exitCode: 0 };

	test("(i) ALL preserve paths are gitlinks → push creates NO entry (foreign stash on top) → NO pop, warning, advance proceeds", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: ["vaults_root/study-news"] }, // a bare gitlink change
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn([
			{ match: isStashTopProbe, result: FOREIGN_TOP },
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", preserve: ["vaults_root/study-news"] });

		expect(out.aborted).toBeUndefined(); // the advance itself proceeds
		// CRITICAL: no restore pop — a blind pop could apply an unrelated stash.
		expect(calls.some((c) => realArgs(c.args).join(" ").startsWith("stash pop"))).toBe(false);
		expect(out.commands.some((c) => c.includes("stash pop"))).toBe(false);
		// nothing was parked, so there is no preserve-restore result at all.
		expect(out.preserved).toBeUndefined();
		const w = out.warnings.join(" ");
		expect(w).toContain("created NO stash entry");
		expect(w).toContain("gitlink");
		expect(w).toContain("SKIPPED");
	});

	test("(ii) rebase mode: same entry-less push → no pop (shared park/restore helpers)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/y",
			worktrees: [{ worktree: REPO, branch: "feat/y" }],
			dirty: { [REPO]: ["vaults_root/study-news"] },
			revs: { "origin/main": sha("r"), HEAD: sha("h") },
		});
		const { fn, calls } = fakeSpawn([{ match: isStashTopProbe, result: FOREIGN_TOP }]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase", preserve: ["vaults_root/study-news"] });

		expect(out.aborted).toBeUndefined();
		expect(calls.some((c) => realArgs(c.args).join(" ").startsWith("stash pop"))).toBe(false);
		expect(out.preserved).toBeUndefined();
		expect(out.warnings.some((w) => w.includes("created NO stash entry"))).toBe(true);
	});

	test("(iii) restore applies the tagged SHA (position-independent) + drops at content-matched position, foreign entry untouched", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		// The top probe reports OUR entry (sha "5"); the index probe shows a
		// concurrent session's stash (sha "f") pushed BELOW ours. Apply keys on
		// the SHA (never positional); drop re-derives the position by content.
		const { fn, calls } = fakeSpawn([
			{ match: isStashTopProbe, result: STASH_TOP },
			{ match: isStashIndexProbe, result: STASH_INDEX },
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined();
		expect(out.preserved).toEqual({ paths: [".agents/memory/MEMORY.md"], restored: true });
		// apply targets the tagged entry's SHA, not a positional stash@{0}.
		const apply = calls.find((c) => realArgs(c.args).join(" ").startsWith("stash apply"));
		expect(apply).toBeDefined();
		expect(apply?.args).toContain(sha("5"));
		expect(apply?.args).not.toContain("stash@{0}");
		// drop resolves OUR entry's position from the list content — index 0
		// here (ours on top), and can never name the foreign sha.
		const drop = calls.find((c) => realArgs(c.args).join(" ").startsWith("stash drop"));
		expect(drop?.args).toContain("stash@{0}");
		expect(drop?.args).not.toContain(sha("f"));
	});
});

// --- caller post-state (#1): what is checked out in the CALLING worktree after
// the sync + how far behind origin/<D> it now is (warn when it lags — full
// mode advances <D> only in the worktree that HOLDS it).
describe("runSync — caller post-state", () => {
	test("caller behind origin/<D> → behindDefault + behind warning", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
				{ worktree: OTHER, branch: "main" },
			],
			revs: { "origin/main": sha("c"), main: sha("a") },
			aheadBehind: { "origin/main..feat/x": { ahead: 1, behind: 2 } },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.caller).toEqual({ worktree: REPO, branch: "feat/x", detached: false, behindDefault: 2 });
		expect(out.warnings.some((w) => /calling worktree \/repo is 2 commit\(s\) behind main/.test(w))).toBe(true);
	});

	test("caller up to date → behindDefault 0, no behind warning", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
				{ worktree: OTHER, branch: "main" },
			],
			revs: { "origin/main": sha("c"), main: sha("a") },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.caller).toEqual({ worktree: REPO, branch: "feat/x", detached: false, behindDefault: 0 });
		expect(out.warnings.some((w) => /calling worktree/.test(w))).toBe(false);
	});

	test("detached caller → branch null, behindDefault null, no behind warning", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "HEAD", // detached (rev-parse --abbrev-ref HEAD → "HEAD")
			worktrees: [
				{ worktree: REPO, detached: true },
				{ worktree: OTHER, branch: "main" },
			],
			revs: { "origin/main": sha("c"), main: sha("a") },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.caller).toEqual({ worktree: REPO, branch: null, detached: true, behindDefault: null });
		expect(out.warnings.some((w) => /calling worktree/.test(w))).toBe(false);
	});
});

// --- verification snapshot (#4): ALWAYS present on a completed full-mode run.
describe("runSync — verification snapshot", () => {
	test("local <D> != origin/<D> post-advance → ok:false + the drift warning", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") }, // revParse(D) still stale → drift
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS }]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.verification).toEqual({ branch: "main", local: sha("a"), remote: sha("b"), ok: false });
		expect(out.warnings.some((w) => /verification: local 'main'/.test(w))).toBe(true);
	});

	test("local <D> == origin/<D> post-advance → ok:true, no drift warning", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("b") }, // post-advance local == remote
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS }]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.verification).toEqual({ branch: "main", local: sha("b"), remote: sha("b"), ok: true });
		expect(out.warnings.some((w) => /verification: local/.test(w))).toBe(false);
	});

	test("present under dryRun too (records the drift the plan would fix), rebase mode omits it", async () => {
		const base = {
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
		};
		const dry = await runSync({ client: fakeClient(base), spawn: fakeSpawn().fn, repoRoot: REPO, mode: "full", dryRun: true });
		expect(dry.verification).toEqual({ branch: "main", local: sha("a"), remote: sha("b"), ok: false });
		expect(dry.warnings.some((w) => /verification: local/.test(w))).toBe(false); // dry never warns
		const rb = await runSync({
			client: fakeClient({ ...base, revs: { "origin/main": sha("r"), HEAD: sha("h") } }),
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			mode: "rebase",
		});
		expect(rb.verification).toBeUndefined(); // full-mode only
	});
});

// --- advanced[] enrichment (#5): count + capped subject list per advance.
describe("runSync — advanced count/subjects", () => {
	test("count from rev-list; subjects capped at 15 with a trailing '... and N more'", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
			aheadBehind: { [`${sha("a")}..${sha("b")}`]: { ahead: 20, behind: 0 } },
			subjects: Array.from({ length: 15 }, (_, i) => `feat: #${i + 1}`),
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS }]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.advanced[0]?.count).toBe(20);
		expect(out.advanced[0]?.subjects).toHaveLength(16); // 15 + the cap note
		expect(out.advanced[0]?.subjects[14]).toBe("feat: #15");
		expect(out.advanced[0]?.subjects[15]).toBe("... and 5 more");
	});

	test("count <= 15 → subjects listed verbatim, no cap note", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
			aheadBehind: { [`${sha("a")}..${sha("b")}`]: { ahead: 2, behind: 0 } },
			subjects: ["feat: one", "feat: two"],
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: SUBMODULE_STATUS }]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.advanced[0]?.count).toBe(2);
		expect(out.advanced[0]?.subjects).toEqual(["feat: one", "feat: two"]);
	});

	test("dryRun → count 0, subjects [], and logSubjects is NEVER called", async () => {
		let logCalls = 0;
		const base = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const client: SyncClient = {
			...base,
			logSubjects: async () => {
				logCalls++;
				return [];
			},
		};
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", dryRun: true });

		expect(out.advanced[0]?.count).toBe(0);
		expect(out.advanced[0]?.subjects).toEqual([]);
		expect(logCalls).toBe(0);
	});
});

// --- advanceTarget submodule ops (#3): when the default branch lives in
// ANOTHER worktree, the 4-command submodule cycle ALSO runs there; entries are
// per-worktree; failures warn and never hard-abort.
describe("runSync — advanceTarget submodule ops", () => {
	test("4 submodule commands run at BOTH repoRoot and advanceTarget; entries tagged per worktree", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
			{ worktree: OTHER, branch: "main" },
			],
			revs: { "origin/main": sha("c"), main: sha("a") },
		});
		// canned status ONLY for the OTHER worktree (repoRoot gets the quiet default → no rows)
		const { fn, calls } = fakeSpawn([
			{
				match: (a) => a[0] === "-C" && a[1] === OTHER && realArgs(a).join(" ").startsWith("submodule status"),
				result: { stdout: `+${sha("d")} sub-q\n-${sha("e")} sub-r\n`, stderr: "", exitCode: 0 },
			},
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined();
		// the 4-command cycle ran at BOTH worktrees (8 submodule commands total).
		expect(out.commands.filter((c) => c.includes("submodule"))).toHaveLength(8);
		expect(out.commands).toContain(`git -C "${OTHER}" submodule update --init --recursive --remote`);
		expect(out.commands).toContain(`git -C "${REPO}" submodule update --init --recursive --remote`);
		// entries tagged with the worktree they were evaluated in.
		expect(out.submodules).toEqual([
			{ worktree: OTHER, path: "sub-q", sha: sha("d"), flag: "+", matchesRecordedGitlink: false },
			{ worktree: OTHER, path: "sub-r", sha: sha("e"), flag: "-", matchesRecordedGitlink: false },
		]);
		// the OTHER worktree actually saw its submodule spawns.
		expect(calls.some((c) => c.args.includes(OTHER) && c.args.includes("submodule"))).toBe(true);
	});

	test("submodule failure at advanceTarget → warning + continue (advance kept, NOT aborted)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
				{ worktree: OTHER, branch: "main" },
			],
			revs: { "origin/main": sha("c"), main: sha("a") },
		});
		const { fn } = fakeSpawn([
			{
				match: (a) => a[0] === "-C" && a[1] === OTHER && realArgs(a).join(" ").startsWith("submodule update"),
				result: { stdout: "", stderr: "fatal: remote error: access denied", exitCode: 1 },
			},
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined(); // NEVER hard-aborts on a submodule failure
		expect(out.advanced).toHaveLength(1); // the default-branch advance is kept
		expect(out.verification).toBeDefined();
		expect(out.warnings.some((w) => /submodule update failed at \/repo-main-wt/.test(w))).toBe(true);
	});

	test("submodule status failure at advanceTarget → warning + no rows for that worktree", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
				{ worktree: OTHER, branch: "main" },
			],
			revs: { "origin/main": sha("c"), main: sha("a") },
		});
		const { fn } = fakeSpawn([
			{
				match: (a) => a[0] === "-C" && a[1] === OTHER && realArgs(a).join(" ").startsWith("submodule status"),
				result: { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 },
			},
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined();
		expect(out.submodules).toEqual([]); // no rows for either worktree (both status calls quiet/failed)
		expect(out.warnings.some((w) => /submodule status failed at \/repo-main-wt/.test(w))).toBe(true);
	});
});

describe("runSync — non-origin remote (remoteName threading)", () => {
	test("full mode: fetch <remote> + merge --ff-only <remote>/<D>, advanced to its tip", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "upstream/main": sha("b"), main: sha("a") },
			aheadBehind: { [`${sha("a")}..${sha("b")}`]: { ahead: 1, behind: 0 } },
			subjects: ["feat: one"],
		});
		const { fn, calls } = fakeSpawn([
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: { stdout: "", stderr: "", exitCode: 0 } },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", remoteName: "upstream" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" fetch upstream`);
		expect(out.commands).toContain(`git -C "${REPO}" merge --ff-only upstream/main`);
		expect(out.commands.some((c) => c.includes("origin"))).toBe(false);
		expect(out.advanced?.[0]?.to).toBe(sha("b"));
		// The recording spawn saw fetch upstream — never fetch origin.
		expect(calls.some((c) => c.args.join(" ").includes("fetch upstream"))).toBe(true);
	});

	test("full mode force:true: reset --hard <remote>/<D>", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "upstream/main": sha("b"), main: sha("a") },
		});
		const { fn } = fakeSpawn([
			{ match: (a) => realArgs(a).join(" ").startsWith("submodule status"), result: { stdout: "", stderr: "", exitCode: 0 } },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", force: true, remoteName: "upstream" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" reset --hard upstream/main`);
	});

	test("missing <remote>/<D> → no_origin_ref abort naming the configured remote", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { main: sha("a") }, // no upstream/main
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", remoteName: "upstream" });

		expect(out.aborted).toMatchObject({ reason: "no_origin_ref", message: "cannot resolve upstream/main" });
		expect(out.warnings.some((w) => w.includes("is remote 'upstream' fetched?"))).toBe(true);
	});

	test("rebase mode: fetch <remote> + rebase onto <remote>/<D>", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
			revs: { "upstream/main": sha("c"), HEAD: sha("a") },
		});
		const { fn } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "rebase", remoteName: "upstream" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" fetch upstream`);
		expect(out.commands).toContain(`git -C "${REPO}" rebase upstream/main`);
	});
});

describe("runSync — hands-on mode (the SOP one-shot prelude: default branch AND caller to tip)", () => {
	/** Empty canned `git submodule status --recursive` (no submodules). */
	const NO_SUBS = [{ match: (a: string[]) => realArgs(a).join(" ").startsWith("submodule status"), result: { stdout: "", stderr: "", exitCode: 0 } as SpawnResult }];

	test("(1) caller HOLDS <D>: single-phase advance here; no phase-B rebase; callerAtTip true", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a"), HEAD: sha("a") },
			aheadBehind: {
				[`${sha("a")}..${sha("b")}`]: { ahead: 2, behind: 0 },
				"origin/main..main": { ahead: 0, behind: 2 },
				"origin/main..HEAD": { ahead: 0, behind: 0 },
			},
		});
		const { fn, calls } = fakeSpawn(NO_SUBS);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "hands-on" });

		expect(out.aborted).toBeUndefined();
		expect(out.mode).toBe("hands-on");
		// phase A: the advance targeted THIS worktree (it holds main).
		expect(out.advanced).toEqual([
			{ worktree: REPO, branch: "main", from: sha("a"), to: sha("b"), count: 2, subjects: ["... and 2 more"] },
		]);
		expect(out.commands).toContain(`git -C "${REPO}" merge --ff-only origin/main`);
		// NO phase B: no rebase, no checkout, no second fetch.
		expect(out.commands.some((c) => c.includes("rebase"))).toBe(false);
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false);
		expect(calls.filter((c) => c.args.includes("fetch") && !c.args.includes("submodule")).length).toBe(1);
		// the hands-on verdict.
		expect(out.handsOn).toEqual({ callerAction: "advanced-default-here", callerAtTip: true });
	});

	test("(2) <D> lives ELSEWHERE + detached caller behind: advance there, then attach <branch> + rebase here", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "", // detached
			worktrees: [{ worktree: REPO }, { worktree: OTHER, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a"), HEAD: sha("c") },
			aheadBehind: {
				[`${sha("a")}..${sha("b")}`]: { ahead: 1, behind: 0 },
				"origin/main..HEAD": { ahead: 0, behind: 3 },
			},
		});
		const { fn, calls } = fakeSpawn(NO_SUBS);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "hands-on", branch: "archify" });

		expect(out.aborted).toBeUndefined();
		// phase A advanced main in the OTHER worktree.
		expect(out.advanced[0]).toMatchObject({ worktree: OTHER, branch: "main" });
		expect(out.commands).toContain(`git -C "${OTHER}" merge --ff-only origin/main`);
		// phase B recovered the detached caller: created the branch at HEAD, rebased onto the tip.
		expect(out.commands).toContain(`git -C "${REPO}" checkout -b archify`);
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main`);
		expect(out.handsOn).toEqual({ callerAction: "attached-and-rebased", callerAtTip: true });
	});

	test("(3) <D> elsewhere + caller ATTACHED on feat/x behind: phase B rebases feat/x (no checkout -b)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }, { worktree: OTHER, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a"), HEAD: sha("x") },
			aheadBehind: {
				[`${sha("a")}..${sha("b")}`]: { ahead: 1, behind: 0 },
				"origin/main..feat/x": { ahead: 0, behind: 3 },
				"origin/main..HEAD": { ahead: 0, behind: 0 },
			},
		});
		const { fn } = fakeSpawn(NO_SUBS);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "hands-on" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main`);
		expect(out.commands.some((c) => c.includes("checkout -b"))).toBe(false);
		expect(out.handsOn).toEqual({ callerAction: "rebased-current-branch", callerAtTip: true });
	});

	test("(4) <D> FREE + attached caller: phase A CLAIMS <D> here; phase B skipped (no rebase)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }], // main checked out NOWHERE
			revs: { "origin/main": sha("b"), main: sha("a") },
			aheadBehind: {
				[`${sha("a")}..${sha("b")}`]: { ahead: 1, behind: 0 },
				"origin/main..feat/x": { ahead: 0, behind: 5 },
				"origin/main..HEAD": { ahead: 0, behind: 0 },
			},
		});
		const { fn } = fakeSpawn(NO_SUBS);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "hands-on" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" checkout main`);
		expect(out.commands).toContain(`git -C "${REPO}" merge --ff-only origin/main`);
		expect(out.commands.some((c) => c.includes("rebase"))).toBe(false);
		expect(out.handsOn).toEqual({ callerAction: "claimed-default-here", callerAtTip: true });
	});

	test("(5) detached caller ALREADY at tip (<D> elsewhere): phase B skipped, already-at-tip", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "",
			worktrees: [{ worktree: REPO }, { worktree: OTHER, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a"), HEAD: sha("b") },
			aheadBehind: {
				[`${sha("a")}..${sha("b")}`]: { ahead: 1, behind: 0 },
				"origin/main..HEAD": { ahead: 0, behind: 0 },
			},
		});
		const { fn } = fakeSpawn(NO_SUBS);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "hands-on" });

		expect(out.aborted).toBeUndefined();
		expect(out.commands.some((c) => c.includes("rebase"))).toBe(false);
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false);
		expect(out.handsOn).toEqual({ callerAction: "already-at-tip", callerAtTip: true });
	});

	test("(6) phase A abort (real dirty at the <D>-holder worktree): structured abort, NO phase B", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "",
			worktrees: [{ worktree: REPO }, { worktree: OTHER, branch: "main" }],
			dirty: { [OTHER]: ["src/real.ts"] },
			revs: { "origin/main": sha("b"), main: sha("a"), HEAD: sha("c") },
			aheadBehind: { "origin/main..HEAD": { ahead: 0, behind: 3 } },
		});
		const { fn, calls } = fakeSpawn(NO_SUBS);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "hands-on", branch: "archify" });

		expect(out.aborted).toMatchObject({ reason: "dirty_tree" });
		expect(out.handsOn).toEqual({ callerAction: "none", callerAtTip: false });
		// phase B never ran — no rebase issued anywhere.
		expect(out.commands.some((c) => c.includes("rebase"))).toBe(false);
		expect(calls.some((c) => c.args.includes("rebase"))).toBe(false);
	});

	test("(7) phase B abort (branch exists at a different commit): phase A's advance is still in the merged outcome", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "",
			worktrees: [{ worktree: REPO }, { worktree: OTHER, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a"), HEAD: sha("c"), "refs/heads/archify": sha("z") },
			aheadBehind: {
				[`${sha("a")}..${sha("b")}`]: { ahead: 1, behind: 0 },
				"origin/main..HEAD": { ahead: 0, behind: 3 },
			},
		});
		const { fn } = fakeSpawn(NO_SUBS);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "hands-on", branch: "archify" });

		expect(out.aborted).toMatchObject({ reason: "branch_exists" });
		// phase A landed (the default branch IS advanced) — the merged outcome keeps it.
		expect(out.advanced[0]).toMatchObject({ worktree: OTHER, branch: "main" });
		expect(out.handsOn).toEqual({ callerAction: "reconcile-aborted", callerAtTip: false });
	});

	test("(8) preserve round-trip: caller's MEMORY.md is parked/restored around the phase-B rebase", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "",
			worktrees: [{ worktree: REPO }, { worktree: OTHER, branch: "main" }],
			dirty: { [REPO]: [".agents/memory/MEMORY.md"] },
			revs: { "origin/main": sha("b"), main: sha("a"), HEAD: sha("c") },
			aheadBehind: {
				[`${sha("a")}..${sha("b")}`]: { ahead: 1, behind: 0 },
				"origin/main..HEAD": { ahead: 0, behind: 3 },
			},
		});
		const { fn } = fakeSpawn([
			...NO_SUBS,
			{ match: isStashTopProbe, result: STASH_TOP },
			{ match: isStashIndexProbe, result: STASH_INDEX },
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "hands-on", branch: "archify" });

		expect(out.aborted).toBeUndefined();
		expect(out.preserved).toMatchObject({ paths: [".agents/memory/MEMORY.md"], restored: true });
		expect(out.commands.some((c) => c.includes("stash push"))).toBe(true);
		expect(out.commands.some((c) => c.includes("stash apply"))).toBe(true);
		expect(out.handsOn?.callerAtTip).toBe(true);
	});

	test("(9) dryRun: plans BOTH phases (advance + reconcile) with zero mutating spawns", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "",
			worktrees: [{ worktree: REPO }, { worktree: OTHER, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a"), HEAD: sha("c") },
			aheadBehind: { "origin/main..HEAD": { ahead: 0, behind: 3 } },
		});
		const { fn, calls } = fakeSpawn(NO_SUBS);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "hands-on", branch: "archify", dryRun: true });

		expect(out.dryRun).toBe(true);
		expect(out.aborted).toBeUndefined();
		expect(out.commands.some((c) => c.includes(`merge --ff-only origin/main`))).toBe(true);
		expect(out.commands.some((c) => c.includes(`checkout -b archify`))).toBe(true);
		expect(out.commands.some((c) => c.includes("rebase origin/main"))).toBe(true);
		expect(calls.length).toBe(0); // read-only queries go through the client, not spawn
	});
});
