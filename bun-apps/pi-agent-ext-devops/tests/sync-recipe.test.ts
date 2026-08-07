/**
 * Tests for runSync — the pure orchestration behind the `sync_repo` tool (a TS
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
import { runSync, type SyncClient } from "../src/sync-recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const REPO = "/repo";
const OTHER = "/repo-main-wt";

/** A 40-hex SHA repeated for the canned revParse/submodule-status fixtures. */
const sha = (c: string) => c.repeat(40);

/** Minimal SyncClient fake. `clean`/`revs`/`aheadBehind` default to safe values. */
function fakeClient(s: {
	defaultBranch?: string;
	current?: string;
	worktrees?: { worktree: string; branch?: string; detached?: boolean }[];
	clean?: Record<string, boolean>;
	revs?: Record<string, string>;
	aheadBehind?: Record<string, { ahead: number; behind: number }>;
}): SyncClient {
	return {
		defaultBranch: async () => s.defaultBranch,
		currentBranch: async () => s.current ?? "",
		worktreeList: async () => s.worktrees ?? [],
		isClean: async (dir: string) => s.clean?.[dir] ?? true,
		revParse: async (rev: string) => s.revs?.[rev],
		aheadBehind: async (base: string, head: string) => s.aheadBehind?.[`${base}..${head}`] ?? { ahead: 0, behind: 0 },
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

describe("runSync — full mode DEFAULT (current worktree holds the default branch)", () => {
	test("(a) advances <D> in THIS worktree: fetch + merge --ff-only, NO reset, no checkout", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
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
		expect(out.advanced).toEqual([{ worktree: REPO, branch: "main", from: sha("a"), to: sha("b") }]);
		// fetch + merge --ff-only in THIS worktree; NO checkout (main already here).
		expect(out.commands).toContain(`git -C "${REPO}" fetch origin`);
		expect(out.commands).toContain(`git -C "${REPO}" merge --ff-only origin/main`);
		// DEFAULT full-mode issues NO reset --hard.
		expect(out.commands.some((c) => c.includes("reset --hard"))).toBe(false);
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false);
		// merge --ff-only was actually spawned (non-dry), targeting THIS worktree.
		expect(calls.some((c) => c.cmd === "git" && c.args.includes(REPO) && c.args.includes("merge"))).toBe(true);
		expect(calls.some((c) => c.args.includes("reset"))).toBe(false);
		// submodule report parsed from the canned status output.
		expect(out.submodules).toEqual([
			{ path: "sub-a", sha: sha("a"), clean: true },
			{ path: "sub-b", sha: sha("b"), clean: false },
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
		expect(out.advanced).toEqual([{ worktree: OTHER, branch: "main", from: sha("a"), to: sha("c") }]);
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
			clean: { [OTHER]: false }, // the worktree holding <D> is dirty
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
		expect(out.advanced).toEqual([{ worktree: REPO, branch: "main", from: sha("a"), to: sha("b") }]);
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
		expect(out.advanced).toEqual([]);
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
		// from/to resolved by read-only queries (real SHAs), so the plan is accurate.
		expect(out.advanced).toEqual([{ worktree: REPO, branch: "main", from: sha("a"), to: sha("b") }]);
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
			clean: { [REPO]: false },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full", dryRun: true });

		expect(out.aborted).toBeUndefined(); // dry-run never aborts
		expect(out.warnings.some((w) => /uncommitted tracked changes/.test(w))).toBe(true);
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
			clean: { [REPO]: false },
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
