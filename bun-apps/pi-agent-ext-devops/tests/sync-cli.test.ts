/**
 * Tests for the bash-callable `sync-cli.ts` wrapper (the plain-`pi` fallback
 * for the sync_repo tool).
 *
 * The wrapper is what CLAUDE.md now tells plain-`pi` sessions (no run-dir
 * extensions → no devops tools) to run instead of hand-rolled git, so what is
 * pinned here is the WRAPPER'S CONTRACT, not sync logic (that lives in
 * tests/sync-recipe.test.ts):
 *  - argv parsing: --mode/--dry-run/--force/--preserve/--preserve-strict,
 *  - stdout is the structured SyncOutcome as JSON (parseable, mode round-trips),
 *  - aborts (dirty_tree, divergent) map to exit 1 — never exit 0,
 *  - usage errors exit 2, --help exits 0 with usage on stderr.
 *
 * Mirrors the dual-seam style of tests/sync-recipe.test.ts: a minimal
 * SyncClient fake + a recording SpawnFn. No real git / filesystem mutation.
 */
import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runSyncCli, parseSyncArgs, SYNC_CLI_USAGE, defaultRepoRoot } from "../src/sync-cli.js";
import { DEFAULT_PRESERVE_PATHS } from "../src/sync-recipe.js";
import type { SyncClient } from "../src/sync-recipe.js";
import type { BranchClient } from "../src/branch-recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const REPO = "/repo";
const sha = (c: string) => c.repeat(40);

/** Minimal SyncClient fake (same shape as tests/sync-recipe.test.ts). */
function fakeClient(s: {
	defaultBranch?: string;
	current?: string;
	worktrees?: { worktree: string; branch?: string; detached?: boolean }[];
	dirty?: Record<string, string[]>;
	revs?: Record<string, string>;
}): BranchClient {
	const base: SyncClient = {
		defaultBranch: async () => s.defaultBranch,
		currentBranch: async () => s.current ?? "",
		worktreeList: async () => s.worktrees ?? [],
		dirtyPaths: async (dir: string) => s.dirty?.[dir] ?? [],
		revParse: async (rev: string) => s.revs?.[rev],
		aheadBehind: async () => ({ ahead: 0, behind: 0 }),
	};
	// BranchClient adds isClean beyond the SyncClient Pick; the CLI never calls it.
	return base as unknown as BranchClient;
}

/** Quiet-success recording SpawnFn (sync-cli only supplies it to runSync). */
function fakeSpawn(): { fn: SpawnFn; calls: { cmd: string; args: string[] }[] } {
	const calls: { cmd: string; args: string[] }[] = [];
	const fn: SpawnFn = async (cmd, args): Promise<SpawnResult> => {
		calls.push({ cmd, args });
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

/** A clean full-mode-ready fake: main in this worktree, origin/main resolvable. */
function cleanDeps() {
	return {
		client: fakeClient({
			defaultBranch: "main",
			current: "main",
			worktrees: [{ worktree: REPO, branch: "main" }],
			revs: { "origin/main": sha("b"), main: sha("a") },
		}),
		spawn: fakeSpawn().fn,
		repoRoot: REPO,
	};
}

describe("parseSyncArgs — argv contract", () => {
	test("defaults: full mode, no dry-run, no force, default preserve", () => {
		const r = parseSyncArgs([]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.mode).toBe("full");
			expect(r.args.dryRun).toBe(false);
			expect(r.args.force).toBe(false);
			expect(r.args.preserve).toBeUndefined(); // ⇒ DEFAULT_PRESERVE_PATHS downstream
		}
	});

	test("--mode accepts exactly full|rebase|pull", () => {
		for (const m of ["full", "rebase", "pull"]) {
			const r = parseSyncArgs(["--mode", m]);
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.args.mode).toBe(m);
		}
		for (const bad of ["ff-only", "missing"]) {
			const r = parseSyncArgs(["--mode", bad]);
			expect(r.ok).toBe(false);
		}
		expect(parseSyncArgs(["--mode"]).ok).toBe(false); // missing value
	});

	test("--preserve is repeatable and accumulates in order", () => {
		const r = parseSyncArgs(["--preserve", "a.md", "--preserve", "dir/"]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.args.preserve).toEqual(["a.md", "dir/"]);
		expect(parseSyncArgs(["--preserve"]).ok).toBe(false); // missing value
	});

	test("--preserve-strict forces preserve: [] (overrides explicit --preserve)", () => {
		const r = parseSyncArgs(["--preserve", "a.md", "--preserve-strict"]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.args.preserve).toEqual([]);
	});

	test("unknown flags and positionals are usage errors", () => {
		expect(parseSyncArgs(["--nope"]).ok).toBe(false);
		expect(parseSyncArgs(["main"]).ok).toBe(false);
		expect(parseSyncArgs(["--repo-root"]).ok).toBe(false);
	});
});

describe("sync-cli — wrapper contract", () => {
	test("clean run exits 0 with the structured SyncOutcome as JSON on stdout", async () => {
		const res = await runSyncCli([], cleanDeps());
		expect(res.exitCode).toBe(0);
		expect(res.stderr).toBe("");
		const outcome = JSON.parse(res.stdout);
		expect(outcome.mode).toBe("full");
		expect(outcome.dryRun).toBe(false);
		expect(outcome.defaultBranch).toBe("main");
		expect(outcome.aborted).toBeUndefined();
		expect(outcome.advanced.length).toBe(1);
	});

	test("--mode rebase round-trips into the outcome", async () => {
		const deps = cleanDeps();
		const res = await runSyncCli(["--mode", "rebase"], deps);
		expect(res.exitCode).toBe(0);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.mode).toBe("rebase");
	});

	test("--dry-run exits 0, plans commands, never mutates (still exit 0 even dirty)", async () => {
		const deps = {
			client: fakeClient({
				defaultBranch: "main",
				current: "main",
				worktrees: [{ worktree: REPO, branch: "main" }],
				dirty: { [REPO]: ["src/x.ts"] }, // REAL dirty — would abort if mutating
				revs: { "origin/main": sha("b"), main: sha("a") },
			}),
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
		};
		const res = await runSyncCli(["--dry-run"], deps);
		expect(res.exitCode).toBe(0);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.dryRun).toBe(true);
		expect(outcome.aborted).toBeUndefined();
		expect(outcome.commands.some((c: string) => c.includes("fetch"))).toBe(true);
	});

	test("abort (dirty_tree) maps to exit 1 with the structured reason", async () => {
		const deps = {
			client: fakeClient({
				defaultBranch: "main",
				current: "main",
				worktrees: [{ worktree: REPO, branch: "main" }],
				dirty: { [REPO]: ["src/x.ts"] },
				revs: { "origin/main": sha("b"), main: sha("a") },
			}),
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
		};
		const res = await runSyncCli([], deps);
		expect(res.exitCode).toBe(1);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.aborted?.aborted).toBe(true);
		expect(outcome.aborted.reason).toBe("dirty_tree");
	});

	test("abort (divergent) maps to exit 1 — the ff-only refusal surfaces", async () => {
		// merge --ff-only fails → runSync records a canned divergent abort.
		const calls: { cmd: string; args: string[] }[] = [];
		const fn: SpawnFn = async (cmd, args) => {
			calls.push({ cmd, args });
			if (args.includes("merge")) return { stdout: "", stderr: "not possible to fast-forward", exitCode: 1 };
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const res = await runSyncCli([], {
			client: fakeClient({
				defaultBranch: "main",
				current: "main",
				worktrees: [{ worktree: REPO, branch: "main" }],
				revs: { "origin/main": sha("b"), main: sha("a") },
			}),
			spawn: fn,
			repoRoot: REPO,
		});
		expect(res.exitCode).toBe(1);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.aborted?.aborted).toBe(true);
		expect(outcome.aborted.reason).toBe("divergent");
		expect(calls.some((c) => c.args.includes("reset"))).toBe(false); // force NOT set
	});

	test("--preserve overrides the default (a preserve-listed dirty path no longer aborts)", async () => {
		const deps = {
			client: fakeClient({
				defaultBranch: "main",
				current: "main",
				worktrees: [{ worktree: REPO, branch: "main" }],
				dirty: { [REPO]: ["hot/file.md"] },
				revs: { "origin/main": sha("b"), main: sha("a") },
			}),
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
		};
		// default preserve list does NOT cover hot/file.md → aborts.
		const aborting = await runSyncCli([], deps);
		expect(aborting.exitCode).toBe(1);
		// explicit --preserve covers it → stashed across the advance, exit 0.
		const ok = await runSyncCli(["--preserve", "hot/"], deps);
		expect(ok.exitCode).toBe(0);
		const outcome = JSON.parse(ok.stdout);
		expect(outcome.preserved).toEqual({ paths: ["hot/file.md"], restored: true });
	});

	test("--preserve-strict makes even the DEFAULT hot file abort", async () => {
		const deps = {
			client: fakeClient({
				defaultBranch: "main",
				current: "main",
				worktrees: [{ worktree: REPO, branch: "main" }],
				dirty: { [REPO]: DEFAULT_PRESERVE_PATHS },
				revs: { "origin/main": sha("b"), main: sha("a") },
			}),
			spawn: fakeSpawn().fn,
			repoRoot: REPO,
		};
		const res = await runSyncCli(["--preserve-strict"], deps);
		expect(res.exitCode).toBe(1);
		const outcome = JSON.parse(res.stdout);
		expect(outcome.aborted.reason).toBe("dirty_tree");
	});

	test("usage errors exit 2 with empty stdout; --help exits 0 with usage on stderr", async () => {
		for (const argv of [["--mode", "bad"], ["--nope"], ["--preserve"]]) {
			const res = await runSyncCli(argv, cleanDeps());
			expect(res.exitCode).toBe(2);
			expect(res.stdout).toBe("");
			expect(res.stderr.includes(SYNC_CLI_USAGE)).toBe(true);
		}
		const help = await runSyncCli(["--help"], cleanDeps());
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toBe("");
		expect(help.stderr).toBe(SYNC_CLI_USAGE);
	});
});

describe("sync-cli — live entry point", () => {
	// PORTABILITY-GUARDED: spawns `process.execPath` (the runtime already
	// executing this test) on a committed file in this repo — no machine-coupled
	// host binary. `--dry-run` is read-only: zero mutating git ops.
	test("`bun src/sync-cli.ts --help` exits 0 with usage", () => {
		const cli = join(import.meta.dir, "..", "src", "sync-cli.ts");
		const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
		expect(r.status).toBe(0);
		expect(r.stderr.includes("usage:")).toBe(true);
	});

	test("`bun src/sync-cli.ts --dry-run` exits 0 with parseable JSON (zero mutations)", () => {
		const cli = join(import.meta.dir, "..", "src", "sync-cli.ts");
		const r = spawnSync(process.execPath, [cli, "--dry-run", "--repo-root", defaultRepoRoot()], {
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		const outcome = JSON.parse(r.stdout);
		expect(outcome.dryRun).toBe(true);
		expect(Array.isArray(outcome.commands)).toBe(true);
		expect(outcome.commands.some((c: string) => c.includes("fetch"))).toBe(true);
	});
});
