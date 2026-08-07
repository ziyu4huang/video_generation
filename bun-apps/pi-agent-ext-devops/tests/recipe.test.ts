/**
 * Tests for runMergeRecipe — the LOCAL-CI-GATED merge behind `await_pr_merge`.
 *
 * Style mirrors tests/ci-recipe.test.ts: a RECORDING fake `SpawnFn` returns
 * canned results by match + records every call, so the whole flow runs with NO
 * real shell / git / filesystem. The `GhClient` is a scripted fake too (prStatus
 * returns a canned status sequence; mergeNow records its args). The recipe does
 * NOT inject a readPkg into runLocalCi, so the fakes are shaped to AVOID
 * package.json reads — either an empty detected package set (green) or a gate
 * failure / detection error (red) — exactly the seams this recipe owns.
 */
import { test, expect, describe } from "bun:test";
import { runMergeRecipe, type GhClient } from "../src/recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const REPO = "/repo";

/** A scripted GhClient: prStatus returns statuses[min(i++, len-1)]; mergeNow
 *  records its args (and optionally throws). */
function fakeGh(
	statuses: Array<{
		state: "OPEN" | "MERGED" | "CLOSED";
		mergeState: string;
		baseRefName: string;
		headRefName: string;
		mergeSha?: string;
	}>,
	opts: { mergeNowThrows?: boolean } = {},
) {
	let i = 0;
	const calls = {
		prStatus: [] as number[],
		mergeNow: [] as Array<{ n: number; strategy: string; deleteBranch: boolean }>,
	};
	const client: GhClient = {
		async prStatus(n) {
			calls.prStatus.push(n);
			return statuses[Math.min(i++, statuses.length - 1)] as never;
		},
		async mergeNow(n, strategy, deleteBranch) {
			calls.mergeNow.push({ n, strategy, deleteBranch });
			if (opts.mergeNowThrows) throw new Error("merge method not allowed on this repo");
		},
	};
	return { client, calls };
}

interface Rec {
	cmd: string;
	args: string[];
	cwd: string;
}

/** Recording spawn: records {cmd,args,cwd} + returns canned results by match.
 *  Unmatched calls default to {exitCode:0} — so a green local_ci (verify ok,
 *  detect {}, gates pass, schema-cost ok) needs NO explicit responses. */
function mkSpawn(responses: Array<{ match: (cmd: string, args: string[], cwd: string) => boolean; result: SpawnResult }>) {
	const calls: Rec[] = [];
	const fn: SpawnFn = async (cmd, args, options) => {
		const cwd = options?.cwd ?? "";
		calls.push({ cmd, args, cwd });
		return responses.find((r) => r.match(cmd, args, cwd))?.result ?? { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

/** detection returning `{}` → no packages (skips per-package loop + readPkg). */
const detectEmpty = () => ({
	match: (c, a) => c === "bash" && a[0] === "scripts/ci-changed-packages.sh" && !a.includes("--all"),
	result: { stdout: "{}", stderr: "", exitCode: 0 },
});
/** detection that ERRORS (non-zero exit) → detectionError → overall fail. */
const detectError = (exit = 1) => ({
	match: (c, a) => c === "bash" && a[0] === "scripts/ci-changed-packages.sh" && !a.includes("--all"),
	result: { stdout: "", stderr: "boom", exitCode: exit },
});
/** a blocking gate that FAILS → overall fail (no packages needed). */
const gateFail = (file: string) => ({
	match: (_c, a) => a.includes(`scripts/${file}`),
	result: { stdout: "", stderr: "fail", exitCode: 1 },
});
/** `git fetch` that FAILS (offline) — recipe must ignore the exit code. */
const fetchFail = () => ({
	match: (c, a) => c === "git" && a[0] === "fetch",
	result: { stdout: "", stderr: "offline", exitCode: 1 },
});

function baseOpts(gh: GhClient, fn: SpawnFn) {
	return {
		prNumber: 42,
		strategy: "squash" as const,
		deleteBranch: true,
		gh,
		spawn: fn,
		repoRoot: REPO,
	};
}

/** Did the recipe run the local_ci detection step at all? */
const ranDetection = (calls: Rec[]) => calls.some((c) => c.args[0] === "scripts/ci-changed-packages.sh");
/** Did the recipe attempt the best-effort fetch? */
const ranFetch = (calls: Rec[]) => calls.some((c) => c.cmd === "git" && c.args[0] === "fetch");

describe("runMergeRecipe — the 8 gates", () => {
	test("1. GREEN (CLEAN + ci pass) → mergeNow called once (--squash), merged:true, localCi attached", async () => {
		const { client, calls } = fakeGh([
			{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" },
			{ state: "MERGED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x", mergeSha: "abc123def" },
		]);
		const { fn } = mkSpawn([detectEmpty()]); // detect {} → no packages → gates pass → green
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(r.merged).toBe(true);
		expect(r.finalState).toBe("MERGED");
		expect(r.mergeSha).toBe("abc123def"); // follow-up prStatus populated it
		expect(r.localCi?.overall).toBe("pass");
		expect(calls.mergeNow).toHaveLength(1);
		expect(calls.mergeNow[0]).toMatchObject({ n: 42, strategy: "squash", deleteBranch: true });
	});

	test("2. RED (CLEAN + ci.overall=fail) → NO merge, merged:false, error, localCi attached", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const { fn } = mkSpawn([detectEmpty(), gateFail("ci-file-size-guard.sh")]); // a blocking gate fails
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/local_ci failed/);
		expect(r.localCi?.overall).toBe("fail");
		expect(calls.mergeNow).toHaveLength(0);
	});

	test("3. DETECTION-ERROR (ci.overall=fail + detectionError) → NO merge, error mentions detection", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const { fn } = mkSpawn([detectError(1)]); // detection exits non-zero
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(r.merged).toBe(false);
		expect(r.localCi?.detectionError).toMatch(/exited 1/);
		expect(r.error).toMatch(/ci-changed-packages/); // detectionError surfaces verbatim
		expect(calls.mergeNow).toHaveLength(0);
	});

	test("4. BEHIND (ci green but mergeState=BEHIND) → NO merge, behind error", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "BEHIND", baseRefName: "main", headRefName: "feat-x" }]);
		const { fn } = mkSpawn([detectEmpty()]); // ci green
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/behind base/i);
		expect(r.localCi?.overall).toBe("pass"); // gate ran + passed; the block is purely BEHIND
		expect(calls.mergeNow).toHaveLength(0);
	});

	test("5. NON-CLEAN (ci green, mergeState=DIRTY) → NO merge, block cites mergeState", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "DIRTY", baseRefName: "main", headRefName: "feat-x" }]);
		const { fn } = mkSpawn([detectEmpty()]); // ci green
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/mergeState=DIRTY/);
		expect(calls.mergeNow).toHaveLength(0);
	});

	test("6. ALREADY-MERGED (state=MERGED) → merged:true, NO ci run, NO merge call", async () => {
		const { client, calls } = fakeGh([{ state: "MERGED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x", mergeSha: "deadbeef" }]);
		const { fn, calls: spawnCalls } = mkSpawn([]); // nothing should be spawned
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(r.merged).toBe(true);
		expect(r.finalState).toBe("MERGED");
		expect(r.mergeSha).toBe("deadbeef");
		expect(r.localCi).toBeUndefined(); // no gate run
		expect(calls.mergeNow).toHaveLength(0);
		expect(ranDetection(spawnCalls)).toBe(false); // short-circuited before any local_ci work
		expect(ranFetch(spawnCalls)).toBe(false);
	});

	test("7. CLOSED (state=CLOSED) → merged:false, error", async () => {
		const { client, calls } = fakeGh([{ state: "CLOSED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const { fn, calls: spawnCalls } = mkSpawn([]);
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(r.merged).toBe(false);
		expect(r.finalState).toBe("CLOSED");
		expect(r.error).toMatch(/CLOSED/);
		expect(calls.mergeNow).toHaveLength(0);
		expect(ranDetection(spawnCalls)).toBe(false);
	});

	test("8. FETCH-FAIL → block (fail-closed): fetch exits non-zero, detect errors → detectionError", async () => {
		// Models offline + origin/<head> missing: fetch fails (ignored), origin/main
		// resolves locally (verify defaults exit 0), but the base..head detection
		// diff errors → detectionError → overall fail → block. The recipe must NOT
		// hard-fail on the fetch itself.
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const { fn, calls: spawnCalls } = mkSpawn([fetchFail(), detectError(1)]);
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(r.merged).toBe(false);
		expect(r.localCi?.detectionError).toBeDefined();
		expect(r.error).toMatch(/ci-changed-packages/);
		expect(calls.mergeNow).toHaveLength(0);
		expect(ranFetch(spawnCalls)).toBe(true); // the fetch WAS attempted …
		expect(ranDetection(spawnCalls)).toBe(true); // … and local_ci still ran (fail-closed), not crashed
	});
});

describe("runMergeRecipe — robustness", () => {
	test("mergeNow THROWS (e.g. merge-queue rejection) → block outcome, not a crash", async () => {
		const { client, calls } = fakeGh(
			[{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }],
			{ mergeNowThrows: true },
		);
		const { fn } = mkSpawn([detectEmpty()]);
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/gh pr merge failed/);
		expect(calls.mergeNow).toHaveLength(1); // attempted, then surfaced as a block
	});

	test("respects deleteBranch=false (passed through to mergeNow)", async () => {
		const { client, calls } = fakeGh([
			{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" },
			{ state: "MERGED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x", mergeSha: "z" },
		]);
		const { fn } = mkSpawn([detectEmpty()]);
		const r = await runMergeRecipe({ ...baseOpts(client, fn), deleteBranch: false });
		expect(r.merged).toBe(true);
		expect(calls.mergeNow[0]).toMatchObject({ deleteBranch: false });
	});

	test("passes baseRef=origin/<base> + headRef=origin/<head> into local_ci detection", async () => {
		// PR's base/head names (from gh) become origin/<base> / origin/<head> in
		// the local_ci diff — pins the fetch-then-diff contract.
		const { client } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const { fn, calls: spawnCalls } = mkSpawn([detectEmpty()]);
		await runMergeRecipe(baseOpts(client, fn));
		const detect = spawnCalls.find((c) => c.args[0] === "scripts/ci-changed-packages.sh");
		expect(detect?.args).toContain("origin/main");
		expect(detect?.args).toContain("origin/feat-x");
	});

	test("outcome always carries elapsedMs", async () => {
		const { client } = fakeGh([{ state: "MERGED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x", mergeSha: "x" }]);
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe(baseOpts(client, fn));
		expect(typeof r.elapsedMs).toBe("number");
		expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	test("already-aborted signal → block before any gh call", async () => {
		const ac = new AbortController();
		ac.abort();
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const { fn } = mkSpawn([detectEmpty()]);
		const r = await runMergeRecipe({ ...baseOpts(client, fn), signal: ac.signal });
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/aborted/);
		expect(calls.prStatus).toHaveLength(0); // short-circuited before the first gh call
	});
});
