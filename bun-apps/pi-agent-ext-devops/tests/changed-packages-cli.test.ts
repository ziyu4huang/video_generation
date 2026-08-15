/**
 * Tests for the bash-callable `changed-packages-cli.ts` wrapper.
 *
 * The wrapper is what the `changed_packages` job in .github/workflows/
 * ci.yml.disabled shells out to, so what is pinned here is the JOB'S CONTRACT,
 * not detection logic (that lives in tests/changed-packages.test.ts):
 *  - the two argv forms the retired bash script accepted (`--all`, `<base> <head>`),
 *  - stdout is ONE line of compact JSON (a GITHUB_OUTPUT value cannot span lines),
 *  - diagnostics never leak into stdout,
 *  - usage errors exit non-zero rather than printing an empty/partial map (an
 *    empty map would make every `fromJSON(...)[matrix.package] == true` gate read
 *    false → every package silently skipped).
 *
 * `spawn` is injected, so no real git repo is touched. One end-to-end case
 * additionally SPAWNS the real file against this repo, to prove the shebang entry
 * actually runs and emits parseable JSON keyed by every workspace package.
 */
import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
	runChangedPackagesCli,
	defaultRepoRoot,
	CHANGED_PACKAGES_CLI_USAGE,
} from "../src/changed-packages-cli.js";
import type { SpawnFn } from "../src/spawn.js";

const REPO = "/repo";

/** Fake git: canned `git diff --name-only` output + a resolvable `rev-parse`. */
function mkSpawn(diffStdout = ""): { fn: SpawnFn; calls: { cmd: string; args: string[] }[] } {
	const calls: { cmd: string; args: string[] }[] = [];
	const fn: SpawnFn = async (cmd, args) => {
		calls.push({ cmd, args });
		if (cmd === "git" && args[0] === "diff") return { stdout: diffStdout, stderr: "", exitCode: 0 };
		return { stdout: "deadbeef\n", stderr: "", exitCode: 0 };
	};
	return { fn, calls };
}

describe("changed-packages-cli — argv contract", () => {
	test("--all emits every discovered package as true, on one compact JSON line", async () => {
		const { fn, calls } = mkSpawn();
		const res = await runChangedPackagesCli(["--all"], { spawn: fn, repoRoot: defaultRepoRoot() });
		expect(res.exitCode).toBe(0);
		expect(res.stderr).toBe("");
		// single line — `echo "packages=$json" >> "$GITHUB_OUTPUT"` requires it.
		expect(res.stdout.includes("\n")).toBe(false);
		const map = JSON.parse(res.stdout) as Record<string, boolean>;
		expect(Object.keys(map).length).toBeGreaterThan(20);
		expect(Object.values(map).every((v) => v === true)).toBe(true);
		// --all short-circuits before any git call (same as the retired bash).
		expect(calls.length).toBe(0);
	});

	test("<base> <head> runs the diff and returns the affected subset", async () => {
		const { fn, calls } = mkSpawn("bun-apps/pi-agent-ext-devops/src/gh.ts\n");
		const res = await runChangedPackagesCli(["base-sha", "head-sha"], { spawn: fn, repoRoot: defaultRepoRoot() });
		expect(res.exitCode).toBe(0);
		const map = JSON.parse(res.stdout) as Record<string, boolean>;
		expect(map["pi-agent-ext-devops"]).toBe(true);
		// a package with no edge to devops is NOT affected → the routing saving.
		expect(map["pi-agent-ext-ltx"]).toBe(false);
		// the refs are passed through to `git diff` as a THREE-dot range, so scope
		// is what this branch changed since the merge-base — not the symmetric
		// difference with a base that keeps moving.
		const diff = calls.find((c) => c.args[0] === "diff");
		expect(diff?.args).toEqual(["diff", "--name-only", "base-sha...head-sha"]);
	});

	test("fail-open survives the wrapper: a file outside bun-apps/<pkg>/ → all true", async () => {
		const { fn } = mkSpawn("scripts/ci-local.sh\n");
		const res = await runChangedPackagesCli(["a", "b"], { spawn: fn, repoRoot: defaultRepoRoot() });
		const map = JSON.parse(res.stdout) as Record<string, boolean>;
		expect(Object.values(map).every((v) => v === true)).toBe(true);
	});

	test("--repo-root overrides the inferred root", async () => {
		const { fn } = mkSpawn();
		const res = await runChangedPackagesCli(["--all", "--repo-root", REPO], { spawn: fn });
		// /repo/bun-apps does not exist → an EMPTY map, not a throw.
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("{}");
	});

	test("usage errors exit 2 with an empty stdout (never a partial map)", async () => {
		for (const argv of [[], ["only-one-ref"], ["a", "b", "c"], ["--nope"], ["--repo-root"]]) {
			const res = await runChangedPackagesCli(argv, { spawn: mkSpawn().fn, repoRoot: defaultRepoRoot() });
			expect(res.exitCode).toBe(2);
			expect(res.stdout).toBe("");
			expect(res.stderr.length).toBeGreaterThan(0);
		}
	});

	test("--help exits 0 with usage on stderr, nothing on stdout", async () => {
		const res = await runChangedPackagesCli(["--help"], { spawn: mkSpawn().fn });
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("");
		expect(res.stderr).toBe(CHANGED_PACKAGES_CLI_USAGE);
	});
});

describe("changed-packages-cli — live entry point", () => {
	test("`bun src/changed-packages-cli.ts --all` prints JSON covering every workspace package", () => {
		const cli = join(import.meta.dir, "..", "src", "changed-packages-cli.ts");
		// PORTABILITY-GUARDED: spawns `bun` (the runtime already executing this
		// test) on a committed file in this repo — no machine-coupled host binary.
		const r = spawnSync("bun", [cli, "--all"], { encoding: "utf8" });
		expect(r.status).toBe(0);
		expect(r.stdout.trim().includes("\n")).toBe(false);
		const map = JSON.parse(r.stdout) as Record<string, boolean>;
		expect(map["pi-agent-ext-devops"]).toBe(true);
		expect(map["pi-agent"]).toBe(true);
	});
});
