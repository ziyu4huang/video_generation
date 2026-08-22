/**
 * Tests for the devops CLI fallbacks (sweep / local-ci / main-health /
 * prepare-branch / verify-merge).
 *
 * WHAT IS ACTUALLY UNDER TEST
 *   A wrapper's only jobs are argv → options and outcome → exit code. So these
 *   tests cover exactly those two, with the recipe's collaborators injected:
 *   the pure `parseXArgs` functions, and the exit-code mapping via a fake
 *   client/spawn. The recipes themselves are tested in their own files; nothing
 *   here re-tests them.
 *
 * THE EXIT-CODE CONTRACT IS THE POINT
 *   These exist so a NON-pi session has a legal path to the devops phases. A
 *   caller in that position is usually a shell script that branches on `$?`, so
 *   a wrong exit code is worse than a wrong message: it silently converts
 *   "nothing was verified" into "verified fine".
 */
import { test, expect, describe } from "bun:test";
import { parseSweepArgs, runSweepCli } from "../src/sweep-merged-branches-cli.js";
import { parseLocalCiArgs } from "../src/local-ci-cli.js";
import { parseMainHealthArgs, runMainHealthCli } from "../src/main-health-cli.js";
import { parsePrepareArgs } from "../src/prepare-feature-branch-cli.js";
import { parseVerifyMergeArgs, runVerifyMergeCli } from "../src/verify-merge-cli.js";
import type { BranchClient, SweepClient } from "../src/branch-recipe.js";
import type { MainHealthClient } from "../src/main-health-recipe.js";
import { runSchemaCostCheck } from "../src/schema-cost-check.js";
import { runLocalCi } from "../src/ci-recipe.js";
import { resolve } from "node:path";

const REPO = "/repo";
/** A real baseline JSON on disk — runSchemaCostCheck reads it with readFileSync. */
const BASELINE_FIXTURE = resolve(import.meta.dir, "..", "..", "..", "scripts", "schema-cost-baseline.json");
const noSpawn = async () => {
	throw new Error("no spawn expected");
};

describe("shared CLI contract", () => {
	const clis = [
		["sweep", parseSweepArgs],
		["local-ci", parseLocalCiArgs],
		["main-health", parseMainHealthArgs],
		["verify-merge", parseVerifyMergeArgs],
	] as const;

	for (const [name, parse] of clis) {
		test(`${name}: an unknown flag is a usage error, never silently ignored`, () => {
			const r = parse(["--not-a-flag"]);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.message).toContain("--not-a-flag");
		});

		test(`${name}: --help parses as "not ok" so the caller can render usage at exit 0`, () => {
			const r = parse(["--help"]);
			expect(r.ok).toBe(false);
		});
	}

	test("prepare: an unknown flag is a usage error", () => {
		const r = parsePrepareArgs(["--rebase", "--nope"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("--nope");
	});

	test("every CLI prints usage on stderr with exit 0 for --help, and nothing on stdout", async () => {
		for (const run of [runSweepCli, runMainHealthCli, runVerifyMergeCli]) {
			const res = await run(["--help"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe("");
			expect(res.stderr).toContain("usage:");
		}
	});
});

describe("sweep-merged-branches-cli", () => {
	test("defaults to a DRY RUN — execute must be explicit", () => {
		const r = parseSweepArgs([]);
		expect(r.ok && r.args.execute).toBe(false);
	});

	test("parses the full flag set", () => {
		const r = parseSweepArgs([
			"--execute",
			"--confirm",
			"a, b",
			"--protect",
			"keep-me",
			"--no-remote",
			"--no-prune",
			"--limit",
			"50",
		]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.args).toMatchObject({
			execute: true,
			confirm: ["a", "b"],
			protect: ["keep-me"],
			includeRemote: false,
			prune: false,
			limit: 50,
		});
	});

	test("--limit rejects a non-positive-integer", () => {
		for (const bad of ["0", "-3", "abc", ""]) {
			expect(parseSweepArgs(["--limit", bad]).ok, `--limit ${bad}`).toBe(false);
		}
	});

	test("a dry-run plan exits 0 even when branches are listed for deletion", async () => {
		const res = await runSweepCli([], { client: sweepClient(), spawn: noSpawn, repoRoot: REPO });
		expect(res.exitCode).toBe(0);
		expect(JSON.parse(res.stdout).deleteLocal).toHaveLength(1);
	});

	test("an executed sweep that SKIPPED something exits 1", async () => {
		// A guard fired or a delete failed, so "the sweep is done" is false. A
		// shell caller branching on $? has to see that.
		const res = await runSweepCli(["--execute"], {
			client: sweepClient({ failLocal: true }),
			spawn: noSpawn,
			repoRoot: REPO,
		});
		expect(res.exitCode).toBe(1);
		expect(JSON.parse(res.stdout).executed.skipped).toHaveLength(1);
	});

	test("a clean executed sweep exits 0", async () => {
		const res = await runSweepCli(["--execute"], { client: sweepClient(), spawn: noSpawn, repoRoot: REPO });
		expect(res.exitCode).toBe(0);
		expect(JSON.parse(res.stdout).executed.deletedLocal).toEqual(["feat/merged"]);
	});
});

/** Minimal SweepClient (git + forge prList) with exactly one merged, deletable local branch. */
function sweepClient(o: { failLocal?: boolean } = {}): SweepClient {
	return {
		branchVv: async () => [{ name: "feat/merged", goneRemote: false }],
		remoteBranches: async () => [],
		worktrees: async () => [],
		worktreeList: async () => [],
		currentBranch: async () => "main",
		prList: async (state: "open" | "merged") =>
			state === "merged"
				? [{ number: 1, headRefName: "feat/merged", mergedAt: "2026-01-01T00:00:00Z" }]
				: [],
		containedBranches: async () => new Set<string>(),
		defaultBranch: async () => "main",
		fetchPrune: async () => {},
		deleteLocalBranch: async () => {
			if (o.failLocal) throw new Error("git branch -D failed (exit 1)");
		},
		deleteRemoteBranch: async () => {},
	} as unknown as SweepClient;
}

describe("local-ci-cli", () => {
	test("defaults: change-scoped, gates on, not strict", () => {
		const r = parseLocalCiArgs([]);
		expect(r.ok && r.args).toMatchObject({ all: false, strict: false, includeGates: true });
	});

	test("--all and --packages are mutually exclusive", () => {
		const r = parseLocalCiArgs(["--all", "--packages", "a,b"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("mutually exclusive");
	});

	test("parses --base / --packages / --strict / --no-gates", () => {
		const r = parseLocalCiArgs(["--base", "origin/dev", "--packages", "a, b", "--strict", "--no-gates"]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.args).toMatchObject({ baseRef: "origin/dev", packages: ["a", "b"], strict: true, includeGates: false });
	});
});

describe("main-health-cli", () => {
	test("takes no flags but --repo-root", () => {
		expect(parseMainHealthArgs([]).ok).toBe(true);
		expect(parseMainHealthArgs(["--repo-root", "/x"]).ok).toBe(true);
		expect(parseMainHealthArgs(["--all"]).ok).toBe(false);
	});

	test("UNTESTABLE (no worktree holds the default branch) exits 1, not 0", async () => {
		// The whole reason this tool exists is that silence reads as health. An
		// abort must not exit 0 just because no test reported a failure.
		const client = {
			defaultBranch: async () => "main",
			worktreeList: async () => [{ worktree: "/repo/feat", branch: "feat/x" }],
			dirtyPaths: async () => [],
			aheadBehind: async () => ({ ahead: 0, behind: 0 }),
			revParse: async () => "sha",
		} as MainHealthClient;
		const res = await runMainHealthCli([], { client, spawn: noSpawn, repoRoot: REPO, remoteName: "origin" });
		expect(res.exitCode).toBe(1);
		expect(JSON.parse(res.stdout).aborted).toBe("no-default-branch-worktree");
	});
});

describe("prepare-feature-branch-cli", () => {
	test("a bare invocation is a usage error, not a silent 0-exit no-op", () => {
		const r = parsePrepareArgs([]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("nothing to do");
	});

	test("--force-push is never implied by --rebase", () => {
		const r = parsePrepareArgs(["--rebase"]);
		expect(r.ok && r.args.forcePush).toBe(false);
		expect(r.ok && r.args.rebase).toBe(true);
	});

	test("parses the full flag set", () => {
		const r = parsePrepareArgs(["--branch", "feat/x", "--base", "origin/main", "--create", "--rebase", "--force-push", "--dry-run"]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.args).toMatchObject({
			branch: "feat/x",
			base: "origin/main",
			create: true,
			rebase: true,
			forcePush: true,
			dryRun: true,
		});
	});
});

describe("verify-merge-cli", () => {
	test("requires a positive-integer PR number", () => {
		expect(parseVerifyMergeArgs([]).ok).toBe(false);
		expect(parseVerifyMergeArgs(["0"]).ok).toBe(false);
		expect(parseVerifyMergeArgs(["not-a-number"]).ok).toBe(false);
		expect(parseVerifyMergeArgs(["1360"]).ok).toBe(true);
	});

	test("parses --scope into prefixes", () => {
		const r = parseVerifyMergeArgs(["1360", "--scope", "bun-apps/, docs/"]);
		expect(r.ok && r.args).toMatchObject({ pr: 1360, expectedScope: ["bun-apps/", "docs/"] });
	});

	test("rejects a second positional", () => {
		expect(parseVerifyMergeArgs(["1", "2"]).ok).toBe(false);
	});

	test("CONTAMINATED exits 1 even though the PR really did merge", async () => {
		const res = await runVerifyMergeCli(["7", "--scope", "bun-apps/"], {
			gh: {
				prStatus: async () => ({
					state: "MERGED",
					mergeState: "CLEAN",
					baseRefName: "main",
					headRefName: "feat/x",
					mergeSha: "deadbee",
					checks: { total: 0, passed: 0, failed: 0, pending: 0 },
				}),
			} as never,
			client: {
				defaultBranch: async () => "main",
				containedBranches: async () => new Set(["feat/x"]),
				revParse: async () => "deadbee",
			} as never,
			spawn: (async (_c: string, args: string[]) =>
				args.includes("--numstat")
					? { stdout: "1\t1\tscripts/rogue.sh\n", stderr: "", exitCode: 0 }
					: { stdout: "", stderr: "", exitCode: 0 }) as never,
			repoRoot: REPO,
		});
		const out = JSON.parse(res.stdout);
		expect(out.merged).toBe(true);
		expect(out.verdict).toBe("CONTAMINATED");
		expect(res.exitCode).toBe(1);
	});
});

describe("the JSON-on-stdout contract survives an IN-PROCESS printer", () => {
	// Found by real-running main-health-cli against this repo: runSchemaCostCheck
	// is an IMPORT, not a spawn, so its comparison banner went to the CLI's own
	// stdout and made the payload unparseable. Every fake-driven test above still
	// passed, because a fake never reaches that code path.
	test("runSchemaCostCheck writes its banner to an injected sink, not console.log", async () => {
		const lines: string[] = [];
		const spawn = (async () => ({
			stdout: JSON.stringify({ totalTokens: 100, tools: 3 }),
			stderr: "",
			exitCode: 0,
		})) as never;
		await runSchemaCostCheck({
			repoRoot: REPO,
			spawn,
			baseline: BASELINE_FIXTURE,
			log: (l: string) => lines.push(l),
		});
		expect(lines.join("\n")).toContain("schema-cost regression");
	});

	test("runLocalCi forwards its log sink, so a CLI can keep stdout pure", async () => {
		const lines: string[] = [];
		const out = await runLocalCi({
			repoRoot: REPO,
			packages: [],
			spawn: (async (cmd: string, args: string[]) =>
				cmd === "git" && args.includes("--verify")
					? { stdout: "deadbeef\n", stderr: "", exitCode: 0 }
					: { stdout: JSON.stringify({ totalTokens: 100, tools: 3 }), stderr: "", exitCode: 0 }) as never,
			readGates: async () => ({ gates: [{ name: "g", cwd: ".", run: "true" }] }),
			schemaCostBaseline: BASELINE_FIXTURE,
			log: (l: string) => lines.push(l),
		});
		expect(out.schemaCost).toBeDefined();
		expect(lines.join("\n")).toContain("schema-cost regression");
	});
})
