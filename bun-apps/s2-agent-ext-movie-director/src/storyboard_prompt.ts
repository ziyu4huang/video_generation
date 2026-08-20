/**
 * storyboard_prompt.ts — the 5-layer shot prompt builder (structured
 * cinematography language → generation prompt).
 *
 * Ports `app/planning/shot_prompt_builder.py` (188 lines) 1:1: pure string
 * assembly, no I/O, no MLX. Part of the storyboard Swift/Bun-native port
 * (.planning/specs/2026-08-01-storyboard-native-port-design.md).
 *
 * The 5-layer framework:
 *   Layer 1: Camera     — lens, depth of field
 *   Layer 2: Movement   — shot size, camera movement
 *   Layer 3: Subject     — description + texture keywords
 *   Layer 4: Lighting   — lighting key, color temperature
 *   Layer 5: Style      — adapted from style context (NOT a verbatim prefix)
 */

const SHOT_SIZE_PHRASES: Record<string, string> = {
  extreme_wide: "extreme wide shot showing vast environment",
  wide: "wide shot capturing full scene",
  medium_wide: "medium-wide shot framing subject with surroundings",
  medium: "medium shot from waist up",
  medium_close: "medium close-up from chest up",
  close_up: "close-up focusing on face or detail",
  extreme_close_up: "extreme close-up on fine detail",
  over_shoulder: "over-the-shoulder perspective",
  insert: "insert shot of specific detail",
  establishing: "establishing shot setting the location",
};

const MOVEMENT_PHRASES: Record<string, string> = {
  static: "locked-off static camera",
  pan_left: "smooth pan to the left",
  pan_right: "smooth pan to the right",
  tilt_up: "gentle tilt upward",
  tilt_down: "gentle tilt downward",
  dolly_in: "slow dolly in toward subject",
  dolly_out: "slow dolly out from subject",
  tracking_left: "tracking shot moving left alongside subject",
  tracking_right: "tracking shot moving right alongside subject",
  crane_up: "crane shot rising upward",
  crane_down: "crane shot descending",
  handheld: "handheld camera with natural movement",
  steadicam: "smooth steadicam following movement",
  whip_pan: "fast whip pan",
  orbital: "orbital camera circling subject",
  zoom_in: "slow zoom in",
  zoom_out: "slow zoom out",
  rack_focus: "rack focus shift between foreground and background",
};

const LIGHTING_PHRASES: Record<string, string> = {
  high_key: "bright high-key lighting, minimal shadows",
  low_key: "dramatic low-key lighting with deep shadows",
  natural: "natural ambient lighting",
  golden_hour: "warm golden hour sunlight",
  blue_hour: "cool blue hour twilight",
  tungsten_warm: "warm tungsten interior lighting",
  neon: "neon-lit with vibrant color spill",
  silhouette: "backlit silhouette",
  rim_lit: "rim lighting highlighting edges",
  volumetric: "volumetric light with visible rays",
  overcast_soft: "soft overcast diffused light",
};

const DOF_PHRASES: Record<string, string> = {
  shallow: "shallow depth of field with bokeh",
  medium: "medium depth of field",
  deep: "deep focus with everything sharp",
};

const COLOR_TEMP_PHRASES: Record<string, string> = {
  cool: "cool blue-toned color palette",
  neutral: "neutral balanced colors",
  warm: "warm amber-toned color palette",
  mixed: "mixed color temperatures for contrast",
};

/** Look up a phrase; unknown keys pass through verbatim (mirrors Python's `_phrase`). */
function phrase(map: Record<string, string>, key: string | null | undefined): string {
  if (key == null) return "";
  return map[key] ?? key;
}

export interface PlannerShotLanguage {
  lensMm?: number | null;
  depthOfField?: string | null;
  shotSize?: string | null;
  cameraMovement?: string | null;
  lightingKey?: string | null;
  colorTemperature?: string | null;
}

export interface PlannerScene {
  id: string;
  type?: string;
  description: string;
  textureKeywords?: string[];
  shotLanguage?: PlannerShotLanguage;
  heroMoment?: boolean;
}

export interface StyleContext {
  mood?: string;
  visualLanguage?: { aesthetic?: string };
}

/** Convert a scene with structured shotLanguage into a generation prompt (mirrors `build_shot_prompt`). */
export function buildShotPrompt(scene: PlannerScene, styleContext?: StyleContext): string {
  const sl = scene.shotLanguage ?? {};
  const layers: string[] = [];

  // Layer 1: Camera — lens and depth of field.
  const cameraParts: string[] = [];
  if (sl.lensMm) cameraParts.push(`${sl.lensMm}mm lens`);
  if (sl.depthOfField) cameraParts.push(phrase(DOF_PHRASES, sl.depthOfField));
  if (cameraParts.length) layers.push(cameraParts.filter(Boolean).join(", "));

  // Layer 2: Movement — shot size and camera movement ("static" contributes nothing).
  const movementParts: string[] = [];
  if (sl.shotSize) movementParts.push(phrase(SHOT_SIZE_PHRASES, sl.shotSize));
  if (sl.cameraMovement && sl.cameraMovement !== "static") movementParts.push(phrase(MOVEMENT_PHRASES, sl.cameraMovement));
  if (movementParts.length) layers.push(movementParts.filter(Boolean).join(", "));

  // Layer 3: Subject — description + texture keywords.
  const texture = scene.textureKeywords ?? [];
  const subjectParts = [scene.description ?? ""];
  if (texture.length) subjectParts.push(texture.join(", "));
  const subject = subjectParts.filter(Boolean).join(". ");
  if (subject) layers.push(subject);

  // Layer 4: Lighting — lighting key and color temperature.
  const lightingParts: string[] = [];
  if (sl.lightingKey) lightingParts.push(phrase(LIGHTING_PHRASES, sl.lightingKey));
  if (sl.colorTemperature) lightingParts.push(phrase(COLOR_TEMP_PHRASES, sl.colorTemperature));
  if (lightingParts.length) layers.push(lightingParts.filter(Boolean).join(", "));

  // Layer 5: Style — adapted from style context (NOT a verbatim prefix).
  if (styleContext) {
    const styleHint = styleContext.visualLanguage?.aesthetic || styleContext.mood || "";
    if (styleHint) layers.push(`Style: ${styleHint}`);
  }

  return layers.filter(Boolean).join(". ");
}

export interface BatchPromptEntry {
  sceneId: string;
  prompt: string;
  heroMoment: boolean;
}

/** Build prompts for all VISUAL scenes (skips type:"transition"). Mirrors `build_batch_prompts`. */
export function buildBatchPrompts(scenes: PlannerScene[], styleContext?: StyleContext): BatchPromptEntry[] {
  const results: BatchPromptEntry[] = [];
  for (const scene of scenes) {
    if ((scene.type ?? "") === "transition") continue;
    results.push({
      sceneId: scene.id ?? "unknown",
      prompt: buildShotPrompt(scene, styleContext),
      heroMoment: !!scene.heroMoment,
    });
  }
  return results;
}
