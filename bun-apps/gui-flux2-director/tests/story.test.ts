import { describe, expect, test } from "bun:test";
import path from "path";

import {
  buildStoryboardConfig,
  finalVideoForLine,
  segmentVideoForLine,
  validateStory,
  DEFAULT_STORY,
} from "../lib/story";

describe("validateStory", () => {
  test("accepts the default story shape", () => {
    const [params, err] = validateStory(DEFAULT_STORY);
    expect(err).toBeNull();
    expect(params?.scenes.length).toBe(4);
    expect(params?.seconds).toBe(2);
    expect(params?.width).toBe(960);
  });

  test("requires at least one non-empty scene", () => {
    expect(validateStory({ scenes: ["  ", ""] })[1]).toMatch(/at least one scene/);
    expect(validateStory({ scenes: [] })[1]).toMatch(/at least one scene/);
  });

  test("caps at 4 scenes", () => {
    expect(validateStory({ scenes: ["a", "b", "c", "d", "e"] })[1]).toMatch(/at most 4/);
  });

  test("seconds must be an integer 1..8 (8k+1 frames @ 24fps)", () => {
    expect(validateStory({ scenes: ["a"], seconds: 0 })[1]).toMatch(/seconds/);
    expect(validateStory({ scenes: ["a"], seconds: 2.5 })[1]).toMatch(/seconds/);
    expect(validateStory({ scenes: ["a"], seconds: 3 })[1]).toBeNull();
  });

  test("seed must be a JSON-number-safe UInt64 string", () => {
    expect(validateStory({ scenes: ["a"], seed: "12ab" })[1]).toMatch(/seed/);
    expect(validateStory({ scenes: ["a"], seed: "99999999999999999999" })[1]).toMatch(/JSON number/);
    expect(validateStory({ scenes: ["a"], seed: "777" })[1]).toBeNull();
  });
});

describe("validateStory (auto mode)", () => {
  test("accepts an idea + sceneCount and materializes blank scenes", () => {
    const [params, err] = validateStory({ auto: { idea: "  a cat's odyssey ", voice: "" }, sceneCount: 3, seed: "7" });
    expect(err).toBeNull();
    expect(params?.auto?.idea).toBe("a cat's odyssey");
    expect(params?.auto?.voice).toBe("");
    expect(params?.scenes).toEqual(["", "", ""]);
  });

  test("idea is required (>=3 chars) in auto mode", () => {
    expect(validateStory({ auto: { idea: "  " }, sceneCount: 2 })[1]).toMatch(/idea/);
    expect(validateStory({ auto: { idea: "ab" }, sceneCount: 2 })[1]).toMatch(/idea/);
  });

  test("idea length is capped", () => {
    expect(validateStory({ auto: { idea: "x".repeat(601) }, sceneCount: 2 })[1]).toMatch(/600/);
  });

  test("voice must be a Kokoro id or empty", () => {
    expect(validateStory({ auto: { idea: "a cat", voice: "../bin" }, sceneCount: 2 })[1]).toMatch(/Kokoro/);
    expect(validateStory({ auto: { idea: "a cat", voice: "af_heart" }, sceneCount: 2 })[1]).toBeNull();
  });

  test("sceneCount must be an integer 1..4 (default 4)", () => {
    expect(validateStory({ auto: { idea: "a cat" }, sceneCount: 0 })[1]).toMatch(/sceneCount/);
    expect(validateStory({ auto: { idea: "a cat" }, sceneCount: 5 })[1]).toMatch(/sceneCount/);
    const [params] = validateStory({ auto: { idea: "a cat" } });
    expect(params?.scenes.length).toBe(4);
  });

  test("auto:false falls back to manual scene validation", () => {
    expect(validateStory({ auto: false, scenes: ["a"] })[1]).toBeNull();
  });
});

describe("buildStoryboardConfig", () => {
  test("hard-cut config: one segment per scene, panel i pinned, style prefix applied", () => {
    const params = validateStory({ scenes: ["a cat", "a dog"], seconds: 2, seed: "42" })[0]!;
    const config = buildStoryboardConfig(params, {
      dir: "/s",
      configPath: "/s/storyboard.json",
      gridPath: "/s/grid.png",
      outDir: "/s/out",
    });
    expect(config.transitionMode).toBe("hard-cut");
    expect(config.grid).toEqual({ image: "/s/grid.png", columns: 2, rows: 1 });
    expect(config.segments.length).toBe(2);
    expect(config.segments[0]).toEqual({ panel: 0, prompt: expect.stringContaining("a cat"), strength: 0.525 });
    expect(config.segments[1]!.panel).toBe(1);
    expect(config.seconds).toBe(2);
    expect(config.output).toBe("/s/out");
  });
});

describe("finalVideoForLine", () => {
  test("parses the native-storyboard 'final:' echo", () => {
    expect(finalVideoForLine("   final: /out/story_final.mp4")).toBe("/out/story_final.mp4");
    expect(finalVideoForLine("   segment 1: /out/seg_1.mp4")).toBeNull();
    expect(finalVideoForLine("✅ wall time: 42.0s")).toBeNull();
  });
});

describe("segmentVideoForLine", () => {
  test("parses relay segment echoes in order", () => {
    const lines = ["→ native storyboard (hard-cut…)", "   segment 1: /out/seg_0001.mp4", "   segment 2: /out/seg_0002.mp4", "   final: /out/story_final.mp4"];
    expect(lines.map(segmentVideoForLine).filter(Boolean)).toEqual(["/out/seg_0001.mp4", "/out/seg_0002.mp4"]);
    expect(segmentVideoForLine("✅ wall time: 42.0s")).toBeNull();
  });
});

describe("stitchGrid single panel", () => {
  test("1 panel copies instead of hstack (ffmpeg needs >=2 inputs)", async () => {
    const { stitchGrid } = await import("../lib/story");
    const { writeFileSync, readFileSync, existsSync } = await import("fs");
    const dir = `/tmp/flux2-gui-grid-${process.pid}-${Date.now()}`;
    const { mkdirSync } = await import("fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/panel.png`, "pngbytes");
    const calls: Array<[string, string[]]> = [];
    await stitchGrid([`${dir}/panel.png`], `${dir}/grid.png`, async (bin, args) => {
      calls.push([bin, args]);
      return { exitCode: 0 };
    });
    expect(calls.length).toBe(0); // no ffmpeg spawn for a 1x1 grid
    expect(readFileSync(`${dir}/grid.png`, "utf8")).toBe("pngbytes");
    expect(existsSync(`${dir}/grid.png`)).toBe(true);
  });
});
