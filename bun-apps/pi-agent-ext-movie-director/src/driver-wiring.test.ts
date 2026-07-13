/**
 * driver-wiring.test.ts — wireProduce routes each stage to its producer and
 * executes the asset plan via dispatch (with chaining), all against fakes.
 */
import { describe, test, expect } from "bun:test";
import { wireProduce, type WireDeps, type DispatchLike } from "./driver-wiring.ts";
import type { WaypointDeps } from "./waypoints.ts";

function makeWireDeps(over: Partial<WireDeps> = {}): WireDeps {
	const defaults: WireDeps = {
		dispatchFn: async () => ({ ok: true, text: JSON.stringify({ result: { artifacts: [{ path: "/tmp/clip.mp4" }] } }) }),
		waypointDeps: {
			completionFn: async () => JSON.stringify({ ok: true }),
			agentFn: async () => JSON.stringify({ data_points: [1, 2, 3] }),
			validateFn: async () => ({ valid: true }),
		},
		projectId: "demo",
		pipeline: "animated-explainer",
	};
	return { ...defaults, ...over };
}

describe("wireProduce — routing", () => {
	test("research → agent waypoint (research_brief artifact)", async () => {
		let called = "";
		const deps = makeWireDeps({
			waypointDeps: {
				completionFn: async () => "x",
				agentFn: async () => {
					called = "agent";
					return JSON.stringify({ data_points: [1] });
				},
				validateFn: async () => ({ valid: true }),
			},
		});
		const produce = wireProduce(deps);
		const out = await produce("research", { topic: "x" });
		expect(called).toBe("agent");
		expect(out).toHaveProperty("research_brief");
	});

	test("script → completion waypoint (script artifact)", async () => {
		let called = "";
		const deps = makeWireDeps({
			waypointDeps: {
				completionFn: async () => {
					called = "completion";
					return JSON.stringify({ sections: [] });
				},
				agentFn: async () => "x",
				validateFn: async () => ({ valid: true }),
			},
		});
		const out = await wireProduce(deps)("script", { topic: "x" });
		expect(called).toBe("completion");
		expect(out).toHaveProperty("script");
	});
});

describe("wireProduce — assets execution (the frozen-frame fix, wired)", () => {
	function assetsDeps() {
		const genCalls: Record<string, unknown>[] = [];
		const dispatchFn: DispatchLike = async (command, opts) => {
			if (command === "generate") genCalls.push(opts);
			return { ok: true, text: JSON.stringify({ result: { artifacts: [{ path: `/tmp/${(opts as any).command}-${(opts as any).sceneId ?? "x"}.mp4` }] } }) };
		};
		const extractLastFrame = async (clip: string) => `${clip}.lastframe.png`;
		return { deps: makeWireDeps({ dispatchFn, extractLastFrame }), genCalls };
	}

	test("executes the plan with frames = ceil(duration × fps)", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 6 }] },
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const vids = genCalls.filter((c) => c.capability === "video_generation");
		expect(vids).toHaveLength(1);
		expect(vids[0]!.options).toMatchObject({ frames: 150, fps: 25 });
	});

	test("chaining: a >8s scene yields multiple I2V calls; links after the first carry `image`", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 16 }] },
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const vids = genCalls.filter((c) => c.capability === "video_generation");
		expect(vids).toHaveLength(2); // ceil(16/8)
		expect(vids[0]!.options).not.toHaveProperty("image"); // first link: no continuation frame
		expect(vids[1]!.options).toHaveProperty("image"); // second link continues from prior last frame
		expect(vids[1]!.options.image).toMatch(/lastframe\.png$/);
	});

	test("returns an asset_manifest", async () => {
		const { deps } = assetsDeps();
		const out = await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "generated", description: "x", start_seconds: 0, end_seconds: 6 }] },
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		expect(out).toHaveProperty("asset_manifest");
	});
});

describe("wireProduce — compose / publish", () => {
	test("compose → dispatch compose-motion with render_runtime ffmpeg", async () => {
		const calls: Record<string, unknown>[] = [];
		const dispatchFn: DispatchLike = async (command, opts) => {
			calls.push({ command, opts });
			if (command === "compose-motion") return { ok: true, text: JSON.stringify({ output: "/tmp/final.mp4", render_grammar: "motion" }) };
			return { ok: true, text: JSON.stringify({ ok: true }) };
		};
		await wireProduce(makeWireDeps({ dispatchFn }))("compose", { edit_decisions: { version: "1.0", cuts: [], render_runtime: "ffmpeg" } });
		const compose = calls.find((c) => c.command === "compose-motion");
		expect(compose).toBeTruthy();
	});

	test("publish → dispatch final-review on the rendered mp4", async () => {
		const calls: Record<string, unknown>[] = [];
		const dispatchFn: DispatchLike = async (command, opts) => {
			calls.push({ command, opts });
			return { ok: true, text: JSON.stringify({ verdict: "pass" }) };
		};
		await wireProduce(makeWireDeps({ dispatchFn }))("publish", { render_report: { output: "/tmp/final.mp4" } });
		expect(calls.some((c) => c.command === "final-review")).toBe(true);
	});
});
