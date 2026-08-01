import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CUTOUT_SUBJECT,
  DEFAULT_SAM_THRESHOLD,
  cutoutPathFor,
  buildIdentitySpec,
  runCharacterNative,
  writeIdentitySpec,
  type CutoutFn,
} from "./character_native.ts";
import type { ProfileResult } from "./profile_native.ts";

describe("cutoutPathFor — cutout output naming", () => {
  it("appends _cutout before the extension", () => {
    expect(cutoutPathFor("/out/front.png")).toBe("/out/front_cutout.png");
  });

  it("handles nested dirs; output is always .png regardless of source extension (cutout always writes PNG)", () => {
    expect(cutoutPathFor("/a/b/c/right.jpg")).toBe("/a/b/c/right_cutout.png");
  });
});

describe("buildIdentitySpec — pure IdentitySpec.json builder", () => {
  it("emits schema character-lock.v1 with defaults", () => {
    const spec = buildIdentitySpec("/hero.png", 42, {}, []);
    expect(spec.schema).toBe("character-lock.v1");
    expect(spec.hero).toBe("/hero.png");
    expect(spec.lock).toEqual({
      pipeline: "flux2-klein",
      seed: 42,
      refCount: 3,
      refStrength: 0.8,
      styleAnchor: "",
    });
    expect(spec.shots).toEqual([]);
    expect(spec.views).toEqual([]);
  });

  it("normalizes pipeline 'auto' to 'flux2-klein' (mirrors Python)", () => {
    const spec = buildIdentitySpec("/hero.png", 1, { pipeline: "auto" }, []);
    expect(spec.lock.pipeline).toBe("flux2-klein");
  });

  it("carries loraPath/loraScale only when loraPath is set", () => {
    const withoutLora = buildIdentitySpec("/hero.png", 1, {}, []);
    expect(withoutLora.lock.loraPath).toBeUndefined();

    const withLora = buildIdentitySpec("/hero.png", 1, { loraPath: "/lora.safetensors" }, []);
    expect(withLora.lock.loraPath).toBe("/lora.safetensors");
    expect(withLora.lock.loraScale).toBe(1.0);

    const withLoraScale = buildIdentitySpec("/hero.png", 1, { loraPath: "/lora.safetensors", loraScale: 0.5 }, []);
    expect(withLoraScale.lock.loraScale).toBe(0.5);
  });

  it("carries cfgScale only when explicitly set", () => {
    const without = buildIdentitySpec("/hero.png", 1, {}, []);
    expect(without.lock.cfgScale).toBeUndefined();
    const withCfg = buildIdentitySpec("/hero.png", 1, { cfgScale: 5.0 }, []);
    expect(withCfg.lock.cfgScale).toBe(5.0);
  });

  it("trims styleAnchor", () => {
    const spec = buildIdentitySpec("/hero.png", 1, { styleAnchor: "  soft anime shading  " }, []);
    expect(spec.lock.styleAnchor).toBe("soft anime shading");
  });

  it("carries views[] through unchanged (extension field)", () => {
    const views = [{ view: "front" as const, image: "/f.png", cutout: "/f_cutout.png" }];
    const spec = buildIdentitySpec("/hero.png", 1, {}, views);
    expect(spec.views).toEqual(views);
  });
});

function fakeProfile(views: ("front" | "back" | "side")[]): ProfileResult {
  return {
    views: views.map((v) => ({ view: v, angle: v, path: `/out/${v}.png`, seed: 123, width: 896, height: 1792 })),
    seed: 123,
    width: 896,
    height: 1792,
  };
}

describe("runCharacterNative — the core orchestration (mocked profile + cutout)", () => {
  it("throws when --input is missing", async () => {
    await expect(runCharacterNative({ input: "" })).rejects.toThrow(/--input .* is required/);
  });

  it("runs profile phase then cutout phase per view, assembling views[] with real cutout paths", async () => {
    const cutoutCalls: { image: string; prompt: string; threshold: number }[] = [];
    const cutoutImpl: CutoutFn = async (p) => {
      cutoutCalls.push({ image: p.image, prompt: p.prompt, threshold: p.threshold });
      return { cutoutPath: `${p.image}.cutout.png` };
    };
    const runProfile = async () => fakeProfile(["front", "side", "back"]);

    const result = await runCharacterNative({
      input: "/hero.png",
      _runProfile: runProfile,
      _cutoutImpl: cutoutImpl,
    });

    expect(cutoutCalls).toHaveLength(3);
    expect(cutoutCalls.every((c) => c.prompt === DEFAULT_CUTOUT_SUBJECT)).toBe(true);
    expect(cutoutCalls.every((c) => c.threshold === DEFAULT_SAM_THRESHOLD)).toBe(true);

    expect(result.cutouts).toBe(3);
    expect(result.identitySpec.views).toEqual([
      { view: "front", image: "/out/front.png", cutout: "/out/front.png.cutout.png" },
      { view: "side", image: "/out/side.png", cutout: "/out/side.png.cutout.png" },
      { view: "back", image: "/out/back.png", cutout: "/out/back.png.cutout.png" },
    ]);
    expect(result.identitySpec.hero).toBe("/hero.png");
    expect(result.identitySpec.lock.seed).toBe(123);
  });

  it("leaves cutout null for a view with no detection (mirrors Python's None)", async () => {
    const cutoutImpl: CutoutFn = async () => ({ cutoutPath: null });
    const runProfile = async () => fakeProfile(["front"]);

    const result = await runCharacterNative({ input: "/hero.png", _runProfile: runProfile, _cutoutImpl: cutoutImpl });

    expect(result.cutouts).toBe(0);
    expect(result.identitySpec.views[0]).toEqual({ view: "front", image: "/out/front.png", cutout: null });
  });

  it("populates views[].cutout with a real path when cutoutFn succeeds (the gap this plan closes)", async () => {
    const cutoutImpl: CutoutFn = async () => ({ cutoutPath: "/out/front_cutout.png" });
    const runProfile = async () => fakeProfile(["front"]);

    const result = await runCharacterNative({ input: "/hero.png", _runProfile: runProfile, _cutoutImpl: cutoutImpl });

    expect(result.identitySpec.views[0]?.cutout).toBe("/out/front_cutout.png");
  });

  it("propagates a profile-phase failure (no partial-success mode)", async () => {
    const runProfile = async () => {
      throw new Error("profile: flux2 angle failed");
    };
    await expect(
      runCharacterNative({ input: "/hero.png", _runProfile: runProfile }),
    ).rejects.toThrow(/flux2 angle failed/);
  });

  it("forwards lock params (styleAnchor/refCount/etc) into the IdentitySpec", async () => {
    const cutoutImpl: CutoutFn = async () => ({ cutoutPath: null });
    const runProfile = async () => fakeProfile(["front"]);

    const result = await runCharacterNative({
      input: "/hero.png",
      styleAnchor: "blue palette",
      refCount: 2,
      _runProfile: runProfile,
      _cutoutImpl: cutoutImpl,
    });

    expect(result.identitySpec.lock.styleAnchor).toBe("blue palette");
    expect(result.identitySpec.lock.refCount).toBe(2);
  });
});

describe("writeIdentitySpec — disk write", () => {
  it("writes IdentitySpec.json with trailing newline (mirrors Python's json.dump + f.write('\\n'))", async () => {
    const dir = await mkdtemp(join(tmpdir(), "character-native-"));
    try {
      const spec = buildIdentitySpec("/hero.png", 1, {}, []);
      const path = await writeIdentitySpec(dir, spec);
      expect(path).toBe(join(dir, "IdentitySpec.json"));
      const raw = await readFile(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toEqual(spec);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
