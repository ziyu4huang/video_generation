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
 *  (e) parseShowStat unit cases (files + counts from sample stdout);
 *  (f) branch-spent true/false (+ revParse SHA-equality fallback);
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
				checks: { pass: 0, fail: 0, pending: 0 },
			};
		},
		async mergeNow() {
			/* unused by verify-merge */
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

/** Canned `git show --stat --format= <sha>` with two in-scope src/ files. */
const SHOW_IN_SCOPE: SpawnResult = {
	stdout: " src/a.ts | 10 ++++--\n src/b.ts |  3 ++\n 2 files changed, 13 insertions(+), 5 deletions(-)\n",
	stderr: "",
	exitCode: 0,
};

/** Canned `git show --stat` with one in-scope (src/) + one out-of-scope (docs/) file. */
const SHOW_DRIFT: SpawnResult = {
	stdout: " src/a.ts  | 10 ++++--\n docs/b.md |  3 ++\n 2 files changed, 13 insertions(+), 5 deletions(-)\n",
	stderr: "",
	exitCode: 0,
};

/** Canned `git show --stat` with an in-scope rename `{src/old.ts => src/new.ts}`
 *  (the NEW path stays under `src/` → should be CLEAN, not CONTAMINATED). */
const SHOW_RENAME_IN_SCOPE: SpawnResult = {
	stdout: " {src/old.ts => src/new.ts} | 5 ++---\n 1 file changed, 3 insertions(+), 2 deletions(-)\n",
	stderr: "",
	exitCode: 0,
};

/** Canned `git show --stat` with a rename whose NEW path is OUT of scope
 *  `{src/a => other/b}` (verifies the rename fix doesn't over-correct). */
const SHOW_RENAME_OUT_OF_SCOPE: SpawnResult = {
	stdout: " {src/a => other/b} | 3 ++\n 1 file changed, 3 insertions(+)\n",
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
		expect(out.commands.some((c) => c.includes("show --stat"))).toBe(true);
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

describe("parseShowStat — unit", () => {
	test("(e) parses paths + the summary counts from sample --stat stdout", () => {
		const parsed = parseShowStat(SHOW_IN_SCOPE.stdout);
		expect(parsed.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(parsed.files.every((f) => f.status === "M")).toBe(true); // best-effort default
		expect(parsed.fileCount).toBe(2);
		expect(parsed.insertions).toBe(13);
		expect(parsed.deletions).toBe(5);
	});

	test("parses an additions-only summary (no deletions)", () => {
		const parsed = parseShowStat(" new.txt | 5 +++++\n 1 file changed, 5 insertions(+)\n");
		expect(parsed.files.map((f) => f.path)).toEqual(["new.txt"]);
		expect(parsed.fileCount).toBe(1);
		expect(parsed.insertions).toBe(5);
		expect(parsed.deletions).toBe(0);
	});

	test("parses a binary file line", () => {
		const parsed = parseShowStat(" logo.png | Bin 100 -> 120 bytes\n 1 file changed, 0 insertions(+), 0 deletions(-)\n");
		expect(parsed.files.map((f) => f.path)).toEqual(["logo.png"]);
	});

	test("falls back to file-line count when the summary is missing", () => {
		const parsed = parseShowStat(" a.txt | 2 +-\n b.txt | 3 ++\n");
		expect(parsed.fileCount).toBe(2);
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
		const parsed = parseShowStat(" {img/old.png => img/new.png} | Bin 100 -> 120 bytes\n 1 file changed, 0 insertions(+), 0 deletions(-)\n");
		expect(parsed.files.map((f) => f.path)).toEqual(["img/new.png"]);
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

	test("contained excludes the head ref → branchSpent false", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		const client = fakeClient({ defaultBranch: "main", contained: ["main"] }); // feat/x NOT contained
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_IN_SCOPE }]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42, expectedScope: ["src/"] });

		expect(out.branchSpent).toBe(false);
	});

	test("revParse SHA-equality fallback → head tip == default tip → spent", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x", mergeSha: SHA });
		// contained empty (e.g. squash repo) but head + default resolve to the SAME sha.
		const client = fakeClient({
			defaultBranch: "main",
			contained: [],
			revs: { "feat/x": sha("c"), main: sha("c") },
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "show", result: SHOW_IN_SCOPE }]);
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42, expectedScope: ["src/"] });

		expect(out.branchSpent).toBe(true);
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

	test("merged but no mergeSha → warning + empty files, verdict CLEAN (no scope)", async () => {
		const gh = fakeGh({ state: "MERGED", headRefName: "feat/x" }); // no mergeSha
		const client = fakeClient({ defaultBranch: "main" });
		const { fn, calls } = fakeSpawn();
		const out = await runVerifyMerge({ gh, client, spawn: fn, repoRoot: REPO, pr: 42 });

		expect(out.merged).toBe(true);
		expect(out.verdict).toBe("CLEAN");
		expect(out.files).toEqual([]);
		expect(out.warnings.some((w) => /no mergeSha/.test(w))).toBe(true);
		// no mergeSha → no `git show` issued.
		expect(calls.filter((c) => c.args.includes("show")).length).toBe(0);
	});
});
