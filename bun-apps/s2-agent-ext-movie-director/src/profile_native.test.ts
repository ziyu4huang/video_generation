import { describe, expect, it } from "bun:test";
import {
  ALL_VIEWS,
  VIEW_ORDER,
  VIEW_TO_ANGLE_PRESET,
  RATIO_PRESETS,
  DEFAULT_RATIO,
  PROFILE_DEFAULT_SEED,
  PROFILE_DEFAULT_STEPS,
  DEFAULT_REF_COUNT,
  resolveDimensions,
  clampRefCount,
  orderViews,
  runProfileNative,
  type AngleFn,
  type ProfileView,
} from "./profile_native.ts";

describe("VIEW_TO_ANGLE_PRESET — view→angle-preset mapping", () => {
  it("maps front/back exactly", () => {
    expect(VIEW_TO_ANGLE_PRESET.front).toBe("front");
    expect(VIEW_TO_ANGLE_PRESET.back).toBe("back");
  });

  it("maps side to 'right' (documented single choice for an ambiguous Python source)", () => {
    expect(VIEW_TO_ANGLE_PRESET.side).toBe("right");
  });
});

describe("resolveDimensions — --ratio preset resolution", () => {
  it("defaults to full-body (896×1792)", () => {
    expect(resolveDimensions({})).toEqual({ width: 896, height: 1792 });
    expect(RATIO_PRESETS[DEFAULT_RATIO]).toEqual([896, 1792]);
  });

  it("resolves a named preset", () => {
    expect(resolveDimensions({ ratio: "standing" })).toEqual({ width: 1024, height: 1536 });
  });

  it("explicit width/height override the preset", () => {
    expect(resolveDimensions({ ratio: "standing", width: 640, height: 960 })).toEqual({ width: 640, height: 960 });
  });
});

describe("clampRefCount — over-conditioning footgun guard", () => {
  it("clamps below 1 up to 1", () => {
    expect(clampRefCount(0)).toBe(1);
  });

  it("clamps above 3 down to 3", () => {
    expect(clampRefCount(5)).toBe(3);
  });

  it("passes through 1-3 unchanged", () => {
    expect(clampRefCount(2)).toBe(2);
  });
});

describe("orderViews — canonical front→side→back ordering", () => {
  it("defaults to all three views in canonical order", () => {
    expect(orderViews(undefined)).toEqual(["front", "side", "back"]);
  });

  it("re-orders an out-of-order subset into canonical order", () => {
    expect(orderViews(["back", "front"])).toEqual(["front", "back"]);
  });

  it("de-duplicates repeated views", () => {
    expect(orderViews(["front", "front", "side"] as ProfileView[])).toEqual(["front", "side"]);
  });
});

describe("runProfileNative — the core multi-view orchestration (mocked angle call)", () => {
  it("throws when --input is missing", async () => {
    await expect(runProfileNative({ input: "" })).rejects.toThrow(/--input is required/);
  });

  it("calls angle once per requested view, in canonical order, with the mapped preset", async () => {
    const calls: { angle: string; seed: number; refCount: number }[] = [];
    const angleImpl: AngleFn = async (p) => {
      calls.push({ angle: p.angle, seed: p.seed, refCount: p.refCount });
      return { path: `/out/${p.angle}.png`, seed: p.seed, width: p.width, height: p.height };
    };

    const result = await runProfileNative({ input: "/ref.png", views: ["back", "front", "side"], _angleImpl: angleImpl });

    expect(calls.map((c) => c.angle)).toEqual(["front", "right", "back"]); // canonical order: front, side(→right), back
    expect(result.views.map((v) => v.view)).toEqual(["front", "side", "back"]);
    expect(result.views[0]?.path).toBe("/out/front.png");
    expect(result.views[1]?.path).toBe("/out/right.png");
    expect(result.views[2]?.path).toBe("/out/back.png");
  });

  it("uses the profile-specific default seed/steps/ref-count when omitted", async () => {
    const calls: { seed: number; steps: number; refCount: number }[] = [];
    const angleImpl: AngleFn = async (p) => {
      calls.push({ seed: p.seed, steps: p.steps, refCount: p.refCount });
      return { path: `/out/${p.angle}.png`, seed: p.seed, width: p.width, height: p.height };
    };

    await runProfileNative({ input: "/ref.png", views: ["front"], _angleImpl: angleImpl });

    expect(calls[0]?.seed).toBe(PROFILE_DEFAULT_SEED);
    expect(calls[0]?.steps).toBe(PROFILE_DEFAULT_STEPS);
    expect(calls[0]?.refCount).toBe(DEFAULT_REF_COUNT);
  });

  it("uses the SAME seed across all views (mirrors Python's all-zero VIEW_SEED_OFFSETS)", async () => {
    const seeds: number[] = [];
    const angleImpl: AngleFn = async (p) => {
      seeds.push(p.seed);
      return { path: `/out/${p.angle}.png`, seed: p.seed, width: p.width, height: p.height };
    };

    await runProfileNative({ input: "/ref.png", seed: 12345, _angleImpl: angleImpl });

    expect(new Set(seeds).size).toBe(1);
    expect(seeds[0]).toBe(12345);
  });

  it("clamps an over-conditioning ref-count before calling angle", async () => {
    let seenRefCount = -1;
    const angleImpl: AngleFn = async (p) => {
      seenRefCount = p.refCount;
      return { path: "/out/front.png", seed: p.seed, width: p.width, height: p.height };
    };

    await runProfileNative({ input: "/ref.png", views: ["front"], refCount: 9, _angleImpl: angleImpl });

    expect(seenRefCount).toBe(3);
  });

  it("propagates an angle failure (no partial-success mode, mirrors Python's sys.exit(1))", async () => {
    const angleImpl: AngleFn = async () => {
      throw new Error("flux2 angle: gate FAIL");
    };
    await expect(runProfileNative({ input: "/ref.png", views: ["front"], _angleImpl: angleImpl })).rejects.toThrow(/gate FAIL/);
  });

  it("defaults ALL_VIEWS to exactly front/back/side", () => {
    expect(ALL_VIEWS).toEqual(["front", "back", "side"]);
    expect(VIEW_ORDER).toEqual(["front", "side", "back"]);
  });
});
