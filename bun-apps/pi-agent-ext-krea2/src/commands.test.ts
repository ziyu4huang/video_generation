import { describe, expect, test } from "bun:test";
import {
  buildArgs,
  COMMANDS,
  COMMAND_LIST,
  modeledFlags,
  pathFieldKeys,
  type CommandSpec,
} from "./commands.ts";

/** Narrow a registry lookup to a defined CommandSpec (fail loudly if missing). */
function cmd(name: string): CommandSpec {
  const spec = COMMANDS[name];
  if (!spec) throw new Error(`unknown krea2 command "${name}"`);
  return spec;
}

describe("buildArgs", () => {
  test("emits a scalar string flag", () => {
    const args = buildArgs(cmd("t2i"), { prompt: "a red apple" });
    expect(args).toEqual(["--prompt", "a red apple"]);
  });

  test("emits scalar int flags as strings", () => {
    const args = buildArgs(cmd("t2i"), { seed: 42, width: 1024, steps: 8 });
    expect(args).toEqual(["--width", "1024", "--steps", "8", "--seed", "42"]);
  });

  test("emits a scalar number (float) flag as a string (mu)", () => {
    const args = buildArgs(cmd("t2i"), { mu: 1.15 });
    expect(args).toEqual(["--mu", "1.15"]);
  });

  test("emits a boolean flag only when true, omits when false (t2i --bridge)", () => {
    expect(buildArgs(cmd("t2i"), { bridge: true })).toEqual(["--bridge"]);
    expect(buildArgs(cmd("t2i"), { bridge: false })).toEqual([]);
  });

  test("omits fields that are undefined/null/absent", () => {
    expect(buildArgs(cmd("t2i"), { prompt: undefined, seed: null as unknown as undefined })).toEqual([]);
    expect(buildArgs(cmd("t2i"), {})).toEqual([]);
  });

  test("ignores keys not declared on the spec", () => {
    const args = buildArgs(cmd("t2i"), { notARealField: "x", prompt: "ok" });
    expect(args).toEqual(["--prompt", "ok"]);
  });

  test("emits i2i's --input + --strength", () => {
    const args = buildArgs(cmd("i2i"), { input: "in.png", prompt: "edit", strength: 0.9 });
    expect(args).toEqual(["--input", "in.png", "--prompt", "edit", "--strength", "0.9"]);
  });

  test("emits controlnet's --control-image/--control-lora/--strength/--channel-mode/--normalize/--invert", () => {
    const args = buildArgs(cmd("controlnet"), {
      prompt: "a mountain",
      controlImage: "depth.png",
      controlLora: "lora.safetensors",
      strength: 0.8,
      channelMode: "rgb",
      normalize: "none",
      invert: true,
    });
    expect(args).toEqual([
      "--prompt", "a mountain",
      "--control-image", "depth.png",
      "--control-lora", "lora.safetensors",
      "--strength", "0.8",
      "--channel-mode", "rgb",
      "--normalize", "none",
      "--invert",
    ]);
  });

  test("controlnet omits --invert when false (default)", () => {
    const args = buildArgs(cmd("controlnet"), { prompt: "x", controlImage: "d.png", invert: false });
    expect(args).toEqual(["--prompt", "x", "--control-image", "d.png"]);
  });
});

describe("pathFieldKeys", () => {
  test("t2i has only `out` as a path field", () => {
    expect(pathFieldKeys(cmd("t2i")).sort()).toEqual(["out"]);
  });

  test("i2i has input + out as path fields", () => {
    expect(pathFieldKeys(cmd("i2i")).sort()).toEqual(["input", "out"]);
  });

  test("controlnet has controlImage + controlLora + out as path fields", () => {
    expect(pathFieldKeys(cmd("controlnet")).sort()).toEqual(["controlImage", "controlLora", "out"]);
  });
});

describe("modeledFlags", () => {
  test("t2i models prompt/width/height/steps/seed/mu/out/bridge", () => {
    const flags = new Set(modeledFlags(cmd("t2i")));
    for (const f of ["--prompt", "--width", "--height", "--steps", "--seed", "--mu", "--out", "--bridge"]) {
      expect(flags.has(f)).toBe(true);
    }
  });
});

describe("COMMANDS registry", () => {
  test("has exactly the 3 krea2 subcommands", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(["controlnet", "i2i", "t2i"]);
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

  test("both commands write an image", () => {
    for (const spec of COMMAND_LIST) {
      expect(spec.writesImage).toBe(true);
    }
  });
});
