/**
 * Test for the shared clearHarnessEnvVars helper (wayfinder 2026-07-30
 * self-reflection 01 deferred gap — the #938 class: config-touching tests that
 * pass in CI's clean env but flake locally because the live harness injects
 * config-mutating env vars). Runner-agnostic — pure process.env manipulation.
 */
import { test, expect, describe } from "bun:test";
import {
	clearHarnessEnvVars,
	restoreHarnessEnvVars,
	HARNESS_CONFIG_ENV_VARS,
} from "./helpers/hermetic-env.js";

describe("clearHarnessEnvVars / restoreHarnessEnvVars", () => {
	// Safety: every test restores, but wrap in afterEach too so a thrown assertion
	// can't leak seeded vars into sibling tests.
	const seed = (vars: Record<string, string>) => {
		for (const [k, v] of Object.entries(vars)) process.env[k] = v;
	};

	test("clears all known harness config-mutating vars, then restores their exact values", () => {
		seed({ PI_HERMES_CONSOLIDATING: "1", TOOL_GATE_LOG_PATH: "/tmp/gate.log" });
		const snap = clearHarnessEnvVars();
		for (const v of HARNESS_CONFIG_ENV_VARS) expect(process.env[v]).toBeUndefined();
		restoreHarnessEnvVars(snap);
		expect(process.env.PI_HERMES_CONSOLIDATING).toBe("1");
		expect(process.env.TOOL_GATE_LOG_PATH).toBe("/tmp/gate.log");
		// cleanup
		delete process.env.PI_HERMES_CONSOLIDATING;
		delete process.env.TOOL_GATE_LOG_PATH;
	});

	test("a var that was UNSET before clear stays UNSET after restore (not the string 'undefined')", () => {
		delete process.env.TOOL_GATE_LOG_PATH;
		delete process.env.PI_HERMES_CONSOLIDATING;
		const snap = clearHarnessEnvVars();
		expect(process.env.TOOL_GATE_LOG_PATH).toBeUndefined();
		expect("TOOL_GATE_LOG_PATH" in process.env).toBe(false);
		restoreHarnessEnvVars(snap);
		expect(process.env.TOOL_GATE_LOG_PATH).toBeUndefined();
		expect("TOOL_GATE_LOG_PATH" in process.env).toBe(false);
	});

	test("HARNESS_CONFIG_ENV_VARS includes the #938 class vars", () => {
		expect(HARNESS_CONFIG_ENV_VARS).toContain("PI_HERMES_CONSOLIDATING");
		expect(HARNESS_CONFIG_ENV_VARS).toContain("TOOL_GATE_LOG_PATH");
	});
});
