/**
 * Tests for runMainHealth — "is the default branch green right now?"
 *
 * WHY THIS EXISTS
 *   run_local_ci is change-scoped and remote CI is disabled, so a branch that avoids
 *   a broken package merges green forever and nothing ever says main is red. On
 *   2026-08-15 main had been failing `s2-agent` for days and had just started
 *   failing `s2-agent-ext-obsidian`; no tool in the devops chain would report it.
 *
 * THE ONE THING THAT MAKES THIS HONEST
 *   A test suite runs against a WORKING TREE, not a ref. Running it from a
 *   feature-branch worktree would report that branch's health under main's name.
 *   So the recipe locates the worktree that actually holds the default branch and
 *   runs there — and when that tree is dirty or behind origin, it says so in
 *   `warnings` rather than pretending the verdict is about origin/<D>.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { runMainHealth, type MainHealthClient } from "../src/main-health-recipe.js";
import type { CiOutcome, CiOptions } from "../src/ci-recipe.js";
import type { SpawnFn } from "../src/spawn.js";
import type { WorktreeRecord } from "../src/gh.js";

const MAIN_WT = "/repo/main-wt";

/** A fake client over the five read-only queries the recipe needs. */
function fakeClient(s: {
	defaultBranch?: string;
	worktrees?: WorktreeRecord[];
	dirty?: string[];
	behind?: number;
	head?: string;
}): MainHealthClient {
	return {
		defaultBranch: async () => s.defaultBranch ?? "main",
		worktreeList: async () => s.worktrees ?? [{ worktree: MAIN_WT, branch: "main" }],
		// Records the dir so a test can prove the dirty check targets the DEFAULT
		// branch's worktree, not the caller's.
		dirtyPaths: async (dir: string) => {
			dirtyDirs.push(dir);
			return s.dirty ?? [];
		},
		aheadBehind: async () => ({ ahead: 0, behind: s.behind ?? 0 }),
		revParse: async (rev: string) => {
			revs.push(rev);
			return s.head ?? "abc1234";
		},
	};
}

/** Recorded across the fakes so the "where" assertions can inspect them. */
let dirtyDirs: string[] = [];
let revs: string[] = [];
beforeEach(() => {
	dirtyDirs = [];
	revs = [];
});

const greenCi = (): CiOutcome => ({
	overall: "pass",
	baseRef: "origin/main",
	headRef: "HEAD",
	packages: [{ name: "pkg-a", test: { exitCode: 0 } }],
	gates: [{ name: "File-size guard", exitCode: 0 }],
	elapsedMs: 1,
	budgetMs: 300_000,
	overBudget: false,
	slowest: [],
});

/** Records the CiOptions it was handed, so the tests can assert WHERE it ran. */
function mkCi(outcome: CiOutcome) {
	const calls: CiOptions[] = [];
	return {
		calls,
		fn: async (opts: CiOptions) => {
			calls.push(opts);
			return outcome;
		},
	};
}

const noSpawn = async () => {
	throw new Error("no spawn expected");
};

describe("runMainHealth — where it runs", () => {
	test("runs the FULL matrix in the worktree holding the default branch, not the caller's cwd", async () => {
		const ci = mkCi(greenCi());
		const out = await runMainHealth({
			client: fakeClient({ worktrees: [{ worktree: "/repo/feature-wt", branch: "feat/x" }, { worktree: MAIN_WT, branch: "main" }] }),
			spawn: noSpawn,
			runCi: ci.fn,
		});
		expect(ci.calls).toHaveLength(1);
		expect(ci.calls[0].repoRoot).toBe(MAIN_WT);
		// `all` is the whole point — a scoped run is what already exists.
		expect(ci.calls[0].all).toBe(true);
		expect(ci.calls[0].includeGates).not.toBe(false);
		expect(out.worktree).toBe(MAIN_WT);
		expect(out.head).toBe("abc1234");
		// The dirty check must look at MAIN's tree, not the caller's.
		expect(dirtyDirs).toEqual([MAIN_WT]);
		// And the sha comes from the BRANCH ref — repo-global, so it needs no cwd
		// and cannot accidentally report the calling worktree's HEAD.
		expect(revs).toEqual(["main"]);
	});

	test("no worktree on the default branch → aborts, and NOTHING runs", async () => {
		// Reporting "healthy" because we could not find a tree to test would be
		// the same false-green the gate derivation exists to prevent.
		const ci = mkCi(greenCi());
		const out = await runMainHealth({
			client: fakeClient({ worktrees: [{ worktree: "/repo/feature-wt", branch: "feat/x" }] }),
			spawn: noSpawn,
			runCi: ci.fn,
		});
		expect(out.aborted).toBe("no-default-branch-worktree");
		expect(out.healthy).toBe(false);
		expect(ci.calls).toHaveLength(0);
		expect(out.message).toContain("main");
	});

	test("a DETACHED worktree is never mistaken for the default branch", async () => {
		const ci = mkCi(greenCi());
		const out = await runMainHealth({
			client: fakeClient({ worktrees: [{ worktree: "/repo/detached", detached: true }] }),
			spawn: noSpawn,
			runCi: ci.fn,
		});
		expect(out.aborted).toBe("no-default-branch-worktree");
		expect(ci.calls).toHaveLength(0);
	});
});

describe("runMainHealth — the verdict", () => {
	test("green CI → healthy, no failures listed", async () => {
		const out = await runMainHealth({ client: fakeClient({}), spawn: noSpawn, runCi: mkCi(greenCi()).fn });
		expect(out.healthy).toBe(true);
		expect(out.failingPackages).toEqual([]);
		expect(out.failingGates).toEqual([]);
		expect(out.warnings).toEqual([]);
	});

	test("names every package that failed — by test OR by typecheck", async () => {
		const red: CiOutcome = {
			...greenCi(),
			overall: "fail",
			packages: [
				{ name: "ok-pkg", test: { exitCode: 0 } },
				{ name: "test-red", test: { exitCode: 1 } },
				{ name: "types-red", typecheck: { exitCode: 1 }, test: { exitCode: 0 } },
				{ name: "no-test-script", test: { exitCode: -1 } },
				{ name: "types-skipped", typecheck: { exitCode: -1, skipped: true }, test: { exitCode: 0 } },
			],
		};
		const out = await runMainHealth({ client: fakeClient({}), spawn: noSpawn, runCi: mkCi(red).fn });
		expect(out.healthy).toBe(false);
		// -1 means "no test script" and a skipped typecheck is not a failure.
		expect(out.failingPackages).toEqual(["test-red", "types-red"]);
	});

	test("a red LINT is a failing package, and a skipped one is not", async () => {
		// The gap this pins: biome was the one tool no phase ran, so a package
		// could be lint-red on main while main_health called the branch green.
		const red: CiOutcome = {
			...greenCi(),
			overall: "fail",
			packages: [
				{ name: "lint-red", lint: { exitCode: 1 }, test: { exitCode: 0 } },
				{ name: "lint-skipped", lint: { exitCode: -1, skipped: true }, test: { exitCode: 0 } },
			],
		};
		const out = await runMainHealth({ client: fakeClient({}), spawn: noSpawn, runCi: mkCi(red).fn });
		expect(out.failingPackages).toEqual(["lint-red"]);
		expect(out.healthy).toBe(false);
	});

	test("a LINT that exited 127 is toolchainMissing, not a red branch", async () => {
		// biome is a package-local binary: an uninstalled worktree fails it with
		// 127 exactly as it fails tsc, and blaming the branch for that is how the
		// health signal turned into noise the first time.
		const red: CiOutcome = {
			...greenCi(),
			overall: "fail",
			packages: [
				{ name: "no-deps", typecheck: { exitCode: -1, skipped: true }, lint: { exitCode: 127 }, test: { exitCode: 1 } },
				{ name: "real-break", lint: { exitCode: 1 }, test: { exitCode: 0 } },
			],
		};
		const out = await runMainHealth({ client: fakeClient({}), spawn: noSpawn, runCi: mkCi(red).fn });
		expect(out.toolchainMissing).toEqual(["no-deps"]);
		expect(out.failingPackages).toEqual(["real-break"]);
	});

	test("names every failing gate, separately from the packages", async () => {
		const red: CiOutcome = {
			...greenCi(),
			overall: "fail",
			gates: [
				{ name: "File-size guard", exitCode: 0 },
				{ name: "ADR identity + citation guard (blocks)", exitCode: 1 },
			],
		};
		const out = await runMainHealth({ client: fakeClient({}), spawn: noSpawn, runCi: mkCi(red).fn });
		expect(out.failingGates).toEqual(["ADR identity + citation guard (blocks)"]);
		expect(out.failingPackages).toEqual([]);
		expect(out.healthy).toBe(false);
	});

	test("a gate job that could not be read → unhealthy, and the reason is carried", async () => {
		const broken: CiOutcome = { ...greenCi(), overall: "fail", gates: [], gateError: "no `regression-gates` job" };
		const out = await runMainHealth({ client: fakeClient({}), spawn: noSpawn, runCi: mkCi(broken).fn });
		expect(out.healthy).toBe(false);
		expect(out.gateError).toContain("regression-gates");
	});
});

describe("runMainHealth — qualifying what was actually tested", () => {
	test("a dirty default-branch worktree WARNS (does not abort) and says the verdict is about the tree", async () => {
		const out = await runMainHealth({
			client: fakeClient({ dirty: ["bun-apps/x/src/a.ts", "README.md"] }),
			spawn: noSpawn,
			runCi: mkCi(greenCi()).fn,
		});
		expect(out.healthy).toBe(true); // still ran; the caveat is a warning
		expect(out.warnings.join(" ")).toMatch(/2 uncommitted/);
		expect(out.warnings.join(" ")).toMatch(/not exactly origin\/main/i);
	});

	test("a default branch behind its remote WARNS with the gap", async () => {
		const out = await runMainHealth({
			client: fakeClient({ behind: 7 }),
			spawn: noSpawn,
			runCi: mkCi(greenCi()).fn,
		});
		expect(out.warnings.join(" ")).toMatch(/7 commit/);
		expect(out.warnings.join(" ")).toMatch(/origin\/main/);
	});

	test("honours a non-'main' default branch name throughout", async () => {
		const out = await runMainHealth({
			client: fakeClient({
				defaultBranch: "trunk",
				worktrees: [{ worktree: "/repo/trunk-wt", branch: "trunk" }],
				behind: 2,
			}),
			spawn: noSpawn,
			runCi: mkCi(greenCi()).fn,
		});
		expect(out.defaultBranch).toBe("trunk");
		expect(out.worktree).toBe("/repo/trunk-wt");
		expect(out.warnings.join(" ")).toMatch(/origin\/trunk/);
	});
});

describe("runMainHealth — an unusable tree is not a broken branch", () => {
	// Found by real-running the CLI: the default-branch worktree had no
	// per-package node_modules, so `bun run typecheck` exited 127 (command not
	// found) for 5 packages. Reporting those as "main is red" alongside the 2
	// genuine failures is how a health signal becomes noise people ignore.
	const withTypecheck = (rows: Array<[string, number]>): CiOutcome => ({
		...greenCi(),
		overall: "fail",
		packages: rows.map(([name, exitCode]) => ({ name, typecheck: { exitCode }, test: { exitCode: 0 } })),
	});

	test("a typecheck that exited 127 is reported as toolchainMissing, NOT as a failing package", async () => {
		const out = await runMainHealth({
			client: fakeClient({}),
			spawn: noSpawn,
			runCi: mkCi(withTypecheck([["no-deps", 127], ["real-break", 1]])).fn,
		});
		expect(out.toolchainMissing).toEqual(["no-deps"]);
		expect(out.failingPackages).toEqual(["real-break"]);
	});

	test("the warning names the fix, not just the symptom", async () => {
		const out = await runMainHealth({
			client: fakeClient({}),
			spawn: noSpawn,
			runCi: mkCi(withTypecheck([["no-deps", 127]])).fn,
		});
		expect(out.warnings.join(" ")).toMatch(/bun install/);
		expect(out.warnings.join(" ")).toMatch(/no-deps/);
	});

	test("127 still leaves the branch UNVERIFIED — never healthy on an unrun check", async () => {
		// The check did not run, so there is no evidence of health. Claiming green
		// here would be the same false-green ci-gates fails closed on.
		const out = await runMainHealth({
			client: fakeClient({}),
			spawn: noSpawn,
			runCi: mkCi({ ...withTypecheck([["no-deps", 127]]), overall: "pass" }).fn,
		});
		expect(out.healthy).toBe(false);
	});

	test("no 127 anywhere → toolchainMissing is empty and adds no warning", async () => {
		const out = await runMainHealth({ client: fakeClient({}), spawn: noSpawn, runCi: mkCi(greenCi()).fn });
		expect(out.toolchainMissing).toEqual([]);
		expect(out.warnings).toEqual([]);
		expect(out.healthy).toBe(true);
	});
});

describe("runMainHealth — a package with no toolchain is UNVERIFIED, not failed", () => {
	test("its test failure is not counted either — that tree could not build it", async () => {
		// Live case: s2-agent-ext-webui's matrix row is `bun run build && bun run
		// test:unit`. With no node_modules the build fails, so BOTH its typecheck
		// (127) and its test (2) fail. Listing it as a failing package blames main
		// for an uninstalled worktree.
		const ci: CiOutcome = {
			...greenCi(),
			overall: "fail",
			packages: [
				{ name: "no-deps", typecheck: { exitCode: 127 }, test: { exitCode: 2 } },
				{ name: "real-break", test: { exitCode: 1 } },
			],
		};
		const out = await runMainHealth({ client: fakeClient({}), spawn: noSpawn, runCi: mkCi(ci).fn });
		expect(out.toolchainMissing).toEqual(["no-deps"]);
		expect(out.failingPackages).toEqual(["real-break"]);
	});
});

describe("runMainHealth — temp-worktree fallback (all-detached multi-worktree mode)", () => {
	// Real defect (2026-08-18): this repo's steady state is EVERY worktree
	// detached, so "find the worktree holding main" never held and the tool
	// could only ever abort — "is main green?" was unanswerable. The fallback
	// MINTS a throwaway detached worktree at <D>, runs there, and removes it.
	// mkdtemp/rm hit the real OS temp dir; everything else stays faked.
	const DETACHED_WTS: WorktreeRecord[] = [{ worktree: "/repo/detached-a", detached: true }];

	/** Records every spawn call so the tests can assert add/remove + cwd. */
	function recordingSpawn(exitCodes: { add?: number } = {}) {
		const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
		const spawn: SpawnFn = async (cmd, args, options) => {
			calls.push({ cmd, args, cwd: options?.cwd });
			const isAdd = args[0] === "worktree" && args[1] === "add";
			return { stdout: "", stderr: "", exitCode: isAdd ? (exitCodes.add ?? 0) : 0 };
		};
		return { calls, spawn };
	}

	test("no default-branch holder → mints a throwaway worktree, runs CI THERE, always removes it", async () => {
		const ci = mkCi(greenCi());
		const { calls, spawn } = recordingSpawn();
		const out = await runMainHealth({
			client: fakeClient({ worktrees: DETACHED_WTS }),
			spawn,
			runCi: ci.fn,
		});
		// minted: `git worktree add --detach <tmp>/wt main`, anchored at a known
		// worktree of the repo (git lists the main one first).
		const add = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
		expect(add).toBeDefined();
		expect(add!.cmd).toBe("git");
		expect(add!.args).toContain("--detach");
		expect(add!.args[add!.args.length - 1]).toBe("main");
		expect(add!.cwd).toBe("/repo/detached-a");
		const wt = add!.args[add!.args.length - 2];
		expect(wt).toMatch(/main-health-.*\/wt$/);
		// the suite ran IN the throwaway tree, not the caller's, full matrix
		expect(ci.calls).toHaveLength(1);
		expect(ci.calls[0].repoRoot).toBe(wt);
		expect(ci.calls[0].all).toBe(true);
		// healthy verdict + provenance: outcome says WHERE it really ran
		expect(out.healthy).toBe(true);
		expect(out.aborted).toBeUndefined();
		expect(out.tempWorktree).toBe(wt);
		expect(out.worktree).toBe(wt);
		expect(out.warnings.join(" ")).toMatch(/throwaway worktree/);
		// ALWAYS removed — even on the success path
		const remove = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "remove");
		expect(remove).toBeDefined();
		expect(remove!.args).toContain("--force");
		expect(remove!.args[remove!.args.length - 1]).toBe(wt);
		// the temp dir itself is swept too (rm is real fs — nothing left behind)
	});

	test("worktree add FAILS → the existing abort, nothing runs", async () => {
		const ci = mkCi(greenCi());
		const { spawn } = recordingSpawn({ add: 128 });
		const out = await runMainHealth({
			client: fakeClient({ worktrees: DETACHED_WTS }),
			spawn,
			runCi: ci.fn,
		});
		expect(out.aborted).toBe("no-default-branch-worktree");
		expect(out.healthy).toBe(false);
		expect(out.tempWorktree).toBeUndefined();
		expect(ci.calls).toHaveLength(0);
		expect(out.message).toContain("main");
	});
});
