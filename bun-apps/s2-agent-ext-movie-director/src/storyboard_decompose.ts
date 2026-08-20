/**
 * storyboard_decompose.ts — story → SceneSpec[] decomposition via the local
 * gemma brain.
 *
 * Ports `app/planning/decompose_prompt.py` (prompt builder + tolerant JSON
 * parser) and `app/planning/gemma_brain.py`'s `decompose_story` (the LM
 * Studio call). The fast-path/safety-retry attempt loop
 * (`reasoning_effort:"none"` first, large-budget retry second) already lives
 * in `lmstudio.ts`'s `lmStudioJsonCall` — this module only supplies the
 * prompt + parser, mirroring how `story_native.ts` reuses the same primitive.
 *
 * LOCAL ONLY: LM Studio always resolves to localhost — never a cloud LLM.
 * Part of the storyboard Swift/Bun-native port
 * (.planning/specs/2026-08-01-storyboard-native-port-design.md).
 */
import { lmStudioJsonCall, type LmStudioChatOptions } from "./lmstudio.ts";

const SCENE_SPEC_SCHEMA = `[
  {
    "id": "beat-1",
    "subject": "WHO/WHAT is in frame (the character/object in focus)",
    "scene": "WHERE — the setting, environment, time of day",
    "motion": "WHAT is happening — the action/beat of this panel",
    "framing": "composition note, e.g. 'subject left, lead-room right' (optional)",
    "character_id": "a stable id for any recurring character (null if none)",
    "hero_moment": false,
    "texture_keywords": ["concrete visual texture words", "e.g. wet pavement, neon"],
    "shot_language": {
      "shot_size": "extreme_wide|wide|medium_wide|medium|medium_close|close_up|extreme_close_up|over_shoulder|establishing",
      "camera_movement": "static|dolly_in|dolly_out|pan_left|pan_right|tilt_up|tilt_down|tracking_left|tracking_right|crane_up|crane_down|handheld|steadicam|orbital|zoom_in|zoom_out|rack_focus",
      "lens_mm": 35,
      "depth_of_field": "shallow|medium|deep",
      "lighting_key": "high_key|low_key|natural|golden_hour|blue_hour|tungsten_warm|neon|silhouette|rim_lit|volumetric|overcast_soft",
      "color_temperature": "cool|neutral|warm|mixed"
    }
  }
]`;

const FIVE_ASPECT_GATE = `Before emitting JSON, silently self-review each planned panel against the 5-aspect checklist (Subject / Subject Motion / Scene / Spatial Framing / Camera). For each aspect: is it concrete and filmable? For multi-panel stories with a recurring character: is the character's identity anchored verbatim across panels (same person, same key visual attributes), even as scene/camera/framing vary? DIVERSITY requirement: vary shot_size, camera_movement, and lens across panels — do NOT repeat the same framing. Revise silently, then emit.`;

/** Build the gemma decomposition prompt (mirrors `build_decompose_prompt`). */
export function buildDecomposePrompt(story: string, numPanels = 4, styleHint?: string): string {
  const styleLine = styleHint ? `\nStyle/palette anchor (apply to every panel): ${styleHint}` : "";
  return `You are a film storyboard director. Decompose the story into exactly ${numPanels} sequential storyboard panels. Each panel is one image to generate.${styleLine}

Rules:
- Cover the story's narrative arc across the ${numPanels} panels (beginning → middle → end).
- When a character appears in more than one panel, give them ONE stable "character_id" and keep their identity anchored verbatim across panels (same person, same key visual attributes) — only the scene/camera/action changes.
- Vary the cinematography across panels: mix shot sizes, camera movements, lenses, and lighting. Avoid repeating the same framing.
- "subject" is concrete and visual (not abstract). "texture_keywords" are real surface details the image model can render.
- ${numPanels} panels EXACTLY.

${FIVE_ASPECT_GATE}

Return ONLY a JSON array (no prose, no markdown fences) of ${numPanels} objects, each matching this shape (omit a field rather than invent values; null is allowed for character_id/framing when not applicable):

${SCENE_SPEC_SCHEMA}

Story:
"""${story}"""

JSON array:`;
}

/** Extract the SceneSpec[] JSON array from a gemma response (mirrors `parse_decomposition`). */
export function parseDecomposition(raw: string): Record<string, unknown>[] {
  let cleaned = raw.replace(/<think[\s\S]*?<\/think\s*>/gi, "").trim();
  if (!cleaned && /<think/i.test(raw)) {
    cleaned = raw.replace(/<\/?think\s*>/gi, "").trim();
  }
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  throw new Error(`decomposition response had no parseable JSON array (first 200 chars: ${JSON.stringify(cleaned.slice(0, 200))})`);
}

export interface DecomposeStoryOptions extends LmStudioChatOptions {
  numPanels?: number;
  styleHint?: string;
}

/** Decompose a story into SceneSpec-shaped dicts via the local gemma brain (mirrors `decompose_story`). */
export async function decomposeStory(story: string, opts: DecomposeStoryOptions = {}): Promise<Record<string, unknown>[]> {
  const numPanels = opts.numPanels ?? 4;
  const prompt = buildDecomposePrompt(story, numPanels, opts.styleHint);
  const scenes = await lmStudioJsonCall(prompt, parseDecomposition, opts);
  return scenes.length > numPanels ? scenes.slice(0, numPanels) : scenes;
}
