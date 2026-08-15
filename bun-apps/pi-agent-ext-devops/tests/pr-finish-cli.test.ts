/**
 * Tests for `pr-finish-cli.ts` (bin `devops-pr-finish`) — the TS port of the
 * deleted `scripts/pr-finish.sh`, with remote-CI waiting intentionally dropped
 * (local CI is the gate).
 *
 * What is pinned here is the WRAPPER'S CONTRACT, not recipe logic (that lives
 * in tests/ci-recipe.test.ts / tests/verify-merge-recipe.test.ts):
 *  - argv parsing: <pr-number> / --pr <n>, --dry-run, --expected-scope,
 *    --keep-branch, --repo-root,
 *  - gate sequencing: dirty_tree → local_ci_failed → behind → not-clean →
 *    not-open all abort with exit 1 and NEVER reach mergeNow,
 *  - happy path: squash-merge + branch cleanup (deletes + prune),
 *  - post-merge warning: run sync_repo (the default-branch worktree / cwd
 *    may now be behind after the merge),
 *  - --dry-run: read-only gates only, planned commands, zero mutations,
 *  - usage errors exit 2; --help exits 0 with usage on stderr.
 *
 * Dual-seam style of tests/sync-cli.test.ts: plain-async-stub `gh` +
 * `BranchClient` fakes + a recording SpawnFn + a stubbed `runCi` seam. No real
 * git / gh / network.
 */
import { test, expect, describe } from "bun:test";
import { runPrFinishCli, parsePrFinishArgs, PR_FINISH_CLI_USAGE } from "../src/pr-finish-cli.js";
import type { GhClient } from "../src/recipe.js";
import type { BranchClient } from "../src/branch-recipe.js";
import type { runLocalCi } from "../src/ci-recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";
import type { CiOutcome } from "../src/ci-recipe.js";

const REPO = "/repo";

/** Quiet-success recording SpawnFn (feeds verify_merge's read-only git). */
function fakeSpawn(): { fn: SpawnFn; calls: { cmd: string; args: string[] }[] } {
	const calls: { cmd: string; args: string[] }[] = [];
	const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
		calls.push({ cmd, args });
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

type PrStatus = Awaited<ReturnType<GhClient["prStatus"]>>;

/** Stateful gh fake: each prStatus() call pops the next snapshot. */
function fakeGh(statuses: PrStatus[], mergeCalls: number[] = []) {
	return {
		gh: {
			prStatus: async () => {
				const s = statuses.shift();
				if (!s) throw new Error("fake gh: no more prStatus snapshots");
				return s;
			},
			mergeNow: async (n: number) => {
				mergeCalls.push(n);
			},
		} as unknown as GhClient,
		mergeCalls,
	};
}

/** BranchClient fake: clean tree, records every mutating call. */
function fakeClient(opts: { clean?: boolean } = {}) {
	const calls: string[] = [];
	const client = {
		currentBranch: async () => "feature",
		defaultBranch: async () => "main",
		isClean: async () => opts.clean ?? true,
		dirtyPaths: async () => (opts.clean ?? true ? [] : ["src/x.ts"]),
		deleteLocalBranch: async (name: string) => {
			calls.push(`deleteLocal:${name}`);
		},
		deleteRemoteBranch: async (name: string) => {
			calls.push(`deleteRemote:${name}`);
		},
		fetchPrune: async () => {
			calls.push("fetchPrune");
		},
		revParse: async () => undefined,
		containedBranches: async () => new Set(["feature"]),
		worktreeList: async () => [],
	};
	return { client: client as unknown as BranchClient, calls };
}

const OPEN_CLEAN: PrStatus = {
	state: "OPEN",
	mergeState: "CLEAN",
	baseRefName: "main",
	headRefName: "feature",
	checks: { pass: 0, fail: 0, pending: 0 },
};

const MERGED: PrStatus = {
	state: "MERGED",
	mergeState: "CLEAN",
	baseRefName: "main",
	headRefName: "feature",
	checks: { pass: 0, fail: 0, pending: 0 },
	mergeSha: "a".repeat(40),
};

function ciPass(): CiOutcome {
	return {
		overall: "pass",
		baseRef: "main",
		headRef: "feature",
		packages: [],
		gates: [],
		elapsedMs: 1,
		budgetMs: 300_000,
		overBudget: false,
		slowest: [],
	};
}

function ciFail(): CiOutcome {
	return { ...ciPass(), overall: "fail" };
}

/** Standard green deps: OPEN+CLEAN pre-merge, MERGED post-merge, CI pass. */
function greenDeps() {
	const ghParts = fakeGh([OPEN_CLEAN, MERGED]);
	const clientParts = fakeClient();
	const ciOpts: Array<Parameters<typeof runLocalCi>[0]> = [];
	return {
		deps: {
			gh: ghParts.gh,
			client: clientParts.client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async (opts: Parameters<typeof runLocalCi>[0]) => {
				ciOpts.push(opts);
				return ciPass();
			},
		},
		mergeCalls: ghParts.mergeCalls,
		clientCalls: clientParts.calls,
		ciOpts,
	};
}

describe("parsePrFinishArgs — argv contract", () => {
	test("positional and --pr forms both parse; flags round-trip", () => {
		for (const argv of [["42"], ["--pr", "42"]]) {
			const r = parsePrFinishArgs(argv);
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.args.pr).toBe(42);
		}
		const r = parsePrFinishArgs(["42", "--dry-run", "--keep-branch", "--expected-scope", "src/", "--expected-scope", "docs/"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.dryRun).toBe(true);
			expect(r.args.keepBranch).toBe(true);
			expect(r.args.expectedScope).toEqual(["src/", "docs/"]);
		}
	});

	test("missing / invalid pr is a usage error", () => {
		expect(parsePrFinishArgs([]).ok).toBe(false);
		expect(parsePrFinishArgs(["--dry-run"]).ok).toBe(false);
		expect(parsePrFinishArgs(["abc"]).ok).toBe(false);
		expect(parsePrFinishArgs(["--pr"]).ok).toBe(false);
		expect(parsePrFinishArgs(["--nope"]).ok).toBe(false);
		expect(parsePrFinishArgs(["--expected-scope"]).ok).toBe(false);
	});
});

describe("pr-finish-cli — wrapper contract", () => {
	test("happy path: OPEN+CLEAN+ci pass → merged, branches deleted, exit 0", async () => {
		const g = greenDeps();
		const res = await runPrFinishCli(["42"], g.deps);
		expect(res.exitCode).toBe(0);
		expect(res.stderr).toBe("");
		const outcome = JSON.parse(res.stdout);
		expect(outcome.pr).toBe(42);
		expect(outcome.merged).toBe(true);
		expect(outcome.verdict).toBe("CLEAN");
		expect(outcome.branchSpent).toBe(true); // fake containedBranches lists "feature"
		expect(outcome.aborted).toBeUndefined();
		expect(g.mergeCalls).toEqual([42]);
		expect(g.clientCalls).toEqual(["deleteLocal:feature", "deleteRemote:feature", "fetchPrune"]);
		// The local_ci diff must be based at the PR base's REMOTE-TRACKING ref,
		// not the local base branch: in this repo's multi-worktree layout `main`
		// is checked out in another worktree and can never be fast-forwarded
		// here, so a stale local `main` over-scopes the diff (observed 318 s vs
		// 69 s for the same branch).
		expect(g.ciOpts[0]?.baseRef).toBe("origin/main");
		expect(g.ciOpts[0]?.headRef).toBe("feature");
	});

	test("ci fail → abort local_ci_failed, exit 1, mergeNow never called", async () => {
		const ghParts = fakeGh([OPEN_CLEAN]);
		const clientParts = fakeClient();
		const res = await runPrFinishCli(["42"], {
			gh: ghParts.gh,
			client: clientParts.client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciFail(),
		});
		expect(res.exitCode).toBe(1);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.aborted?.aborted).toBe(true);
		expect(outcome.aborted.reason).toBe("local_ci_failed");
		expect(ghParts.mergeCalls).toEqual([]);
		expect(clientParts.calls).toEqual([]);
	});

	test("BEHIND → abort behind, exit 1 (points at prepare_branch)", async () => {
		const ghParts = fakeGh([{ ...OPEN_CLEAN, mergeState: "BEHIND" }]);
		const res = await runPrFinishCli(["42"], {
			gh: ghParts.gh,
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
		});
		expect(res.exitCode).toBe(1);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.aborted.reason).toBe("behind");
		expect(outcome.aborted.message.includes("prepare_branch")).toBe(true);
		expect(ghParts.mergeCalls).toEqual([]);
	});

	test("BLOCKED (non-CLEAN) → abort not-clean", async () => {
		const ghParts = fakeGh([{ ...OPEN_CLEAN, mergeState: "BLOCKED" }]);
		const res = await runPrFinishCli(["42"], {
			gh: ghParts.gh,
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
		});
		expect(res.exitCode).toBe(1);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.aborted.reason).toBe("not-clean");
		expect(ghParts.mergeCalls).toEqual([]);
	});

	test("dirty tree → abort dirty_tree, exit 1 (before any gh call)", async () => {
		const ghParts = fakeGh([OPEN_CLEAN]);
		const res = await runPrFinishCli(["42"], {
			gh: ghParts.gh,
			client: fakeClient({ clean: false }).client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
		});
		expect(res.exitCode).toBe(1);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.aborted.reason).toBe("dirty_tree");
		expect(ghParts.mergeCalls).toEqual([]);
	});

	test("--keep-branch → merge + verify, but no delete/prune calls", async () => {
		const g = greenDeps();
		const res = await runPrFinishCli(["42", "--keep-branch"], g.deps);
		expect(res.exitCode).toBe(0);
		expect(JSON.parse(res.stdout).merged).toBe(true);
		expect(g.mergeCalls).toEqual([42]);
		expect(g.clientCalls).toEqual([]);
	});

	test("--dry-run → read-only gates pass, planned commands emitted, zero mutations, exit 0", async () => {
		const g = greenDeps();
		const spawnParts = fakeSpawn();
		const res = await runPrFinishCli(["42", "--dry-run"], { ...g.deps, spawn: spawnParts.fn });
		expect(res.exitCode).toBe(0);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.dryRun).toBe(true);
		expect(outcome.merged).toBe(false);
		expect(outcome.aborted).toBeUndefined();
		// planned commands present…
		expect(outcome.commands.some((c: string) => c === "gh pr merge 42 --squash")).toBe(true);
		expect(outcome.commands.some((c: string) => c === "git branch -D feature")).toBe(true);
		expect(outcome.commands.some((c: string) => c === "git push origin --delete feature")).toBe(true);
		expect(outcome.commands.some((c: string) => c === "git fetch --prune")).toBe(true);
		// …but nothing mutated: no merge, no deletes, no prune, no mutating spawn.
		expect(g.mergeCalls).toEqual([]);
		expect(g.clientCalls).toEqual([]);
		const mutating = spawnParts.calls.filter((c) => /^(push|branch\s+-D)/.test(c.args.join(" ")));
		expect(mutating).toEqual([]);
	});

	test("--dry-run abort paths still exit 1 (dirty tree)", async () => {
		const res = await runPrFinishCli(["42", "--dry-run"], {
			gh: fakeGh([OPEN_CLEAN]).gh,
			client: fakeClient({ clean: false }).client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
		});
		expect(res.exitCode).toBe(1);
		expect(JSON.parse(res.stdout).aborted.reason).toBe("dirty_tree");
	});

	test("recordingSpawn forwards spawn options (cwd) — a dropped opts made every local_ci gate run at the repo root", async () => {
		// Regression (2026-08-15): recordingSpawn dropped the third SpawnFn
		// argument, so every spawn local_ci makes on pr-finish's behalf lost its
		// cwd and ran at the baked-in default — package tests and gate commands
		// (`bun run test:seam` at bun-apps/) executed at the repo root and failed,
		// while the same local_ci passed standalone. Drive the passthrough via the
		// default-runCi path's spawn seam and assert the fake receives options.
		const seen: Array<{ args: string[]; cwd?: string }> = [];
		const g = greenDeps();
		const res = await runPrFinishCli(["42"], {
			...g.deps,
			spawn: (async (cmd: string, args: string[], options?: { cwd?: string }) => {
				if (cmd === "echo") seen.push({ args, cwd: options?.cwd });
				return { stdout: "", stderr: "", exitCode: 0 };
			}) as unknown as typeof g.deps.spawn,
			runCi: async (opts) => {
				await opts.spawn("echo", ["probe"], { cwd: "/tmp/probe-cwd" });
				return ciPass();
			},
		});
		expect(res.exitCode).toBe(0);
		expect(seen.some((s) => s.args[0] === "probe" && s.cwd === "/tmp/probe-cwd")).toBe(true);
	});

	test("usage: missing pr → exit 2 with usage on stderr; --help exits 0", async () => {
		const g = greenDeps();
		const bad = await runPrFinishCli(["--dry-run"], g.deps);
		expect(bad.exitCode).toBe(2);
		expect(bad.stdout).toBe("");
		expect(bad.stderr.includes(PR_FINISH_CLI_USAGE)).toBe(true);
		const help = await runPrFinishCli(["--help"], g.deps);
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toBe("");
		expect(help.stderr).toBe(PR_FINISH_CLI_USAGE);
	});
});
