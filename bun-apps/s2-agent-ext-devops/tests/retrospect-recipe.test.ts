/**
 * Tests for runRetrospect — the ADVISORY post-run retrospective. Mirrors the
 * dual-seam style of sync-recipe.test.ts: a minimal `RetrospectClient` fake
 * feeds canned read-only git state, a recording `SpawnFn` feeds canned reflog /
 * log output (and lets dryRun-style cases assert ZERO spawns). No real git/fs.
 *
 * Coverage:
 *  (a) clean state + benign reflog → anomalies empty;
 *  (b) reflog with a reset/rewrite signature → `history-rewrite-signature`;
 *  (c) expectedScope set + recent files outside → `scope-drift` lists them;
 *  (d) current branch in 2 worktrees → `worktree-conflict-risk`;
 *  (e) dirty tree → `dirty-tree` (info);
 *  (f) divergence ahead+behind → `unexpected-divergence`;
 *  (g) a read throws → `warnings` populated, NOT aborted (advisory has no abort);
 *  (h) `commands` records the read-only git invocations (reflog + log).
 */
import { test, expect, describe } from "bun:test";
import { runRetrospect, type RetrospectClient } from "../src/retrospect-recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const REPO = "/repo";
const OTHER = "/repo-wt";

/** Minimal RetrospectClient fake. `throwOn` forces a method to throw (case g). */
function fakeClient(s: {
	defaultBranch?: string;
	current?: string;
	worktrees?: { worktree: string; branch?: string; detached?: boolean }[];
	clean?: boolean;
	aheadBehind?: Record<string, { ahead: number; behind: number }>;
	throwOn?: string;
}): RetrospectClient {
	const tryThrow = (name: string) => {
		if (s.throwOn === name) throw new Error(`${name} forced failure`);
	};
	return {
		defaultBranch: async () => {
			tryThrow("defaultBranch");
			return s.defaultBranch;
		},
		currentBranch: async () => {
			tryThrow("currentBranch");
			return s.current ?? "";
		},
		worktreeList: async () => {
			tryThrow("worktreeList");
			return s.worktrees ?? [];
		},
		isClean: async () => {
			tryThrow("isClean");
			return s.clean ?? true;
		},
		aheadBehind: async (base: string, head: string) => {
			tryThrow("aheadBehind");
			return s.aheadBehind?.[`${base}..${head}`] ?? { ahead: 0, behind: 0 };
		},
	};
}

/** Recording SpawnFn. Returns canned results by matching args (post `-C <dir>`),
 *  defaulting to a quiet success. Records every call. */
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

/** A benign reflog (checkout + commit — no rewrite/reset/amend/rebase). */
const CLEAN_REFLOG: SpawnResult = {
	stdout: "aaa0001 checkout: moving from main to feat/x\naaa0002 commit: feat: add thing\n",
	stderr: "",
	exitCode: 0,
};

/** A reflog containing a reset signature (the local force-push precursor). */
const FORCE_REFLOG: SpawnResult = {
	stdout: "bbb0001 reset: moving to HEAD~1\nbbb0002 commit: feat: add thing\n",
	stderr: "",
	exitCode: 0,
};

/** A reflog whose ONLY op prefixes are benign (checkout/commit/pull) — even
 *  though a commit MESSAGE mentions "rebase", this must NOT fire history-rewrite
 *  (the heuristic now anchors on the op prefix, not a keyword anywhere). */
const BENIGN_REBASE_MSG_REFLOG: SpawnResult = {
	stdout:
		"ccc0001 pull: fast-forward\nccc0002 commit: fix: handle rebase edge case\nccc0003 checkout: moving from main to feat/x\n",
	stderr: "",
	exitCode: 0,
};

/** A reflog containing a `commit (amend):` op prefix (a history rewrite). */
const AMEND_REFLOG: SpawnResult = {
	stdout: "ddd0001 commit (amend): tweak message\n",
	stderr: "",
	exitCode: 0,
};

describe("runRetrospect — advisory read-only", () => {
	test("(a) clean state + benign reflog → no anomalies", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
			clean: true,
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		expect(out.anomalies).toEqual([]);
		expect(out.clean).toBe(true);
		expect(out.divergence).toEqual({ ahead: 0, behind: 0 });
		expect(out.warnings).toEqual([]);
		expect(out.branch).toBe("feat/x");
		expect(out.defaultBranch).toBe("main");
		expect(out.summary).toMatch(/0 anomaly/);
	});

	test("(b) reflog with a reset signature → history-rewrite-signature (warn)", async () => {
		const client = fakeClient({ defaultBranch: "main", current: "feat/x" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: FORCE_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		const fp = out.anomalies.find((x) => x.kind === "history-rewrite-signature");
		expect(fp).toBeDefined();
		expect(fp?.severity).toBe("warn");
		expect(fp?.message).toMatch(/reset/);
	});

	test("(c) expectedScope set + recent files outside → scope-drift lists them", async () => {
		const client = fakeClient({ defaultBranch: "main", current: "feat/x" });
		const { fn } = fakeSpawn([
			{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG },
			{
				match: (a) => realArgs(a)[0] === "log",
				result: { stdout: "src/a.ts\ndocs/b.md\n", stderr: "", exitCode: 0 },
			},
		]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO, expectedScope: ["src/"] });

		const drift = out.anomalies.find((x) => x.kind === "scope-drift");
		expect(drift).toBeDefined();
		expect(drift?.severity).toBe("warn");
		expect(drift?.message).toContain("docs/b.md");
		expect(drift?.message).not.toContain("src/a.ts");
	});

	test("(c2) bare scope entry uses matchesScope — pseudo-prefix sibling IS drift, exact child is not", async () => {
		const client = fakeClient({ defaultBranch: "main", current: "feat/x" });
		const { fn } = fakeSpawn([
			{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG },
			{
				match: (a) => realArgs(a)[0] === "log",
				// srcx/b.ts is a PSEUDO-PREFIX sibling of `src` — the old literal
				// startsWith treated it as in-scope (false-clean); matchesScope doesn't.
				result: { stdout: "src/a.ts\nsrcx/b.ts\n", stderr: "", exitCode: 0 },
			},
		]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO, expectedScope: ["src"] });

		const drift = out.anomalies.find((x) => x.kind === "scope-drift");
		expect(drift).toBeDefined();
		expect(drift?.message).toContain("srcx/b.ts");
		expect(drift?.message).not.toContain("src/a.ts");
	});

	test("(d) current branch in 2 worktrees → worktree-conflict-risk", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			worktrees: [
				{ worktree: REPO, branch: "feat/x" },
				{ worktree: OTHER, branch: "feat/x" },
			],
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		const wt = out.anomalies.find((x) => x.kind === "worktree-conflict-risk");
		expect(wt).toBeDefined();
		expect(wt?.severity).toBe("warn");
		expect(wt?.message).toMatch(/2 worktrees/);
	});

	test("(e) dirty tree → dirty-tree (info)", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			clean: false,
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		const dirty = out.anomalies.find((x) => x.kind === "dirty-tree");
		expect(dirty).toBeDefined();
		expect(dirty?.severity).toBe("info");
		expect(out.clean).toBe(false);
	});

	test("(f) divergence ahead+behind → unexpected-divergence", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			aheadBehind: { "main..feat/x": { ahead: 2, behind: 3 } },
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		const div = out.anomalies.find((x) => x.kind === "unexpected-divergence");
		expect(div).toBeDefined();
		expect(div?.severity).toBe("info");
		expect(div?.message).toMatch(/ahead \(2\).*behind \(3\)/);
		expect(out.divergence).toEqual({ ahead: 2, behind: 3 });
	});

	test("(g) a read throws → warnings populated, NOT aborted (advisory has no abort)", async () => {
		const client = fakeClient({ defaultBranch: "main", current: "feat/x", throwOn: "currentBranch" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		// throw-free: the recipe still returns a full outcome.
		expect(out.warnings.some((w) => /currentBranch/.test(w))).toBe(true);
		// advisory → there is no `aborted` field at all.
		expect("aborted" in out).toBe(false);
		expect(out.branch).toBe(""); // safe() fallback
	});

	test("(h) commands records the read-only git invocations (reflog + log)", async () => {
		const client = fakeClient({ defaultBranch: "main", current: "feat/x" });
		const { fn, calls } = fakeSpawn([
			{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG },
			{ match: (a) => realArgs(a)[0] === "log", result: { stdout: "src/a.ts\n", stderr: "", exitCode: 0 } },
		]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO, expectedScope: ["src/"] });

		expect(out.commands.some((c) => c.includes("reflog"))).toBe(true);
		// the log command is `log -n 12 --name-only --format=` — assert the stable
		// `--name-only` token (the `-n 12` sits between `log` and `--name-only`).
		expect(out.commands.some((c) => c.includes("--name-only"))).toBe(true);
		// both read-only git calls were actually spawned.
		expect(calls.filter((c) => c.args.includes("reflog")).length).toBe(1);
		expect(calls.filter((c) => c.args.includes("log")).length).toBe(1);
		// no mutating command ever recorded.
		expect(out.commands.some((c) => /push|reset|rebase|merge|checkout/.test(c))).toBe(false);
	});

	test("without expectedScope → no log command issued (reflog only)", async () => {
		const client = fakeClient({ defaultBranch: "main", current: "feat/x" });
		const { fn, calls } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		expect(out.commands.some((c) => c.includes("reflog"))).toBe(true);
		expect(out.commands.some((c) => c.includes("log --name-only"))).toBe(false);
		expect(calls.filter((c) => c.args.includes("log")).length).toBe(0);
	});

	test("far-behind-only (no ahead) → unexpected-divergence info", async () => {
		const client = fakeClient({
			defaultBranch: "main",
			current: "feat/x",
			aheadBehind: { "main..feat/x": { ahead: 0, behind: 12 } },
			worktrees: [{ worktree: REPO, branch: "feat/x" }],
		});
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: CLEAN_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		expect(out.anomalies.find((x) => x.kind === "unexpected-divergence")?.message).toMatch(/12 commits behind/);
	});
});

describe("runRetrospect — history-rewrite heuristic (M2)", () => {
	test("benign reflog (checkout/commit/pull, message mentions rebase) → NO history-rewrite", async () => {
		const client = fakeClient({ defaultBranch: "main", current: "feat/x" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: BENIGN_REBASE_MSG_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		// Op prefixes are all benign — the "rebase" keyword inside a commit
		// message must NOT trip the anchored heuristic (no crying wolf).
		expect(out.anomalies.find((x) => x.kind === "history-rewrite-signature")).toBeUndefined();
	});

	test("reflog with a commit (amend): op → history-rewrite-signature fired", async () => {
		const client = fakeClient({ defaultBranch: "main", current: "feat/x" });
		const { fn } = fakeSpawn([{ match: (a) => realArgs(a)[0] === "reflog", result: AMEND_REFLOG }]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		const hr = out.anomalies.find((x) => x.kind === "history-rewrite-signature");
		expect(hr).toBeDefined();
		expect(hr?.severity).toBe("warn");
		expect(hr?.message).toMatch(/amend|rewrite/);
	});

	test("a plain `commit:` op (no amend) does NOT fire history-rewrite", async () => {
		const client = fakeClient({ defaultBranch: "main", current: "feat/x" });
		// `commit:` (no `(amend)`) is a normal commit op, not a rewrite.
		const { fn } = fakeSpawn([
			{ match: (a) => realArgs(a)[0] === "reflog", result: { stdout: "eee0001 commit: feat: add thing\n", stderr: "", exitCode: 0 } },
		]);
		const out = await runRetrospect({ client, spawn: fn, repoRoot: REPO });

		expect(out.anomalies.find((x) => x.kind === "history-rewrite-signature")).toBeUndefined();
	});
});
