/**
 * character_lock.test.ts — unit tests for the cross-image character-lock planner.
 *
 * Pure/deterministic (no generation). Covers: the lock is applied identically to
 * every shot, the hero is the reference anchor, the style anchor is appended, the
 * ref-conditioning extraArgs, default-fill, and the validation guards.
 */
import { describe, expect, it } from "bun:test";
import {
  planCharacterShots,
  shotOptionsFor,
  refCondExtraArgs,
  type CharacterLock,
} from "./character_lock.ts";

const BASE_LOCK: CharacterLock = {
  pipeline: "flux2-klein",
  seed: 42,
  refCount: 3,
  refStrength: 0.8,
  styleAnchor: "cinematic, teal-and-orange grade",
};

describe("planCharacterShots", () => {
  it("applies the SAME seed + pipeline to every shot (the #1 consistency lever)", () => {
    const spec = planCharacterShots({
      hero: "/hero.png",
      lock: BASE_LOCK,
      scenes: [{ prompt: "reading in a café" }, { prompt: "walking in rain" }, { prompt: "on a rooftop" }],
    });
    expect(spec.shots.length).toBe(3);
    for (const shot of spec.shots) {
      expect(shot.options.seed).toBe(42);
      expect(shot.options.pipeline).toBe("flux2-klein");
      expect(shot.options.action).toBe("i2i");
    }
  });

  it("uses the hero as BOTH inputImage and referenceImage (identity anchor)", () => {
    const spec = planCharacterShots({
      hero: "/bank/hero.png",
      lock: { seed: 7 },
      scenes: [{ prompt: "scene A" }],
    });
    expect(spec.shots[0]!.options.inputImage).toBe("/bank/hero.png");
    expect(spec.shots[0]!.options.referenceImage).toBe("/bank/hero.png");
    expect(spec.hero).toBe("/bank/hero.png");
    expect(spec.schema).toBe("character-lock.v1");
  });

  it("appends the styleAnchor to each shot prompt (style/palette lock)", () => {
    const spec = planCharacterShots({
      hero: "/h.png",
      lock: { seed: 1, styleAnchor: "film grain, 35mm" },
      scenes: [{ prompt: "a detective" }],
    });
    expect(spec.shots[0]!.options.prompt).toBe("a detective, film grain, 35mm");
  });

  it("uses high denoise so the scene is new (identity via ref-cond, not low-denoise edit)", () => {
    const spec = planCharacterShots({
      hero: "/h.png",
      lock: { seed: 1 },
      scenes: [{ prompt: "x" }],
    });
    expect(spec.shots[0]!.options.denoiseStrength).toBeGreaterThanOrEqual(0.8);
  });

  it("auto-ids shots shot-1..shot-N when no explicit id is given", () => {
    const spec = planCharacterShots({
      hero: "/h.png",
      lock: { seed: 1 },
      scenes: [{ prompt: "a" }, { prompt: "b" }],
    });
    expect(spec.shots.map((s) => s.id)).toEqual(["shot-1", "shot-2"]);
  });

  it("fills defaults: pipeline flux2-klein, refCount 3, refStrength 0.8", () => {
    const spec = planCharacterShots({
      hero: "/h.png",
      lock: { seed: 9 },
      scenes: [{ prompt: "x" }],
    });
    expect(spec.lock.pipeline).toBe("flux2-klein");
    expect(spec.lock.refCount).toBe(3);
    expect(spec.lock.refStrength).toBe(0.8);
  });

  it("includes the LoRA on each shot only when a loraPath is set", () => {
    const withLora = planCharacterShots({
      hero: "/h.png",
      lock: { seed: 1, loraPath: "/loras/char.safetensors" },
      scenes: [{ prompt: "x" }],
    });
    expect(withLora.shots[0]!.options.loraPath).toBe("/loras/char.safetensors");
    expect(withLora.shots[0]!.options.loraScale).toBe(1.0);

    const noLora = planCharacterShots({
      hero: "/h.png",
      lock: { seed: 1 },
      scenes: [{ prompt: "x" }],
    });
    expect(noLora.shots[0]!.options.loraPath).toBeUndefined();
  });

  it("throws when hero is empty or no scenes given", () => {
    expect(() => planCharacterShots({ hero: "", lock: { seed: 1 }, scenes: [{ prompt: "x" }] })).toThrow(/hero/);
    expect(() => planCharacterShots({ hero: "/h.png", lock: { seed: 1 }, scenes: [] })).toThrow(/scene/);
  });
});

describe("refCondExtraArgs", () => {
  it("emits --ref-count + --ref-strength from the lock", () => {
    expect(refCondExtraArgs(BASE_LOCK)).toEqual(["--ref-count", "3", "--ref-strength", "0.8"]);
  });
  it("omits a field when it is null/undefined", () => {
    expect(refCondExtraArgs({ seed: 1, refCount: 2 })).toEqual(["--ref-count", "2"]);
  });
});

describe("shotOptionsFor (single-shot helper)", () => {
  it("returns one locked option set for a scene", () => {
    const o = shotOptionsFor("/h.png", BASE_LOCK, "running");
    expect(o.action).toBe("i2i");
    expect(o.seed).toBe(42);
    expect(o.prompt).toBe("running, cinematic, teal-and-orange grade");
  });
});
