/**
 * run-pipeline.integration.test.ts — the dispatch `run-pipeline` case wires the
 * driver + wireProduce + waypoints end-to-end, with innerDispatch + waypointDeps
 * injected (no MLX, no real pi session). Plus COMMANDS / CLI auto-wire checks.
 */
import { describe, test, expect } from "bun:test";
import { dispatch, COMMANDS, type DispatchDeps } from "./dispatch.ts";
import { COMMAND_NAMES } from "./commands.ts";
import type { WaypointDeps } from "./waypoints.ts";

/** Fake inner dispatch: in-memory checkpoints + auto-success for mechanical calls. */
function makeFakeInner() {
	const checkpoints = new Map<string, Record<string, unknown>>();
	const inner: DispatchDeps["innerDispatch"] = async (command, opts) => {
		const key = `${opts.projectId}:${opts.stage}`;
		if (command === "write-checkpoint") {
			checkpoints.set(key, opts);
			return { ok: true, text: JSON.stringify({ recorded: true }) };
		}
		if (command === "read-checkpoint") {
			const completed = [...checkpoints.entries()]
				.filter(([k]) => k.startsWith(`${opts.projectId}:`))
				.filter(([, v]) => v.status === "completed")
				.map(([k]) => k.split(":")[1]!);
			return { ok: true, text: JSON.stringify({ checkpoint: null, completedStages: completed }) };
		}
		if (command === "validate-artifact") return { ok: true, text: JSON.stringify({ valid: true }) };
		// generate / compose-motion / final-review → success
		if (command === "generate") {
			if (opts.command === "native-relay") {
				// One segment_N artifact per requested relay link, matching produceAssets's
				// expectation (see driver-wiring.ts's segment-count guard).
				const linkCount = ((opts.options as Record<string, unknown> | undefined)?.secondsPerSegment as unknown[] | undefined)?.length ?? 1;
				const segmentArtifacts = Array.from({ length: linkCount }, (_, i) => ({
					path: `/tmp/relay/seg0${i + 1}/segment.mp4`,
					role: `segment_${i + 1}`,
				}));
				return { ok: true, text: JSON.stringify({ result: { artifacts: [{ path: "/tmp/c.mp4" }, ...segmentArtifacts] } }) };
			}
			return { ok: true, text: JSON.stringify({ result: { artifacts: [{ path: "/tmp/c.mp4" }] } }) };
		}
		if (command === "compose-motion") return { ok: true, text: JSON.stringify({ output: "/tmp/final.mp4" }) };
		if (command === "final-review") return { ok: true, text: JSON.stringify({ verdict: "pass" }) };
		return { ok: true, text: JSON.stringify({ ok: true }) };
	};
	return { inner, checkpoints };
}

/** Stage-aware fake completion: returns a minimal valid artifact parsed from the system prompt. */
function stageAwareCompletion(): WaypointDeps["completionFn"] {
	return async (system) => {
		const m = system.match(/You are the (\w+) director/);
		const stage = m?.[1] ?? "x";
		const body: Record<string, unknown> = {
			research: { data_points: [1, 2, 3] },
			proposal: { concept_options: [{ id: "a" }], selected_concept: { concept_id: "a" } },
			script: { sections: [{ id: "s1", text: "hi" }] },
			scene_plan: { scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 6 }] },
			edit: { version: "1.0", cuts: [], render_runtime: "ffmpeg" },
		}[stage] ?? { ok: true };
		return JSON.stringify(body);
	};
}

function makeWaypointDeps(): WaypointDeps {
	return {
		completionFn: stageAwareCompletion(),
		agentFn: async () => JSON.stringify({ data_points: [1, 2, 3] }),
		validateFn: async () => ({ valid: true }),
	};
}

describe("dispatch run-pipeline — wiring", () => {
	test("drives all 8 stages to completed via the wired driver", async () => {
		const { inner, checkpoints } = makeFakeInner();
		const res = await dispatch(
			"run-pipeline",
			{ projectId: "demo", topic: "x", pipeline: "animated-explainer" },
			{ innerDispatch: inner, waypointDeps: makeWaypointDeps() },
		);
		expect(res.ok).toBe(true);
		if (res.ok) {
			const parsed = JSON.parse(res.text) as { status: string; stages: string[] };
			expect(parsed.status).toBe("completed");
			expect(parsed.stages).toHaveLength(8);
		}
		// every stage got a completed checkpoint
		for (const s of ["research", "proposal", "script", "scene_plan", "assets", "edit", "compose", "publish"]) {
			expect(checkpoints.get(`demo:${s}`)?.status).toBe("completed");
		}
	});

	test("the assets stage passes a single native-relay call with segment seconds derived from the scene's real duration", async () => {
		const genCalls: Record<string, unknown>[] = [];
		const base = makeFakeInner();
		const inner: DispatchDeps["innerDispatch"] = async (command, opts) => {
			if (command === "generate") genCalls.push(opts);
			return base.inner(command, opts);
		};
		await dispatch(
			"run-pipeline",
			{ projectId: "demo", topic: "x", pipeline: "animated-explainer" },
			{ innerDispatch: inner, waypointDeps: makeWaypointDeps() },
		);
		const vids = genCalls.filter((c) => c.capability === "video_generation");
		expect(vids).toHaveLength(1); // ONE native-relay call for the whole movie, not one per scene/link
		expect(vids[0]!.command).toBe("native-relay");
		// scene is 6s, under the default 8s per-link ceiling → a single 6s relay link
		expect(vids[0]!.options).toMatchObject({ secondsPerSegment: [6], segmentContinuity: [true] });
	});

	test("requireHumanApproval pauses at the named stage", async () => {
		const { inner } = makeFakeInner();
		const res = await dispatch(
			"run-pipeline",
			{ projectId: "demo", topic: "x", pipeline: "animated-explainer", requireHumanApproval: "script" },
			{ innerDispatch: inner, waypointDeps: makeWaypointDeps() },
		);
		expect(res.ok).toBe(true);
		if (res.ok) {
			const parsed = JSON.parse(res.text) as { status: string; stage: string };
			expect(parsed.status).toBe("paused");
			expect(parsed.stage).toBe("script");
		}
	});
});

describe("dispatch run-pipeline — surface", () => {
	test("run-pipeline is in COMMANDS (movie tool)", () => {
		expect(COMMANDS).toContain("run-pipeline");
	});
	test("run-pipeline is auto-wired into the CLI (COMMAND_NAMES)", () => {
		expect(COMMAND_NAMES.has("run-pipeline")).toBe(true);
	});
});
