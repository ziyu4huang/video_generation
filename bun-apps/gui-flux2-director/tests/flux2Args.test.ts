import { describe, expect, test } from "bun:test";

import { t2iArgs, upscaleArgs } from "../lib/flux2Args";

describe("t2iArgs", () => {
  test("minimal: only the prompt", () => {
    expect(t2iArgs({ prompt: "a cat in space" })).toEqual(["t2i", "--prompt", "a cat in space"]);
  });

  test("full expert settings emit every flag", () => {
    const args = t2iArgs({
      prompt: "兩個角色在教室",
      negativePrompt: "blurry",
      transformer: "klein-9b-dark-beast-bfs",
      width: 896,
      height: 1152,
      steps: 8,
      cfgScale: 1.0,
      seed: "12345",
      strictGate: true,
      lora: [
        { name: "details-9b", scale: 0.8 },
        { name: "qualitya", scale: 1.0 },
      ],
    });
    expect(args).toEqual([
      "t2i",
      "--prompt", "兩個角色在教室",
      "--negative-prompt", "blurry",
      "--transformer", "klein-9b-dark-beast-bfs",
      "--width", "896",
      "--height", "1152",
      "--steps", "8",
      "--cfg-scale", "1",
      "--seed", "12345",
      "--lora", "details-9b", "--lora", "qualitya",
      "--lora-scale", "0.8", "--lora-scale", "1",
      "--strict-gate",
    ]);
  });

  test("seed is a string pass-through (UInt64 may exceed safe int)", () => {
    const seed = "99999999999999999999";
    expect(t2iArgs({ prompt: "x", seed })).toContain(seed);
  });

  test("lora scales repeat one flag per entry", () => {
    const args = t2iArgs({
      prompt: "x",
      lora: [{ name: "a", scale: 0.5 }, { name: "b", scale: 0.25 }],
    });
    const scales = args.filter((a, i) => args[i - 1] === "--lora-scale");
    expect(scales).toEqual(["0.5", "0.25"]);
  });

  test("rejects empty prompt", () => {
    expect(() => t2iArgs({ prompt: "  " })).toThrow(/prompt/);
  });
});

describe("upscaleArgs", () => {
  test("input + computed output next to the input", () => {
    expect(upscaleArgs({ input: "/out/a.png", output: "/out/a.4x.png" })).toEqual([
      "upscale", "--input", "/out/a.png", "--output", "/out/a.4x.png",
    ]);
  });

  test("model + tiling options", () => {
    const args = upscaleArgs({ input: "/x.png", model: "4x-nomos-webphoto-realplksr", tileSize: 256, noTile: true });
    expect(args).toEqual([
      "upscale", "--input", "/x.png",
      "--model", "4x-nomos-webphoto-realplksr",
      "--tile-size", "256",
      "--no-tile",
    ]);
  });

  test("rejects missing input", () => {
    expect(() => upscaleArgs({ input: "" })).toThrow(/input/);
  });
});
