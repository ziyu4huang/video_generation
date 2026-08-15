/**
 * shotLanguage.ts — structured camera/lighting vocabulary, rendered into a
 * text clause appended to a prompt before it reaches the Swift binary.
 *
 * Concept borrowed from ../OpenMontage's `schemas/artifacts/scene_plan.schema.json`
 * `shot_language` object (shot_size/camera_movement/lens_mm/lighting_key/
 * depth_of_field/color_temperature enums) — that repo's own video-generation
 * tools don't map this vocabulary to structured args either; it gets
 * flattened to prompt text upstream, same approach taken here. No
 * OpenMontage code is imported or modified; only the vocabulary shape is
 * reused, adapted to what LTX-2.3's prompt-following can actually act on
 * (this repo has no named-camera-move flag — see native-i2v-dev-variant-study.md
 * and project_runninghub_grid_guide_research memory: a `--camera dolly_in`
 * style control doesn't exist here or upstream in LTX-2.3's public CLI).
 *
 * Pure text templating — no model/CLI changes required, so this works with
 * every prompt-taking command (t2i, native-i2v, native-relay per-segment)
 * without touching Swift at all.
 *
 * Deliberately NOT wired into native-storyboard: that command's `prompt`
 * text lives inside a JSON config file (`--config <path>`), not an inline
 * `options.prompt`/`options.prompts` string(-array) — `withShotLanguage`
 * (index.ts) only rewrites those two fields, so reaching storyboard would
 * mean reading the JSON, rewriting each segment's `prompt`, and writing a
 * temp file just to swap `--config` to point at it. Storyboard's config
 * already gives the caller full per-panel authorial control over prompt
 * text, so the redundant round-trip isn't worth the added invasiveness
 * (extra temp-file lifecycle, path-safety implications) for a purely
 * additive convenience feature. Revisit only if a real user request for
 * storyboard-level shot-language surfaces.
 */

export const SHOT_SIZES = [
  "extreme_wide", "wide", "medium_wide", "medium", "medium_close",
  "close_up", "extreme_close_up", "over_shoulder", "insert", "establishing",
] as const;

export const CAMERA_MOVEMENTS = [
  "static", "pan_left", "pan_right", "tilt_up", "tilt_down",
  "dolly_in", "dolly_out", "tracking_left", "tracking_right",
  "crane_up", "crane_down", "handheld", "steadicam", "whip_pan",
  "orbital", "zoom_in", "zoom_out", "rack_focus",
] as const;

export const LENS_MM = [14, 24, 35, 50, 85, 135, 200] as const;

export const LIGHTING_KEYS = [
  "high_key", "low_key", "natural", "golden_hour", "blue_hour",
  "tungsten_warm", "neon", "silhouette", "rim_lit", "volumetric", "overcast_soft",
] as const;

export const DEPTH_OF_FIELDS = ["shallow", "medium", "deep"] as const;

export const COLOR_TEMPERATURES = ["cool", "neutral", "warm", "mixed"] as const;

export type ShotSize = (typeof SHOT_SIZES)[number];
export type CameraMovement = (typeof CAMERA_MOVEMENTS)[number];
export type LensMm = (typeof LENS_MM)[number];
export type LightingKey = (typeof LIGHTING_KEYS)[number];
export type DepthOfField = (typeof DEPTH_OF_FIELDS)[number];
export type ColorTemperature = (typeof COLOR_TEMPERATURES)[number];

export interface ShotLanguage {
  shotSize?: ShotSize;
  cameraMovement?: CameraMovement;
  lensMm?: LensMm;
  lightingKey?: LightingKey;
  depthOfField?: DepthOfField;
  colorTemperature?: ColorTemperature;
}

const HUMANIZE: Record<string, string> = {
  extreme_wide: "extreme wide shot",
  wide: "wide shot",
  medium_wide: "medium wide shot",
  medium: "medium shot",
  medium_close: "medium close-up",
  close_up: "close-up",
  extreme_close_up: "extreme close-up",
  over_shoulder: "over-the-shoulder shot",
  insert: "insert shot",
  establishing: "establishing shot",
  static: "static camera",
  pan_left: "panning left",
  pan_right: "panning right",
  tilt_up: "tilting up",
  tilt_down: "tilting down",
  dolly_in: "dollying in",
  dolly_out: "dollying out",
  tracking_left: "tracking left",
  tracking_right: "tracking right",
  crane_up: "crane rising",
  crane_down: "crane descending",
  handheld: "handheld camera",
  steadicam: "smooth steadicam movement",
  whip_pan: "whip pan",
  orbital: "orbiting around the subject",
  zoom_in: "zooming in",
  zoom_out: "zooming out",
  rack_focus: "rack focus",
  high_key: "high-key lighting",
  low_key: "low-key lighting",
  natural: "natural lighting",
  golden_hour: "golden hour lighting",
  blue_hour: "blue hour lighting",
  tungsten_warm: "warm tungsten lighting",
  neon: "neon lighting",
  silhouette: "silhouette lighting",
  rim_lit: "rim-lit",
  volumetric: "volumetric lighting",
  overcast_soft: "soft overcast lighting",
  shallow: "shallow depth of field",
  medium_dof: "medium depth of field",
  deep: "deep focus",
  cool: "cool color temperature",
  neutral: "neutral color temperature",
  warm: "warm color temperature",
  mixed: "mixed color temperature",
};

function depthOfFieldPhrase(v: DepthOfField): string {
  return (v === "medium" ? HUMANIZE.medium_dof : HUMANIZE[v]) ?? "";
}

/** Render a ShotLanguage into a comma-joined clause, e.g. "close-up, dollying in, shot on a 35mm lens, golden hour lighting, shallow depth of field, warm color temperature". Empty/undefined input renders "". */
export function renderShotLanguage(sl: ShotLanguage | undefined): string {
  if (!sl) return "";
  const parts: string[] = [];
  if (sl.shotSize) parts.push(HUMANIZE[sl.shotSize] ?? sl.shotSize);
  if (sl.cameraMovement) parts.push(HUMANIZE[sl.cameraMovement] ?? sl.cameraMovement);
  if (sl.lensMm) parts.push(`shot on a ${sl.lensMm}mm lens`);
  if (sl.lightingKey) parts.push(HUMANIZE[sl.lightingKey] ?? sl.lightingKey);
  if (sl.depthOfField) parts.push(depthOfFieldPhrase(sl.depthOfField));
  if (sl.colorTemperature) parts.push(HUMANIZE[sl.colorTemperature] ?? sl.colorTemperature);
  return parts.join(", ");
}

/** Append a rendered ShotLanguage clause to a prompt. Returns `prompt` unchanged if `sl` is empty/undefined. */
export function applyShotLanguage(prompt: string, sl: ShotLanguage | undefined): string {
  const clause = renderShotLanguage(sl);
  if (!clause) return prompt;
  const trimmed = prompt.trim();
  const sep = trimmed.endsWith(".") || trimmed.endsWith(",") ? " " : ", ";
  return `${trimmed}${sep}${clause}.`;
}
