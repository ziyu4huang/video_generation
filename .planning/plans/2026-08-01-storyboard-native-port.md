# storyboard Swift/Bun-native Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `image-storyboard.py`'s core generation line (scene decomposition → scene/shot planning → per-shot routed generation → contact sheet) onto a new `storyboard_native.ts` module, closing the last non-permanent gap in `runpy_image`.

**Architecture:** Four new pure-Bun files mirroring the Python package boundary 1:1 (`storyboard_prompt.ts` ← `shot_prompt_builder.py`, `storyboard_scene.ts` ← `scene_spec.py`, `storyboard_decompose.ts` ← `decompose_prompt.py`+`gemma_brain.py`, `storyboard_native.ts` ← `image-storyboard.py`'s core `run_storyboard`), wired into `registry.ts` (new `storyboard_native` entry, `storyboard` removed from `runpy_image`) and `bridge.ts` (`realStoryboardNative` adapter). Generation reuses already-native primitives: `krea2` `t2i` (independent shots), `flux2` `edit` (soft character-lock), `flux2` `kontext` (true in-context lock). Contact sheet uses ffmpeg (already a dependency elsewhere in this package), avoiding a new image-codec dependency.

**Tech Stack:** Bun/TypeScript, `bun:test`, `@repo/pi-agent-ext-krea2`, `@repo/pi-agent-ext-flux2`, ffmpeg (subprocess via `spawn.ts`), LM Studio HTTP (via `lmstudio.ts`).

**Spec:** `.planning/specs/2026-08-01-storyboard-native-port-design.md`

---

### Task 1: `storyboard_prompt.ts` — the 5-layer prompt builder

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/storyboard_prompt.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/storyboard_prompt.test.ts`

Ports `app/planning/shot_prompt_builder.py` (188 lines) 1:1: pure string composition, no I/O, no dependency on any other new file.

- [ ] **Step 1: Write the failing test**

```typescript
// bun-apps/pi-agent-ext-movie-director/src/storyboard_prompt.test.ts
import { describe, expect, it } from "bun:test";
import { buildShotPrompt, buildBatchPrompts } from "./storyboard_prompt.ts";

describe("buildShotPrompt — 5-layer prompt assembly", () => {
  it("assembles camera, movement, subject, lighting layers in order, joined by '. '", () => {
    const prompt = buildShotPrompt({
      id: "beat-1",
      description: "a weary detective in a trench coat. lighting a cigarette. a rain-soaked alley at night",
      textureKeywords: ["neon reflections", "wet pavement"],
      shotLanguage: {
        lensMm: 35,
        depthOfField: "shallow",
        shotSize: "wide",
        cameraMovement: "dolly_in",
        lightingKey: "low_key",
        colorTemperature: "cool",
      },
    });
    expect(prompt).toBe(
      "35mm lens, shallow depth of field with bokeh. " +
        "wide shot capturing full scene, slow dolly in toward subject. " +
        "a weary detective in a trench coat. lighting a cigarette. a rain-soaked alley at night. neon reflections, wet pavement. " +
        "dramatic low-key lighting with deep shadows, cool blue-toned color palette",
    );
  });

  it("omits camera_movement contribution when 'static' (locked camera is the default feel)", () => {
    const prompt = buildShotPrompt({
      id: "s1",
      description: "a lighthouse",
      shotLanguage: { shotSize: "wide", cameraMovement: "static" },
    });
    expect(prompt).toBe("wide shot capturing full scene. a lighthouse");
  });

  it("unknown enum values pass through verbatim instead of dropping", () => {
    const prompt = buildShotPrompt({
      id: "s1",
      description: "x",
      shotLanguage: { shotSize: "dutch_angle_wide" },
    });
    expect(prompt).toBe("dutch_angle_wide. x");
  });

  it("appends a Style: layer from style_context.visual_language.aesthetic (falls back to mood)", () => {
    const withAesthetic = buildShotPrompt(
      { id: "s1", description: "x" },
      { visualLanguage: { aesthetic: "noir, teal-and-orange" }, mood: "tense" },
    );
    expect(withAesthetic).toBe("x. Style: noir, teal-and-orange");

    const moodOnly = buildShotPrompt({ id: "s1", description: "x" }, { mood: "tense" });
    expect(moodOnly).toBe("x. Style: tense");
  });

  it("drops empty layers cleanly (no stray '. ' separators)", () => {
    const prompt = buildShotPrompt({ id: "s1", description: "" });
    expect(prompt).toBe("");
  });
});

describe("buildBatchPrompts — batch driver", () => {
  it("skips transition-type scenes (non-visual)", () => {
    const built = buildBatchPrompts([
      { id: "a", type: "visual", description: "a house" },
      { id: "b", type: "transition", description: "fade to black" },
      { id: "c", type: "visual", description: "a car" },
    ]);
    expect(built.map((b) => b.sceneId)).toEqual(["a", "c"]);
  });

  it("carries heroMoment through unchanged, defaulting to false", () => {
    const built = buildBatchPrompts([
      { id: "a", description: "x", heroMoment: true },
      { id: "b", description: "y" },
    ]);
    expect(built[0]?.heroMoment).toBe(true);
    expect(built[1]?.heroMoment).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_prompt.test.ts )`
Expected: FAIL — `Cannot find module './storyboard_prompt.ts'`

- [ ] **Step 3: Write the implementation**

```typescript
// bun-apps/pi-agent-ext-movie-director/src/storyboard_prompt.ts
/**
 * storyboard_prompt.ts — the 5-layer shot prompt builder (structured
 * cinematography language → generation prompt).
 *
 * Ports `app/planning/shot_prompt_builder.py` (188 lines) 1:1: pure string
 * assembly, no I/O, no MLX. Part of the storyboard Swift/Bun-native port
 * (docs/superpowers/specs/2026-08-01-storyboard-native-port-design.md).
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_prompt.test.ts )`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/storyboard_prompt.ts bun-apps/pi-agent-ext-movie-director/src/storyboard_prompt.test.ts
git commit -m "feat(storyboard): port shot_prompt_builder.py's 5-layer prompt assembly"
```

---

### Task 2: `storyboard_scene.ts` — scene types + deterministic planner

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/storyboard_scene.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/storyboard_scene.test.ts`

Ports `app/planning/scene_spec.py` (151 lines): the `SceneSpec`/`Shot`/`Storyboard` types plus `planStoryboard` (deterministic scene→shot mapper, computes `recurringCharacters`). Depends on Task 1's `buildBatchPrompts`.

- [ ] **Step 1: Write the failing test**

```typescript
// bun-apps/pi-agent-ext-movie-director/src/storyboard_scene.test.ts
import { describe, expect, it } from "bun:test";
import { sceneToPlannerScene, planStoryboard, type SceneSpec } from "./storyboard_scene.ts";

describe("sceneToPlannerScene — flatten SceneSpec for the prompt builder", () => {
  it("joins subject/motion/scene with '. ', skipping empty parts", () => {
    const planner = sceneToPlannerScene({
      id: "beat-1",
      subject: "a detective",
      motion: "lighting a cigarette",
      scene: "a rain-soaked alley",
    });
    expect(planner.description).toBe("a detective. lighting a cigarette. a rain-soaked alley");
    expect(planner.type).toBe("visual");
  });

  it("defaults type to 'visual' and heroMoment to false", () => {
    const planner = sceneToPlannerScene({ id: "s1", subject: "x", scene: "y" });
    expect(planner.type).toBe("visual");
    expect(planner.heroMoment).toBe(false);
  });
});

describe("planStoryboard — deterministic scene → shot mapping", () => {
  const scenes: SceneSpec[] = [
    { id: "beat-1", subject: "detective", scene: "alley", characterId: "detective", heroMoment: true },
    { id: "beat-2", subject: "detective", scene: "diner", characterId: "detective" },
    { id: "beat-3", subject: "a stranger", scene: "rooftop", characterId: "stranger" },
  ];

  it("maps each scene to one shot with its prompt + characterId", () => {
    const board = planStoryboard(scenes);
    expect(board.shots).toHaveLength(3);
    expect(board.shots[0]).toMatchObject({ sceneId: "beat-1", characterId: "detective", heroMoment: true });
    expect(board.shots[0]?.prompt.length).toBeGreaterThan(0);
  });

  it("lists characters appearing in >=2 shots as recurring, sorted", () => {
    const board = planStoryboard(scenes);
    expect(board.recurringCharacters).toEqual(["detective"]);
  });

  it("a character appearing in exactly 1 shot is NOT recurring", () => {
    const board = planStoryboard(scenes);
    expect(board.recurringCharacters).not.toContain("stranger");
  });

  it("drops transition scenes from shots (skipped by buildBatchPrompts)", () => {
    const board = planStoryboard([...scenes, { id: "t1", subject: "", scene: "", type: "transition" }]);
    expect(board.shots.map((s) => s.sceneId)).not.toContain("t1");
  });

  it("scenes with no characterId never appear in recurringCharacters", () => {
    const board = planStoryboard([{ id: "solo", subject: "x", scene: "y" }]);
    expect(board.recurringCharacters).toEqual([]);
    expect(board.shots[0]?.characterId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_scene.test.ts )`
Expected: FAIL — `Cannot find module './storyboard_scene.ts'`

- [ ] **Step 3: Write the implementation**

```typescript
// bun-apps/pi-agent-ext-movie-director/src/storyboard_scene.ts
/**
 * storyboard_scene.ts — the 5-aspect scene spec + deterministic storyboard
 * planner.
 *
 * Ports `app/planning/scene_spec.py` (151 lines) 1:1: pure data structures +
 * a planner mapping a gemma-produced (or --scenes-file) scene list onto
 * per-shot generation specs. No LLM, no generation — fully testable. Part of
 * the storyboard Swift/Bun-native port
 * (docs/superpowers/specs/2026-08-01-storyboard-native-port-design.md).
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_scene.test.ts )`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/storyboard_scene.ts bun-apps/pi-agent-ext-movie-director/src/storyboard_scene.test.ts
git commit -m "feat(storyboard): port scene_spec.py's types + deterministic planner"
```

---

### Task 3: `storyboard_decompose.ts` — gemma story→scene decomposition

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/storyboard_decompose.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/storyboard_decompose.test.ts`

Ports `app/planning/decompose_prompt.py` (prompt builder + tolerant parser) and `app/planning/gemma_brain.py`'s `decompose_story` (the LM Studio call). Depends on `lmstudio.ts`'s `lmStudioJsonCall`, which already implements the fast-path/safety-retry contract — no retry logic needs re-implementing here.

- [ ] **Step 1: Write the failing test**

```typescript
// bun-apps/pi-agent-ext-movie-director/src/storyboard_decompose.test.ts
import { describe, expect, it } from "bun:test";
import { buildDecomposePrompt, parseDecomposition, decomposeStory } from "./storyboard_decompose.ts";

describe("buildDecomposePrompt", () => {
  it("embeds the panel count, story text, and JSON schema", () => {
    const prompt = buildDecomposePrompt("A hero's journey.", 5);
    expect(prompt).toContain("exactly 5");
    expect(prompt).toContain("A hero's journey.");
    expect(prompt).toContain('"character_id"');
  });

  it("appends a style/palette anchor line only when styleHint is given", () => {
    const withHint = buildDecomposePrompt("story", 4, "noir, teal-and-orange");
    expect(withHint).toContain("Style/palette anchor (apply to every panel): noir, teal-and-orange");
    const withoutHint = buildDecomposePrompt("story", 4);
    expect(withoutHint).not.toContain("Style/palette anchor");
  });
});

describe("parseDecomposition — tolerant JSON-array extraction", () => {
  it("parses a clean JSON array", () => {
    const scenes = parseDecomposition('[{"id":"a"},{"id":"b"}]');
    expect(scenes).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("strips <think>...</think> reasoning blocks", () => {
    const scenes = parseDecomposition('<think>reasoning here</think>[{"id":"a"}]');
    expect(scenes).toEqual([{ id: "a" }]);
  });

  it("strips ```json fences", () => {
    const scenes = parseDecomposition('```json\n[{"id":"a"}]\n```');
    expect(scenes).toEqual([{ id: "a" }]);
  });

  it("recovers a JSON array from inside an unclosed <think> block", () => {
    const scenes = parseDecomposition('<think>[{"id":"a"}]');
    expect(scenes).toEqual([{ id: "a" }]);
  });

  it("throws when no parseable array exists", () => {
    expect(() => parseDecomposition("no json here")).toThrow(/no parseable JSON array/);
  });
});

describe("decomposeStory — end-to-end via a mocked fetch", () => {
  it("calls the LM Studio chat endpoint and returns the parsed scene list, truncated to numPanels", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '[{"id":"a"},{"id":"b"},{"id":"c"}]' } }] }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const scenes = await decomposeStory("a story", { numPanels: 2, _fetchImpl: fetchImpl });
    expect(scenes).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_decompose.test.ts )`
Expected: FAIL — `Cannot find module './storyboard_decompose.ts'`

- [ ] **Step 3: Write the implementation**

```typescript
// bun-apps/pi-agent-ext-movie-director/src/storyboard_decompose.ts
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
 * (docs/superpowers/specs/2026-08-01-storyboard-native-port-design.md).
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_decompose.test.ts )`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/storyboard_decompose.ts bun-apps/pi-agent-ext-movie-director/src/storyboard_decompose.test.ts
git commit -m "feat(storyboard): port decompose_prompt.py + gemma_brain.py's story decomposition"
```

---

### Task 4: `storyboard_native.ts` part A — scene sourcing + shot routing

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.test.ts`

The main orchestration module. This task establishes the file with the pure/deterministic pieces: `sceneFromDict` (raw JSON → `SceneSpec`), `deterministicFixture` (the 3-beat noir fixture), `loadScenes` (the `--scenes`/`--story`/fixture three-way fallback), and `shotRoute` (the per-shot routing decision). Later tasks append to this same file.

- [ ] **Step 1: Write the failing test**

```typescript
// bun-apps/pi-agent-ext-movie-director/src/storyboard_native.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sceneFromDict, deterministicFixture, loadScenes, shotRoute } from "./storyboard_native.ts";

describe("sceneFromDict — raw JSON → SceneSpec", () => {
  it("maps snake_case fields (the wire format both --scenes files and gemma output use)", () => {
    const scene = sceneFromDict({
      id: "beat-1",
      subject: "a detective",
      scene: "an alley",
      motion: "walking",
      character_id: "detective",
      hero_moment: true,
      texture_keywords: ["neon"],
      shot_language: { shot_size: "wide", lens_mm: 35 },
    });
    expect(scene).toMatchObject({
      id: "beat-1",
      subject: "a detective",
      scene: "an alley",
      motion: "walking",
      characterId: "detective",
      heroMoment: true,
      textureKeywords: ["neon"],
      shotLanguage: { shotSize: "wide", lensMm: 35 },
    });
  });

  it("defaults missing fields (empty strings, null characterId, false heroMoment, 'visual' type)", () => {
    const scene = sceneFromDict({ id: "s1" });
    expect(scene.subject).toBe("");
    expect(scene.characterId).toBeNull();
    expect(scene.heroMoment).toBe(false);
    expect(scene.type).toBe("visual");
  });
});

describe("deterministicFixture — the 3-beat noir certification fixture", () => {
  it("returns 3 scenes sharing character_id 'detective', 2 of them hero_moment", () => {
    const scenes = deterministicFixture();
    expect(scenes).toHaveLength(3);
    expect(scenes.every((s) => s.characterId === "detective")).toBe(true);
    expect(scenes.filter((s) => s.heroMoment)).toHaveLength(2);
  });
});

describe("loadScenes — --scenes / --story / fixture fallback", () => {
  it("reads and parses a --scenes JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storyboard-native-"));
    try {
      const scenesPath = join(dir, "scenes.json");
      await writeFile(scenesPath, JSON.stringify([{ id: "a", subject: "x", scene: "y" }]));
      const scenes = await loadScenes({ scenes: scenesPath });
      expect(scenes).toHaveLength(1);
      expect(scenes[0]?.id).toBe("a");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when --scenes JSON is not a list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storyboard-native-"));
    try {
      const scenesPath = join(dir, "scenes.json");
      await writeFile(scenesPath, JSON.stringify({ not: "a list" }));
      await expect(loadScenes({ scenes: scenesPath })).rejects.toThrow(/must be a list/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses --story via the injected decompose impl when given", async () => {
    const decomposeImpl = async () => [{ id: "gen-1", subject: "x", scene: "y" }];
    const scenes = await loadScenes({ story: "a story", _decomposeImpl: decomposeImpl });
    expect(scenes[0]?.id).toBe("gen-1");
  });

  it("falls back to the deterministic fixture when --story decomposition throws", async () => {
    const decomposeImpl = async () => {
      throw new Error("LM Studio unreachable");
    };
    const scenes = await loadScenes({ story: "a story", _decomposeImpl: decomposeImpl });
    expect(scenes[0]?.id).toBe("beat-1");
  });

  it("falls back to the deterministic fixture when --story decomposition returns an empty list", async () => {
    const decomposeImpl = async () => [];
    const scenes = await loadScenes({ story: "a story", _decomposeImpl: decomposeImpl });
    expect(scenes[0]?.id).toBe("beat-1");
  });

  it("defaults to the deterministic fixture when neither --scenes nor --story is given", async () => {
    const scenes = await loadScenes({});
    expect(scenes[0]?.id).toBe("beat-1");
  });
});

describe("shotRoute — per-shot generation routing", () => {
  const recurring = new Set(["detective"]);

  it("routes a recurring-character shot to 'locked' when hero is present and kontextLock is off", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: "detective", heroMoment: false }, recurring, false, true)).toBe("locked");
  });

  it("routes a recurring-character shot to 'kontext' when hero is present and kontextLock is on", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: "detective", heroMoment: false }, recurring, true, true)).toBe("kontext");
  });

  it("routes to 'independent' when there is no hero, even for a recurring character (mirrors Python's documented --character requirement)", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: "detective", heroMoment: false }, recurring, true, false)).toBe("independent");
  });

  it("routes a non-recurring character to 'independent' regardless of hero/kontextLock", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: "stranger", heroMoment: false }, recurring, true, true)).toBe("independent");
  });

  it("routes a shot with no characterId to 'independent'", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: null, heroMoment: false }, recurring, false, true)).toBe("independent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_native.test.ts )`
Expected: FAIL — `Cannot find module './storyboard_native.ts'`

- [ ] **Step 3: Write the implementation**

```typescript
// bun-apps/pi-agent-ext-movie-director/src/storyboard_native.ts
/**
 * storyboard_native.ts — native Bun port of `run.py image storyboard`'s core
 * generation line (`app/commands/image-storyboard.py`, 730 lines).
 *
 * image-storyboard.py's own docstring says generation "reuses the tested
 * `execute_generation` core (the same path t2i uses) — no new MLX generation
 * code": scene decomposition is a plain LM Studio HTTP call
 * (storyboard_decompose.ts), scene→shot planning is pure logic
 * (storyboard_scene.ts / storyboard_prompt.ts), and per-shot generation
 * routes onto already-native primitives:
 *   - independent shots  → krea2 `t2i` (Z-Image)
 *   - locked shots        → flux2 `edit` (soft character-lock, hero as the
 *                            sole multi-ref)
 *   - kontext-lock shots  → flux2 `kontext` (true in-context identity lock)
 *
 * Two documented deltas from the Python (not silently dropped — see
 * docs/superpowers/specs/2026-08-01-storyboard-native-port-design.md):
 *   - The Python's soft character-lock uses `denoise_strength=0.85` (partial
 *     SDEdit redraw on top of flux2-klein's reference conditioning). flux2's
 *     `edit` command has no denoise-strength knob (verified against
 *     commands.ts); this port uses pure multi-ref conditioning instead — the
 *     same identity-lock mechanism `profile_native.ts`/`character_native.ts`
 *     already rely on.
 *   - The Python batches all kontext-lock shots in an arc into ONE
 *     `Flux1Kontext` model load (the ~31GB load is the expensive part). The
 *     Swift `flux2 kontext` CLI has no multi-prompt-per-invocation mode, so
 *     this port calls it once per shot (N loads instead of 1) — a
 *     performance delta, not a functional one.
 *
 * DEFERRED (documented, not silently dropped): the `--judge` closed loop
 * (caption score + VLM identity verification + weak-frame regeneration) —
 * left on the `runpy_image` fallback path, same treatment `workflow_hybrid`
 * gives its own deferred stages.
 *
 * Unlike the Python (which raises `RuntimeError` and aborts the whole run on
 * one shot's generation failure), a failed shot here records `image: null`
 * and orchestration continues — matching the graceful-degradation
 * convention `character_native.ts`'s Phase 2 cutout loop already
 * established, a deliberate deviation from the Python's fail-fast behavior.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runFlux2 } from "@repo/pi-agent-ext-flux2";
import { runKrea2 } from "@repo/pi-agent-ext-krea2";
import { decomposeStory } from "./storyboard_decompose.ts";
import { planStoryboard, type SceneSpec, type Shot, type ShotLanguage } from "./storyboard_scene.ts";
import { runSpawn, type SpawnImpl } from "./spawn.ts";
import type { LmStudioChatOptions } from "./lmstudio.ts";

export type { SceneSpec, Shot, Storyboard, ShotLanguage } from "./storyboard_scene.ts";

// ── Scene sourcing ──────────────────────────────────────────────────────

/** Convert a raw JSON scene dict (from --scenes or gemma decomposition) into a SceneSpec (mirrors `_scene_from_dict`). Wire format is snake_case, matching the schema embedded in the decompose prompt and the --scenes file convention. */
export function sceneFromDict(d: Record<string, unknown>): SceneSpec {
  const sl = (d.shot_language ?? {}) as Record<string, unknown>;
  const shotLanguage: ShotLanguage = {
    lensMm: sl.lens_mm as number | undefined,
    depthOfField: sl.depth_of_field as string | undefined,
    shotSize: sl.shot_size as string | undefined,
    cameraMovement: sl.camera_movement as string | undefined,
    lightingKey: sl.lighting_key as string | undefined,
    colorTemperature: sl.color_temperature as string | undefined,
  };
  return {
    id: String(d.id ?? `scene-${(d as { _idx?: unknown })._idx ?? "?"}`),
    subject: String(d.subject ?? ""),
    scene: String(d.scene ?? ""),
    motion: String(d.motion ?? ""),
    framing: String(d.framing ?? ""),
    shotLanguage,
    textureKeywords: Array.isArray(d.texture_keywords) ? (d.texture_keywords as string[]) : [],
    characterId: (d.character_id as string | null | undefined) ?? null,
    heroMoment: !!d.hero_moment,
    type: String(d.type ?? "visual"),
  };
}

/** A 3-beat detective-noir storyboard with one recurring character (mirrors `_deterministic_fixture`). Certifies the pipeline without the gemma brain. */
export function deterministicFixture(): SceneSpec[] {
  const shot = (shotSize: string, lightingKey: string, lensMm: number): ShotLanguage => ({ shotSize, lightingKey, lensMm });
  return [
    {
      id: "beat-1",
      subject: "a weary detective in a trench coat",
      scene: "a rain-soaked alley at night",
      motion: "lighting a cigarette under a flickering lamp",
      shotLanguage: shot("wide", "low_key", 35),
      textureKeywords: ["neon reflections", "wet pavement", "cigarette smoke"],
      characterId: "detective",
      heroMoment: true,
    },
    {
      id: "beat-2",
      subject: "the same detective",
      scene: "a cramped diner booth",
      motion: "studying a case file across the table",
      shotLanguage: shot("medium", "tungsten_warm", 50),
      textureKeywords: ["steam from coffee", "scattered photographs"],
      characterId: "detective",
      heroMoment: false,
    },
    {
      id: "beat-3",
      subject: "the detective",
      scene: "the city rooftop at dawn",
      motion: "looking out over the skyline",
      shotLanguage: shot("medium_close", "blue_hour", 85),
      textureKeywords: ["wind-blown coat", "soft morning haze"],
      characterId: "detective",
      heroMoment: true,
    },
  ];
}

export interface LoadScenesOptions extends LmStudioChatOptions {
  scenes?: string;
  story?: string;
  numPanels?: number;
  styleHint?: string;
  /** Test seam: inject a canned decompose call so unit tests don't need a real LM Studio server. */
  _decomposeImpl?: typeof decomposeStory;
}

/** Resolve the scene list: --scenes JSON file, --story (gemma decomposition), or the deterministic fixture (mirrors `_load_scenes`). */
export async function loadScenes(opts: LoadScenesOptions): Promise<SceneSpec[]> {
  if (opts.scenes) {
    const raw: unknown = JSON.parse(await readFile(opts.scenes, "utf8"));
    if (!Array.isArray(raw)) {
      throw new Error(`--scenes JSON must be a list, got ${typeof raw}`);
    }
    return (raw as Record<string, unknown>[]).map(sceneFromDict);
  }
  if (opts.story) {
    const decompose = opts._decomposeImpl ?? decomposeStory;
    try {
      const raw = await decompose(opts.story, {
        numPanels: opts.numPanels ?? 4,
        styleHint: opts.styleHint,
        model: opts.model,
        apiUrl: opts.apiUrl,
        timeoutMs: opts.timeoutMs,
        _fetchImpl: opts._fetchImpl,
      });
      if (raw.length > 0) return raw.map(sceneFromDict);
    } catch {
      // fall through to the deterministic fixture — mirrors Python's broad except
    }
    return deterministicFixture();
  }
  return deterministicFixture();
}

// ── Shot routing ─────────────────────────────────────────────────────────

export type ShotRoute = "kontext" | "locked" | "independent";

/**
 * Decide one shot's render path (mirrors `_shot_route`, extended with an
 * explicit `hasHero` check — Python's own `--character` help text says
 * "without it, all shots are independent T2I").
 */
export function shotRoute(shot: Shot, recurringIds: Set<string>, kontextLock: boolean, hasHero: boolean): ShotRoute {
  if (hasHero && shot.characterId != null && recurringIds.has(shot.characterId)) {
    return kontextLock ? "kontext" : "locked";
  }
  return "independent";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_native.test.ts )`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/storyboard_native.ts bun-apps/pi-agent-ext-movie-director/src/storyboard_native.test.ts
git commit -m "feat(storyboard): scene sourcing + shot routing (storyboard_native.ts part A)"
```

---

### Task 5: `storyboard_native.ts` part B — generation impls + contact sheet

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.test.ts`

Appends the three generation function types + default implementations (`defaultT2i`/`defaultEdit`/`defaultKontext`, thin wrappers over `runKrea2`/`runFlux2` — not unit-tested directly, same precedent as `character_native.ts`'s `defaultCutout`) and `buildContactSheet` (ffmpeg `scale`+`pad`+`concat`+`tile`, tested via an injected `SpawnImpl`).

- [ ] **Step 1: Write the failing test**

Append to `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.test.ts`:

```typescript
import { buildContactSheet } from "./storyboard_native.ts";
import type { SpawnImpl } from "./spawn.ts";

describe("buildContactSheet — ffmpeg tile assembly", () => {
  it("throws when given zero images", async () => {
    await expect(buildContactSheet([], "/out/sheet.png")).rejects.toThrow(/no frames/);
  });

  it("invokes ffmpeg with one scale+pad filter per image, concat, and a tile filter sized to the grid", async () => {
    const calls: { cmd: string; argv: string[] }[] = [];
    const spawnImpl: SpawnImpl = async (cmd, argv) => {
      calls.push({ cmd, argv });
      return { code: 0, stdout: "", stderr: "" };
    };

    await buildContactSheet(["/a.png", "/b.png", "/c.png", "/d.png"], "/out/sheet.png", 3, spawnImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("ffmpeg");
    const argv = calls[0]!.argv;
    expect(argv).toContain("-i");
    expect(argv.filter((a) => a === "-i")).toHaveLength(5); // 4 real inputs + 1 pad source (2x2 grid, 4 images)
    const filterIdx = argv.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(-1);
    const filter = argv[filterIdx + 1]!;
    expect(filter).toContain("concat=n=4");
    expect(filter).toContain("tile=3x2");
    expect(argv).toContain("/out/sheet.png");
  });

  it("needs no pad source when the image count exactly fills the grid", async () => {
    const calls: { argv: string[] }[] = [];
    const spawnImpl: SpawnImpl = async (_cmd, argv) => {
      calls.push({ argv });
      return { code: 0, stdout: "", stderr: "" };
    };
    await buildContactSheet(["/a.png", "/b.png", "/c.png"], "/out/sheet.png", 3, spawnImpl);
    expect(calls[0]!.argv.filter((a) => a === "-i")).toHaveLength(3);
  });

  it("throws with ffmpeg's stderr tail when the process exits non-zero", async () => {
    const spawnImpl: SpawnImpl = async () => ({ code: 1, stdout: "", stderr: "unknown filter" });
    await expect(buildContactSheet(["/a.png"], "/out/sheet.png", 3, spawnImpl)).rejects.toThrow(/unknown filter/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_native.test.ts )`
Expected: FAIL — `buildContactSheet is not a function` (or "does not provide an export")

- [ ] **Step 3: Append the implementation**

Append to `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.ts` (after the `shotRoute` function, before the final export):

```typescript
// ── Generation impls (independent / locked / kontext) ──────────────────

export interface T2iParams {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  outputDir?: string;
}
export interface T2iResult {
  path: string | null;
}
export type T2iFn = (params: T2iParams) => Promise<T2iResult>;

/** Default independent-shot generation: native krea2 Z-Image t2i (mirrors the Python's default `zimage` pipeline). */
export const defaultT2i: T2iFn = async (p) => {
  const out = await runKrea2({
    command: "t2i",
    options: { prompt: p.prompt, seed: p.seed, width: p.width, height: p.height, steps: p.steps },
    outputDir: p.outputDir,
  });
  return { path: out.details.ok ? out.details.output : null };
};

export interface EditParams {
  prompt: string;
  images: string[];
  seed: number;
  width: number;
  height: number;
  steps: number;
  outputDir?: string;
}
export interface EditResult {
  path: string | null;
}
export type EditFn = (params: EditParams) => Promise<EditResult>;

/** Default soft-lock generation: native flux2 `edit` (multi-ref conditioning, hero as the sole reference). No denoise-strength knob — see module doc. */
export const defaultEdit: EditFn = async (p) => {
  const out = await runFlux2({
    command: "edit",
    options: { prompt: p.prompt, images: p.images, seed: p.seed, width: p.width, height: p.height, steps: p.steps },
    outputDir: p.outputDir,
  });
  return { path: out.details.ok ? out.details.output : null };
};

export interface KontextParams {
  input: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  outputDir?: string;
}
export interface KontextResult {
  path: string | null;
}
export type KontextFn = (params: KontextParams) => Promise<KontextResult>;

/** Default kontext-lock generation: native flux2 `kontext` (true in-context identity lock). One call per shot — no batched single-model-load, see module doc. */
export const defaultKontext: KontextFn = async (p) => {
  const out = await runFlux2({
    command: "kontext",
    options: { input: p.input, prompt: p.prompt, seed: p.seed, width: p.width, height: p.height },
    outputDir: p.outputDir,
  });
  return { path: out.details.ok ? out.details.output : null };
};

// ── Contact sheet ────────────────────────────────────────────────────────

const CONTACT_SHEET_CELL_W = 480;
const CONTACT_SHEET_CELL_H = 720; // matches the non-kontext default aspect (640x960)

/**
 * Tile frame PNGs into a contact-sheet grid via ffmpeg (mirrors
 * `_build_contact_sheet`'s PIL tiling, without adding an image-codec
 * dependency to this package). Each source is letterboxed into a fixed
 * CONTACT_SHEET_CELL_W x CONTACT_SHEET_CELL_H cell (ffmpeg's `concat`+`tile`
 * require identical frame dimensions, unlike PIL's variable-height row
 * packing) — a documented simplification, not a silent behavior change.
 * Trailing empty grid cells (when imagePaths.length isn't a multiple of
 * cols) are padded with a solid dark-gray still frame, mirroring Python's
 * (16,16,16) background canvas.
 */
export async function buildContactSheet(
  imagePaths: string[],
  outPath: string,
  cols = 3,
  spawnImpl: SpawnImpl = runSpawn,
): Promise<void> {
  if (imagePaths.length === 0) {
    throw new Error("buildContactSheet: no frames to build a contact sheet");
  }
  const rows = Math.ceil(imagePaths.length / cols);
  const totalCells = cols * rows;
  const padCount = totalCells - imagePaths.length;

  const argv: string[] = ["-y"];
  for (const p of imagePaths) argv.push("-i", p);
  if (padCount > 0) {
    argv.push("-f", "lavfi", "-i", `color=c=0x101010:s=${CONTACT_SHEET_CELL_W}x${CONTACT_SHEET_CELL_H}:d=1`);
  }

  const filter: string[] = [];
  const labels: string[] = [];
  imagePaths.forEach((_, i) => {
    filter.push(
      `[${i}:v]scale=${CONTACT_SHEET_CELL_W}:${CONTACT_SHEET_CELL_H}:force_original_aspect_ratio=decrease,` +
        `pad=${CONTACT_SHEET_CELL_W}:${CONTACT_SHEET_CELL_H}:(ow-iw)/2:(oh-ih)/2:color=0x101010[s${i}]`,
    );
    labels.push(`[s${i}]`);
  });
  if (padCount > 0) {
    const padInputIdx = imagePaths.length;
    for (let i = 0; i < padCount; i++) {
      filter.push(`[${padInputIdx}:v]scale=${CONTACT_SHEET_CELL_W}:${CONTACT_SHEET_CELL_H}[sp${i}]`);
      labels.push(`[sp${i}]`);
    }
  }
  filter.push(`${labels.join("")}concat=n=${totalCells}:v=1:a=0[c]`);
  filter.push(`[c]tile=${cols}x${rows}[out]`);
  argv.push("-filter_complex", filter.join(";"));
  argv.push("-map", "[out]", "-frames:v", "1", outPath);

  const r = await spawnImpl("ffmpeg", argv);
  if (r.code !== 0) {
    throw new Error(`buildContactSheet: ffmpeg exited ${r.code}: ${r.stderr.slice(-500)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_native.test.ts )`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/storyboard_native.ts bun-apps/pi-agent-ext-movie-director/src/storyboard_native.test.ts
git commit -m "feat(storyboard): generation impls + ffmpeg contact sheet (storyboard_native.ts part B)"
```

---

### Task 6: `storyboard_native.ts` part C — the main orchestration

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.test.ts`

Appends `runStoryboardNative` (ties scene loading → planning → per-shot routed generation → contact sheet) and `writeStoryboardJson` (split out for testability, mirroring `character_native.ts`'s `writeIdentitySpec`).

- [ ] **Step 1: Write the failing test**

Append to `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.test.ts`:

```typescript
import { runStoryboardNative, writeStoryboardJson, type SceneSpec, type T2iFn, type EditFn, type KontextFn } from "./storyboard_native.ts";

function noContactSheet(): SpawnImpl {
  return async () => ({ code: 0, stdout: "", stderr: "" });
}

describe("runStoryboardNative — the core orchestration (mocked scenes + generation)", () => {
  const fixedScenes: SceneSpec[] = [
    { id: "beat-1", subject: "detective", scene: "alley", characterId: "detective", heroMoment: true },
    { id: "beat-2", subject: "detective", scene: "diner", characterId: "detective" },
    { id: "beat-3", subject: "a stranger", scene: "rooftop", characterId: "stranger" },
  ];

  it("routes independent/locked/kontext shots to the right generation impl and assembles frames", async () => {
    const t2iCalls: string[] = [];
    const editCalls: string[] = [];
    const t2iImpl: T2iFn = async (p) => {
      t2iCalls.push(p.prompt);
      return { path: `/out/${p.prompt.slice(0, 4)}-t2i.png` };
    };
    const editImpl: EditFn = async (p) => {
      editCalls.push(p.prompt);
      return { path: `/out/${p.prompt.slice(0, 4)}-edit.png` };
    };

    const result = await runStoryboardNative({
      scenesOverride: fixedScenes,
      character: "/hero.png",
      outputDir: "/out",
      _t2iImpl: t2iImpl,
      _editImpl: editImpl,
      _spawnImpl: noContactSheet(),
    });

    expect(t2iCalls).toHaveLength(1); // the "stranger" shot (not recurring)
    expect(editCalls).toHaveLength(2); // the two "detective" shots (recurring, no kontextLock)
    expect(result.frames).toHaveLength(3);
    expect(result.frames.find((f) => f.sceneId === "beat-1")?.characterLocked).toBe(true);
    expect(result.frames.find((f) => f.sceneId === "beat-3")?.characterLocked).toBe(false);
    expect(result.recurringCharacters).toEqual(["detective"]);
  });

  it("routes recurring shots to kontext when kontextLock is set, with a distinct seed per kontext shot", async () => {
    const kontextSeeds: number[] = [];
    const kontextImpl: KontextFn = async (p) => {
      kontextSeeds.push(p.seed);
      return { path: "/out/k.png" };
    };

    await runStoryboardNative({
      scenesOverride: fixedScenes,
      character: "/hero.png",
      kontextLock: true,
      seed: 777,
      outputDir: "/out",
      _kontextImpl: kontextImpl,
      _t2iImpl: async () => ({ path: "/out/t2i.png" }),
      _spawnImpl: noContactSheet(),
    });

    expect(kontextSeeds).toEqual([777, 778]); // base_seed + index within the kontext-routed shots
  });

  it("keeps a failed shot's image as null and continues the run (no fail-fast, unlike Python)", async () => {
    const t2iImpl: T2iFn = async () => ({ path: null });
    const result = await runStoryboardNative({
      scenesOverride: [{ id: "s1", subject: "x", scene: "y" }],
      outputDir: "/out",
      _t2iImpl: t2iImpl,
      _spawnImpl: noContactSheet(),
    });
    expect(result.frames[0]?.image).toBeNull();
  });

  it("skips the contact sheet entirely when every shot fails (nothing to tile)", async () => {
    const spawnCalls: string[][] = [];
    const result = await runStoryboardNative({
      scenesOverride: [{ id: "s1", subject: "x", scene: "y" }],
      outputDir: "/out",
      _t2iImpl: async () => ({ path: null }),
      _spawnImpl: async (_cmd, argv) => {
        spawnCalls.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(spawnCalls).toHaveLength(0);
    expect(result.contactSheet).toBeNull();
  });

  it("uses the deterministic fixture when scenesOverride is omitted and no --scenes/--story is given", async () => {
    const result = await runStoryboardNative({
      outputDir: "/out",
      _t2iImpl: async () => ({ path: "/out/t2i.png" }),
      _editImpl: async () => ({ path: "/out/edit.png" }),
      _spawnImpl: noContactSheet(),
    });
    expect(result.frames).toHaveLength(3);
    expect(result.frames[0]?.sceneId).toBe("beat-1");
  });
});

describe("writeStoryboardJson", () => {
  it("writes storyboard.json with a trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storyboard-native-"));
    try {
      const result = await runStoryboardNative({
        scenesOverride: [{ id: "s1", subject: "x", scene: "y" }],
        outputDir: dir,
        _t2iImpl: async () => ({ path: "/out/t2i.png" }),
        _spawnImpl: noContactSheet(),
      });
      const path = await writeStoryboardJson(dir, result);
      expect(path).toBe(join(dir, "storyboard.json"));
      const { readFile: rf } = await import("node:fs/promises");
      const raw = await rf(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw).frames).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_native.test.ts )`
Expected: FAIL — `runStoryboardNative is not a function`

- [ ] **Step 3: Append the implementation**

Append to `bun-apps/pi-agent-ext-movie-director/src/storyboard_native.ts` (after `buildContactSheet`):

```typescript
// ── The main orchestration ──────────────────────────────────────────────

export interface StoryboardOptions extends LoadScenesOptions {
  character?: string;
  kontextLock?: boolean;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  outputDir?: string;
  /** Test seam: bypass loadScenes entirely with a fixed scene list. */
  scenesOverride?: SceneSpec[];
  /** Test seam: inject a canned t2i call so unit tests don't need the krea2 binary. */
  _t2iImpl?: T2iFn;
  /** Test seam: inject a canned edit call so unit tests don't need the flux2 binary. */
  _editImpl?: EditFn;
  /** Test seam: inject a canned kontext call so unit tests don't need the flux2 binary. */
  _kontextImpl?: KontextFn;
  /** Test seam: inject a canned ffmpeg spawn so unit tests don't need a real ffmpeg. */
  _spawnImpl?: SpawnImpl;
}

export interface StoryboardFrame {
  sceneId: string;
  characterId: string | null;
  heroMoment: boolean;
  characterLocked: boolean;
  kontextLocked: boolean;
  prompt: string;
  image: string | null;
}

export interface StoryboardResult {
  outDir: string;
  contactSheet: string | null;
  hero: string | null;
  kontextLock: boolean;
  recurringCharacters: string[];
  frames: StoryboardFrame[];
}

/**
 * Run the storyboard core generation line: scene sourcing → planning →
 * per-shot routed generation → contact sheet (mirrors `run_storyboard`,
 * minus the `--judge` closed loop — see module doc). A shot generation
 * failure records `image: null` and the run continues (see module doc for
 * the deliberate deviation from Python's fail-fast behavior).
 */
export async function runStoryboardNative(opts: StoryboardOptions): Promise<StoryboardResult> {
  const scenes = opts.scenesOverride ?? (await loadScenes(opts));
  const storyboard = planStoryboard(scenes);
  const hero = opts.character ?? null;
  const kontextLock = !!opts.kontextLock && hero != null;
  const recurringIds = new Set(storyboard.recurringCharacters);

  const baseSeed = opts.seed ?? 777;
  const width = opts.width ?? 640;
  const height = opts.height ?? 960;
  const steps = opts.steps ?? 9;
  const kontextWidth = opts.width ?? 1024;
  const kontextHeight = opts.height ?? 1024;

  const t2i = opts._t2iImpl ?? defaultT2i;
  const edit = opts._editImpl ?? defaultEdit;
  const kontext = opts._kontextImpl ?? defaultKontext;

  const frames: StoryboardFrame[] = [];
  let kontextIndex = 0;
  for (const shot of storyboard.shots) {
    const route = shotRoute(shot, recurringIds, kontextLock, hero != null);
    let image: string | null = null;
    if (route === "independent") {
      const r = await t2i({ prompt: shot.prompt, seed: baseSeed, width, height, steps, outputDir: opts.outputDir });
      image = r.path;
    } else if (route === "locked") {
      const r = await edit({ prompt: shot.prompt, images: [hero as string], seed: baseSeed, width, height, steps, outputDir: opts.outputDir });
      image = r.path;
    } else {
      const r = await kontext({
        input: hero as string,
        prompt: shot.prompt,
        seed: baseSeed + kontextIndex,
        width: kontextWidth,
        height: kontextHeight,
        outputDir: opts.outputDir,
      });
      kontextIndex += 1;
      image = r.path;
    }
    frames.push({
      sceneId: shot.sceneId,
      characterId: shot.characterId,
      heroMoment: shot.heroMoment,
      characterLocked: route !== "independent",
      kontextLocked: route === "kontext",
      prompt: shot.prompt,
      image,
    });
  }

  const outDir = opts.outputDir ?? ".";
  const successfulImages = frames.map((f) => f.image).filter((p): p is string => p != null);
  let contactSheet: string | null = null;
  if (successfulImages.length > 0) {
    const contactSheetPath = join(outDir, "contact_sheet.png");
    await buildContactSheet(successfulImages, contactSheetPath, 3, opts._spawnImpl);
    contactSheet = contactSheetPath;
  }

  return { outDir, contactSheet, hero, kontextLock, recurringCharacters: storyboard.recurringCharacters, frames };
}

/** Write storyboard.json to `<outDir>/storyboard.json` (mirrors Python's `json.dump(..., indent=2)` + trailing newline). Split out so the core orchestration stays pure/testable, mirroring `character_native.ts`'s `writeIdentitySpec`. */
export async function writeStoryboardJson(outDir: string, result: StoryboardResult): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "storyboard.json");
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/storyboard_native.test.ts )`
Expected: PASS (23 tests)

- [ ] **Step 5: Run the full package suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: PASS, no regressions in other test files

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/storyboard_native.ts bun-apps/pi-agent-ext-movie-director/src/storyboard_native.test.ts
git commit -m "feat(storyboard): main orchestration — runStoryboardNative (storyboard_native.ts part C)"
```

---

### Task 7: `registry.ts` — new entry, remove `storyboard` from `runpy_image`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts`

- [ ] **Step 1: Add `"bun:storyboard-native"` to the `invoke` union**

In `bun-apps/pi-agent-ext-movie-director/src/registry.ts`, find the `invoke` union inside `ProviderEntry` (around line 38-65) and add the new literal after `"bun:character-native"`:

```typescript
    | "bun:character-native"
    | "bun:storyboard-native"
```

- [ ] **Step 2: Remove `"storyboard"` from `runpy_image`'s `commands[]` and update its notes**

Find the `runpy_image` entry (around line 134-146). Change:

```typescript
    commands: [
      "purify", "multicouple",
      "storyboard",
    ],
```

to:

```typescript
    commands: ["purify", "multicouple"],
```

In the same entry's `notes` string, find this sentence:

> `storyboard` accepts `--kontext-lock` to route recurring-character shots through true in-context Kontext (FLUX.1-Kontext-dev).

Replace it with:

> `storyboard` moved OFF this adapter (2026-08-01) onto `storyboard_native` below — see that entry's notes; image-storyboard.py's own docstring calls its generation "no new MLX generation code," reusing the same `execute_generation` core `t2i` uses.

And find this later sentence in the same `notes` string:

> `storyboard --kontext-lock` stays here — image-storyboard.py still calls Python's `_run_kontext_generation` in-process, a deliberately separate follow-up.

Delete that sentence entirely (the whole `storyboard` command, including its `--kontext-lock` path, moved off this adapter — there is no longer a partial-stay-here case for it).

- [ ] **Step 3: Add the new `storyboard_native` entry**

Insert after the `character_native` entry (after its closing `},`, before the `// story adapters` comment block, around line 273):

```typescript
  // storyboard — 2026-08-01: image-storyboard.py's own docstring says its
  // generation "reuses the tested execute_generation core (the same path
  // t2i uses) — no new MLX generation code": scene decomposition is a plain
  // LM Studio HTTP call (same shape story_native.ts already ported), scene
  // planning is pure logic, and per-shot generation routes onto already-
  // Swift-native primitives (krea2 t2i / flux2 edit / flux2 kontext). So it
  // moved off run.py onto a direct Bun implementation (storyboard_native.ts)
  // — see docs/superpowers/specs/2026-08-01-storyboard-native-port-design.md.
  // Declared AFTER runpy_image is irrelevant here since `storyboard` was
  // removed from runpy_image's commands[] above — no overlap, no selector
  // tiebreak needed.
  {
    name: "storyboard_native",
    capability: "image_generation",
    provider: "storyboard-native",
    backend: "native_swift",
    invoke: "bun:storyboard-native",
    configured: true,
    commands: ["storyboard"],
    notes: "Direct Bun implementation (src/storyboard_native.ts) of image-storyboard.py's core generation line: scene decomposition (LM Studio HTTP, same gemma-brain pattern as story_native.ts) → scene_spec/shot_prompt_builder planning (ported 1:1, pure logic) → per-shot routing onto krea2 t2i (independent) / flux2 edit (locked, hero as sole multi-ref — no denoise-strength knob, a documented delta from Python's SDEdit soft-lock) / flux2 kontext (kontext-lock, one call per shot — no batched single-model-load like Python's arc-level Kontext batching) → ffmpeg-tiled contact sheet. No run.py, no MLX venv for the orchestration itself — generation still bridges through the same krea2/flux2 Swift directors every other native module uses. Deferred to runpy_image (documented, not silently dropped): the --judge closed loop (caption score + VLM identity verification + weak-frame regeneration), see docs/superpowers/specs/2026-08-01-storyboard-native-port-design.md.",
  },

```

- [ ] **Step 4: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun run typecheck )`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/registry.ts
git commit -m "feat(storyboard): register storyboard_native, remove storyboard from runpy_image"
```

---

### Task 8: `bridge.ts` wiring + `selector.test.ts` coverage

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/selector.test.ts`

- [ ] **Step 1: Add `realStoryboardNative` to `bridge.ts`**

In `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`, insert after the `realCharacterNative` function (immediately before the `/** The live adapter map. ... */` comment, around line 1151):

```typescript
/**
 * realStoryboardNative — the storyboard core generation line via
 * storyboard_native.ts, NOT a run.py subprocess (2026-08-01 — see that
 * module's header). Each generated frame's image becomes one kind:"image"
 * artifact (role:"primary"); frames whose generation failed are skipped from
 * artifacts (their `image` is null, but still recorded in the returned
 * result for the caller). The written storyboard.json rides as a second
 * kind:"text" artifact (role:"metadata"). ok = at least one frame was
 * generated (runStoryboardNative itself never throws on a per-shot failure
 * — see module doc; it only throws on a scene-loading error, e.g. an
 * unreadable --scenes file).
 */
async function realStoryboardNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as Record<string, unknown>;
  const started = Date.now();
  try {
    const { runStoryboardNative, writeStoryboardJson } = await import("./storyboard_native.ts");
    const result = await runStoryboardNative({
      scenes: opts.scenes as string | undefined,
      story: opts.story as string | undefined,
      numPanels: opts.numPanels as number | undefined,
      styleHint: opts.styleHint as string | undefined,
      character: (opts.character as string | undefined) ?? (opts.input as string | undefined),
      kontextLock: opts.kontextLock as boolean | undefined,
      seed: opts.seed as number | undefined,
      width: opts.width as number | undefined,
      height: opts.height as number | undefined,
      steps: opts.steps as number | undefined,
      outputDir: req.outputDir,
    });

    const artifacts: ToolResult["artifacts"] = result.frames
      .filter((f) => f.image)
      .map((f) => ({ path: f.image as string, kind: "image" as const, role: "primary" as const }));

    const jsonPath = await writeStoryboardJson(result.outDir, result);
    artifacts.push({ path: jsonPath, kind: "text" as const, role: "metadata" as const });
    if (result.contactSheet) {
      artifacts.push({ path: result.contactSheet, kind: "image" as const, role: "reference" as const });
    }

    return {
      success: artifacts.some((a) => a.kind === "image" && a.role === "primary"),
      provider: "storyboard-native",
      command: "image storyboard",
      artifacts,
      error: null,
      cost_usd: costFor(req.capability, null, env),
      duration_seconds: (Date.now() - started) / 1000,
      seed: opts.seed as number | undefined ?? null,
      model: "krea2:t2i+flux2:edit+flux2:kontext",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      provider: "storyboard-native",
      command: "image storyboard",
      artifacts: [],
      error: msg,
      cost_usd: 0,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "krea2:t2i+flux2:edit+flux2:kontext",
    };
  }
}

```

- [ ] **Step 2: Register it in `realAdapters`**

In the same file, find `realAdapters`'s return object (around line 1153-1175) and add a new entry right after `"bun:character-native": (req) => realCharacterNative(req, env),`:

```typescript
    "bun:storyboard-native": (req) => realStoryboardNative(req, env),
```

- [ ] **Step 3: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun run typecheck )`
Expected: 0 errors

- [ ] **Step 4: Add a routing test to `selector.test.ts`**

In `bun-apps/pi-agent-ext-movie-director/src/selector.test.ts`, insert a new test after the `"routes image_generation:character → character-native ..."` test (around line 267, before the `"routes image_generation:{angle,swap,...}"` test):

```typescript
  it("routes image_generation:storyboard → storyboard-native (pure orchestration of decompose+plan+route, already Swift-native)", () => {
    // 2026-08-01: image-storyboard.py's own docstring calls its generation
    // "no new MLX generation code" (reuses the same execute_generation core
    // t2i uses). Moved off run.py onto a direct Bun implementation
    // (storyboard_native.ts) routing per-shot onto krea2 t2i / flux2 edit /
    // flux2 kontext, all already Swift-native.
    const e = selectProvider("image_generation", { command: "storyboard", env: NO_ENV });
    expect(e.provider).toBe("storyboard-native");
    expect(e.invoke).toBe("bun:storyboard-native");
  });

```

Then update the existing `"routes image_generation:<run.py-only command> → runpy-image"` test's comment block (around line 198-221) — the line `// "multicouple" stays here permanently...` is still accurate, but the preceding summary line needs updating. Change:

```typescript
    // runpy_image declares purify/multicouple/storyboard —
```

to:

```typescript
    // runpy_image declares purify/multicouple —
```

And the trailing list of "moved OFF" bullets in that same comment (ending in `... and "cutout" moved OFF (2026-07-31) onto flux2_image — see the dedicated tests.`) gets one more clause appended:

```typescript
    // ... and "cutout" moved OFF (2026-07-31) onto flux2_image — see the
    // dedicated tests. "storyboard" moved OFF (2026-08-01) onto
    // storyboard_native — see the dedicated test above.
```

- [ ] **Step 5: Run the full test suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: PASS, all tests green including the new selector test

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/bridge.ts bun-apps/pi-agent-ext-movie-director/src/selector.test.ts
git commit -m "feat(storyboard): wire storyboard_native into bridge.ts + selector routing test"
```

---

### Task 9: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full movie-director suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: PASS, 0 failures

- [ ] **Step 2: Typecheck the package**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun run typecheck )`
Expected: 0 errors

- [ ] **Step 3: Validate the schema-drift canary**

Run: `bun run --cwd bun-apps/gui-movie-director check:schema`
Expected: PASS (no drift between `run.py`'s schema and this registry/bridge change — this port adds a routing path, it doesn't change any CLI schema)

- [ ] **Step 4: Grep for stale `storyboard` + `segment`/`purify-only` references**

Run:
```bash
grep -rn '"storyboard"' bun-apps/pi-agent-ext-movie-director/src/runpy_image.ts
grep -rn "storyboard" bun-apps/pi-agent-ext-movie-director/src/registry.ts | grep -i "runpy_image\|commands\[\]" 
```
Expected: `runpy_image.ts`'s `ImageAction` union may still list `"storyboard"` as a legal run.py CLI action (that's fine — `runpy_image.ts` still supports being called directly/manually with `provider: "runpy-image"` hint; only the default `{capability, command}` routing changed). Confirm no other file still claims `storyboard` reaches `runpy_image` by default (i.e. `registry.ts`'s `runpy_image.commands[]` must not contain `"storyboard"`).

- [ ] **Step 5: Confirm no leftover TODO/placeholder markers**

Run: `grep -rn "TODO\|FIXME\|TBD" bun-apps/pi-agent-ext-movie-director/src/storyboard_*.ts`
Expected: no output

This task produces no commit — it's a verification checkpoint before handing off to code review / finishing-a-development-branch.
