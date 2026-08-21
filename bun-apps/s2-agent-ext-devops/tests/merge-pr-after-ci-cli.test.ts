/**
 * Tests for `merge-pr-after-ci-cli.ts` (bin `devops-merge-pr-after-ci`) — the TS port of the
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
 *  - post-merge warning: run sync_default_branch (the default-branch worktree / cwd
 *    may now be behind after the merge),
 *  - --dry-run: read-only gates only, planned commands, zero mutations,
 *  - usage errors exit 2; --help exits 0 with usage on stderr.
 *
 * Dual-seam style of tests/sync-default-branch-cli.test.ts: plain-async-stub `gh` +
 * `BranchClient` fakes + a recording SpawnFn + a stubbed `runCi` seam. No real
 * git / gh / network.
 */
import { test, expect, describe } from "bun:test";
import { runPrFinishCli, parsePrFinishArgs, settlePrStatus, isMissingWorkflowScope, MERGE_STATE_POLLS, PR_FINISH_CLI_USAGE } from "../src/merge-pr-after-ci-cli.js";
import type { GhClient } from "../src/recipe.js";
import type { BranchClient } from "../src/branch-recipe.js";
import type { runLocalCi } from "../src/ci-recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";
import type { CiOutcome } from "../src/ci-recipe.js";

const REPO = "/repo";

/** Quiet-success recording SpawnFn (feeds verify_merge_landed's read-only git). */
function fakeSpawn(): { fn: SpawnFn; calls: { cmd: string; args: string[] }[] } {
	const calls: { cmd: string; args: string[] }[] = [];
	const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
		calls.push({ cmd, args });
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

type PrStatus = Awaited<ReturnType<GhClient["prStatus"]>>;

/** Stateful gh fake: each prStatus() call pops the next snapshot.
 *
 *  The snapshot list IS the expected call sequence, and it is deliberately
 *  strict (running out throws) — a run that reads the PR status more or fewer
 *  times than the test says is itself a finding. A full green run reads it
 *  three times: preflight (for the ref names), the post-CI refresh the merge
 *  gates read, and verify_merge_landed's own post-merge read. */
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

/** BranchClient fake: clean tree, records every mutating call.
 *  `current` defaults to "feature" — i.e. the worktree is sitting ON the head
 *  branch, which is the normal post-merge state and the one that used to make
 *  `git branch -D` fail. `worktreeList` lets a test place the branch in a
 *  DIFFERENT worktree instead. */
function fakeClient(opts: {
	clean?: boolean;
	current?: string;
	worktrees?: { worktree: string; branch?: string; detached?: boolean }[];
	failDeleteLocal?: boolean;
} = {}) {
	const calls: string[] = [];
	let current = opts.current ?? "feature";
	const client = {
		currentBranch: async () => current,
		defaultBranch: async () => "main",
		isClean: async () => opts.clean ?? true,
		dirtyPaths: async () => (opts.clean ?? true ? [] : ["src/x.ts"]),
		detachHead: async (ref: string) => {
			calls.push(`detach:${ref}`);
			current = "";
		},
		deleteLocalBranch: async (name: string) => {
			if (opts.failDeleteLocal || current === name) {
				throw new Error(`cannot delete branch '${name}' used by worktree`);
			}
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
		worktreeList: async () => opts.worktrees ?? [],
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
	return {
		...ciPass(),
		overall: "fail",
		gates: [
			{
				name: "oneshot-smoke",
				exitCode: 1,
				note: "fail (fast probe: nonzero-exit)",
				detail:
					"344 | if (!BUILTIN_THEMES) {\nENOENT: no such file or directory, open '.../theme/dark.json'\n    at getBuiltinThemes",
			},
		],
		packages: [
			{
				name: "s2-agent",
				test: {
					exitCode: 1,
					source: "matrix",
					command: "bun test && bun run typecheck",
					detail: "(fail) resolveLLMFromArgs > settings.json defaults\nExpected: \"openai\" Received: \"zai\"",
				},
			},
		],
	};
}

/** Standard green deps: OPEN+CLEAN pre-merge, MERGED post-merge, CI pass.
 *  `client` forwards to fakeClient so a test can vary the worktree situation. */
function greenDeps(client: Parameters<typeof fakeClient>[0] = {}) {
	const ghParts = fakeGh([OPEN_CLEAN, OPEN_CLEAN, MERGED]);
	const clientParts = fakeClient(client);
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

describe("merge-pr-after-ci-cli — wrapper contract", () => {
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
		// The detach step is new. The worktree that runs pr_finish is still on the
		// head branch, and git refuses `branch -D` on a checked-out branch — so
		// deleteLocal used to fail on essentially every real run and the caller had
		// to detach and sweep by hand. The fake now models that refusal, which is
		// why this sequence changed rather than merely gaining a step. The target is
		// the MERGE SHA, not `origin/main`: the remote-tracking ref is still at the
		// pre-merge tip until the `fetchPrune` two lines below.
		expect(g.clientCalls).toEqual([
			`detach:${MERGED.mergeSha}`,
			"deleteLocal:feature",
			"deleteRemote:feature",
			"fetchPrune",
		]);
		// The run_local_ci diff must be based at the PR base's REMOTE-TRACKING ref,
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
		// Diagnosability contract: the abort must carry WHICH steps failed —
		// naming only refs+elapsed forced callers to re-run the full local CI
		// (and hand-parse its JSON) just to find the failing step (observed:
		// a 2-minute re-run + three ad-hoc parsers to reach "oneshot-smoke").
		expect(outcome.aborted.message).toContain("oneshot-smoke");
		expect(outcome.aborted.message).toContain("s2-agent/test");
		expect(outcome.aborted.message).toContain("ENOENT");
		expect(ghParts.mergeCalls).toEqual([]);
		expect(clientParts.calls).toEqual([]);
	});

	test("BEHIND → abort behind, exit 1 (points at prepare_feature_branch)", async () => {
		const ghParts = fakeGh([OPEN_CLEAN, { ...OPEN_CLEAN, mergeState: "BEHIND" }]);
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
		expect(outcome.aborted.message.includes("prepare_feature_branch")).toBe(true);
		expect(ghParts.mergeCalls).toEqual([]);
	});

	test("BLOCKED (non-CLEAN) → abort not-clean", async () => {
		const ghParts = fakeGh([OPEN_CLEAN, { ...OPEN_CLEAN, mergeState: "BLOCKED" }]);
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

	test("recordingSpawn forwards spawn options (cwd) — a dropped opts made every run_local_ci gate run at the repo root", async () => {
		// Regression (2026-08-15): recordingSpawn dropped the third SpawnFn
		// argument, so every spawn run_local_ci makes on pr-finish's behalf lost its
		// cwd and ran at the baked-in default — package tests and gate commands
		// (`bun run test:seam` at bun-apps/) executed at the repo root and failed,
		// while the same run_local_ci passed standalone. Drive the passthrough via the
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

// ─────────────────────────────────────────────────────────────────────────────
// Post-merge cleanup: git refuses `branch -D` on a branch checked out in ANY
// worktree. The worktree running pr_finish is normally still on the head
// branch, so this failed every run; a branch held by a DIFFERENT worktree is
// not ours to move and must be reported rather than force-deleted.
// ─────────────────────────────────────────────────────────────────────────────

describe("merge-pr-after-ci-cli — spent-branch deletion", () => {
	test("detaches onto the MERGE COMMIT, not the stale origin/<base> ref", async () => {
		// `fetchPrune()` runs after this block, so `origin/main` still points at the
		// PRE-merge tip — detaching onto it left the worktree one commit behind the
		// merge it had just made. verify already fetched + read the merge sha, so
		// that is the ref to land on.
		const g = greenDeps({ current: "feature" });
		const withNumstat: SpawnFn = async (_cmd, args) =>
			args.includes("show")
				? { stdout: "1\t0\tbun-apps/x.ts\n", stderr: "", exitCode: 0 }
				: { stdout: "", stderr: "", exitCode: 0 };
		const res = await runPrFinishCli(["42"], { ...g.deps, spawn: withNumstat });
		expect(res.exitCode).toBe(0);
		expect(JSON.parse(res.stdout).verdict).toBe("CLEAN");
		expect(g.clientCalls).toContain(`detach:${MERGED.mergeSha}`);
		expect(g.clientCalls).not.toContain("detach:origin/main");
	});

	test("falls back to origin/<base> when the merge could not be inspected", async () => {
		// No usable merge sha locally → the sha may not resolve, so the base ref is
		// the only safe target. Still detaches, so the delete still succeeds.
		const g = greenDeps({ current: "feature" });
		const badShow: SpawnFn = async (_cmd, args) =>
			args.includes("show") || args.includes("fetch")
				? { stdout: "", stderr: "fatal: bad object", exitCode: 128 }
				: { stdout: "", stderr: "", exitCode: 0 };
		const res = await runPrFinishCli(["42"], { ...g.deps, spawn: badShow });
		expect(JSON.parse(res.stdout).verdict).toBe("UNVERIFIED");
		expect(g.clientCalls).toContain("detach:origin/main");
		expect(g.clientCalls).toContain("deleteLocal:feature");
	});

	test("detaches THIS worktree off the head branch before deleting it", async () => {
		const g = greenDeps({ current: "feature" });
		const res = await runPrFinishCli(["42"], g.deps);
		expect(res.exitCode).toBe(0);
		// Target-agnostic on purpose — WHICH ref we land on is pinned by the two
		// tests above; what matters here is that a detach happens at all, because
		// without it the delete cannot succeed.
		expect(g.clientCalls.some((c) => c.startsWith("detach:"))).toBe(true);
		expect(g.clientCalls).toContain("deleteLocal:feature");
		const outcome = JSON.parse(res.stdout);
		expect(outcome.warnings.some((w: string) => /deleteLocalBranch.*failed/.test(w))).toBe(false);
	});

	test("does NOT detach when the worktree is already elsewhere", async () => {
		const g = greenDeps({ current: "some-other-branch" });
		await runPrFinishCli(["42"], g.deps);
		expect(g.clientCalls.some((c) => c.startsWith("detach:"))).toBe(false);
		expect(g.clientCalls).toContain("deleteLocal:feature");
	});

	test("leaves a branch held by ANOTHER worktree alone, and says so", async () => {
		const g = greenDeps({
			current: "some-other-branch",
			worktrees: [
				{ worktree: "/repo", branch: "some-other-branch" },
				{ worktree: "/elsewhere", branch: "feature" },
			],
		});
		const res = await runPrFinishCli(["42"], g.deps);
		expect(res.exitCode).toBe(0);
		// Never touched locally...
		expect(g.clientCalls.some((c) => c.startsWith("detach:"))).toBe(false);
		expect(g.clientCalls).not.toContain("deleteLocal:feature");
		// ...but the REMOTE branch is still spent and still deleted.
		expect(g.clientCalls).toContain("deleteRemote:feature");
		const outcome = JSON.parse(res.stdout);
		expect(outcome.warnings.some((w: string) => /checked out in another worktree \(\/elsewhere\)/.test(w))).toBe(true);
	});

	test("a deleteLocal failure is a warning, never a lost remote delete or a non-zero exit", async () => {
		const g = greenDeps({ current: "some-other-branch", failDeleteLocal: true });
		const res = await runPrFinishCli(["42"], g.deps);
		expect(res.exitCode).toBe(0);
		expect(g.clientCalls).toContain("deleteRemote:feature");
		expect(g.clientCalls).toContain("fetchPrune");
		const outcome = JSON.parse(res.stdout);
		expect(outcome.warnings.some((w: string) => /deleteLocalBranch\(feature\) failed/.test(w))).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The verification step must never launder its own failure into a pass. This
// is issue #1439 one layer up: the catch around runVerifyMerge used to build a
// synthetic outcome with `verdict: "CLEAN"`, so a total failure to verify was
// reported as a verified-clean merge.
// ─────────────────────────────────────────────────────────────────────────────

describe("merge-pr-after-ci-cli — verification failures are not passes", () => {
	test("an unreadable merge sha does NOT report CLEAN", async () => {
		// The reachable form of issue #1439 at this layer: the merge lands, but
		// `git show` cannot read it. pr_finish used to print verdict CLEAN having
		// inspected zero files.
		const g = greenDeps();
		const failingShow: SpawnFn = async (cmd, args) => {
			if (args.includes("show")) return { stdout: "", stderr: "fatal: bad object", exitCode: 128 };
			if (args.includes("fetch")) return { stdout: "", stderr: "fatal: could not fetch", exitCode: 128 };
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const res = await runPrFinishCli(["42"], { ...g.deps, spawn: failingShow });
		const outcome = JSON.parse(res.stdout);
		expect(outcome.merged).toBe(true);
		expect(outcome.verdict).toBe("UNVERIFIED");
		expect(outcome.warnings.some((w: string) => /UNVERIFIED merge/.test(w))).toBe(true);
	});

	test("pr_finish passes allowFetch — it just merged, so the sha is remote-only", async () => {
		// Without allowFetch the case above could never recover; with it, the one
		// targeted object fetch is attempted before giving up. Asserting the
		// attempt (not its success) is what pins the flag being passed through.
		const g = greenDeps();
		const calls: string[][] = [];
		const failingShow: SpawnFn = async (_cmd, args) => {
			calls.push(args);
			if (args.includes("show")) return { stdout: "", stderr: "fatal: bad object", exitCode: 128 };
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		await runPrFinishCli(["42"], { ...g.deps, spawn: failingShow });
		expect(calls.some((a) => a.includes("fetch") && a.includes("origin"))).toBe(true);
	});

	test("a verify step that THROWS falls back to UNVERIFIED, never CLEAN", async () => {
		// runVerifyMerge is throw-free today, so this catch is purely defensive —
		// which is exactly why its fabricated `verdict: "CLEAN"` sat there
		// unnoticed. The `verify` seam exists so the defensive path is reachable
		// from a test instead of being trusted by inspection.
		const g = greenDeps();
		const res = await runPrFinishCli(["42"], {
			...g.deps,
			verify: async () => {
				throw new Error("verify exploded");
			},
		});
		const outcome = JSON.parse(res.stdout);
		expect(outcome.merged).toBe(true);
		expect(outcome.verdict).toBe("UNVERIFIED");
		expect(outcome.warnings.some((w: string) => /runVerifyMerge threw: verify exploded/.test(w))).toBe(true);
	});
});

/**
 * The merge gates must read a FRESH pr status, and an UNKNOWN mergeState is
 * "GitHub hasn't computed it yet", not "cannot merge".
 *
 * Both halves cost a real merge on 2026-08-18 (PR #1646): the preflight
 * snapshot was taken, ~2 minutes of run_local_ci ran, and the gate then rejected a
 * mergeState that had already settled to CLEAN — at the price of a full CI
 * re-run per manual retry.
 */
describe("merge-pr-after-ci-cli — the merge gates read a fresh, settled status", () => {
	const OID = "b".repeat(40);
	const noSleep = async () => {};

	test("UNKNOWN settles to CLEAN across polls → merges, and says so", async () => {
		const ghParts = fakeGh([
			OPEN_CLEAN,
			{ ...OPEN_CLEAN, mergeState: "UNKNOWN" },
			{ ...OPEN_CLEAN, mergeState: "UNKNOWN" },
			OPEN_CLEAN,
			MERGED,
		]);
		const res = await runPrFinishCli(["42"], {
			gh: ghParts.gh,
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
			sleep: noSleep,
		});
		expect(res.exitCode).toBe(0);
		const outcome = JSON.parse(res.stdout);
		expect(ghParts.mergeCalls).toEqual([42]);
		expect(outcome.mergeStateSettle).toEqual({ mergeState: "CLEAN", polls: 3 });
		expect(outcome.warnings.some((w: string) => /mergeState was UNKNOWN and settled to CLEAN after 3 reads/.test(w))).toBe(true);
	});

	test("a mergeState that never settles is bounded, and aborts not-clean", async () => {
		// The poll must not become an unbounded wait: an UNKNOWN that is really
		// stuck has to surface as a normal abort the caller can act on.
		const unknown = { ...OPEN_CLEAN, mergeState: "UNKNOWN" as const };
		const ghParts = fakeGh([OPEN_CLEAN, unknown, unknown, unknown, unknown]);
		const res = await runPrFinishCli(["42"], {
			gh: ghParts.gh,
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
			sleep: noSleep,
		});
		expect(res.exitCode).toBe(1);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.aborted.reason).toBe("not-clean");
		expect(outcome.mergeStateSettle).toEqual({ mergeState: "UNKNOWN", polls: MERGE_STATE_POLLS });
		expect(ghParts.mergeCalls).toEqual([]);
	});

	test("a CLEAN preflight snapshot does NOT authorize the merge — the refresh does", async () => {
		// Kills the pre-fix code directly: it gated on the preflight snapshot, so
		// a base that moved during the CI run merged on stale evidence.
		const ghParts = fakeGh([OPEN_CLEAN, { ...OPEN_CLEAN, mergeState: "BEHIND" }]);
		const res = await runPrFinishCli(["42"], {
			gh: ghParts.gh,
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
			sleep: noSleep,
		});
		expect(res.exitCode).toBe(1);
		expect(JSON.parse(res.stdout).aborted.reason).toBe("behind");
		expect(ghParts.mergeCalls).toEqual([]);
	});

	test("the common path costs exactly one extra read (no polling when the answer is real)", async () => {
		const g = greenDeps();
		const res = await runPrFinishCli(["42"], { ...g.deps, sleep: noSleep });
		expect(res.exitCode).toBe(0);
		expect(JSON.parse(res.stdout).mergeStateSettle).toEqual({ mergeState: "CLEAN", polls: 1 });
	});

	test("settlePrStatus returns a non-UNKNOWN answer immediately", async () => {
		let reads = 0;
		const gh = {
			prStatus: async () => {
				reads++;
				return { ...OPEN_CLEAN, mergeState: "DIRTY" as const };
			},
		} as unknown as GhClient;
		const settled = await settlePrStatus(gh, 42, noSleep);
		expect(settled.polls).toBe(1);
		expect(reads).toBe(1);
		expect(settled.status.mergeState).toBe("DIRTY");
	});

	test("--assume-ci-green matching the CURRENT head skips local CI and merges", async () => {
		let ciRuns = 0;
		const ghParts = fakeGh([
			{ ...OPEN_CLEAN, headRefOid: OID },
			{ ...OPEN_CLEAN, headRefOid: OID },
			MERGED,
		]);
		const res = await runPrFinishCli(["42", "--assume-ci-green", OID], {
			gh: ghParts.gh,
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => {
				ciRuns++;
				return ciPass();
			},
			sleep: noSleep,
		});
		expect(res.exitCode).toBe(0);
		expect(ciRuns).toBe(0);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.ciSkipped).toEqual({ assumedSha: OID });
		expect(outcome.warnings.some((w: string) => /run_local_ci SKIPPED/.test(w))).toBe(true);
		expect(ghParts.mergeCalls).toEqual([42]);
	});

	test("--assume-ci-green against a head that moved aborts instead of merging", async () => {
		// The whole safety of the shortcut is this comparison: without it the
		// flag would merge a commit no gate has ever seen.
		const ghParts = fakeGh([
			{ ...OPEN_CLEAN, headRefOid: "c".repeat(40) },
			{ ...OPEN_CLEAN, headRefOid: "c".repeat(40) },
		]);
		const res = await runPrFinishCli(["42", "--assume-ci-green", OID], {
			gh: ghParts.gh,
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
			sleep: noSleep,
		});
		expect(res.exitCode).toBe(1);
		expect(JSON.parse(res.stdout).aborted.reason).toBe("ci-assumption-stale");
		expect(ghParts.mergeCalls).toEqual([]);
	});

	test("--assume-ci-green with no headRefOid to compare against is refused, not trusted", async () => {
		const ghParts = fakeGh([OPEN_CLEAN, OPEN_CLEAN]);
		const res = await runPrFinishCli(["42", "--assume-ci-green", OID], {
			gh: ghParts.gh,
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
			sleep: noSleep,
		});
		expect(res.exitCode).toBe(1);
		expect(JSON.parse(res.stdout).aborted.reason).toBe("ci-assumption-unverifiable");
		expect(ghParts.mergeCalls).toEqual([]);
	});

	test("a normal run carries NO ciSkipped key — its absence is the proof CI ran", async () => {
		const g = greenDeps();
		const res = await runPrFinishCli(["42"], { ...g.deps, sleep: noSleep });
		expect("ciSkipped" in JSON.parse(res.stdout)).toBe(false);
	});

	test("--assume-ci-green rejects an abbreviated sha at argv parse time (exit 2)", async () => {
		const short = parsePrFinishArgs(["42", "--assume-ci-green", "b".repeat(7)]);
		expect(short.ok).toBe(false);
		const missing = parsePrFinishArgs(["42", "--assume-ci-green"]);
		expect(missing.ok).toBe(false);
		const good = parsePrFinishArgs(["42", "--assume-ci-green", OID.toUpperCase()]);
		expect(good.ok).toBe(true);
		if (good.ok) expect(good.args.assumeCiGreen).toBe(OID);
	});
});

/**
 * A missing `workflow` scope is a distinct, recoverable failure with exactly
 * one fix — not a generic merge error. It blocked PR #1646 on 2026-08-18 and
 * arrived as a raw GraphQL passthrough that named no remedy.
 */
describe("merge-pr-after-ci-cli — the missing-workflow-scope refusal is its own class", () => {
	const GRAPHQL_REFUSAL =
		"gh pr merge 42 (direct) failed (exit 1): GraphQL: refusing to allow an OAuth App to create or " +
		"update workflow `.github/workflows/ci.yml.disabled` without `workflow` scope (mergePullRequest)";

	function ghThatRefuses(message: string) {
		const statuses: PrStatus[] = [OPEN_CLEAN, OPEN_CLEAN];
		return {
			prStatus: async () => {
				const s = statuses.shift();
				if (!s) throw new Error("fake gh: no more prStatus snapshots");
				return s;
			},
			mergeNow: async () => {
				throw new Error(message);
			},
		} as unknown as GhClient;
	}

	test("the GraphQL refusal aborts as missing-workflow-scope and carries the fix command", async () => {
		const res = await runPrFinishCli(["42"], {
			gh: ghThatRefuses(GRAPHQL_REFUSAL),
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
			sleep: async () => {},
		});
		expect(res.exitCode).toBe(1);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.aborted.reason).toBe("missing-workflow-scope");
		expect(outcome.aborted.message).toContain("gh auth refresh -h github.com -s workflow");
		// The retry shortcut is named too — without it the caller re-pays for CI.
		expect(outcome.aborted.message).toContain("--assume-ci-green");
		// The original text is preserved, not swallowed by the friendlier message.
		expect(outcome.aborted.message).toContain("mergePullRequest");
		expect(outcome.merged).toBe(false);
	});

	test("an unrelated merge failure still aborts as merge-failed (the class is not a catch-all)", async () => {
		const res = await runPrFinishCli(["42"], {
			gh: ghThatRefuses("gh pr merge 42 (direct) failed (exit 1): Base branch was modified"),
			client: fakeClient().client,
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
			runCi: async () => ciPass(),
			sleep: async () => {},
		});
		expect(JSON.parse(res.stdout).aborted.reason).toBe("merge-failed");
	});

	test("isMissingWorkflowScope matches the real wordings and nothing else", () => {
		expect(isMissingWorkflowScope(GRAPHQL_REFUSAL)).toBe(true);
		// GitHub has used both an OAuth-App and a GitHub-App phrasing.
		expect(
			isMissingWorkflowScope("refusing to allow a GitHub App to update workflow `.github/workflows/ci.yml` without `workflow` scope"),
		).toBe(true);
		expect(isMissingWorkflowScope("Base branch was modified. Review and try the merge again.")).toBe(false);
		expect(isMissingWorkflowScope("Resource not accessible by integration")).toBe(false);
	});
});
