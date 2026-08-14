/**
 * Tests for the `devops-verify-deploy` bin (`src/verify-deploy-cli.ts`) — the
 * TS port of the deleted root `scripts/verify-deploy.sh` (final part of the
 * devops-scripts unification).
 *
 * What is pinned here is the BIN'S CONTRACT, not the deployed artifact (that
 * is exercised by the real run): step order + composition of the NOW-LOCAL
 * devops scripts, the JSON shape on stdout, exit-code mapping (0 green / 1 any
 * step failed / 2 usage), fail-loudly-on-first-break (no later steps after a
 * failure), tmp-deploy-dir lifecycle (--keep-deploy / default cleanup), and
 * throw-freedom (a throwing spawn is a failed step, never a rejection).
 *
 * Mirrors the dual-seam style of tests/sync-cli.test.ts: a recording SpawnFn
 * plus stubbed mkTempDir/removeDir. No real build / filesystem mutation.
 */
import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
	runVerifyDeployCli,
	parseVerifyDeployArgs,
	VERIFY_DEPLOY_USAGE,
} from "../src/verify-deploy-cli.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const REPO = "/repo";
const TMP_DEPLOY = "/tmp/devops-verify-deploy-fake";

interface RecordedCall {
	cmd: string;
	args: string[];
	cwd?: string;
}

/**
 * Offline fake: a recording SpawnFn + stubbed fs seams. `failOn` matches a
 * substring of the command display (`cmd args.join(" ")`) to force an exit
 * code; `throwOn` makes the spawn throw (throw-freedom probe).
 */
function fakeDeps(opts: { failOn?: string; throwOn?: string } = {}) {
	const calls: RecordedCall[] = [];
	const removed: string[] = [];
	const display = (cmd: string, args: string[]) => `${cmd} ${args.join(" ")}`;
	const spawn: SpawnFn = async (cmd, args, options): Promise<SpawnResult> => {
		calls.push({ cmd, args, cwd: options?.cwd });
		const d = display(cmd, args);
		if (opts.throwOn && d.includes(opts.throwOn)) throw new Error("spawn boom");
		if (opts.failOn && d.includes(opts.failOn)) return { stdout: "", stderr: "fake failure", exitCode: 1 };
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return {
		deps: {
			spawn,
			repoRoot: REPO,
			mkTempDir: () => TMP_DEPLOY,
			removeDir: (p: string) => removed.push(p),
		},
		calls,
		removed,
		display,
	};
}

describe("parseVerifyDeployArgs — argv contract", () => {
	test("defaults: run install, clean up the deploy dir", () => {
		const r = parseVerifyDeployArgs([]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.skipInstall).toBe(false);
			expect(r.args.keepDeploy).toBe(false);
			expect(r.args.repoRoot).toBeUndefined();
		}
	});

	test("--skip-install / --keep-deploy / --repo-root <path> parse", () => {
		const r = parseVerifyDeployArgs(["--skip-install", "--keep-deploy", "--repo-root", "/x"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.skipInstall).toBe(true);
			expect(r.args.keepDeploy).toBe(true);
			expect(r.args.repoRoot).toBe("/x");
		}
	});

	test("unknown flags, positionals, and a missing --repo-root value are usage errors", () => {
		expect(parseVerifyDeployArgs(["--nope"]).ok).toBe(false);
		expect(parseVerifyDeployArgs(["extra"]).ok).toBe(false);
		expect(parseVerifyDeployArgs(["--repo-root"]).ok).toBe(false);
	});
});

describe("verify-deploy-cli — pipeline contract", () => {
	test("happy path: 5 green steps, exit 0, structured JSON on stdout, deploy dir cleaned up", async () => {
		const f = fakeDeps();
		const res = await runVerifyDeployCli([], f.deps);
		expect(res.exitCode).toBe(0);
		expect(res.stderr).toBe("");
		const out = JSON.parse(res.stdout);
		expect(out.overall).toBe("pass");
		expect(out.steps.map((s: { name: string }) => s.name)).toEqual([
			"install",
			"quick-tests",
			"bundle-deploy",
			"smoke",
			"foreign-cwd",
		]);
		expect(out.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
		expect(typeof out.elapsedMs).toBe("number");
		expect(out.deployDir).toBeUndefined(); // cleaned up → not echoed

		// Composes the NOW-LOCAL scripts with the right cwds.
		expect(f.calls[0]).toEqual({ cmd: "bun", args: ["install"], cwd: join(REPO, "bun-apps") });
		expect(f.calls[1]?.cmd).toBe("bash");
		expect(f.calls[1]?.args[0]).toBe(join(REPO, "bun-apps/pi-agent-ext-devops/scripts/run-test.sh"));
		expect(f.calls[1]?.args[1]).toBe("quick");
		expect(f.calls[2]?.cwd).toBe(join(REPO, "bun-apps/pi-agent")); // deploy.ts REQUIRES the pi-agent cwd
		expect(f.calls[2]?.args[0]).toBe(join(REPO, "bun-apps/pi-agent-ext-devops/scripts/deploy.ts"));
		expect(f.calls[2]?.args[1]).toBe(TMP_DEPLOY);
		expect(f.calls[2]?.args).toContain("--bundle");
		// Smoke boots the deployed artifact from the deploy dir.
		expect(f.calls[3]?.cwd).toBe(TMP_DEPLOY);
		expect(f.calls[3]?.args[0]).toBe(join(TMP_DEPLOY, "pi-agent.js"));
		expect(f.calls[4]?.args[0]).toBe(join(TMP_DEPLOY, "run.sh"));
		// Foreign-cwd probes boot from a non-repo cwd.
		expect(f.calls[5]?.cwd).not.toBe(TMP_DEPLOY);
		expect(f.calls[5]?.args[0]).toBe(join(TMP_DEPLOY, "pi-agent.js"));
		// The tmp deploy dir was removed.
		expect(f.removed).toEqual([TMP_DEPLOY]);
	});

	test("a failing step (run-test quick exit 1) → exit 1, step marked failed, chain stops there", async () => {
		const f = fakeDeps({ failOn: "run-test.sh quick" });
		const res = await runVerifyDeployCli([], f.deps);
		expect(res.exitCode).toBe(1);
		const out = JSON.parse(res.stdout);
		expect(out.overall).toBe("fail");
		const failed = out.steps.find((s: { name: string }) => s.name === "quick-tests");
		expect(failed.ok).toBe(false);
		expect(failed.exitCode).toBe(1);
		// Fail loudly on the FIRST break: no deploy/smoke/foreign spawns ran.
		expect(f.calls.filter((c) => c.args.some((a) => a.includes("deploy.ts")))).toHaveLength(0);
		expect(out.steps.some((s: { name: string }) => s.name === "smoke")).toBe(false);
	});

	test("--skip-install records a skipped step and never spawns `bun install`", async () => {
		const f = fakeDeps();
		const res = await runVerifyDeployCli(["--skip-install"], f.deps);
		expect(res.exitCode).toBe(0);
		const out = JSON.parse(res.stdout);
		const install = out.steps.find((s: { name: string }) => s.name === "install");
		expect(install.ok).toBe(true);
		expect(install.note).toBe("skipped (--skip-install)");
		expect(f.calls.some((c) => c.args[0] === "install")).toBe(false);
	});

	test("--keep-deploy skips cleanup and echoes the deploy dir in the JSON", async () => {
		const f = fakeDeps();
		const res = await runVerifyDeployCli(["--keep-deploy"], f.deps);
		expect(res.exitCode).toBe(0);
		expect(f.removed).toHaveLength(0);
		const out = JSON.parse(res.stdout);
		expect(out.deployDir).toBe(TMP_DEPLOY);
	});

	test("a throwing spawn is a failed step, never a rejection (throw-free)", async () => {
		const f = fakeDeps({ throwOn: "deploy.ts" });
		const res = await runVerifyDeployCli([], f.deps);
		expect(res.exitCode).toBe(1);
		const out = JSON.parse(res.stdout);
		const failed = out.steps.find((s: { name: string }) => s.name === "bundle-deploy");
		expect(failed.ok).toBe(false);
		expect(failed.exitCode).toBe(-1);
		expect(failed.note).toContain("spawn error");
	});

	test("usage errors exit 2 with empty stdout; --help exits 0 with usage on stderr", async () => {
		const f = fakeDeps();
		for (const argv of [["--nope"], ["--repo-root"], ["positional"]]) {
			const res = await runVerifyDeployCli(argv, f.deps);
			expect(res.exitCode).toBe(2);
			expect(res.stdout).toBe("");
			expect(res.stderr.includes(VERIFY_DEPLOY_USAGE)).toBe(true);
		}
		const help = await runVerifyDeployCli(["--help"], f.deps);
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toBe("");
		expect(help.stderr).toBe(VERIFY_DEPLOY_USAGE);
	});
});

describe("verify-deploy-cli — live entry point", () => {
	// PORTABILITY-GUARDED: spawns `process.execPath` on a committed file in this
	// repo; `--help` is read-only.
	test("`bun src/verify-deploy-cli.ts --help` exits 0 with usage", () => {
		const cli = join(import.meta.dir, "..", "src", "verify-deploy-cli.ts");
		const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
		expect(r.status).toBe(0);
		expect(r.stderr.includes("usage:")).toBe(true);
	});
});
