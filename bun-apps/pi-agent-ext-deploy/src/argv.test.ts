import { describe, expect, test } from "bun:test";
import { buildDeployArgv, buildVerifyArgv } from "./argv.ts";

describe("buildDeployArgv", () => {
	test("defaults to --bundle, no outDir, no --no-freeze", () => {
		expect(buildDeployArgv()).toEqual(["--bundle"]);
	});
	test("mode → flag, noFreeze appended last", () => {
		expect(buildDeployArgv({ mode: "standalone", noFreeze: true })).toEqual(["--standalone", "--no-freeze"]);
	});
	test("snapshot + exe modes", () => {
		expect(buildDeployArgv({ mode: "snapshot" })).toEqual(["--snapshot"]);
		expect(buildDeployArgv({ mode: "exe" })).toEqual(["--exe"]);
	});
	test("outDir is positional, placed before flags", () => {
		expect(buildDeployArgv({ outDir: "/tmp/out", mode: "bundle", noFreeze: true }))
			.toEqual(["/tmp/out", "--bundle", "--no-freeze"]);
	});
});

describe("buildVerifyArgv", () => {
	test("defaults to medium tier", () => {
		expect(buildVerifyArgv()).toEqual(["medium"]);
	});
	test("tier + bail", () => {
		expect(buildVerifyArgv({ tier: "high", bail: true })).toEqual(["high", "--bail"]);
	});
	test("all tiers pass through", () => {
		for (const t of ["quick", "medium", "high", "readonly", "full"] as const) {
			expect(buildVerifyArgv({ tier: t })).toEqual([t]);
		}
	});
});
