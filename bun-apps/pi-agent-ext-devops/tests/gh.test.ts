/**
 * Tests for the gh-CLI output parsers (pure functions) + the GhClient glue.
 * Parsers turn structured `gh ... --json` into our domain types — robust, no
 * `grep -c` footguns. The GhClient is tested with a recording fake spawn.
 */
import { test, expect, describe } from "bun:test";
import { parsePrView, parseChecks, createGhClient, type SpawnFn, type SpawnResult } from "../src/gh.js";

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

	test("rebaseAndForcePush runs fetch → rebase → force-push", async () => {
		const { fn, calls } = rec([]);
		await createGhClient(fn).rebaseAndForcePush("feat-x");
		expect(calls).toEqual([
			{ cmd: "git", args: ["fetch", "origin", "main"] },
			{ cmd: "git", args: ["rebase", "origin/main"] },
			{ cmd: "git", args: ["push", "--force-with-lease", "origin", "feat-x"] },
		]);
	});
});
