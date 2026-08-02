/**
 * Tests for the gh-CLI output parsers (pure functions) + the GhClient glue.
 * Parsers turn structured `gh ... --json` into our domain types — robust, no
 * `grep -c` footguns. The GhClient is tested with a recording fake spawn.
 */
import { test, expect, describe } from "bun:test";
import {
	parsePrView,
	parseChecks,
	createGhClient,
	parseBranchVv,
	parseRemoteBranches,
	parseWorktrees,
	parseMergedPrs,
	parseOpenPrRefs,
	parseContained,
	createBranchClient,
	type SpawnFn,
	type SpawnResult,
} from "../src/gh.js";

describe("parsePrView", () => {
	test("MERGED with mergeCommit → mergeSha", () => {
		const r = parsePrView({ state: "MERGED", mergeStateStatus: "CLEAN", mergeCommit: { oid: "abc123" } });
		expect(r).toEqual({ state: "MERGED", mergeState: "CLEAN", mergeSha: "abc123" });
	});

	test("OPEN + BEHIND", () => {
		expect(parsePrView({ state: "OPEN", mergeStateStatus: "BEHIND", mergeCommit: null })).toEqual({
			state: "OPEN",
			mergeState: "BEHIND",
			mergeSha: undefined,
		});
	});

	test("unknown mergeStateStatus → UNKNOWN (defensive)", () => {
		expect(parsePrView({ state: "OPEN", mergeStateStatus: "SOMETHING_NEW" }).mergeState).toBe("UNKNOWN");
	});

	test("malformed/empty input → OPEN/UNKNOWN defaults", () => {
		expect(parsePrView(null)).toEqual({ state: "OPEN", mergeState: "UNKNOWN", mergeSha: undefined });
	});
});

describe("parseChecks", () => {
	test("all SUCCESS → pass=N, fail=0, pending=0", () => {
		expect(parseChecks([
			{ name: "a", state: "SUCCESS", completedAt: "2026-01-01T00:00:00Z" },
			{ name: "b", state: "SUCCESS", completedAt: "2026-01-01T00:00:00Z" },
		])).toEqual({ pass: 2, fail: 0, pending: 0 });
	});

	test("one FAILURE among successes → fail=1", () => {
		expect(parseChecks([
			{ name: "a", state: "SUCCESS", completedAt: "x" },
			{ name: "b", state: "FAILURE", completedAt: "y" },
		])).toEqual({ pass: 1, fail: 1, pending: 0 });
	});

	test("a running check (completedAt null) → pending=1", () => {
		expect(parseChecks([
			{ name: "a", state: "SUCCESS", completedAt: "x" },
			{ name: "running", state: "WAITING", completedAt: null },
		])).toEqual({ pass: 1, fail: 0, pending: 1 });
	});

	test("SKIPPED counts as pass (not pending, not fail)", () => {
		expect(parseChecks([{ name: "sk", state: "SKIPPED", completedAt: "x" }])).toEqual({ pass: 1, fail: 0, pending: 0 });
	});

	test("CANCELLED/TIMED_OUT/ACTION_REQUIRED count as fail", () => {
		expect(parseChecks([
			{ name: "c", state: "CANCELLED", completedAt: "x" },
			{ name: "t", state: "TIMED_OUT", completedAt: "x" },
			{ name: "a", state: "ACTION_REQUIRED", completedAt: "x" },
		]).fail).toBe(3);
	});

	test("empty checks → all zero", () => {
		expect(parseChecks([])).toEqual({ pass: 0, fail: 0, pending: 0 });
	});

	test("a running state with a STALE non-null completedAt → pending, not pass (re-run race)", () => {
		// gh can carry a prior run's completedAt while a new run is WAITING/IN_PROGRESS;
		// classifying by completedAt would wrongly count it pass, starving the wait branch
		// and producing a false "all green / BLOCKED" result.
		expect(parseChecks([
			{ name: "a", state: "SUCCESS", completedAt: "2026-01-01T00:00:00Z" },
			{ name: "rerun", state: "WAITING", completedAt: "2026-01-01T00:00:00Z" },
		])).toEqual({ pass: 1, fail: 0, pending: 1 });
	});

	test("an unknown state defaults to pending (never claim success)", () => {
		expect(parseChecks([{ name: "x", state: "WAT", completedAt: "z" }]))
			.toEqual({ pass: 0, fail: 0, pending: 1 });
	});
});

describe("createGhClient (glue)", () => {
	/** spawn that records every call + returns canned results by match. */
	function rec(responses: Array<{ match: (cmd: string, args: string[]) => boolean; result: SpawnResult }>) {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const fn: SpawnFn = async (cmd, args) => {
			calls.push({ cmd, args });
			return responses.find((r) => r.match(cmd, args))?.result ?? { stdout: "", stderr: "", exitCode: 0 };
		};
		return { fn, calls };
	}

	test("prStatus parses view + checks JSON into the domain shape", async () => {
		const { fn, calls } = rec([
			{ match: (c, a) => c === "gh" && a.includes("view"), result: { stdout: JSON.stringify({ state: "OPEN", mergeStateStatus: "CLEAN", mergeCommit: null }), stderr: "", exitCode: 0 } },
			{ match: (c, a) => c === "gh" && a.includes("checks"), result: { stdout: JSON.stringify([{ name: "a", state: "SUCCESS", completedAt: "x" }]), stderr: "", exitCode: 0 } },
		]);
		const status = await createGhClient(fn).prStatus(1);
		expect(status).toEqual({ state: "OPEN", mergeState: "CLEAN", mergeSha: undefined, checks: { pass: 1, fail: 0, pending: 0 } });
		expect(calls.map((c) => c.args[1])).toEqual(["view", "checks"]); // two gh calls
	});

	test("enableAutoMerge builds the --<strategy> --auto [--delete-branch] args", async () => {
		const { fn, calls } = rec([]);
		await createGhClient(fn).enableAutoMerge(9, "rebase", true);
		expect(calls[0]).toEqual({ cmd: "gh", args: ["pr", "merge", "9", "--rebase", "--auto", "--delete-branch"] });
	});

	test("enableAutoMerge omits --delete-branch when false", async () => {
		const { fn, calls } = rec([]);
		await createGhClient(fn).enableAutoMerge(9, "squash", false);
		expect(calls[0].args).toEqual(["pr", "merge", "9", "--squash", "--auto"]);
	});

	test("rebaseAndForcePush runs fetch → autoStash-rebase → force-push", async () => {
		const { fn, calls } = rec([]);
		await createGhClient(fn).rebaseAndForcePush("feat-x");
		expect(calls).toEqual([
			{ cmd: "git", args: ["fetch", "origin", "main"] },
			{ cmd: "git", args: ["-c", "rebase.autoStash=true", "rebase", "origin/main"] },
			{ cmd: "git", args: ["push", "--force-with-lease", "origin", "feat-x"] },
		]);
	});

	test("rebaseAndForcePush THROWS on a failed rebase (dirty tree/conflict), aborts, and does NOT force-push", async () => {
		// RCA #1009: a dirty working tree makes `git rebase` exit non-zero. The
		// fix checks the exit code, aborts the (possibly mid-flight) rebase, and
		// throws — never silently force-pushing an un-rebased branch.
		const { fn, calls } = rec([
			{ match: (c, a) => c === "git" && a.includes("rebase") && !a.includes("--abort"),
				result: { stdout: "", stderr: "cannot rebase: you have unstaged changes", exitCode: 1 } },
		]);
		await expect(createGhClient(fn).rebaseAndForcePush("feat-x")).rejects.toThrow(/rebase origin\/main failed/);
		// cleaned up the mid-rebase state
		expect(calls.some((c) => c.cmd === "git" && c.args.includes("--abort"))).toBe(true);
		// did NOT force-push a broken (un-rebased) state
		expect(calls.some((c) => c.args.includes("--force-with-lease"))).toBe(false);
	});

	test("rebaseAndForcePush THROWS on a failed force-push", async () => {
		const { fn } = rec([
			{ match: (c, a) => c === "git" && a.includes("--force-with-lease"),
				result: { stdout: "", stderr: "non-fast-forward (lease denied)", exitCode: 1 } },
		]);
		await expect(createGhClient(fn).rebaseAndForcePush("feat-x")).rejects.toThrow(/force-with-lease.*failed/);
	});
});

describe("parseBranchVv", () => {
	test("extracts name + gone marker, skips detached HEAD", () => {
		const out = parseBranchVv([
			"* main                abc [origin/main] x",
			"  feat/gone           def [origin/feat/gone: gone] y",
			"+ wt                  ghi [origin/wt] z",
			"  (HEAD detached at 0000)",
		].join("\n"));
		expect(out).toEqual([
			{ name: "main", goneRemote: false },
			{ name: "feat/gone", goneRemote: true },
			{ name: "wt", goneRemote: false },
		]);
	});

	test("empty/malformed → []", () => {
		expect(parseBranchVv("")).toEqual([]);
	});
});

describe("parseRemoteBranches", () => {
	test("strips origin/, drops HEAD -> line", () => {
		expect(parseRemoteBranches(["  origin/HEAD -> origin/main", "  origin/main", "  origin/feat/x"].join("\n"))).toEqual([
			"main",
			"feat/x",
		]);
	});

	test("empty → []", () => {
		expect(parseRemoteBranches("")).toEqual([]);
	});
});

describe("parseWorktrees", () => {
	test("extracts branch refs/heads/<name>, ignores detached", () => {
		const out = parseWorktrees([
			"worktree /a",
			"HEAD abc",
			"branch refs/heads/feat/x",
			"",
			"worktree /b",
			"HEAD def",
			"detached",
		].join("\n"));
		expect(out).toEqual(["feat/x"]);
	});

	test("empty → []", () => {
		expect(parseWorktrees("")).toEqual([]);
	});
});

describe("parseMergedPrs", () => {
	test("maps headRefName → number", () => {
		const m = parseMergedPrs([{ headRefName: "feat/a", number: 10 }, { headRefName: "feat/b", number: 11 }]);
		expect(m.get("feat/a")).toBe(10);
		expect(m.get("feat/b")).toBe(11);
		expect(m.size).toBe(2);
	});

	test("non-array → empty map (defensive)", () => {
		expect(parseMergedPrs(null).size).toBe(0);
	});

	test("rows missing fields are skipped", () => {
		const m = parseMergedPrs([{ headRefName: "x" }, { number: 9 }, { headRefName: "y", number: 2 }]);
		expect(m.size).toBe(1);
		expect(m.get("y")).toBe(2);
	});
});

describe("parseOpenPrRefs", () => {
	test("collects headRefName set", () => {
		expect(parseOpenPrRefs([{ headRefName: "a" }, { headRefName: "b" }, { headRefName: "a" }])).toEqual(
			new Set(["a", "b"]),
		);
	});

	test("non-array → empty set", () => {
		expect(parseOpenPrRefs("nope").size).toBe(0);
	});
});

describe("parseContained", () => {
	test("collects merged branch names, skips detached", () => {
		expect(parseContained(["  feat/old", "* main", "  (HEAD detached)"].join("\n"))).toEqual(
			new Set(["feat/old", "main"]),
		);
	});
});

describe("createBranchClient (glue)", () => {
	/** spawn that records every call + returns canned results by match. */
	function rec(responses: Array<{ match: (cmd: string, args: string[]) => boolean; result: SpawnResult }>) {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const fn: SpawnFn = async (cmd, args) => {
			calls.push({ cmd, args });
			return responses.find((r) => r.match(cmd, args))?.result ?? { stdout: "", stderr: "", exitCode: 0 };
		};
		return { fn, calls };
	}

	test("mergedPrRefs issues gh pr list --state merged --limit N", async () => {
		const { fn, calls } = rec([
			{ match: (c, a) => c === "gh" && a.includes("merged"), result: { stdout: JSON.stringify([{ headRefName: "x", number: 7 }]), stderr: "", exitCode: 0 } },
		]);
		const m = await createBranchClient(fn).mergedPrRefs(50);
		expect(m.get("x")).toBe(7);
		expect(calls[0].args).toContain("--limit");
		expect(calls[0].args[calls[0].args.indexOf("--limit") + 1]).toBe("50");
	});

	test("openPrRefs issues gh pr list --state open", async () => {
		const { fn, calls } = rec([
			{ match: (c, a) => c === "gh" && a.includes("open"), result: { stdout: JSON.stringify([{ headRefName: "o" }]), stderr: "", exitCode: 0 } },
		]);
		const s = await createBranchClient(fn).openPrRefs();
		expect(s.has("o")).toBe(true);
		expect(calls[0].args).toContain("open");
	});

	test("branchVv issues git branch -vv", async () => {
		const { fn, calls } = rec([
			{ match: (c, a) => c === "git" && a.includes("-vv"), result: { stdout: "  x abc [origin/x]\n  y def [origin/y: gone]\n", stderr: "", exitCode: 0 } },
		]);
		expect(await createBranchClient(fn).branchVv()).toEqual([
			{ name: "x", goneRemote: false },
			{ name: "y", goneRemote: true },
		]);
		expect(calls[0].args).toEqual(["branch", "-vv"]);
	});

	test("remoteBranches issues git branch -r", async () => {
		const { fn } = rec([
			{ match: (c, a) => c === "git" && a.includes("-r"), result: { stdout: "  origin/HEAD -> origin/main\n  origin/main\n", stderr: "", exitCode: 0 } },
		]);
		expect(await createBranchClient(fn).remoteBranches()).toEqual(["main"]);
	});

	test("worktrees issues git worktree list --porcelain", async () => {
		const { fn, calls } = rec([
			{ match: (c, a) => c === "git" && a.includes("worktree"), result: { stdout: "worktree /a\nbranch refs/heads/feat/x\n", stderr: "", exitCode: 0 } },
		]);
		expect(await createBranchClient(fn).worktrees()).toEqual(["feat/x"]);
		expect(calls[0].args).toEqual(["worktree", "list", "--porcelain"]);
	});

	test("containedBranches issues git branch --merged <default>", async () => {
		const { fn, calls } = rec([
			{ match: (c, a) => c === "git" && a.includes("--merged"), result: { stdout: "  feat/old\n* main\n", stderr: "", exitCode: 0 } },
		]);
		expect(await createBranchClient(fn).containedBranches("main")).toEqual(new Set(["feat/old", "main"]));
		expect(calls[0].args).toEqual(["branch", "--merged", "main"]);
	});

	test("defaultBranch parses symbolic-ref origin/HEAD", async () => {
		const { fn } = rec([
			{ match: (c, a) => c === "git" && a.includes("symbolic-ref"), result: { stdout: "refs/remotes/origin/main\n", stderr: "", exitCode: 0 } },
		]);
		expect(await createBranchClient(fn).defaultBranch()).toBe("main");
	});

	test("defaultBranch returns undefined when origin/HEAD unset (best-effort)", async () => {
		const { fn } = rec([]);
		expect(await createBranchClient(fn).defaultBranch()).toBeUndefined();
	});

	test("fetchPrune issues git fetch --prune", async () => {
		const { fn, calls } = rec([]);
		await createBranchClient(fn).fetchPrune();
		expect(calls[0]).toEqual({ cmd: "git", args: ["fetch", "--prune"] });
	});

	test("currentBranch issues git rev-parse --abbrev-ref HEAD", async () => {
		const { fn } = rec([
			{ match: (c, a) => c === "git" && a.includes("rev-parse"), result: { stdout: "feat/cur\n", stderr: "", exitCode: 0 } },
		]);
		expect(await createBranchClient(fn).currentBranch()).toBe("feat/cur");
	});

	test("deleteLocalBranch issues git branch -D <name>", async () => {
		const { fn, calls } = rec([]);
		await createBranchClient(fn).deleteLocalBranch("feat/x");
		expect(calls[0]).toEqual({ cmd: "git", args: ["branch", "-D", "feat/x"] });
	});

	test("deleteRemoteBranch issues git push origin --delete <name>", async () => {
		const { fn, calls } = rec([]);
		await createBranchClient(fn).deleteRemoteBranch("feat/x");
		expect(calls[0]).toEqual({ cmd: "git", args: ["push", "origin", "--delete", "feat/x"] });
	});
});
