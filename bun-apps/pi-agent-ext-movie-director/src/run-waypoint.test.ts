/**
 * run-waypoint.test.ts — the dispatch `run-waypoint` case (per-stage iteration
 * harness), with waypointDeps injected (no MLX, no real pi session). Plus the
 * COMMANDS / CLI auto-wire checks.
 */
import { describe, test, expect } from "bun:test";
import { dispatch, COMMANDS } from "./dispatch.ts";
import { COMMAND_NAMES } from "./commands.ts";
import type { WaypointDeps } from "./waypoints.ts";

function fakeWaypointDeps(): WaypointDeps {
	return {
		completionFn: async () => JSON.stringify({ sections: [{ id: "s1", text: "hi" }] }),
		agentFn: async () => JSON.stringify({ data_points: [1, 2, 3] }),
		validateFn: async () => ({ valid: true }),
	};
}

describe("dispatch run-waypoint — wiring", () => {
	test("runs ONE completion stage and returns {stage, valid, artifact}", async () => {
		const res = await dispatch(
			"run-waypoint",
			{ stage: "script", inputs: { topic: "x" } },
			{ waypointDeps: fakeWaypointDeps() },
		);
		expect(res.ok).toBe(true);
		if (res.ok) {
			const parsed = JSON.parse(res.text) as { stage: string; valid: boolean; artifact: { sections: unknown[] } };
			expect(parsed.stage).toBe("script");
			expect(parsed.valid).toBe(true);
			expect(parsed.artifact.sections).toHaveLength(1);
		}
	});

	test("rejects a mechanical stage (assets) with a clear error", async () => {
		const res = await dispatch("run-waypoint", { stage: "assets" }, { waypointDeps: fakeWaypointDeps() });
		expect(res.ok).toBe(false);
	});

	test("returns valid:false (not a throw) when the waypoint exhausts retries", async () => {
		const bad: WaypointDeps = {
			completionFn: async () => "not even json",
			agentFn: async () => "not even json",
			validateFn: async () => ({ valid: false, errors: "bad" }),
		};
		const res = await dispatch(
			"run-waypoint",
			{ stage: "script", inputs: {}, maxRetries: 1 },
			{ waypointDeps: bad },
		);
		expect(res.ok).toBe(true);
		if (res.ok) {
			const parsed = JSON.parse(res.text) as { valid: boolean; errors: string };
			expect(parsed.valid).toBe(false);
			expect(parsed.errors).toContain("exhausted");
		}
	});
});

describe("dispatch run-waypoint — surface", () => {
	test("run-waypoint is in COMMANDS (movie tool)", () => {
		expect(COMMANDS).toContain("run-waypoint");
	});
	test("run-waypoint is auto-wired into the CLI (COMMAND_NAMES)", () => {
		expect(COMMAND_NAMES.has("run-waypoint")).toBe(true);
	});
});
