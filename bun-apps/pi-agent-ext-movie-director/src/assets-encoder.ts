/**
 * assets-encoder.ts — the proactive asset-generation planner.
 *
 * This is the frozen-frame fix, by construction. Instead of asking the agent
 * what to generate (it forgets and accepts the ~4s I2V default, then paper-overs
 * with frozen-frame extension — see receipts/real-e2e-20260711-v5-…), the driver
 * COMPUTES the exact generate calls from scene_plan: each video scene's clip
 * length is `frames = ceil(duration × fps)`, and when a scene exceeds the
 * practical per-call ceiling it is split into a CHAIN of real t2i2v sub-clips —
 * link 0 is a self-contained T2I2V (no anchor image), and each later link
 * continues from the previous clip's last frame (wired at execution).
 *
 * Pure: emits the call list. Execution (dispatch("generate") + ffmpeg last-frame
 * extraction between chain links) is wired in driver-wiring.ts.
 */

/** Scene types that need a real generated video clip, not just an overlay. */
const VIDEO_TYPES = new Set(["generated", "character_scene", "broll", "talking_head"]);

export interface AssetGenCall {
	capability: "video_generation" | "tts" | "music_generation";
	command: "t2i2v" | "tts" | "music";
	options: Record<string, unknown>;
	sceneId?: string;
	/** 0-based index within a scene's t2i2v chain (absent for the TTS/music call). */
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
 * Plan the generate calls for the whole video: per video-scene a t2i2v chain
 * (frames from real duration, split across ≤ maxCallSeconds per link), plus one
 * TTS narration call.
 */
export function planAssetGeneration(
	scenePlan: { scenes: SceneLike[] },
	script: ScriptLike | undefined,
	opts: { fps: number; maxCallSeconds: number; music?: { prompt: string; duration?: number } },
): AssetPlan {
	const calls: AssetGenCall[] = [];

	for (const scene of scenePlan.scenes) {
		const duration = Math.max(0, scene.end_seconds - scene.start_seconds);
		if (!VIDEO_TYPES.has(scene.type) || duration <= 0) continue;

		// t2i2v chain: split the scene's duration across ≤ maxCallSeconds links so
		// each generate stays within the practical per-call ceiling. Link 0 is a
		// self-contained T2I2V; each later link continues from the prior clip's
		// last frame (wired at execution via `options.image`).
		const linkCount = Math.max(1, Math.ceil(duration / opts.maxCallSeconds));
		const perCallFrames = Math.ceil((duration / linkCount) * opts.fps);
		for (let i = 0; i < linkCount; i++) {
			calls.push({
				capability: "video_generation",
				command: "t2i2v",
				options: { prompt: scene.description, frames: perCallFrames, fps: opts.fps },
				sceneId: scene.id,
				chainIndex: i,
			});
		}
	}

	// TTS narration — the full spoken track, driven through the cost-tracked
	// generate path (never raw say/edge-tts). SKIPPED when the script declares
	// narration:"none" (a silent/ambient video). Text = explicit narration, else
	// the concatenation of the script's section texts. Tagged with the first
	// scene's id so the resulting manifest asset has a valid scene_id.
	if (script?.narration !== "none") {
		const narrationText =
			script?.narration ?? script?.sections?.map((s) => s.text ?? "").filter(Boolean).join(" ") ?? "";
		if (narrationText.trim()) {
			calls.push({
				capability: "tts",
				command: "tts",
				options: { text: narrationText },
				sceneId: scenePlan.scenes[0]?.id,
			});
		}
	}

	// Music — the score track, driven through the cost-tracked generate path
	// (local MLX MusicGen). OPTIONAL: emitted only when the caller supplies a
	// music prompt (opts.music). Compose-motion's amix pass mixes the result
	// under the narration. Deriving the prompt from scene mood is the
	// mood→query-mapping fog (map Not-yet-specified); until it graduates the
	// driver/agent passes an explicit prompt. Tagged with the first scene's id.
	if (opts.music && opts.music.prompt.trim()) {
		const musicOpts: Record<string, unknown> = { prompt: opts.music.prompt };
		if (opts.music.duration != null) musicOpts.duration = opts.music.duration;
		calls.push({
			capability: "music_generation",
			command: "music",
			options: musicOpts,
			sceneId: scenePlan.scenes[0]?.id,
		});
	}

	return { calls };
}
