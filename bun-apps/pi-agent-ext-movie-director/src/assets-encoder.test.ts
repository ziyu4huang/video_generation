/**
 * assets-encoder.test.ts — the proactive asset-generation planner (the frozen-
 * frame fix). Pure logic: given a scene_plan + script, emit the exact generate
 * calls with frames computed from each scene's real duration, chained when a
 * scene exceeds the per-call ceiling. No dispatch, no MLX.
 */
import { describe, test, expect } from "bun:test";
import { planAssetGeneration } from "./assets-encoder.ts";

const scene = (over: Partial<Record<string, unknown>> = {}) => ({
	id: "s1",
	type: "generated",
	description: "a red cube rotating",
	start_seconds: 0,
	end_seconds: 6,
	...over,
});
const script = { sections: [{ id: "s1", text: "Behold the cube." }] };

describe("planAssetGeneration — video scenes", () => {
	test("scene ≤ ceiling → ONE i2v call with frames = ceil(duration × fps)", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ end_seconds: 6 })] } as any,
			script as any,
			{ fps: 25, maxCallSeconds: 8 },
		);
		const vids = plan.calls.filter((c) => c.capability === "video_generation");
		expect(vids).toHaveLength(1);
		expect(vids[0]!.options.frames).toBe(150); // ceil(6 * 25)
		expect(vids[0]!.options.fps).toBe(25);
	});

	test("scene 16s @25fps → TWO chained i2v calls (ceil(16/8)=2), each frames=200", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ end_seconds: 16 })] } as any,
			script as any,
			{ fps: 25, maxCallSeconds: 8 },
		);
		const vids = plan.calls.filter((c) => c.capability === "video_generation");
		expect(vids).toHaveLength(2);
		expect(vids.map((v) => v.chainIndex)).toEqual([0, 1]);
		expect(vids.every((v) => v.options.frames === 200)).toBe(true); // ceil(8 * 25)
	});

	test("scene 20s @24fps → THREE chained calls, each frames=160 (ceil((20/3)*24))", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ end_seconds: 20 })] } as any,
			script as any,
			{ fps: 24, maxCallSeconds: 8 },
		);
		const vids = plan.calls.filter((c) => c.capability === "video_generation");
		expect(vids).toHaveLength(3);
		expect(vids.every((v) => v.options.frames === 160)).toBe(true);
	});

	test("each video scene gets a T2I still first, then its I2V chain", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ end_seconds: 16 })] } as any,
			script as any,
			{ fps: 25, maxCallSeconds: 8 },
		);
		const seq = plan.calls.filter((c) => c.sceneId === "s1").map((c) => c.command);
		expect(seq[0]).toBe("t2i");
		expect(seq.slice(1)).toEqual(["i2v", "i2v"]); // chain after the still
	});
});

describe("planAssetGeneration — non-video scenes", () => {
	test("text_card / diagram scenes emit NO video or image calls", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ type: "text_card" }), scene({ type: "diagram" })] } as any,
			script as any,
			{ fps: 25, maxCallSeconds: 8 },
		);
		expect(plan.calls.filter((c) => c.capability === "video_generation" || c.capability === "image_generation")).toEqual([]);
	});
});

describe("planAssetGeneration — narration", () => {
	test("a TTS call is present carrying the script's narration text", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ end_seconds: 6 })] } as any,
			{ sections: [{ id: "s1", text: "Hello" }, { id: "s2", text: "world" }] } as any,
			{ fps: 25, maxCallSeconds: 8 },
		);
		const tts = plan.calls.find((c) => c.capability === "tts");
		expect(tts).toBeTruthy();
		expect(String(tts!.options.text)).toContain("Hello");
		expect(String(tts!.options.text)).toContain("world");
	});
});
