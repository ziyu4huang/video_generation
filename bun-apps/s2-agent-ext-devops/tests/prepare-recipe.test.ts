/**
 * Tests for runPrepare — the worktree-aware create/rebase/force-push. Mirrors
 * the dual-seam style of sync-recipe.test.ts: a minimal `PrepareClient` fake
 * feeds canned read-only git state, a recording `SpawnFn` returns canned
 * mutation results by match (and lets dryRun assert ZERO spawns). No real git.
 *
 * Coverage:
 *  (a) create off base → step ok;
 *  (b) rebase clean → step ok;
 *  (b2) rebase names the branch even when the caller is on a DIFFERENT one —
 *      the regression that let `--rebase` no-op while reporting ok;
 *  (c) rebase conflict (spawn exit 1 for rebase) → aborted `rebase-conflict`
 *      AND a `rebase --abort` command recorded;
 *  (d) forcePush true → `push --force-with-lease` in commands;
 *  (e) forcePush false (default) → NO push command;
 *  (f) worktree-conflict → aborted `worktree-conflict`, zero mutations;
 *  (g) dryRun → commands recorded, zero spawns;
 *  (h) compose create + rebase + forcePush.
 */
import { test, expect, describe } from "bun:test";
import { runPrepare, type PrepareClient } from "../src/prepare-recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const REPO = "/repo";
const OTHER = "/repo-wt";

/** Minimal PrepareClient fake. */
function fakeClient(s: {
	defaultBranch?: string;
	current?: string;
	worktrees?: { worktree: string; branch?: string; detached?: boolean }[];
	revs?: Record<string, string>;
}): PrepareClient {
	return {
		defaultBranch: async () => s.defaultBranch,
		currentBranch: async () => s.current ?? "",
		worktreeList: async () => s.worktrees ?? [],
		revParse: async (rev: string) => s.revs?.[rev],
		// PrepareClient widened with aheadBehind (post-rebase divergence report).
		aheadBehind: async () => ({ ahead: 0, behind: 0 }),
	};
}

/** Recording SpawnFn. Returns canned results by matching args (post `-C <dir>`),
 *  defaulting to a quiet success. Records every call. */
function fakeSpawn(canned?: Array<{ match: (args: string[]) => boolean; result: SpawnResult }>) {
	const calls: { cmd: string; args: string[] }[] = [];
	const fn: SpawnFn = async (cmd, args) => {
		calls.push({ cmd, args });
		return canned?.find((c) => c.match(args))?.result ?? { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

/** Drop the leading `-C <dir>` so matchers read the real git subcommand. */
const realArgs = (a: string[]) => a.filter((_, i) => !(i === 0 && _ === "-C") && !(i === 1 && a[0] === "-C"));

/** args of a git subcommand joined (post `-C <dir>`), for readable matching. */
const joined = (a: string[]) => realArgs(a).join(" ");

describe("runPrepare — create", () => {
	test("(a) create off base → step ok, checkout -b recorded", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
		});
		const { fn, calls } = fakeSpawn();
		const out = await runPrepare({ client, spawn: fn, repoRoot: REPO, branch: "feat/x", create: true });

		expect(out.aborted).toBeUndefined();
		expect(out.branch).toBe("feat/x");
		expect(out.base).toBe("origin/main");
		expect(out.steps).toEqual([{ step: "create", ok: true }]);
		expect(out.commands).toContain(`git -C "${REPO}" checkout -b feat/x origin/main`);
		expect(calls.some((c) => c.args.includes("checkout") && c.args.includes("-b"))).toBe(true);
	});
});

describe("runPrepare — rebase", () => {
	test("(b) rebase clean → step ok", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn, calls } = fakeSpawn();
		const out = await runPrepare({ client, spawn: fn, repoRoot: REPO, branch: "feat/x", rebase: true });

		expect(out.aborted).toBeUndefined();
		expect(out.steps).toEqual([{ step: "rebase", ok: true }]);
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main feat/x`);
		expect(calls.some((c) => c.args.includes("rebase"))).toBe(true);
	});

	test("(b2) rebase targets the named branch, not the caller's HEAD", async () => {
		// The bug this pins: step 4 ran `git rebase <base>` with no branch, so a
		// caller sitting on `main` who asked to rebase `feat/x` rebased MAIN —
		// a no-op reported as `{step: "rebase", ok: true}` while the branch stayed
		// BEHIND. Every pre-existing rebase case had current === branch, which is
		// precisely why it went unnoticed. Assert the branch reaches argv.
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
		});
		const { fn, calls } = fakeSpawn();
		const out = await runPrepare({ client, spawn: fn, repoRoot: REPO, branch: "feat/x", rebase: true });

		expect(out.aborted).toBeUndefined();
		expect(out.steps).toEqual([{ step: "rebase", ok: true }]);
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main feat/x`);
		const rebaseCall = calls.find((c) => realArgs(c.args)[0] === "rebase");
		expect(rebaseCall).toBeDefined();
		expect(realArgs(rebaseCall!.args)).toEqual(["rebase", "origin/main", "feat/x"]);
	});

	test("(c) rebase conflict → aborted rebase-conflict + a rebase --abort recorded", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn } = fakeSpawn([
			{
				// rebase (not --abort) fails with conflicts.
				match: (a) => realArgs(a)[0] === "rebase" && !realArgs(a).includes("--abort"),
				result: { stdout: "", stderr: "CONFLICT (content): Merge conflict", exitCode: 1 },
			},
		]);
		const out = await runPrepare({ client, spawn: fn, repoRoot: REPO, branch: "feat/x", rebase: true });

		expect(out.aborted?.aborted).toBe(true);
		expect(out.aborted?.reason).toBe("rebase-conflict");
		expect(out.aborted?.message).toMatch(/rebase onto origin\/main failed/);
		// the rebase attempt is recorded …
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main feat/x`);
		// … and so is the cleanup rebase --abort.
		expect(out.commands).toContain(`git -C "${REPO}" rebase --abort`);
		expect(out.steps).toEqual([{ step: "rebase", ok: false }]);
	});
});

describe("runPrepare — forcePush", () => {
	test("(d) forcePush true → push --force-with-lease in commands", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn, calls } = fakeSpawn();
		const out = await runPrepare({ client, spawn: fn, repoRoot: REPO, branch: "feat/x", forcePush: true });

		expect(out.aborted).toBeUndefined();
		expect(out.commands).toContain(`git -C "${REPO}" push --force-with-lease origin feat/x`);
		expect(out.steps).toEqual([{ step: "forcePush", ok: true }]);
		expect(calls.some((c) => c.args.includes("--force-with-lease"))).toBe(true);
	});

	test("(e) forcePush false (default) → NO push command", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn, calls } = fakeSpawn();
		const out = await runPrepare({ client, spawn: fn, repoRoot: REPO, branch: "feat/x", create: true });

		expect(out.commands.some((c) => c.includes("push"))).toBe(false);
		expect(calls.some((c) => c.args.includes("push"))).toBe(false);
		expect(out.steps.some((s) => s.step === "forcePush")).toBe(false);
	});

	test("forcePush non-zero → aborted force-push-failed", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn } = fakeSpawn([
			{
				match: (a) => joined(a).startsWith("push --force-with-lease"),
				result: { stdout: "", stderr: " ! [remote rejected]", exitCode: 1 },
			},
		]);
		const out = await runPrepare({ client, spawn: fn, repoRoot: REPO, branch: "feat/x", forcePush: true });

		expect(out.aborted?.reason).toBe("force-push-failed");
		expect(out.steps).toEqual([{ step: "forcePush", ok: false }]);
	});
});

describe("runPrepare — worktree guard", () => {
	test("(f) target branch checked out in another worktree → aborted worktree-conflict, zero mutations", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [
				{ worktree: REPO, branch: "main" },
				{ worktree: OTHER, branch: "feat/x" }, // busy elsewhere
			],
		});
		const { fn, calls } = fakeSpawn();
		const out = await runPrepare({ client, spawn: fn, repoRoot: REPO, branch: "feat/x", create: true, forcePush: true });

		expect(out.aborted?.aborted).toBe(true);
		expect(out.aborted?.reason).toBe("worktree-conflict");
		expect(out.steps).toEqual([]); // nothing attempted
		// zero mutations: no spawns, no recorded commands.
		expect(calls.length).toBe(0);
		expect(out.commands).toEqual([]);
	});
});

describe("runPrepare — dryRun", () => {
	test("(g) dryRun → commands recorded, zero spawns", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn, calls } = fakeSpawn();
		const out = await runPrepare({
			client,
			spawn: fn,
			repoRoot: REPO,
			branch: "feat/x",
			create: true,
			rebase: true,
			forcePush: true,
			dryRun: true,
		});

		expect(out.aborted).toBeUndefined();
		// the full command plan is present …
		expect(out.commands).toContain(`git -C "${REPO}" checkout -b feat/x origin/main`);
		expect(out.commands).toContain(`git -C "${REPO}" rebase origin/main feat/x`);
		expect(out.commands).toContain(`git -C "${REPO}" push --force-with-lease origin feat/x`);
		// all steps ok (canned success) …
		expect(out.steps).toEqual([
			{ step: "create", ok: true },
			{ step: "rebase", ok: true },
			{ step: "forcePush", ok: true },
		]);
		// … but ZERO mutations fired.
		expect(calls.length).toBe(0);
	});
});

describe("runPrepare — compose", () => {
	test("(h) create + rebase + forcePush → three steps, three commands, in order", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
		});
		const { fn, calls } = fakeSpawn();
		const out = await runPrepare({
			client,
			spawn: fn,
			repoRoot: REPO,
			branch: "feat/y",
			create: true,
			rebase: true,
			forcePush: true,
		});

		expect(out.aborted).toBeUndefined();
		expect(out.steps).toEqual([
			{ step: "create", ok: true },
			{ step: "rebase", ok: true },
			{ step: "forcePush", ok: true },
		]);
		// commands recorded in execution order: create → rebase → forcePush.
		const idxCreate = out.commands.findIndex((c) => c.includes("checkout -b"));
		const idxRebase = out.commands.findIndex((c) => /rebase origin/.test(c));
		const idxPush = out.commands.findIndex((c) => c.includes("--force-with-lease"));
		expect(idxCreate).toBeGreaterThanOrEqual(0);
		expect(idxRebase).toBeGreaterThan(idxCreate);
		expect(idxPush).toBeGreaterThan(idxRebase);
		// all three actually spawned.
		expect(calls.length).toBe(3);
	});
});

describe("runPrepare — non-origin remote (remoteName threading)", () => {
	test("default base + force-push target follow the configured remote", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn, calls } = fakeSpawn();
		const out = await runPrepare({ client, spawn: fn, repoRoot: REPO, branch: "feat/x", rebase: true, forcePush: true, remoteName: "upstream" });

		expect(out.aborted).toBeUndefined();
		expect(out.base).toBe("upstream/main");
		expect(out.commands).toContain(`git -C "${REPO}" rebase upstream/main feat/x`);
		expect(out.commands).toContain(`git -C "${REPO}" push --force-with-lease upstream feat/x`);
		const pushCall = calls.find((c) => realArgs(c.args)[0] === "push");
		expect(realArgs(pushCall!.args)).toEqual(["push", "--force-with-lease", "upstream", "feat/x"]);
	});
});
