/**
 * Tests for runMergeRecipe — the LOCAL-CI-GATED merge behind `await_pr_merge`.
 *
 * Style mirrors tests/ci-recipe.test.ts: a RECORDING fake `SpawnFn` returns
 * canned results by match + records every call, so the whole flow runs with NO
 * real shell / git / filesystem. The `GhClient` is a scripted fake too (prStatus
 * returns a canned status sequence; mergeNow records its args). The recipe
 * forwards an injected `detectChangedPackages` into runLocalCi, so the fakes
 * shape detection WITHOUT touching package.json — either an empty detected map
 * (green) or a detection throw (red) — exactly the seams this recipe owns.
 *
 * Change-package detection (formerly scripts/ci-changed-packages.sh) is now
 * extension-native TS (src/changed-packages.ts); these recipe tests inject it
 * and assert the recipe's gating CONSEQUENCES (green→merge, detection-error→
 * block), not detection internals.
 */
import { test, expect, describe } from "bun:test";
import { runMergeRecipe, type GhClient } from "../src/recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";
import type { ComputeChangedPackagesOptions, ChangedPackagesMap } from "../src/changed-packages.js";

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
 *  gates pass, schema-cost ok) needs NO explicit responses. */
function mkSpawn(responses: Array<{ match: (cmd: string, args: string[], cwd: string) => boolean; result: SpawnResult }>) {
	const calls: Rec[] = [];
	const fn: SpawnFn = async (cmd, args, options) => {
		const cwd = options?.cwd ?? "";
		calls.push({ cmd, args, cwd });
		return responses.find((r) => r.match(cmd, args, cwd))?.result ?? { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

/**
 * Recording detect fn: returns a fixed map (default {} → no packages → green)
 * and records the opts it was called with. `throws` simulates a detection
 * I/O failure (→ detectionError → overall fail → block).
 */
function mkDetect(map: ChangedPackagesMap = {}, throws = false) {
	const calls: ComputeChangedPackagesOptions[] = [];
	const fn = async (opts: ComputeChangedPackagesOptions): Promise<ChangedPackagesMap> => {
		calls.push(opts);
		if (throws) throw new Error("detection I/O failure");
		return { ...map };
	};
	return { fn, calls };
}

/**
 * The gate list local_ci derives from the workflow. Injected here so the recipe
 * stays filesystem-free: the REAL reader parses the repo's workflow, and against
 * this fake REPO path it would fail closed (gateError) and block every merge.
 */
const GATE_RUN = "bash scripts/ci-file-size-guard.sh";
const fakeGates = async () => ({ gates: [{ name: "File-size guard (2 MB, blocks)", cwd: ".", run: GATE_RUN }] });

/** a gate that FAILS → overall fail (no packages needed). */
const gateFail = () => ({
	match: (c: string, a: string[]) => c === "bash" && a[0] === "-c" && a[1] === GATE_RUN,
	result: { stdout: "", stderr: "fail", exitCode: 1 },
});
/** `git fetch` that FAILS (offline) — recipe must ignore the exit code. */
const fetchFail = () => ({
	match: (c: string, a: string[]) => c === "git" && a[0] === "fetch",
	result: { stdout: "", stderr: "offline", exitCode: 1 },
});

function baseOpts(gh: GhClient, fn: SpawnFn, detect?: { fn: (o: ComputeChangedPackagesOptions) => Promise<ChangedPackagesMap> }) {
	return {
		prNumber: 42,
		strategy: "squash" as const,
		deleteBranch: true,
		gh,
		spawn: fn,
		repoRoot: REPO,
		readGates: fakeGates,
		...(detect ? { detectChangedPackages: detect.fn } : {}),
	};
}

/** Did the recipe attempt the best-effort fetch? */
const ranFetch = (calls: Rec[]) => calls.some((c) => c.cmd === "git" && c.args[0] === "fetch");

describe("runMergeRecipe — the 8 gates", () => {
	test("1. GREEN (CLEAN + ci pass) → mergeNow called once (--squash), merged:true, localCi attached", async () => {
		const { client, calls } = fakeGh([
			{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" },
			{ state: "MERGED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x", mergeSha: "abc123def" },
		]);
		const detect = mkDetect({}); // {} → no packages → gates pass → green
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(r.merged).toBe(true);
		expect(r.finalState).toBe("MERGED");
		expect(r.mergeSha).toBe("abc123def"); // follow-up prStatus populated it
		expect(r.localCi?.overall).toBe("pass");
		expect(calls.mergeNow).toHaveLength(1);
		expect(calls.mergeNow[0]).toMatchObject({ n: 42, strategy: "squash", deleteBranch: true });
	});

	test("2. RED (CLEAN + ci.overall=fail) → NO merge, merged:false, error, localCi attached", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const detect = mkDetect({});
		const { fn } = mkSpawn([gateFail()]); // a gate fails
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/local_ci failed/);
		expect(r.localCi?.overall).toBe("fail");
		expect(calls.mergeNow).toHaveLength(0);
	});

	test("3. DETECTION-ERROR (ci.overall=fail + detectionError) → NO merge, error mentions detection", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const detect = mkDetect({}, true); // detection THROWS → detectionError
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(r.merged).toBe(false);
		expect(r.localCi?.detectionError).toMatch(/detection failed/);
		expect(r.error).toMatch(/changed-packages/); // detectionError surfaces verbatim
		expect(calls.mergeNow).toHaveLength(0);
	});

	test("4. BEHIND (ci green but mergeState=BEHIND) → NO merge, behind error", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "BEHIND", baseRefName: "main", headRefName: "feat-x" }]);
		const detect = mkDetect({}); // ci green
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/behind base/i);
		expect(r.localCi?.overall).toBe("pass"); // gate ran + passed; the block is purely BEHIND
		expect(calls.mergeNow).toHaveLength(0);
	});

	test("5. NON-CLEAN (ci green, mergeState=DIRTY) → NO merge, block cites mergeState", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "DIRTY", baseRefName: "main", headRefName: "feat-x" }]);
		const detect = mkDetect({}); // ci green
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/mergeState=DIRTY/);
		expect(calls.mergeNow).toHaveLength(0);
	});

	test("6. ALREADY-MERGED (state=MERGED) → merged:true, NO ci run, NO merge call", async () => {
		const { client, calls } = fakeGh([{ state: "MERGED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x", mergeSha: "deadbeef" }]);
		const detect = mkDetect({});
		const { fn, calls: spawnCalls } = mkSpawn([]); // nothing should be spawned
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(r.merged).toBe(true);
		expect(r.finalState).toBe("MERGED");
		expect(r.mergeSha).toBe("deadbeef");
		expect(r.localCi).toBeUndefined(); // no gate run
		expect(calls.mergeNow).toHaveLength(0);
		expect(detect.calls.length).toBe(0); // short-circuited before any local_ci work
		expect(ranFetch(spawnCalls)).toBe(false);
	});

	test("7. CLOSED (state=CLOSED) → merged:false, error", async () => {
		const { client, calls } = fakeGh([{ state: "CLOSED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const detect = mkDetect({});
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(r.merged).toBe(false);
		expect(r.finalState).toBe("CLOSED");
		expect(r.error).toMatch(/CLOSED/);
		expect(calls.mergeNow).toHaveLength(0);
		expect(detect.calls.length).toBe(0);
	});

	test("8. FETCH-FAIL → block (fail-closed): fetch exits non-zero, detect errors → detectionError", async () => {
		// Models offline: fetch fails (ignored), local_ci still runs (fail-closed).
		// Detection THROWS (simulating an unrecoverable I/O failure during the
		// base..head diff) → detectionError → overall fail → block. The recipe must
		// NOT hard-fail on the fetch itself.
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const detect = mkDetect({}, true); // detection throws
		const { fn, calls: spawnCalls } = mkSpawn([fetchFail()]);
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(r.merged).toBe(false);
		expect(r.localCi?.detectionError).toBeDefined();
		expect(r.error).toMatch(/changed-packages/);
		expect(calls.mergeNow).toHaveLength(0);
		expect(ranFetch(spawnCalls)).toBe(true); // the fetch WAS attempted …
		expect(detect.calls.length).toBe(1); // … and local_ci still ran (fail-closed), not crashed
	});
});

describe("runMergeRecipe — robustness", () => {
	test("mergeNow THROWS (e.g. merge-queue rejection) → block outcome, not a crash", async () => {
		const { client, calls } = fakeGh(
			[{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }],
			{ mergeNowThrows: true },
		);
		const detect = mkDetect({});
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/gh pr merge failed/);
		expect(calls.mergeNow).toHaveLength(1); // attempted, then surfaced as a block
	});

	test("respects deleteBranch=false (passed through to mergeNow)", async () => {
		const { client, calls } = fakeGh([
			{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" },
			{ state: "MERGED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x", mergeSha: "z" },
		]);
		const detect = mkDetect({});
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe({ ...baseOpts(client, fn, detect), deleteBranch: false });
		expect(r.merged).toBe(true);
		expect(calls.mergeNow[0]).toMatchObject({ deleteBranch: false });
	});

	test("passes baseRef=origin/<base> + headRef=origin/<head> into local_ci detection", async () => {
		// PR's base/head names (from gh) become origin/<base> / origin/<head> in
		// the local_ci diff — pins the fetch-then-diff contract.
		const { client } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const detect = mkDetect({});
		const { fn } = mkSpawn([]);
		await runMergeRecipe(baseOpts(client, fn, detect));
		expect(detect.calls[0].baseRef).toBe("origin/main");
		expect(detect.calls[0].headRef).toBe("origin/feat-x");
	});

	test("outcome always carries elapsedMs", async () => {
		const { client } = fakeGh([{ state: "MERGED", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x", mergeSha: "x" }]);
		const detect = mkDetect({});
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe(baseOpts(client, fn, detect));
		expect(typeof r.elapsedMs).toBe("number");
		expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	test("already-aborted signal → block before any gh call", async () => {
		const ac = new AbortController();
		ac.abort();
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", baseRefName: "main", headRefName: "feat-x" }]);
		const detect = mkDetect({});
		const { fn } = mkSpawn([]);
		const r = await runMergeRecipe({ ...baseOpts(client, fn, detect), signal: ac.signal });
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/aborted/);
		expect(calls.prStatus).toHaveLength(0); // short-circuited before the first gh call
	});
});
