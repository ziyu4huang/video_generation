/**
 * Tests for runSync — the pure orchestration behind the `sync_repo` tool (a TS
 * port of scripts/sync-repo.sh). Mirrors the dual-seam style of recipe.test.ts
 * (fake client) + ci-recipe.test.ts (recording SpawnFn): a minimal `SyncClient`
 * fake feeds canned read-only git state, a recording `SpawnFn` captures every
 * MUTATING command (and feeds canned output for the submodule-status parse).
 * No real git / filesystem.
 *
 * Coverage (per ticket 02 acceptance):
 *  (a) full-mode default-branch advance in the CURRENT worktree,
 *  (b) full-mode advance in ANOTHER worktree (the worktree-aware branch),
 *  (c) rebase mode,
 *  (d) pull mode (real merge, --no-ff),
 *  (e) dryRun returns commands without mutating (zero spawns),
 *  (f) dirty-tree pre-flight abort,
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

describe("runSync — full mode (current worktree holds the default branch)", () => {
	test("(a) advances <D> in THIS worktree: fetch + reset --hard, no checkout", async () => {
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
				result: {
					stdout: ` ${sha("a")} sub-a\n+${sha("b")} sub-b\n`,
					stderr: "",
					exitCode: 0,
				},
			},
		]);
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toBeUndefined();
		expect(out.defaultBranch).toBe("main");
		expect(out.advanced).toEqual([{ worktree: REPO, branch: "main", from: sha("a"), to: sha("b") }]);
		// fetch + reset --hard in THIS worktree; NO checkout (main already here).
		expect(out.commands).toContain(`git -C "${REPO}" fetch origin`);
		expect(out.commands).toContain(`git -C "${REPO}" reset --hard origin/main`);
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false);
		// reset --hard was actually spawned (non-dry), targeting THIS worktree.
		expect(calls.some((c) => c.cmd === "git" && c.args.includes(REPO) && c.args.includes("reset"))).toBe(true);
		// submodule report parsed from the canned status output.
		expect(out.submodules).toEqual([
			{ path: "sub-a", sha: sha("a"), clean: true },
			{ path: "sub-b", sha: sha("b"), clean: false },
		]);
	});
});

describe("runSync — full mode (default branch lives in ANOTHER worktree)", () => {
	test("(b) advances <D> in the OTHER worktree; leaves this one untouched", async () => {
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
		// reset --hard targets the OTHER worktree, NOT this one.
		expect(out.commands).toContain(`git -C "${OTHER}" reset --hard origin/main`);
		expect(out.commands.some((c) => c.includes(`-C "${REPO}"`) && c.includes("reset"))).toBe(false);
		expect(out.commands.some((c) => c.includes("checkout"))).toBe(false); // main not free → no checkout
		// fetch still happens from this worktree (shared refs).
		expect(out.commands).toContain(`git -C "${REPO}" fetch origin`);
		// the actual reset spawn hit the OTHER worktree dir.
		expect(calls.some((c) => c.args.includes(OTHER) && c.args.includes("reset"))).toBe(true);
		expect(calls.some((c) => c.args.includes(REPO) && c.args.includes("reset"))).toBe(false);
	});

	test("dirty OTHER worktree → aborted, no reset anywhere", async () => {
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

		expect(out.aborted).toMatch(/dirty tree/);
		expect(out.advanced).toEqual([]);
		// aborted BEFORE fetch → nothing mutated.
		expect(calls.length).toBe(0);
		expect(out.commands.some((c) => c.includes("reset"))).toBe(false);
	});
});

describe("runSync — rebase mode", () => {
	test("(c) fetches then rebases the current branch onto origin/<D>", async () => {
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
		expect(out.commands.some((c) => c.includes("submodule"))).toBe(false);
		expect(out.submodules).toEqual([]);
		expect(calls.some((c) => c.args.includes("rebase"))).toBe(true);
	});
});

describe("runSync — pull mode", () => {
	test("(d) fetches then MERGES origin/<D> (real merge, --no-ff — never ff)", async () => {
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
		expect(out.aborted).toMatch(/detached HEAD/);
		expect(out.advanced).toEqual([]);
	});
});

describe("runSync — dryRun", () => {
	test("(e) computes + returns the full command plan WITHOUT spawning any mutation", async () => {
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
		// the full happy-path command set is present …
		expect(out.commands).toContain(`git -C "${REPO}" fetch origin`);
		expect(out.commands).toContain(`git -C "${REPO}" reset --hard origin/main`);
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
		expect(out.commands.some((c) => c.includes("reset --hard"))).toBe(true); // plan still shown
		expect(calls.length).toBe(0);
	});
});

describe("runSync — pre-flight abort (dirty tree)", () => {
	test("(f) mutating full run on a dirty tree → aborted before fetch, no commands", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			clean: { [REPO]: false },
			revs: { "origin/main": sha("b"), main: sha("a") },
		});
		const { fn, calls } = fakeSpawn();
		const out = await runSync({ client, spawn: fn, repoRoot: REPO, mode: "full" });

		expect(out.aborted).toMatch(/dirty tree/);
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
