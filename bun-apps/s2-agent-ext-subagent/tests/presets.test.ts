import { describe, expect, test } from "bun:test";
import { findPreset, MODEL_PRESETS } from "../src/presets.js";

describe("MODEL_PRESETS — data validity", () => {
  test("every preset has a valid {tiers, capabilities.vision}", () => {
    expect(MODEL_PRESETS.length).toBeGreaterThanOrEqual(2);
    for (const p of MODEL_PRESETS) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.label).toBeTruthy();
      expect(p.summary).toBeTruthy();
      expect(Object.keys(p.config.tiers).length).toBeGreaterThan(0);
      for (const [, spec] of Object.entries(p.config.tiers)) {
        expect(typeof spec).toBe("string");
        // provider/modelId shape
        expect(spec).toMatch(/^[a-z0-9.-]+\/[a-z0-9./-]+$/i);
      }
    }
  });

  // 2026-08-28: vision lanes are no longer forced local — zai/glm-5.3-flash
  // and deepseek/deepseek-v4-flash-vision-exp are cloud models with REAL
  // image input (glm-5.3-flash vision-verified 2026-08-28 via the repo
  // launcher on the FILE2MD E2E OCR fixture). A vision spec may only name a
  // model from that verified set — a text-only model id here fails silently
  // at runtime (the image part is dropped).
  test("every preset's vision lane is a verified image-capable model", () => {
    const VISION_VERIFIED = /^(zai\/glm-5\.3-flash|deepseek\/deepseek-v4-flash-vision-exp|lm-studio\/[a-z0-9./-]+)$/;
    for (const p of MODEL_PRESETS) {
      for (const [cap, spec] of Object.entries(p.config.capabilities ?? {})) {
        if (cap.includes("vision")) {
          expect(spec).toMatch(VISION_VERIFIED);
        }
      }
    }
    // User directive 2026-08-28: the glm preset rides its own cloud vision
    // lane; the deepseek presets ride deepseek's vision-exp model.
    expect(findPreset("glm")?.config.capabilities?.vision).toBe("zai/glm-5.3-flash");
    for (const id of ["deepseek-pro", "deepseek-flash"]) {
      expect(findPreset(id)?.config.capabilities?.vision).toBe("deepseek/deepseek-v4-flash-vision-exp");
    }
  });

  test("findPreset returns by id, undefined otherwise", () => {
    for (const p of MODEL_PRESETS) {
      expect(findPreset(p.id)?.id).toBe(p.id);
    }
    expect(findPreset("does-not-exist")).toBeUndefined();
  });
});
