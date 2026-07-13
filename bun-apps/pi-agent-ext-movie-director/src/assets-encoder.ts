/**
 * assets-encoder.ts — the proactive asset-generation planner.
 *
 * This is the frozen-frame fix, by construction. Instead of asking the agent
 * what to generate (it forgets and accepts the ~4s I2V default, then paper-overs
 * with frozen-frame extension — see receipts/real-e2e-20260711-v5-…), the driver
 * COMPUTES the exact generate calls from scene_plan: each video scene's clip
 * length is `frames = ceil(duration × fps)`, and when a scene exceeds the
 * practical per-call ceiling it is split into a CHAIN of real I2V sub-clips
 * (each continuing from the previous clip's last frame at execution time).
 *
 * Pure: emits the call list. Execution (dispatch("generate") + ffmpeg last-frame
 * extraction between chain links) is wired in driver-wiring.ts.
 */

/** Scene types that need a real generated video clip (I2V), not just an overlay. */
const VIDEO_TYPES = new Set(["generated", "character_scene", "broll", "talking_head"]);

export interface AssetGenCall {
	capability: "image_generation" | "video_generation" | "tts";
	command: "t2i" | "i2v" | "narrate";
	options: Record<string, unknown>;
	sceneId?: string;
	/** 0-based index within a scene's I2V chain (absent for the T2I still / TTS). */
	chainIndex?: number;
}

export interface AssetPlan {
	calls: AssetGenCall[];
}

interface SceneLike {
	id: string;
	type: string;
	description: string;
	start_seconds: number;
	end_seconds: number;
}

interface ScriptLike {
	sections?: Array<{ id?: string; text?: string }>;
	narration?: string;
}

/**
 * Plan the generate calls for the whole video: per video-scene a T2I still then
 * an I2V chain (frames from real duration), plus one TTS narration call.
 */
export function planAssetGeneration(
	scenePlan: { scenes: SceneLike[] },
	script: ScriptLike | undefined,
	opts: { fps: number; maxCallSeconds: number },
): AssetPlan {
	const calls: AssetGenCall[] = [];

	for (const scene of scenePlan.scenes) {
		const duration = Math.max(0, scene.end_seconds - scene.start_seconds);
		if (!VIDEO_TYPES.has(scene.type) || duration <= 0) continue;

		// T2I still — the anchor frame for the scene's motion.
		calls.push({
			capability: "image_generation",
			command: "t2i",
			options: { prompt: scene.description },
			sceneId: scene.id,
		});

		// I2V chain: split the scene's duration across ≤ maxCallSeconds calls so
		// each generate stays within the practical per-call ceiling. Each link
		// continues from the previous clip's last frame (wired at execution).
		const linkCount = Math.max(1, Math.ceil(duration / opts.maxCallSeconds));
		const perCallFrames = Math.ceil((duration / linkCount) * opts.fps);
		for (let i = 0; i < linkCount; i++) {
			calls.push({
				capability: "video_generation",
				command: "i2v",
				options: { prompt: scene.description, frames: perCallFrames, fps: opts.fps },
				sceneId: scene.id,
				chainIndex: i,
			});
		}
	}

	// TTS narration — the full spoken track, driven through the cost-tracked
	// generate path (never raw say/edge-tts). Text = explicit narration, else
	// the concatenation of the script's section texts.
	const narrationText =
		script?.narration ?? script?.sections?.map((s) => s.text ?? "").filter(Boolean).join(" ") ?? "";
	if (narrationText.trim()) {
		calls.push({
			capability: "tts",
			command: "narrate",
			options: { text: narrationText },
		});
	}

	return { calls };
}
