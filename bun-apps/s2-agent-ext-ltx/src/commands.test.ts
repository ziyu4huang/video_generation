import { describe, expect, test } from "bun:test";
import { buildArgs, buildParams, COMMANDS, COMMAND_LIST, modeledFlags, pathFieldKeys, pathSpecFieldKeys } from "./commands.ts";

describe("buildArgs", () => {
  test("emits a scalar string flag", () => {
    const args = buildArgs(COMMANDS.t2i, { prompt: "a cat" });
    expect(args).toEqual(["--prompt", "a cat"]);
  });

  test("emits a scalar number/int flag as a string", () => {
    const args = buildArgs(COMMANDS.t2i, { seed: 42, width: 1024 });
    expect(args).toEqual(["--width", "1024", "--seed", "42"]);
  });

  test("emits a boolean flag only when true, and omits it when false (no invertedFlag)", () => {
    expect(buildArgs(COMMANDS.gate, { json: true })).toEqual(["--json"]);
    expect(buildArgs(COMMANDS.gate, { json: false })).toEqual([]);
  });

  test("inversion boolean: true emits the primary flag, false emits invertedFlag", () => {
    expect(buildArgs(COMMANDS["native-i2v"], { upscale: true })).toEqual(["--upscale"]);
    expect(buildArgs(COMMANDS["native-i2v"], { upscale: false })).toEqual(["--no-upscale"]);
    expect(buildArgs(COMMANDS["native-i2v"], { refine: false })).toEqual(["--no-refine"]);
  });

  test("mp4 inversion: true emits --mp4, false emits --no-mp4 (native-i2v and native-upscale)", () => {
    expect(buildArgs(COMMANDS["native-i2v"], { mp4: true })).toEqual(["--mp4"]);
    expect(buildArgs(COMMANDS["native-i2v"], { mp4: false })).toEqual(["--no-mp4"]);
    expect(buildArgs(COMMANDS["native-upscale"], { mp4: true })).toEqual(["--mp4"]);
    expect(buildArgs(COMMANDS["native-upscale"], { mp4: false })).toEqual(["--no-mp4"]);
  });

  test("native-upscale's restorationLora/upscaleLora emit their flags as plain string options", () => {
    const args = buildArgs(COMMANDS["native-upscale"], {
      restorationLora: "restore.safetensors",
      upscaleLora: "upscale.safetensors",
    });
    expect(args).toEqual(["--restoration-lora", "restore.safetensors", "--upscale-lora", "upscale.safetensors"]);
  });

  test("omits fields that are undefined/null/absent", () => {
    expect(buildArgs(COMMANDS.t2i, { prompt: undefined, seed: null as unknown as undefined })).toEqual([]);
    expect(buildArgs(COMMANDS.t2i, {})).toEqual([]);
  });

  test("expands a string[] field into repeated flags (native-i2v's --lora)", () => {
    const args = buildArgs(COMMANDS["native-i2v"], { loras: ["a.safetensors:0.8", "b.safetensors"] });
    expect(args).toEqual(["--lora", "a.safetensors:0.8", "--lora", "b.safetensors"]);
  });

  test("throws when an array field receives a non-array value", () => {
    expect(() => buildArgs(COMMANDS["native-i2v"], { loras: "a.safetensors" })).toThrow(/expects an array/);
  });

  test("collects positional args and appends them after all flags (gate)", () => {
    const args = buildArgs(COMMANDS.gate, { videos: ["a.mp4", "b.mp4"], json: true });
    expect(args).toEqual(["--json", "a.mp4", "b.mp4"]);
  });

  test("collects a single positional path field (upscale's input)", () => {
    const args = buildArgs(COMMANDS.upscale, { input: "clip.mp4", scale: 2.0 });
    expect(args).toEqual(["--scale", "2", "clip.mp4"]);
  });

  test("ignores keys not declared on the spec", () => {
    const args = buildArgs(COMMANDS.t2i, { notARealField: "x", prompt: "ok" });
    expect(args).toEqual(["--prompt", "ok"]);
  });

  test("native-i2v's inputImage emits --input-image as a plain string option", () => {
    const args = buildArgs(COMMANDS["native-i2v"], { inputImage: "prior_last_frame.png" });
    expect(args).toEqual(["--input-image", "prior_last_frame.png"]);
  });

  test("native-relay expands prompts/lora/variant as repeated flags", () => {
    const args = buildArgs(COMMANDS["native-relay"], {
      prompts: ["a cat walks", "the cat sits"],
      loras: ["a.safetensors:0.8"],
      variant: ["baseline", "vbvr=vbvr.safetensors:1.0"],
    });
    expect(args).toEqual([
      "--prompts", "a cat walks", "--prompts", "the cat sits",
      "--lora", "a.safetensors:0.8",
      "--variant", "baseline", "--variant", "vbvr=vbvr.safetensors:1.0",
    ]);
  });

  test("native-relay's secondsPerSegment/segmentContinuity emit one flag occurrence per array element", () => {
    const args = buildArgs(COMMANDS["native-relay"], {
      prompts: ["a", "b"],
      secondsPerSegment: [8, 6.5],
      segmentContinuity: [true, false],
    });
    expect(args).toEqual([
      "--prompts", "a", "--prompts", "b",
      "--seconds-per-segment", "8", "--seconds-per-segment", "6.5",
      "--segment-continuity", "true", "--segment-continuity", "false",
    ]);
  });

  test("native-ingredients/native-restyle emit their required scalar flags", () => {
    expect(buildArgs(COMMANDS["native-ingredients"], { input: "ref.png", prompt: "a scene", lora: "ing.safetensors" }))
      .toEqual(["--input", "ref.png", "--prompt", "a scene", "--lora", "ing.safetensors"]);
    expect(buildArgs(COMMANDS["native-restyle"], { input: "frames/", prompt: "anime style", audio: "a.wav", lora: "style.safetensors" }))
      .toEqual(["--input", "frames/", "--prompt", "anime style", "--audio", "a.wav", "--lora", "style.safetensors"]);
  });
});

describe("pathFieldKeys", () => {
  test("t2i has output as its only plain path field", () => {
    expect(pathFieldKeys(COMMANDS.t2i)).toEqual(["output"]);
  });

  test("native-i2v includes lastFrame/audioTrack/inputImage/output but NOT loras (that's a path-spec field)", () => {
    const keys = pathFieldKeys(COMMANDS["native-i2v"]);
    expect(keys).toContain("lastFrame");
    expect(keys).toContain("audioTrack");
    expect(keys).toContain("inputImage");
    expect(keys).toContain("output");
    expect(keys).not.toContain("loras");
  });

  test("native-upscale includes restorationLora/upscaleLora as path-validated fields", () => {
    const keys = pathFieldKeys(COMMANDS["native-upscale"]);
    expect(keys).toContain("restorationLora");
    expect(keys).toContain("upscaleLora");
  });

  test("gate's positional `videos` field is a path array", () => {
    expect(pathFieldKeys(COMMANDS.gate)).toEqual(["videos"]);
  });
});

describe("pathSpecFieldKeys", () => {
  test("native-i2v's loras/anchorImages, native-t2a/native-relay's loras are the only path-spec fields in the registry", () => {
    expect(pathSpecFieldKeys(COMMANDS["native-i2v"])).toEqual(["loras", "anchorImages"]);
    expect(pathSpecFieldKeys(COMMANDS["native-t2a"])).toEqual(["loras"]);
    expect(pathSpecFieldKeys(COMMANDS["native-relay"])).toEqual(["loras"]);
    for (const [name, spec] of Object.entries(COMMANDS)) {
      if (name === "native-i2v" || name === "native-t2a" || name === "native-relay") continue;
      expect(pathSpecFieldKeys(spec)).toEqual([]);
    }
  });

  test("native-relay's --variant is a plain string[] (name[=lora_path[:strength]]), NOT a path-spec field — its format doesn't match plain path[:strength]", () => {
    expect(COMMANDS["native-relay"].fields.variant?.isPathSpecArray).toBeFalsy();
    expect(COMMANDS["native-relay"].fields.variant?.isPath).toBeFalsy();
  });
});

describe("modeledFlags", () => {
  test("excludes positional fields and includes every flagged field", () => {
    const flags = modeledFlags(COMMANDS.gate);
    expect(flags).not.toContain("");
    expect(flags).toContain("--json");
    expect(flags).toContain("--strict");
  });

  test("includes both directions of an inversion pair", () => {
    const flags = modeledFlags(COMMANDS["native-i2v"]);
    expect(flags).toContain("--upscale");
    expect(flags).toContain("--no-upscale");
    expect(flags).toContain("--refine");
    expect(flags).toContain("--no-refine");
  });
});

describe("COMMANDS registry", () => {
  test("has exactly the 21 documented ltx-video subcommands", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [
        "t2i", "native-i2v", "native-upscale", "native-t2a", "native-relay",
        "native-storyboard", "native-ingredients", "native-restyle", "segment", "i2v", "upscale",
        "gate", "verify", "models", "audio-decode", "video-decode",
        "asr-gate", "vbvr", "review", "compare", "quality",
      ].sort(),
    );
  });

  test("every command's fields build to a valid args array without throwing (empty options)", () => {
    for (const spec of COMMAND_LIST) {
      expect(() => buildArgs(spec, {})).not.toThrow();
    }
  });

  test("every command's `name` matches its registry key", () => {
    for (const [key, spec] of Object.entries(COMMANDS)) {
      expect(spec.name).toBe(key);
    }
  });
});

describe("isPathComponent fields (model-selector names Swift joins onto a root itself)", () => {
  test("t2i/native-i2v/native-relay/i2v's transformer fields are marked isPathComponent", () => {
    expect(COMMANDS.t2i.fields.transformer?.isPathComponent).toBe(true);
    expect(COMMANDS["native-i2v"].fields.t2iTransformer?.isPathComponent).toBe(true);
    expect(COMMANDS["native-relay"].fields.t2iTransformer?.isPathComponent).toBe(true);
    expect(COMMANDS.i2v.fields.transformer?.isPathComponent).toBe(true);
  });

  test("isPathComponent fields are never also marked isPath/isPathArray/isPathSpecArray", () => {
    for (const spec of COMMAND_LIST) {
      for (const [key, f] of Object.entries(spec.fields)) {
        if (f.isPathComponent) {
          expect(f.isPath, `${spec.name}.${key}`).toBeFalsy();
          expect(f.isPathArray, `${spec.name}.${key}`).toBeFalsy();
          expect(f.isPathSpecArray, `${spec.name}.${key}`).toBeFalsy();
        }
      }
    }
  });
});

describe("enumValues fields (restricted to a fixed set of values)", () => {
  test("gate's expectedScript is restricted to 'traditional'/'simplified' in the generated typebox schema", () => {
    // Regression: expectedScript used to be an unconstrained free-form string
    // — an invalid value (e.g. "zh-TW") silently disabled the whole
    // script-mismatch check on the Swift side instead of erroring (found by
    // s2-agent-ext-ltx-self-improve's review lane, 2026-07-05).
    expect(COMMANDS.gate.fields.expectedScript?.enumValues).toEqual(["traditional", "simplified"]);
    const schema = buildParams(COMMANDS.gate) as { properties: Record<string, unknown> };
    const expectedScriptSchema = schema.properties.expectedScript as { type: string; enum: string[] };
    // StringEnum (from @earendil-works/pi-ai) emits a JSON-Schema `enum` array;
    // it replaced Type.Union([Type.Literal(...), ...]) whose anyOf/const shape this
    // test previously asserted.
    expect(expectedScriptSchema.type).toBe("string");
    expect(expectedScriptSchema.enum).toEqual(["traditional", "simplified"]);
  });
});
