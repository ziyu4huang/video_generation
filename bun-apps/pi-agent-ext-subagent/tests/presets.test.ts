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

  test("vision is ALWAYS local lm-studio in every preset (text providers can't do vision)", () => {
    for (const p of MODEL_PRESETS) {
      const vision = p.config.capabilities?.vision;
      expect(vision).toMatch(/^lm-studio\//);
    }
  });

  test("findPreset returns by id, undefined otherwise", () => {
    for (const p of MODEL_PRESETS) {
      expect(findPreset(p.id)?.id).toBe(p.id);
    }
    expect(findPreset("does-not-exist")).toBeUndefined();
  });
});
