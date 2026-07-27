/**
 * assets-encoder.test.ts — the proactive asset-generation planner. Pure logic:
 * given a scene_plan + script, flatten every video scene's duration into one
 * ordered RelayLink[] (a single native-relay call executes the whole movie —
 * see driver-wiring.ts's produceAssets), plus one TTS call for the narration.
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

describe("planAssetGeneration — relay links", () => {
	test("scene ≤ ceiling → ONE link, seconds = full scene duration", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 6 })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks).toHaveLength(1);
		expect(plan.relayLinks[0]).toMatchObject({ sceneId: "s1", chainIndex: 0, prompt: "a red cube rotating", seconds: 6, continuity: true });
	});

	test("scene 16s → TWO links (ceil(16/8)=2), each 8s", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 16 })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks).toHaveLength(2);
		expect(plan.relayLinks.map((l) => l.chainIndex)).toEqual([0, 1]);
		expect(plan.relayLinks.every((l) => l.seconds === 8)).toBe(true);
	});

	test("scene 20s → THREE links, each 20/3 seconds", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 20 })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks).toHaveLength(3);
		expect(plan.relayLinks.every((l) => Math.abs(l.seconds - 20 / 3) < 1e-9)).toBe(true);
	});

	test("multiple scenes flatten into ONE ordered array across scene boundaries", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ id: "s1", end_seconds: 6 }), scene({ id: "s2", start_seconds: 6, end_seconds: 10 })] } as any,
			script as any,
			{ maxCallSeconds: 8 },
		);
		expect(plan.relayLinks.map((l) => l.sceneId)).toEqual(["s1", "s2"]);
	});

	test("a scene's later links (chainIndex > 0) always continue, regardless of continuity", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 16, continuity: "cut" })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks.map((l) => l.continuity)).toEqual([false, true]);
	});

	test("continuity 'cut' on a scene's first link sets continuity:false; default/'continue' sets true", () => {
		const plan = planAssetGeneration(
			{
				scenes: [
					scene({ id: "s1", end_seconds: 6 }), // no `continuity` field -> default continue
					scene({ id: "s2", start_seconds: 6, end_seconds: 12, continuity: "cut" }),
					scene({ id: "s3", start_seconds: 12, end_seconds: 18, continuity: "continue" }),
				],
			} as any,
			script as any,
			{ maxCallSeconds: 8 },
		);
		expect(plan.relayLinks.map((l) => l.continuity)).toEqual([true, false, true]);
	});

	test("text_card / diagram scenes emit NO relay links", () => {
		const plan = planAssetGeneration({ scenes: [scene({ type: "text_card" }), scene({ type: "diagram" })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks).toEqual([]);
	});

	test("passes shot_language.camera_movement through to only the FIRST relay link of a split scene", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ end_seconds: 16, shot_language: { camera_movement: "dolly_in" } })] } as any,
			script as any,
			{ maxCallSeconds: 8 },
		);
		expect(plan.relayLinks.length).toBe(2); // 16s / 8s ceiling = 2 links, same scene
		expect(plan.relayLinks[0]!.cameraMovement).toBe("dolly_in");
		expect(plan.relayLinks[1]!.cameraMovement).toBeUndefined();
	});

	test("omits cameraMovement when shot_language.camera_movement is absent", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 6 })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks[0]!.cameraMovement).toBeUndefined();
	});
});

describe("planAssetGeneration — narration", () => {
	test("a tts call is present carrying the script's narration text", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ end_seconds: 6 })] } as any,
			{ sections: [{ id: "s1", text: "Hello" }, { id: "s2", text: "world" }] } as any,
			{ maxCallSeconds: 8 },
		);
		expect(plan.tts).toBeTruthy();
		expect(plan.tts!.text).toContain("Hello");
		expect(plan.tts!.text).toContain("world");
	});

	test("narration:'none' skips tts entirely (silent video)", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 6 })] } as any, { narration: "none", sections: [{ id: "s1", text: "Hello" }] } as any, { maxCallSeconds: 8 });
		expect(plan.tts).toBeUndefined();
	});

	test("the tts call is tagged with the first scene's id", () => {
		const plan = planAssetGeneration({ scenes: [scene({ id: "sc1", end_seconds: 6 })] } as any, { sections: [{ id: "s1", text: "Hello" }] } as any, { maxCallSeconds: 8 });
		expect(plan.tts?.sceneId).toBe("sc1");
	});
});
