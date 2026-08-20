/**
 * assets-encoder.ts — the proactive asset-generation planner.
 *
 * Instead of asking the agent what to generate, the driver COMPUTES the exact
 * native-relay call from scene_plan: every video scene's duration flattens
 * into ONE ordered list of relay links (prompt + per-link duration +
 * continuity flag) across the WHOLE movie, split across a scene's own
 * boundary only when that scene's duration exceeds the practical per-link
 * quality ceiling (maxCallSeconds). A SINGLE native-relay dispatch executes
 * the entire chain natively — the model loads once, last-frame reseed and
 * concatenation happen inside Swift (see driver-wiring.ts's produceAssets).
 *
 * Pure: emits the relay-link list + tts text. Execution (one dispatch("generate",
 * {command:"native-relay", provider:"ltx", ...}) call + per-segment duration
 * probing) is wired in driver-wiring.ts.
 */

/** Scene types that need a real generated video clip, not just an overlay. */
const VIDEO_TYPES = new Set(["generated", "character_scene", "broll", "talking_head"]);

/** One native-relay segment: a single I2V generation within the whole-movie chain. */
export interface RelayLink {
	sceneId: string;
	/** 0-based index within THIS scene's own chain (not the flattened array index). */
	chainIndex: number;
	prompt: string;
	seconds: number;
	/** false = fresh T2I for this link (hard cut); true = continue from the previous link's last frame. */
	continuity: boolean;
	/** shot_language.camera_movement passthrough from scene_plan, e.g. "dolly_in".
	 *  Only ever set on a scene's FIRST relay link (chainIndex === 0); every later
	 *  link of a split scene gets undefined. This is deliberate: on the Swift side
	 *  each link independently synthesizes its own full movement arc from its own
	 *  start frame, so tagging every link of a split scene would replay the same
	 *  arc per link (a visible doubled/restarted move) instead of one continuous
	 *  move across the scene — spreading one arc across a multi-link scene is out
	 *  of scope for v1. Undefined when the scene has no shot_language.camera_movement
	 *  set, or on non-first links per the above. Only "dolly_in"/"tilt_up" get real
	 *  IC-LoRA conditioning in v1 (see native-relay's --camera-movements); an
	 *  unsupported or absent value here gets NO shot_language enrichment on this
	 *  path — applyShotLanguage/withShotLanguage (s2-agent-ext-ltx) is gated on a
	 *  top-level input.shotLanguage field that driver-wiring.ts's produceAssets
	 *  never sets, so generation simply falls back to scene.description as-is. */
	cameraMovement?: string;
}

export interface TtsCall {
	text: string;
	sceneId?: string;
}

export interface MusicCall {
	prompt: string;
	duration?: number;
	sceneId?: string;
}

export interface AssetPlan {
	relayLinks: RelayLink[];
	tts?: TtsCall;
	music?: MusicCall;
}

interface SceneLike {
	id: string;
	type: string;
	description: string;
	start_seconds: number;
	end_seconds: number;
	/** Chaining behavior into this scene's FIRST link. Default "continue" when absent. */
	continuity?: "continue" | "cut";
	shot_language?: { camera_movement?: string };
}

interface ScriptLike {
	sections?: Array<{ id?: string; text?: string }>;
	narration?: string;
}

/**
 * Plan the whole movie's asset generation: one flattened list of native-relay
 * links across ALL video scenes in scene_plan order (each scene's duration
 * split across ≤ maxCallSeconds links so no single link exceeds the practical
 * per-link quality ceiling), plus one TTS narration call.
 */
export function planAssetGeneration(
	scenePlan: { scenes: SceneLike[] },
	script: ScriptLike | undefined,
	opts: { maxCallSeconds: number; music?: { prompt: string; duration?: number } },
): AssetPlan {
	const relayLinks: RelayLink[] = [];

	for (const scene of scenePlan.scenes) {
		const duration = Math.max(0, scene.end_seconds - scene.start_seconds);
		if (!VIDEO_TYPES.has(scene.type) || duration <= 0) continue;

		const linkCount = Math.max(1, Math.ceil(duration / opts.maxCallSeconds));
		const perLinkSeconds = duration / linkCount;
		for (let i = 0; i < linkCount; i++) {
			relayLinks.push({
				sceneId: scene.id,
				chainIndex: i,
				prompt: scene.description,
				seconds: perLinkSeconds,
				// Only a scene's FIRST link can be a hard cut; later links within
				// the same scene are the SAME shot split across the per-link
				// ceiling, so they always continue.
				continuity: i === 0 ? scene.continuity !== "cut" : true,
				cameraMovement: i === 0 ? scene.shot_language?.camera_movement : undefined,
			});
		}
	}

	let tts: TtsCall | undefined;
	if (script?.narration !== "none") {
		const narrationText =
			script?.narration ?? script?.sections?.map((s) => s.text ?? "").filter(Boolean).join(" ") ?? "";
		if (narrationText.trim()) {
			tts = { text: narrationText, sceneId: scenePlan.scenes[0]?.id };
		}
	}

	// Music — the score track, driven through the cost-tracked generate path
	// (local MLX MusicGen). OPTIONAL: emitted only when the caller supplies a
	// music prompt (opts.music). compose-motion's amix pass mixes the result
	// under the narration. Deriving the prompt from scene mood automatically is
	// out of scope here; until that lands the driver/agent passes an explicit
	// prompt. Tagged with the first scene's id, mirroring tts above.
	let music: MusicCall | undefined;
	if (opts.music && opts.music.prompt.trim()) {
		music = { prompt: opts.music.prompt, duration: opts.music.duration, sceneId: scenePlan.scenes[0]?.id };
	}

	return { relayLinks, tts, music };
}
