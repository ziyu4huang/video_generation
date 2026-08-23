/**
 * pi_deploy now delegates to runShDeploy (a typed call), so there is no human
 * output left to scrape — the old parseDeployOutput regex suite is gone with
 * the pipeline it parsed. What remains worth testing is the params→options
 * mapping and the failure shaping, plus the post-deploy E2E wiring (the seam
 * is injected — the model-call probe must never run in unit tests).
 */
import { describe, expect, test } from "bun:test";
import { runDeploy } from "../src/deploy-tool.ts";
import { DeployVersionExistsError } from "../src/deploy/run.ts";
import type { DeployE2eOutcome } from "../src/deploy-e2e-recipe.js";

const e2ePass = (verdict: DeployE2eOutcome["verdict"] = "pass"): DeployE2eOutcome => ({
	versionDir: "/tmp/x/0.1.0+gabc1234",
	version: "0.1.0+gabc1234",
	sourceSha: "abc1234",
	probes: [],
	warnings: [],
	verdict,
	note: `${verdict} (fake)`,
	durationMs: 0,
});

describe("runDeploy", () => {
	test("maps params onto DeployShOptions and passes the cache/prune facts through", async () => {
		let seen: unknown = null;
		const r = await runDeploy(
			{ force: true, noFreeze: true },
			{
				deploy: async (opts) => {
					seen = opts;
					return {
						version: "0.1.0+gabc1234",
						target: "/tmp/x/0.1.0+gabc1234",
						extensions: [{ name: "power-tool", bytes: 1000 }],
						coreBytes: 70_000_000,
						coreCached: true,
						currentUpdated: false,
						pruned: ["0.1.0+gold0000"],
						prunedCores: [{ hash: "a".repeat(64), bytes: 89_523_400 }],
						runtime: { bunVersion: "1.4.0", platform: "darwin", arch: "arm64", bytes: 63_558_256, cached: true },
						prunedBuns: [],
					};
				},
				e2e: async () => e2ePass(),
			},
		);
		expect(seen).toMatchObject({ force: true, freeze: false });
		expect(r.ok).toBe(true);
		expect(r.version).toBe("0.1.0+gabc1234");
		expect(r.extensions).toEqual([{ name: "power-tool", bytes: 1000 }]);
		expect(r.coreCached).toBe(true);
		expect(r.pruned).toEqual(["0.1.0+gold0000"]);
		expect(r.e2e?.verdict).toBe("pass");
	});

	test("omits every option the caller did not ask for", async () => {
		// An option present-but-false is NOT the same as absent: runShDeploy reads
		// `opts.freeze ?? cfg.freeze`, so passing `freeze: undefined` would be
		// harmless but passing `freeze: false` unconditionally would silently stop
		// honouring the config's `freeze: true`.
		let seen: Record<string, unknown> = {};
		await runDeploy(
			{},
			{
				deploy: async (opts) => {
					seen = opts as Record<string, unknown>;
					return {
						version: "v",
						target: "/tmp/x",
						extensions: [],
						coreBytes: 0,
						coreCached: false,
						currentUpdated: true,
						pruned: [],
						prunedCores: [],
						runtime: { bunVersion: "1.4.0", platform: "darwin", arch: "arm64", bytes: 0, cached: false },
						prunedBuns: [],
					};
				},
				e2e: async () => e2ePass(),
			},
		);
		expect(Object.keys(seen)).toEqual([]);
	});

	test("a throwing deploy becomes { ok:false } with the message, not an exception", async () => {
		const r = await runDeploy(
			{},
			{
				deploy: async () => {
					throw new Error("bundle references specifier(s) the host does not provide: foo");
				},
			},
		);
		expect(r.ok).toBe(false);
		expect(r.errorTail).toContain("host does not provide");
	});

	test("a re-deploy of an existing version is a NO-OP success, not a failure", async () => {
		// The version dir is content-addressed by git sha — an existing target
		// means the same tree state was already deployed. That is a no-op
		// success (scripts must be able to distinguish it from a real failure:
		// `ok:false` here previously sent callers to diagnose a healthy deploy).
		const r = await runDeploy(
			{},
			{
				deploy: async () => {
					throw new DeployVersionExistsError("0.1.0+gabc1234", "/dist/s2-agent-sh/0.1.0+gabc1234");
				},
				e2e: async () => e2ePass(),
			},
		);
		expect(r.ok).toBe(true);
		expect(r.noop).toBe(true);
		expect(r.version).toBe("0.1.0+gabc1234");
		expect(r.target).toBe("/dist/s2-agent-sh/0.1.0+gabc1234");
		expect(r.message).toContain("--force");
		expect(r.e2e?.verdict).toBe("pass");
	});

	test("a PASSING post-deploy E2E keeps ok true; a failing one flips it", async () => {
		const deployOk = async () => ({
			version: "v",
			target: "/tmp/x/v",
			extensions: [],
			coreBytes: 0,
			coreCached: false,
			currentUpdated: true,
			pruned: [],
			prunedCores: [],
			runtime: { bunVersion: "1.4.0", platform: "darwin", arch: "arm64", bytes: 0, cached: false },
			prunedBuns: [],
		});
		const good = await runDeploy({}, { deploy: deployOk, e2e: async () => e2ePass() });
		expect(good.ok).toBe(true);
		expect(good.e2e?.verdict).toBe("pass");

		const bad = await runDeploy({}, { deploy: deployOk, e2e: async () => e2ePass("fail") });
		expect(bad.ok).toBe(false);
		expect(bad.e2e?.verdict).toBe("fail");
	});

	test("a provider-down E2E (SKIP) is not a deploy failure", async () => {
		const deployOk = async () => ({
			version: "v",
			target: "/tmp/x/v",
			extensions: [],
			coreBytes: 0,
			coreCached: false,
			currentUpdated: true,
			pruned: [],
			prunedCores: [],
			runtime: { bunVersion: "1.4.0", platform: "darwin", arch: "arm64", bytes: 0, cached: false },
			prunedBuns: [],
		});
		const r = await runDeploy({}, { deploy: deployOk, e2e: async () => e2ePass("skip") });
		expect(r.ok).toBe(true);
		expect(r.e2e?.verdict).toBe("skip");
	});
});
