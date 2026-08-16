/**
 * storyboard_scene.ts — the 5-aspect scene spec + deterministic storyboard
 * planner.
 *
 * Ports `app/planning/scene_spec.py` (151 lines) 1:1: pure data structures +
 * a planner mapping a gemma-produced (or --scenes-file) scene list onto
 * per-shot generation specs. No LLM, no generation — fully testable. Part of
 * the storyboard Swift/Bun-native port
 * (.planning/specs/2026-08-01-storyboard-native-port-design.md).
 *
 * Each shot carries an optional `characterId`: when the same character
 * recurs across shots, `storyboard_native.ts`'s routing applies the
 * character-lock (soft `edit` reference or true `kontext` in-context).
 */
import { buildBatchPrompts, type PlannerScene, type StyleContext } from "./storyboard_prompt.ts";

export interface ShotLanguage {
  lensMm?: number | null;
  depthOfField?: string | null;
  shotSize?: string | null;
  cameraMovement?: string | null;
  lightingKey?: string | null;
  colorTemperature?: string | null;
}

export interface SceneSpec {
  id: string;
  subject: string;
  scene: string;
  motion?: string;
  framing?: string;
  shotLanguage?: ShotLanguage;
  textureKeywords?: string[];
  characterId?: string | null;
  heroMoment?: boolean;
  type?: string;
}

export interface Shot {
  sceneId: string;
  prompt: string;
  characterId: string | null;
  heroMoment: boolean;
}

export interface Storyboard {
  shots: Shot[];
  recurringCharacters: string[];
}

/** Flatten a SceneSpec to the shape buildShotPrompt/buildBatchPrompts expect (mirrors `SceneSpec.to_planner_scene`). */
export function sceneToPlannerScene(s: SceneSpec): PlannerScene {
  const description = [s.subject, s.motion, s.scene].filter((p) => p).join(". ");
  return {
    id: s.id,
    type: s.type ?? "visual",
    description,
    textureKeywords: s.textureKeywords ?? [],
    shotLanguage: s.shotLanguage,
    heroMoment: !!s.heroMoment,
  };
}

/**
 * Map a scene list onto a Storyboard of generation prompts (mirrors
 * `plan_storyboard`). Deterministic: same scenes → same storyboard.
 * Characters appearing in >=2 shots are listed in `recurringCharacters` so
 * the caller knows to apply the character-lock to those shots.
 */
export function planStoryboard(scenes: SceneSpec[], styleContext?: StyleContext): Storyboard {
  const plannerScenes = scenes.map(sceneToPlannerScene);
  const built = buildBatchPrompts(plannerScenes, styleContext);

  const charById = new Map(scenes.map((s) => [s.id, s.characterId ?? null]));
  const shots: Shot[] = [];
  const charCounts = new Map<string, number>();
  for (const entry of built) {
    const cid = charById.get(entry.sceneId) ?? null;
    shots.push({ sceneId: entry.sceneId, prompt: entry.prompt, characterId: cid, heroMoment: entry.heroMoment });
    if (cid) charCounts.set(cid, (charCounts.get(cid) ?? 0) + 1);
  }
  const recurringCharacters = [...charCounts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([c]) => c)
    .sort();
  return { shots, recurringCharacters };
}
