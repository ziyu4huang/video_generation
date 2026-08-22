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
	parsePrList,
	parseContained,
	parseDirtyPaths,
	parseSubmoduleStatus,
	createBranchClient,
	type SpawnFn,
	type SpawnResult,
} from "../src/gh.js";

describe("parsePrView", () => {
	test("MERGED with mergeCommit + base/head refs → full domain shape", () => {
		const r = parsePrView({ state: "MERGED", mergeStateStatus: "CLEAN", mergeCommit: { oid: "abc123" }, baseRefName: "main", headRefName: "feat-a" });
		expect(r).toEqual({ state: "MERGED", mergeState: "CLEAN", mergeSha: "abc123", baseRefName: "main", headRefName: "feat-a" });
	});

	test("OPEN + BEHIND carries base/head refs", () => {
		expect(parsePrView({ state: "OPEN", mergeStateStatus: "BEHIND", mergeCommit: null, baseRefName: "main", headRefName: "feat-b" })).toEqual({
			state: "OPEN",
			mergeState: "BEHIND",
			mergeSha: undefined,
			baseRefName: "main",
			headRefName: "feat-b",
		});
	});

	test("unknown mergeStateStatus → UNKNOWN (defensive)", () => {
		expect(parsePrView({ state: "OPEN", mergeStateStatus: "SOMETHING_NEW" }).mergeState).toBe("UNKNOWN");
	});

	test("missing base/head refs → empty strings (defensive)", () => {
		expect(parsePrView({ state: "OPEN", mergeStateStatus: "CLEAN" })).toMatchObject({ baseRefName: "", headRefName: "" });
	});

	test("malformed/empty input → OPEN/UNKNOWN defaults + empty refs", () => {
		expect(parsePrView(null)).toEqual({ state: "OPEN", mergeState: "UNKNOWN", mergeSha: undefined, baseRefName: "", headRefName: "" });
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

	test("prStatus parses view + checks JSON into the domain shape (incl. base/head refs)", async () => {
		const { fn, calls } = rec([
			{ match: (c, a) => c === "gh" && a.includes("view"), result: { stdout: JSON.stringify({ state: "OPEN", mergeStateStatus: "CLEAN", mergeCommit: null, baseRefName: "main", headRefName: "feat-x" }), stderr: "", exitCode: 0 } },
			{ match: (c, a) => c === "gh" && a.includes("checks"), result: { stdout: JSON.stringify([{ name: "a", state: "SUCCESS", completedAt: "x" }]), stderr: "", exitCode: 0 } },
		]);
		const status = await createGhClient(fn).prStatus(1);
		expect(status).toEqual({ state: "OPEN", mergeState: "CLEAN", mergeSha: undefined, baseRefName: "main", headRefName: "feat-x", checks: { pass: 1, fail: 0, pending: 0 } });
		expect(calls.map((c) => c.args[1])).toEqual(["view", "checks"]); // two gh calls
		// the view call now requests baseRefName,headRefName alongside state/mergeStateStatus/mergeCommit
		const viewCall = calls.find((c) => c.args[1] === "view");
		expect(viewCall?.args.join(" ")).toContain("baseRefName,headRefName");
	});

	test("mergeNow builds the --<strategy> [--delete-branch] args (NO --auto)", async () => {
		const { fn, calls } = rec([]);
		await createGhClient(fn).mergeNow(9, "squash", true);
		expect(calls[0]).toEqual({ cmd: "gh", args: ["pr", "merge", "9", "--squash", "--delete-branch"] });
	});

	test("prList issues gh pr list --state <s> --json number,headRefName,mergedAt --limit N", async () => {
		const { fn, calls } = rec([
			{
				match: (c, a) => c === "gh" && a.includes("list"),
				result: { stdout: JSON.stringify([{ number: 7, headRefName: "feat/x", mergedAt: "2026-01-01T00:00:00Z" }]), stderr: "", exitCode: 0 },
			},
		]);
		const rows = await createGhClient(fn).prList("merged", 50);
		expect(rows).toEqual([{ number: 7, headRefName: "feat/x", mergedAt: "2026-01-01T00:00:00Z" }]);
		expect(calls[0]).toEqual({ cmd: "gh", args: ["pr", "list", "--state", "merged", "--json", "number,headRefName,mergedAt", "--limit", "50"] });
	});

	test("prList defaults --limit 200 for open state", async () => {
		const { fn, calls } = rec([]);
		await createGhClient(fn).prList("open");
		expect(calls[0].args[calls[0].args.indexOf("--limit") + 1]).toBe("200");
		expect(calls[0].args).toContain("open");
	});

	test("mergeNow omits --delete-branch when false + never adds --auto", async () => {
		const { fn, calls } = rec([]);
		await createGhClient(fn).mergeNow(9, "rebase", false);
		expect(calls[0].args).toEqual(["pr", "merge", "9", "--rebase"]);
		expect(calls[0].args.includes("--auto")).toBe(false);
	});

	test("mergeNow THROWS on a non-zero exit (surfaces as a recipe block)", async () => {
		const { fn } = rec([
			{ match: (c, a) => c === "gh" && a.includes("merge"), result: { stdout: "", stderr: "merge queue: not your turn", exitCode: 2 } },
		]);
		await expect(createGhClient(fn).mergeNow(9, "squash", true)).rejects.toThrow(/gh pr merge 9 .* failed .*2/);
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

	test("non-origin remote: keeps <remote>/* branches, drops other remotes'", () => {
		const out = ["  origin/main", "  upstream/main", "  upstream/feat/x", "  fork/other"].join("\n");
		// The scoping that matters: under a non-origin remote the DEFAULT call
		// silently saw nothing (regression guard for the sweep silent-drop bug).
		expect(parseRemoteBranches(out)).toEqual(["main"]);
		expect(parseRemoteBranches(out, "upstream")).toEqual(["main", "feat/x"]);
	});

	test("dotted remote names are escaped, not treated as regex wildcards", () => {
		const out = ["  my.git.remote/main", "  myXgitXremote/trap"].join("\n");
		expect(parseRemoteBranches(out, "my.git.remote")).toEqual(["main"]);
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

describe("parsePrList (forge/gh-cli — supersedes parseMergedPrs/parseOpenPrRefs)", () => {
	test("rows carry number + headRefName + mergedAt when present", () => {
		const rows = parsePrList([
			{ headRefName: "feat/a", number: 10, mergedAt: "2026-01-01T00:00:00Z" },
			{ headRefName: "feat/b", number: 11 },
		]);
		expect(rows).toEqual([
			{ number: 10, headRefName: "feat/a", mergedAt: "2026-01-01T00:00:00Z" },
			{ number: 11, headRefName: "feat/b", mergedAt: undefined },
		]);
	});

	test("non-array → empty list (defensive)", () => {
		expect(parsePrList(null)).toEqual([]);
		expect(parsePrList("nope")).toEqual([]);
	});

	test("rows missing number/headRefName are skipped", () => {
		const rows = parsePrList([{ headRefName: "x" }, { number: 9 }, { headRefName: "y", number: 2 }]);
		expect(rows).toEqual([{ number: 2, headRefName: "y", mergedAt: undefined }]);
	});
});

describe("parseContained", () => {
	test("collects merged branch names, skips detached", () => {
		expect(parseContained(["  feat/old", "* main", "  (HEAD detached)"].join("\n"))).toEqual(
			new Set(["feat/old", "main"]),
		);
	});
});

describe("parseDirtyPaths", () => {
	test("parses modified/added/deleted tracked paths, repo-relative", () => {
		const out = parseDirtyPaths(" M .agents/memory/MEMORY.md\nA  src/new.ts\nD  gone.md\n");
		expect(out).toEqual([".agents/memory/MEMORY.md", "src/new.ts", "gone.md"]);
	});

	test("EXCLUDES untracked (??) and ignored (!!)", () => {
		const out = parseDirtyPaths(" M a.txt\n?? untracked.txt\n!! ignored.log\n");
		expect(out).toEqual(["a.txt"]);
	});

	test("rename R/C keeps the POST-rename destination path", () => {
		const out = parseDirtyPaths("R  old.txt -> renamed.ts\nC  copy.ts -> copy2.ts\n");
		expect(out).toEqual(["renamed.ts", "copy2.ts"]);
	});

	test("strips core.quotePath quoting on tracked paths", () => {
		const out = parseDirtyPaths(' M "src/weird \"name\".txt"\n');
		expect(out).toEqual(['src/weird "name".txt']);
	});

	test("empty / short lines → empty array (never throws)", () => {
		expect(parseDirtyPaths("")).toEqual([]);
		expect(parseDirtyPaths("\n\n")).toEqual([]);
		expect(parseDirtyPaths("ab\n")).toEqual([]); // 2-char line (< 3) skipped
	});
});

describe("parseSubmoduleStatus", () => {
	const sha = (c: string) => c.repeat(40);

	test("all four flags parse verbatim: ' ' (in-sync), '+' (drifted), '-' (not initialized), 'U' (conflict)", () => {
		const rows = parseSubmoduleStatus(` ${sha("a")} sub-a\n+${sha("b")} sub-b\n-${sha("c")} sub-c\nU${sha("d")} sub-d\n`);
		expect(rows).toEqual([
			{ flag: " ", sha: sha("a"), path: "sub-a" },
			{ flag: "+", sha: sha("b"), path: "sub-b" },
			{ flag: "-", sha: sha("c"), path: "sub-c" },
			{ flag: "U", sha: sha("d"), path: "sub-d" },
		]);
	});

	test("shell-quoted paths are unquoted + unescaped", () => {
		const rows = parseSubmoduleStatus(`+${sha("a")} "weird \\"path\\" x"`);
		expect(rows).toEqual([{ flag: "+", sha: sha("a"), path: 'weird "path" x' }]);
	});

	test("CRLF line endings: one row per line, no phantom rows", () => {
		const rows = parseSubmoduleStatus(` ${sha("a")} sub-a\r\n+${sha("b")} sub-b\r\n`);
		expect(rows).toEqual([
			{ flag: " ", sha: sha("a"), path: "sub-a" },
			{ flag: "+", sha: sha("b"), path: "sub-b" },
		]);
	});

	test("garbage / blank lines are skipped defensively", () => {
		expect(parseSubmoduleStatus("noise\n\nnot-a-status-line\n")).toEqual([]);
		expect(parseSubmoduleStatus("")).toEqual([]);
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

	test("mergedPrRefs/openPrRefs are GONE from BranchClient (moved to ForgeClient.prList)", () => {
		const client = createBranchClient(rec([]).fn) as unknown as Record<string, unknown>;
		expect("mergedPrRefs" in client).toBe(false);
		expect("openPrRefs" in client).toBe(false);
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

	test("deleteLocalBranch THROWS on a non-zero exit (surfaces stderr)", async () => {
		const { fn } = rec([
			{ match: (c, a) => c === "git" && a.includes("-D"), result: { stdout: "", stderr: "branch not found", exitCode: 1 } },
		]);
		await expect(createBranchClient(fn).deleteLocalBranch("feat/x")).rejects.toThrow(/git branch -D feat\/x failed .*1.*branch not found/);
	});

	test("deleteRemoteBranch issues git push origin --delete <name>", async () => {
		const { fn, calls } = rec([]);
		await createBranchClient(fn).deleteRemoteBranch("feat/x");
		expect(calls[0]).toEqual({ cmd: "git", args: ["push", "origin", "--delete", "feat/x"] });
	});

	test("deleteRemoteBranch THROWS on a non-zero exit (surfaces stderr)", async () => {
		const { fn } = rec([
			{ match: (c, a) => c === "git" && a.includes("--delete"), result: { stdout: "", stderr: "remote rejected", exitCode: 1 } },
		]);
		await expect(createBranchClient(fn).deleteRemoteBranch("feat/x")).rejects.toThrow(/git push origin --delete feat\/x failed .*1.*remote rejected/);
	});

	test("remoteName scoping: defaultBranch/deleteRemoteBranch follow a non-origin remote", async () => {
		const { fn, calls } = rec([
			{ match: (c, a) => c === "git" && a.includes("symbolic-ref"), result: { stdout: "refs/remotes/upstream/main\n", stderr: "", exitCode: 0 } },
			{ match: (c, a) => c === "git" && a.includes("--delete"), result: { stdout: "", stderr: "", exitCode: 0 } },
		]);
		const client = createBranchClient(fn, "upstream");
		expect(await client.defaultBranch()).toBe("main");
		await client.deleteRemoteBranch("feat/x");
		expect(calls[0].args).toEqual(["symbolic-ref", "refs/remotes/upstream/HEAD"]);
		expect(calls[1].args).toEqual(["push", "upstream", "--delete", "feat/x"]);
	});

	test("remoteName scoping: deleteRemoteBranch error names the configured remote", async () => {
		const { fn } = rec([
			{ match: (c, a) => c === "git" && a.includes("--delete"), result: { stdout: "", stderr: "remote rejected", exitCode: 1 } },
		]);
		await expect(createBranchClient(fn, "upstream").deleteRemoteBranch("feat/x")).rejects.toThrow(
			/git push upstream --delete feat\/x failed/,
		);
	});

	test("dirtyPaths issues git -C <dir> status --porcelain=v1", async () => {
		const { fn, calls } = rec([
			{ match: (c, a) => c === "git" && a.includes("status"), result: { stdout: " M .agents/memory/MEMORY.md\n?? skip.txt\n", stderr: "", exitCode: 0 } },
		]);
		expect(await createBranchClient(fn).dirtyPaths("/repo-wt")).toEqual([".agents/memory/MEMORY.md"]);
		expect(calls[0]).toEqual({ cmd: "git", args: ["-C", "/repo-wt", "status", "--porcelain=v1"] });
	});

	test("unmergedPaths issues git -C <dir> ls-files -u; dedupes per-stage rows; [] on failure", async () => {
		const { fn, calls } = rec([
			{
				match: (c, a) => c === "git" && a.includes("ls-files"),
				// one conflicted path, TWO stages (base + theirs) → deduped to one
				result: {
					stdout: "100644 616e2b4b375d47d0a5f6c11f4e2b6421 1\t.agents/memory/MEMORY.md\n100644 8a5f0e13d9c7f2b4a1c6e3d2f9b8a7c6 3\t.agents/memory/MEMORY.md\n",
					stderr: "",
					exitCode: 0,
				},
			},
		]);
		expect(await createBranchClient(fn).unmergedPaths("/repo-wt")).toEqual([".agents/memory/MEMORY.md"]);
		expect(calls[0]).toEqual({ cmd: "git", args: ["-C", "/repo-wt", "ls-files", "-u"] });
		// non-zero exit (not a repo, etc.) → [] (never throws; sync treats as clean).
		const { fn: fn2 } = rec([{ match: (c, a) => c === "git" && a.includes("ls-files"), result: { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 } }]);
		expect(await createBranchClient(fn2).unmergedPaths("/repo-wt")).toEqual([]);
	});

	test("isClean stays available on the full BranchClient (true on exit 0)", async () => {
		const { fn } = rec([{ match: (c, a) => c === "git" && a.includes("diff"), result: { stdout: "", stderr: "", exitCode: 0 } }]);
		expect(await createBranchClient(fn).isClean("/repo-wt")).toBe(true);
	});
});
