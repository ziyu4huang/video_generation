import { describe, expect, test } from "bun:test";
import {
  buildArgs,
  COMMANDS,
  COMMAND_LIST,
  modeledFlags,
  pathFieldKeys,
} from "./commands.ts";

describe("buildArgs", () => {
  test("emits a scalar string flag", () => {
    const args = buildArgs(COMMANDS.t2i, { prompt: "a cat" });
    expect(args).toEqual(["--prompt", "a cat"]);
  });

  test("emits a scalar number/int flag as a string", () => {
    const args = buildArgs(COMMANDS.t2i, { seed: 42, width: 1024 });
    expect(args).toEqual(["--seed", "42", "--width", "1024"]);
  });

  test("emits a boolean flag only when true, and omits it when false", () => {
    expect(buildArgs(COMMANDS.t2i, { strictGate: true })).toEqual(["--strict-gate"]);
    expect(buildArgs(COMMANDS.t2i, { strictGate: false })).toEqual([]);
  });

  test("omits fields that are undefined/null/absent", () => {
    expect(buildArgs(COMMANDS.t2i, { prompt: undefined, seed: null as unknown as undefined })).toEqual([]);
    expect(buildArgs(COMMANDS.t2i, {})).toEqual([]);
  });

  test("expands a string[] field into repeated flags", () => {
    const args = buildArgs(COMMANDS.scene, { ref: ["a.png", "b.png"] });
    expect(args).toEqual(["--ref", "a.png", "--ref", "b.png"]);
  });

  test("expands a number[] field into repeated flags", () => {
    const args = buildArgs(COMMANDS.scene, { refStrength: [0.5, 1.0] });
    expect(args).toEqual(["--ref-strength", "0.5", "--ref-strength", "1"]);
  });

  test("throws when an array field receives a non-array value", () => {
    expect(() => buildArgs(COMMANDS.scene, { ref: "a.png" })).toThrow(/expects an array/);
  });

  test("collects positional args and appends them after all flags (gate)", () => {
    const args = buildArgs(COMMANDS.gate, { images: ["a.png", "b.png"], json: true });
    expect(args).toEqual(["--json", "a.png", "b.png"]);
  });

  test("ignores keys not declared on the spec", () => {
    const args = buildArgs(COMMANDS.t2i, { notARealField: "x", prompt: "ok" });
    expect(args).toEqual(["--prompt", "ok"]);
  });
});

describe("pathFieldKeys", () => {
  test("t2i has no path fields besides output/outputDir", () => {
    expect(pathFieldKeys(COMMANDS.t2i).sort()).toEqual(["output", "outputDir"]);
  });

  test("scene includes array-of-path fields (ref) alongside scalar path fields", () => {
    const keys = pathFieldKeys(COMMANDS.scene);
    expect(keys).toContain("ref");
    expect(keys).toContain("bg");
    expect(keys).toContain("output");
  });

  test("gate's positional `images` field is a path array", () => {
    expect(pathFieldKeys(COMMANDS.gate)).toEqual(["images"]);
  });
});

describe("modeledFlags", () => {
  test("excludes positional fields and includes every flagged field", () => {
    const flags = modeledFlags(COMMANDS.gate);
    expect(flags).not.toContain("");
    expect(flags).toContain("--json");
    expect(flags).toContain("--strict");
  });
});

describe("COMMANDS registry", () => {
  test("has exactly the 18 documented flux2 subcommands", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [
        "angle", "edit", "expand", "gate", "models", "scene", "segment",
        "story", "style", "swap", "t2i", "upscale",
        "verify-e2e", "verify-edit", "verify-encoder", "verify-tokenizer",
        "verify-transformer", "verify-vae",
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
