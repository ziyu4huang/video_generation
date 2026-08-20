/**
 * The buildDeployArgv half of this suite went with the four legacy deploy
 * modes — the sh deploy is a typed call (runShDeploy), not an argv, and its
 * params→options mapping is covered in deploy-tool.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { buildVerifyArgv } from "../src/deploy-argv.ts";

describe("buildVerifyArgv", () => {
	test("defaults to medium tier", () => {
		expect(buildVerifyArgv()).toEqual(["medium"]);
	});
	test("tier + bail", () => {
		expect(buildVerifyArgv({ tier: "full", bail: true })).toEqual(["full", "--bail"]);
	});
	test("all tiers pass through", () => {
		for (const t of ["quick", "medium", "full"] as const) {
			expect(buildVerifyArgv({ tier: t })).toEqual([t]);
		}
	});
});
