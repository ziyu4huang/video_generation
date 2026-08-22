/**
 * Tests for runVerifyMerge — the post-merge verification. Mirrors the dual-seam
 * style of recipe.test.ts (scripted `GhClient` fake) + sync-recipe.test.ts
 * (recording `SpawnFn` + minimal `Pick`-typed branch client). No real gh/git/fs.
 *
 * Coverage:
 *  (a) merged + all files in expectedScope → CLEAN;
 *  (b) merged + a file outside expectedScope → CONTAMINATED + outOfScope lists it;
 *  (c) not merged (state OPEN) → NOT-MERGED;
 *  (d) merged + no expectedScope → CLEAN (files reported, no scope check);
 *  (e) parseShowStat unit cases (numstat lines + summed counts);
 *  (f) branch-spent, incl. the squash case gh's headRefOid is needed for;
 *  (g) gh.prStatus throws → warnings + aborted.
 */
import { test, expect, describe } from "bun:test";
import { runVerifyMerge, parseShowStat, type VerifyMergeClient } from "../src/verify-merge-recipe.js";
import type { GhClient } from "../src/recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const REPO = "/repo";
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const sha = (c: string) => c.repeat(40);

/** Scripted GhClient. prStatus returns the canned snapshot (or throws). */
function fakeGh(
	status: {
		state: "OPEN" | "MERGED" | "CLOSED";
		mergeState?: string;
		baseRefName?: string;
		headRefName: string;
		mergeSha?: string;
		headRefOid?: string;
	},
	opts: { throws?: boolean } = {},
): GhClient {
	return {
		async prStatus() {
			if (opts.throws) throw new Error("gh pr view forced failure");
			return {
				state: status.state,
				mergeState: (status.mergeState ?? "CLEAN") as never,
				baseRefName: status.baseRefName ?? "main",
				headRefName: status.headRefName,
				mergeSha: status.mergeSha,
				headRefOid: status.headRefOid,
				checks: { pass: 0, fail: 0, pending: 0 },
			};
		},
		async mergeNow() {
			/* unused by verify-merge */
		},
		async prList() {
			return []; // unused by verify-merge
		},
	};
}

/** Minimal VerifyMergeClient fake. */
function fakeClient(s: {
	defaultBranch?: string;
	contained?: string[];
	revs?: Record<string, string>;
}): VerifyMergeClient {
	return {
		defaultBranch: async () => s.defaultBranch,
		containedBranches: async () => new Set(s.contained ?? []),
		revParse: async (rev: string) => s.revs?.[rev],
	};
}

/** Recording SpawnFn. Returns canned results by matching args (post `-C <dir>`). */
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

/** Canned `git show --numstat --format= <sha>` with two in-scope src/ files. */
const SHOW_IN_SCOPE: SpawnResult = {
	stdout: "8\t2\tsrc/a.ts\n5\t3\tsrc/b.ts\n",
	stderr: "",
	exitCode: 0,
};

/** Canned `git show --numstat` with one in-scope (src/) + one out-of-scope (docs/) file. */
const SHOW_DRIFT: SpawnResult = {
	stdout: "8\t2\tsrc/a.ts\n5\t3\tdocs/b.md\n",
	stderr: "",
	exitCode: 0,
};

/** Canned `git show --numstat` with an in-scope rename. git compacts against the
 *  common prefix, so `src/old.ts -> src/new.ts` renders as `src/{old.ts => new.ts}`
 *  (the NEW path stays under `src/` → should be CLEAN, not CONTAMINATED). */
const SHOW_RENAME_IN_SCOPE: SpawnResult = {
	stdout: "3\t2\tsrc/{old.ts => new.ts}\n",
	stderr: "",
	exitCode: 0,
};

/** Canned `git show --numstat` with a rename whose NEW path is OUT of scope.
 *  No common prefix, so git uses the plain `old => new` form. Verifies the
 *  rename fix doesn't over-correct. */
const SHOW_RENAME_OUT_OF_SCOPE: SpawnResult = {
	stdout: "3\t0\tsrc/a => other/b\n",
	stderr: "",
	exitCode: 0,
};

describe("runVerifyMerge — verdicts", () => {
	test("(a) merged + all files in expectedScope → CLEAN", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main", contained: [] });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_IN_SCOPE }]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42, expectedScope: ["src/"] });

		expect(out.merged).toBe(true);
		expect(out.verdict).toBe("CLEAN");
		expect(out.outOfScope).toEqual([]);
		expect(out.fileCount).toBe(2);
		expect(out.insertions).toBe(13);
		expect(out.deletions).toBe(5);
		expect(out.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(out.commands.some((c) => c.includes("show --numstat"))).toBe(true);
	});

	test("(b) merged + a file outside expectedScope → CONTAMINATED + outOfScope lists it", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_DRIFT }]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42, expectedScope: ["src/"] });

		expect(out.verdict).toBe("CONTAMINATED");
		expect(out.outOfScope.map((f) => f.path)).toEqual(["docs/b.md"]);
		expect(out.files.map((f) => f.path)).toEqual(["src/a.ts", "docs/b.md"]);
	});

	test("(c) not merged (state OPEN) → NOT-MERGED, no file inspection", async () => {
		const gh = fakeGh({ state: "OPEN", headRefName: "feat/x" });
		const client = fakeClient({ defaultBranch: "main" });
		const { fn, calls } = fakeSpawn();
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42, expectedScope: ["src/"] });

		expect(out.merged).toBe(false);
		expect(out.verdict).toBe("NOT-MERGED");
		expect(out.files).toEqual([]);
		// not merged → no `git show` issued.
		expect(calls.length).toBe(0);
		expect(out.commands).toEqual([]);
	});

	test("(d) merged + no expectedScope → CLEAN (files reported, no scope check)", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_DRIFT }]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42 });

		expect(out.verdict).toBe("CLEAN");
		expect(out.outOfScope).toEqual([]); // no scope → no outOfScope check
		expect(out.files.map((f) => f.path)).toEqual(["src/a.ts", "docs/b.md"]);
	});
});

describe("parseShowStat — unit (numstat)", () => {
	test("(e) parses paths + sums the per-file columns", () => {
		const parsed = parseShowStat(SHOW_IN_SCOPE.stdout);
		expect(parsed.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(parsed.files.every((f) => f.status === "M")).toBe(true); // best-effort default
		expect(parsed.fileCount).toBe(2);
		expect(parsed.insertions).toBe(13);
		expect(parsed.deletions).toBe(5);
	});

	test("parses an additions-only change", () => {
		const parsed = parseShowStat("5\t0\tnew.txt\n");
		expect(parsed.files.map((f) => f.path)).toEqual(["new.txt"]);
		expect(parsed.fileCount).toBe(1);
		expect(parsed.insertions).toBe(5);
		expect(parsed.deletions).toBe(0);
	});

	test("parses a binary file line (`-` counts)", () => {
		const parsed = parseShowStat("-\t-\tlogo.png\n");
		expect(parsed.files.map((f) => f.path)).toEqual(["logo.png"]);
		expect(parsed.fileCount).toBe(1);
		expect(parsed.insertions).toBe(0);
	});

	test("fileCount is the number of file lines — there is no summary line to scrape", () => {
		const parsed = parseShowStat("2\t1\ta.txt\n3\t0\tb.txt\n");
		expect(parsed.fileCount).toBe(2);
	});

	test("a path containing spaces survives (tab is the only separator)", () => {
		const parsed = parseShowStat("1\t0\tdocs/my notes.md\n");
		expect(parsed.files[0].path).toBe("docs/my notes.md");
	});
});

describe("runVerifyMerge — rename handling (M1)", () => {
	test("merged + in-scope rename {src/old.ts => src/new.ts} → CLEAN", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_RENAME_IN_SCOPE }]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42, expectedScope: ["src/"] });

		expect(out.verdict).toBe("CLEAN");
		expect(out.outOfScope).toEqual([]);
		// the parsed path is the NEW post-rename path, not the brace string.
		expect(out.files.map((f) => f.path)).toEqual(["src/new.ts"]);
	});

	test("merged + rename to OUT-of-scope new path {src/a => other/b} → CONTAMINATED", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_RENAME_OUT_OF_SCOPE }]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42, expectedScope: ["src/"] });

		expect(out.verdict).toBe("CONTAMINATED");
		// parsed path is the NEW (out-of-scope) path, not the old in-scope one.
		expect(out.files.map((f) => f.path)).toEqual(["other/b"]);
		expect(out.outOfScope.map((f) => f.path)).toEqual(["other/b"]);
	});

	test("parseShowStat resolves a binary rename brace too", () => {
		const parsed = parseShowStat("-\t-\timg/{old.png => new.png}\n");
		expect(parsed.files.map((f) => f.path)).toEqual(["img/new.png"]);
	});
});

describe("runVerifyMerge — expectedScope glob semantics (regression, PRs #1737/#1739)", () => {
	// `bun-apps/<pkg>/**` entries used to go through a literal startsWith, so
	// every in-scope file failed the comparison and the verdict was CONTAMINATED
	// on perfectly clean merges (PRs #1737/#1739). The scope check now goes
	// through matchesScope (src/scope-match.ts), which also tightens bare
	// entries against pseudo-prefix siblings.

	/** Canned `git show --numstat` with two in-scope bun-apps/foo/ files. */
	const SHOW_FOO: SpawnResult = {
		stdout: "8\t2\tbun-apps/foo/src/a.ts\n5\t3\tbun-apps/foo/package.json\n",
		stderr: "",
		exitCode: 0,
	};

	/** SHOW_FOO plus one pseudo-prefix sibling under bun-apps/foo-bar/. */
	const SHOW_FOO_DRIFT: SpawnResult = {
		stdout: `${SHOW_FOO.stdout}1\t0\tbun-apps/foo-bar/x.ts\n`,
		stderr: "",
		exitCode: 0,
	};

	test("glob entry 'bun-apps/foo/**' yields CLEAN for in-scope files", async () => {
		// Cloned from "(a) merged + all files in expectedScope → CLEAN"; only the
		// canned numstat and expectedScope differ.
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main", contained: [] });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_FOO }]);
		const out = await runVerifyMerge({
			gh,
			client,
			spawn: fn,
			repoRoot: REPO,
			pr: 42,
			expectedScope: ["bun-apps/foo/**"],
		});

		expect(out.merged).toBe(true);
		expect(out.verdict).toBe("CLEAN");
		expect(out.outOfScope).toEqual([]);
	});

	test("glob entry rejects a pseudo-prefix sibling as CONTAMINATED", async () => {
		// Cloned from "(b) merged + a file outside expectedScope → CONTAMINATED";
		// the drift file is the sibling package.
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_FOO_DRIFT }]);
		const out = await runVerifyMerge({
			gh,
			client,
			spawn: fn,
			repoRoot: REPO,
			pr: 42,
			expectedScope: ["bun-apps/foo/**"],
		});

		expect(out.verdict).toBe("CONTAMINATED");
		expect(out.outOfScope.map((f) => f.path)).toEqual(["bun-apps/foo-bar/x.ts"]);
	});

	test("bare entry 'bun-apps/foo' does NOT match 'bun-apps/foo-bar/x.ts' (tightened)", async () => {
		// Old startsWith("bun-apps/foo") swallowed the sibling → false CLEAN risk.
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_FOO_DRIFT }]);
		const out = await runVerifyMerge({
			gh,
			client,
			spawn: fn,
			repoRoot: REPO,
			pr: 42,
			expectedScope: ["bun-apps/foo"],
		});

		expect(out.outOfScope.map((f) => f.path)).toContain("bun-apps/foo-bar/x.ts");
	});
});

describe("runVerifyMerge — branchSpent", () => {
	test("(f) contained includes the head ref → branchSpent true", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main", contained: ["feat/x", "main"] });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_IN_SCOPE }]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42, expectedScope: ["src/"] });

		expect(out.branchSpent).toBe(true);
	});

	test("not contained AND the tree still differs → branchSpent false", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main", contained: ["main"] }); // feat/x NOT contained
		const { fn } = fakeSpawn([
			{ match: (a) => realArgs(a)[0] === "show", result: SHOW_IN_SCOPE },
			{ match: (a) => realArgs(a)[0] === "diff", result: { stdout: "", stderr: "", exitCode: 1 } },
		]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42, expectedScope: ["src/"] });

		expect(out.branchSpent).toBe(false);
	});

	test("no mergeSha → no tree diff to run, so not spent (and no crash)", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x" }); // no mergeSha
		const client = fakeClient({ defaultBranch: "main", contained: [] });
		const { fn, calls } = fakeSpawn([]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42 });

		expect(out.branchSpent).toBe(false);
		expect(calls.some((c) => realArgs(c.args)[0] === "diff")).toBe(false);
	});
});

describe("runVerifyMerge — failure modes", () => {
	test("(g) gh.prStatus throws → warnings + aborted", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA }, { throws: true });
		const client = fakeClient({ defaultBranch: "main" });
		const { fn, calls } = fakeSpawn();
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42 });

		expect(out.aborted?.aborted).toBe(true);
		expect(out.aborted?.reason).toBe("pr-status-failed");
		expect(out.warnings.some((w) => /gh\.prStatus failed/.test(w))).toBe(true);
		expect(out.verdict).toBe("NOT-MERGED"); // cannot determine → defaults to not-merged
		// prStatus failed before any git show → nothing spawned.
		expect(calls.length).toBe(0);
	});

	// CHANGED for issue #1439. This test previously asserted `verdict: "CLEAN"`
	// here — i.e. it pinned the bug as the spec: "we could not inspect anything,
	// therefore the merge is clean". A merge whose files were never read is
	// UNVERIFIED; the rest of the assertions are unchanged.
	test("merged but no mergeSha → warning + empty files, verdict UNVERIFIED", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x" }); // no mergeSha
		const client = fakeClient({ defaultBranch: "main" });
		const { fn, calls } = fakeSpawn();
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42 });

		expect(out.merged).toBe(true);
		expect(out.verdict).toBe("UNVERIFIED");
		expect(out.inspected).toBe(false);
		expect(out.files).toEqual([]);
		expect(out.warnings.some((w) => /no mergeSha/.test(w))).toBe(true);
		// no mergeSha → no `git show` issued.
		expect(calls.filter((c) => c.args.includes("show")).length).toBe(0);
	});
});

describe("BUG: `git show --stat` TRUNCATES long paths → false CONTAMINATED", () => {
	// Found by dogfooding verify-merge-cli on PR #1360. `--stat` pads to a terminal
	// width and abbreviates anything longer as `.../tail`, so `startsWith(prefix)`
	// fails for every deep path and a perfectly in-scope merge is reported
	// CONTAMINATED. The CLI then exits 1, blocking a clean merge.
	//
	// This is the mirror image of the failure the SKILL cites as the REASON to use
	// verify_merge_landed instead of hand-rolled `git show --stat` parsing: same disease,
	// opposite sign (false CONTAMINATED rather than false CLEAN).
	//
	// `--numstat` emits `<added>\t<deleted>\t<path>` with FULL paths and never
	// abbreviates. Binary files come through as `-\t-\t<path>`.
	const DEEP = "bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md";
	const NUMSTAT: SpawnResult = {
		stdout: `30\t8\tbun-apps/s2-agent-ext-devops/CONTEXT.md\n51\t3\t${DEEP}\n`,
		stderr: "",
		exitCode: 0,
	};

	test("a deep in-scope path is CLEAN — it must not be abbreviated away", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main", contained: ["feat/x"] });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: NUMSTAT }]);
		const out = await runVerifyMerge({
			gh,
			client,
			spawn: fn,
			repoRoot: REPO,
			pr: 1360,
			expectedScope: ["bun-apps/s2-agent-ext-devops/"],
		});
		expect(out.files.map((f) => f.path)).toContain(DEEP);
		expect(out.outOfScope).toEqual([]);
		expect(out.verdict).toBe("CLEAN");
	});

	test("the recipe asks git for --numstat, never --stat", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main" });
		const { fn, calls } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: NUMSTAT }]);
		await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 1360 });
		const show = calls.find((c) => realArgs(c.args)[0] === "show");
		expect(show?.args).toContain("--numstat");
		expect(show?.args).not.toContain("--stat");
	});

	test("counts come from summing the per-file columns", async () => {
		const parsed = parseShowStat(`30\t8\ta.ts\n51\t3\tb.ts\n`);
		expect(parsed.fileCount).toBe(2);
		expect(parsed.insertions).toBe(81);
		expect(parsed.deletions).toBe(11);
	});

	test("a binary file (`-\\t-\\tpath`) counts as a file but adds no insertions", () => {
		const parsed = parseShowStat(`-\t-\timg/logo.png\n5\t1\ta.ts\n`);
		expect(parsed.files.map((f) => f.path)).toEqual(["img/logo.png", "a.ts"]);
		expect(parsed.fileCount).toBe(2);
		expect(parsed.insertions).toBe(5);
		expect(parsed.deletions).toBe(1);
	});

	test("an EMBEDDED rename brace resolves to the new path", () => {
		// numstat compacts a rename with a common prefix/suffix as
		// `pre{old => new}post` — the old regex only matched a whole-string brace,
		// so this deep form fell through unresolved and broke the scope check.
		const parsed = parseShowStat(`22\t3\tbun-apps/{pkg-a => pkg-b}/src/entities.ts\n`);
		expect(parsed.files[0].path).toBe("bun-apps/pkg-b/src/entities.ts");
	});

	test("a brace with an EMPTY side resolves (a move into/out of a directory)", () => {
		expect(parseShowStat(`1\t0\tsrc/{ => nested}/a.ts\n`).files[0].path).toBe("src/nested/a.ts");
		expect(parseShowStat(`1\t0\tsrc/{nested => }/a.ts\n`).files[0].path).toBe("src/a.ts");
	});

	test("a whole-path rename with no common prefix still resolves", () => {
		expect(parseShowStat(`3\t0\tsrc/a.ts => other/b.ts\n`).files[0].path).toBe("other/b.ts");
	});
});

describe("BUG: branchSpent is always false under the repo's squash convention", () => {
	// A squash merge rewrites the branch's commits into one NEW commit, so the head
	// ref is never an ancestor of the base and `git branch --merged` never lists
	// it. Every squash-merged PR reported branchSpent:false — the field carried no
	// information in the only merge strategy this repo uses.
	//
	// The fix keys off gh's `headRefOid`: the SHA that actually got merged. Still
	// pointing there means everything on the branch landed.
	//
	// A tree comparison against the merge commit was tried FIRST and is wrong: the
	// merge commit's tree is all of <default> at merge time, so it includes every
	// unrelated PR that landed between this branch's last rebase and its merge.
	// Verified empirically on PR #1360, where the difference was another PR's
	// .planning/ files.
	const NUMSTAT: SpawnResult = { stdout: "1\t0\tsrc/a.ts\n", stderr: "", exitCode: 0 };
	const showOnly = () => fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: NUMSTAT }]);

	test("squash-merged (not contained) but the branch still points at what was merged → spent", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA, headRefOid: sha("a") });
		const client = fakeClient({ defaultBranch: "main", contained: [], revs: { "feat/x": sha("a") } });
		const out = await runVerifyMerge({ gh, client, spawn: showOnly().fn, repoRoot: REPO, pr: 42 });
		expect(out.branchSpent).toBe(true);
	});

	test("commits pushed AFTER the merge (branch moved past headRefOid) → NOT spent", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA, headRefOid: sha("a") });
		const client = fakeClient({ defaultBranch: "main", contained: [], revs: { "feat/x": sha("d") } });
		const out = await runVerifyMerge({ gh, client, spawn: showOnly().fn, repoRoot: REPO, pr: 42 });
		expect(out.branchSpent).toBe(false);
	});

	test("a head ref that no longer resolves → spent, with a warning saying why", async () => {
		// Already deleted (or never fetched): there is nothing local left to lose,
		// and reporting "not spent" would be a false alarm in the other direction.
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/gone", mergeSha: SHA, headRefOid: sha("a") });
		const client = fakeClient({ defaultBranch: "main", contained: [], revs: {} });
		const out = await runVerifyMerge({ gh, client, spawn: showOnly().fn, repoRoot: REPO, pr: 42 });
		expect(out.branchSpent).toBe(true);
		expect(out.warnings.join(" ")).toMatch(/does not resolve locally/);
	});

	test("NO tree diff is ever run — that approach was disproved", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA, headRefOid: sha("a") });
		const client = fakeClient({ defaultBranch: "main", contained: [], revs: { "feat/x": sha("a") } });
		const { fn, calls } = showOnly();
		await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42 });
		expect(calls.some((c) => realArgs(c.args)[0] === "diff")).toBe(false);
	});

	test("an already-contained branch never needs headRefOid (a merge-commit merge)", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main", contained: ["feat/x"] });
		const out = await runVerifyMerge({ gh, client, spawn: showOnly().fn, repoRoot: REPO, pr: 42 });
		expect(out.branchSpent).toBe(true);
	});

	test("no headRefOid from gh (older data) → falls back to containment alone", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main", contained: [], revs: { "feat/x": sha("a") } });
		const out = await runVerifyMerge({ gh, client, spawn: showOnly().fn, repoRoot: REPO, pr: 42 });
		expect(out.branchSpent).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1439: a merge whose files could not be READ must never report CLEAN.
//
// CLEAN used to be the else-branch of the scope check, so an unreadable merge
// produced files=[] → outOfScope=[] → CLEAN with fileCount 0. The trigger is
// the normal post-merge state, not an edge case: `gh pr merge` puts the squash
// commit on the remote, and `git show` on a sha that is not local yet fails
// with `fatal: bad object`.
// ─────────────────────────────────────────────────────────────────────────────

/** `git show` on a sha the local object store does not have. */
const SHOW_BAD_OBJECT: SpawnResult = {
	stdout: "",
	stderr: `fatal: bad object ${SHA}\n`,
	exitCode: 128,
};

const isShow = (a: string[]) => realArgs(a)[0] === "show";
const isFetch = (a: string[]) => realArgs(a)[0] === "fetch";

describe("unreadable merge (issue #1439)", () => {
	test("an unfetched merge sha reports UNVERIFIED, not CLEAN", async () => {
		const spawn = fakeSpawn([{ match: isShow, result: SHOW_BAD_OBJECT }]);
		const out = await runVerifyMerge({
			gh: fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA }),
			client: fakeClient({ defaultBranch: "main" }),
			spawn: spawn.fn,
			repoRoot: REPO,
			pr: 1,
			expectedScope: ["src/"],
		});
		expect(out.verdict).toBe("UNVERIFIED");
		expect(out.inspected).toBe(false);
		expect(out.merged).toBe(true);
		// The old shape: merged + CLEAN + zero files, indistinguishable from a
		// genuinely empty in-scope merge.
		expect(out.fileCount).toBe(0);
	});

	test("UNVERIFIED even with NO expectedScope — the failure is the file read, not the scope", async () => {
		const spawn = fakeSpawn([{ match: isShow, result: SHOW_BAD_OBJECT }]);
		const out = await runVerifyMerge({
			gh: fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA }),
			client: fakeClient({ defaultBranch: "main" }),
			spawn: spawn.fn,
			repoRoot: REPO,
			pr: 1,
		});
		expect(out.verdict).toBe("UNVERIFIED");
	});

	test("a MERGED PR with no mergeSha is UNVERIFIED", async () => {
		const spawn = fakeSpawn();
		const out = await runVerifyMerge({
			gh: fakeGh({ state: "MERGED", headRefName: "feat/x" }),
			client: fakeClient({ defaultBranch: "main" }),
			spawn: spawn.fn,
			repoRoot: REPO,
			pr: 1,
			expectedScope: ["src/"],
		});
		expect(out.verdict).toBe("UNVERIFIED");
		expect(out.inspected).toBe(false);
	});

	test("without allowFetch, no fetch is attempted (read-only contract holds)", async () => {
		const spawn = fakeSpawn([{ match: isShow, result: SHOW_BAD_OBJECT }]);
		await runVerifyMerge({
			gh: fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA }),
			client: fakeClient({ defaultBranch: "main" }),
			spawn: spawn.fn,
			repoRoot: REPO,
			pr: 1,
		});
		expect(spawn.calls.filter((c) => isFetch(c.args)).length).toBe(0);
	});

	test("allowFetch fetches the missing object once, then verifies for real", async () => {
		// First `show` fails (object absent); the fetch lands it; the retry reads it.
		let shows = 0;
		const spawn = fakeSpawn([
			{
				match: isShow,
				get result() {
					shows++;
					return shows === 1 ? SHOW_BAD_OBJECT : SHOW_IN_SCOPE;
				},
			} as never,
		]);
		const out = await runVerifyMerge({
			gh: fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA }),
			client: fakeClient({ defaultBranch: "main" }),
			spawn: spawn.fn,
			repoRoot: REPO,
			pr: 1,
			expectedScope: ["src/"],
			allowFetch: true,
		});
		expect(out.verdict).toBe("CLEAN");
		expect(out.inspected).toBe(true);
		expect(out.fileCount).toBe(2);
		const fetches = spawn.calls.filter((c) => isFetch(c.args));
		expect(fetches.length).toBe(1);
		expect(realArgs(fetches[0]!.args)).toEqual(["fetch", "origin", SHA]);
	});

	test("allowFetch does NOT launder a real failure into CLEAN", async () => {
		// The object genuinely does not exist anywhere: fetch fails, show still
		// fails. The answer must stay UNVERIFIED.
		const spawn = fakeSpawn([
			{ match: isShow, result: SHOW_BAD_OBJECT },
			{ match: isFetch, result: { stdout: "", stderr: "fatal: could not fetch", exitCode: 128 } },
		]);
		const out = await runVerifyMerge({
			gh: fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA }),
			client: fakeClient({ defaultBranch: "main" }),
			spawn: spawn.fn,
			repoRoot: REPO,
			pr: 1,
			expectedScope: ["src/"],
			allowFetch: true,
		});
		expect(out.verdict).toBe("UNVERIFIED");
		expect(out.inspected).toBe(false);
	});

	test("a successful read still yields CLEAN / CONTAMINATED as before", async () => {
		const clean = await runVerifyMerge({
			gh: fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA }),
			client: fakeClient({ defaultBranch: "main" }),
			spawn: fakeSpawn([{ match: isShow, result: SHOW_IN_SCOPE }]).fn,
			repoRoot: REPO,
			pr: 1,
			expectedScope: ["src/"],
		});
		expect(clean.verdict).toBe("CLEAN");
		expect(clean.inspected).toBe(true);

		const drift = await runVerifyMerge({
			gh: fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA }),
			client: fakeClient({ defaultBranch: "main" }),
			spawn: fakeSpawn([{ match: isShow, result: SHOW_DRIFT }]).fn,
			repoRoot: REPO,
			pr: 1,
			expectedScope: ["src/"],
		});
		expect(drift.verdict).toBe("CONTAMINATED");
		expect(drift.inspected).toBe(true);
	});
});

describe("runVerifyMerge — non-origin remote (remoteName threading)", () => {
	test("allowFetch fetch targets the configured remote", async () => {
		// First show fails (bad object), the one allowed fetch targets <remote>,
		// second show succeeds with a numstat (counter-getter, mirrors the
		// existing allowFetch test — fakeSpawn matches the FIRST entry, not in order).
		let shows = 0;
		const spawn = fakeSpawn([
			{
				match: isShow,
				get result() {
					shows++;
					return shows === 1 ? SHOW_BAD_OBJECT : SHOW_IN_SCOPE;
				},
			} as never,
		]);
		const out = await runVerifyMerge({
			gh: fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA }),
			client: fakeClient({ defaultBranch: "main" }),
			spawn: spawn.fn,
			repoRoot: REPO,
			pr: 1,
			expectedScope: ["src/"],
			allowFetch: true,
			remoteName: "upstream",
		});
		expect(out.verdict).toBe("CLEAN");
		const fetches = spawn.calls.filter((c) => isFetch(c.args));
		expect(fetches.length).toBe(1);
		expect(realArgs(fetches[0]!.args)).toEqual(["fetch", "upstream", SHA]);
	});
});
