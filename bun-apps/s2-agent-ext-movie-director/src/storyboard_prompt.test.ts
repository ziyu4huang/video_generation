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
