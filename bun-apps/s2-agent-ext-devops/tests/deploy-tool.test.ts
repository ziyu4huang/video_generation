/**
 * pi_deploy now delegates to runShDeploy (a typed call), so there is no human
 * output left to scrape — the old parseDeployOutput regex suite is gone with
 * the pipeline it parsed. What remains worth testing is the params→options
 * mapping and the failure shaping.
 */
import { describe, expect, test } from "bun:test";
import { runDeploy } from "../src/deploy-tool.ts";

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
					};
				},
			},
		);
		expect(seen).toMatchObject({ force: true, freeze: false });
		expect(r.ok).toBe(true);
		expect(r.version).toBe("0.1.0+gabc1234");
		expect(r.extensions).toEqual([{ name: "power-tool", bytes: 1000 }]);
		expect(r.coreCached).toBe(true);
		expect(r.pruned).toEqual(["0.1.0+gold0000"]);
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
					};
				},
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
});
