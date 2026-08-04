import { describe, expect, test } from "bun:test";
import {
  buildArgs,
  COMMANDS,
  COMMAND_LIST,
  modeledFlags,
  pathFieldKeys,
  type CommandSpec,
} from "./commands.ts";

/**
 * Narrow a registry lookup to a defined CommandSpec.
 *
 * `COMMANDS` is `Record<string, CommandSpec>`; under `noUncheckedIndexedAccess`
 * every lookup is `CommandSpec | undefined`. These tests assert specific
 * commands EXIST and have certain fields, so a missing command should fail the
 * test loudly (throw → test failure) rather than silently dereference
 * undefined. Centralizing the narrowing here keeps each assertion readable.
 */
function cmd(name: string): CommandSpec {
  const spec = COMMANDS[name];
  if (!spec) throw new Error(`unknown flux2 command "${name}"`);
  return spec;
}

describe("buildArgs", () => {
  test("emits a scalar string flag", () => {
    const args = buildArgs(cmd("t2i"), { prompt: "a cat" });
    expect(args).toEqual(["--prompt", "a cat"]);
  });

  test("emits a scalar number/int flag as a string", () => {
    const args = buildArgs(cmd("t2i"), { seed: 42, width: 1024 });
    expect(args).toEqual(["--seed", "42", "--width", "1024"]);
  });

  test("emits a boolean flag only when true, and omits it when false", () => {
    // scene, not t2i — t2i's Swift command doesn't declare --strict-gate.
    expect(buildArgs(cmd("scene"), { strictGate: true })).toEqual(["--strict-gate"]);
    expect(buildArgs(cmd("scene"), { strictGate: false })).toEqual([]);
  });

  test("omits fields that are undefined/null/absent", () => {
    expect(buildArgs(cmd("t2i"), { prompt: undefined, seed: null as unknown as undefined })).toEqual([]);
    expect(buildArgs(cmd("t2i"), {})).toEqual([]);
  });

  test("expands a string[] field into repeated flags", () => {
    const args = buildArgs(cmd("scene"), { ref: ["a.png", "b.png"] });
    expect(args).toEqual(["--ref", "a.png", "--ref", "b.png"]);
  });

  test("expands a number[] field into repeated flags", () => {
    const args = buildArgs(cmd("scene"), { refStrength: [0.5, 1.0] });
    expect(args).toEqual(["--ref-strength", "0.5", "--ref-strength", "1"]);
  });

  test("throws when an array field receives a non-array value", () => {
    expect(() => buildArgs(cmd("scene"), { ref: "a.png" })).toThrow(/expects an array/);
  });

  test("a joinWith array field emits ONE flag with values joined by the separator (edit's --images)", () => {
    const args = buildArgs(cmd("edit"), { images: ["a.png", "b.png"] });
    expect(args).toEqual(["--images", "a.png,b.png"]);
  });

  test("a joinWith array field with a single element still emits one flag, no trailing separator", () => {
    const args = buildArgs(cmd("edit"), { images: ["only.png"] });
    expect(args).toEqual(["--images", "only.png"]);
  });

  test("collects positional args and appends them after all flags (gate)", () => {
    const args = buildArgs(cmd("gate"), { images: ["a.png", "b.png"], json: true });
    expect(args).toEqual(["--json", "a.png", "b.png"]);
  });

  test("ignores keys not declared on the spec", () => {
    const args = buildArgs(cmd("t2i"), { notARealField: "x", prompt: "ok" });
    expect(args).toEqual(["--prompt", "ok"]);
  });
});

describe("pathFieldKeys", () => {
  test("t2i has no path fields besides output/outputDir", () => {
    expect(pathFieldKeys(cmd("t2i")).sort()).toEqual(["output", "outputDir"]);
  });

  test("scene includes array-of-path fields (ref) alongside scalar path fields", () => {
    const keys = pathFieldKeys(cmd("scene"));
    expect(keys).toContain("ref");
    expect(keys).toContain("bg");
    expect(keys).toContain("output");
  });

  test("gate's positional `images` field is a path array", () => {
    expect(pathFieldKeys(cmd("gate"))).toEqual(["images"]);
  });

  test("edit's images field is a path array (not a single path) — matches --images taking one path per ref", () => {
    expect(pathFieldKeys(cmd("edit"))).toContain("images");
    expect(cmd("edit").fields.images!.isPathArray).toBe(true);
    expect(cmd("edit").fields.images!.isPath).toBeUndefined();
  });
});

describe("modeledFlags", () => {
  test("excludes positional fields and includes every flagged field", () => {
    const flags = modeledFlags(cmd("gate"));
    expect(flags).not.toContain("");
    expect(flags).toContain("--json");
    expect(flags).toContain("--strict");
  });
});

describe("COMMANDS registry", () => {
  test("has exactly the 26 documented flux2 subcommands", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [
        "angle", "cutout", "edit", "expand", "face-detail", "faceswap", "gate", "inpaint", "kontext", "kv-style-transfer", "models", "postprocess", "scene", "segment",
        "story", "style", "styletransfer", "swap", "t2i", "upscale",
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

describe("per-command field sets match the real CLI (verified against `flux2 <cmd> --help`)", () => {
  // t2i/edit/style/angle's Swift commands never declare --strict-gate (only
  // scene/upscale do) — GEN_FIELDS.strictGate must not be present on these.
  for (const name of ["t2i", "edit", "style", "angle"] as const) {
    test(`${name} has no strictGate field`, () => {
      expect(cmd(name).fields.strictGate).toBeUndefined();
    });
  }

  test("scene DOES have strictGate (it's one of the two commands that support --strict-gate)", () => {
    expect(cmd("scene").fields.strictGate).toBeDefined();
  });

  test("swap has no cfgScale/vae/encoder/tokenizerDir/strictGate (SwapCommand.swift doesn't declare them)", () => {
    for (const key of ["cfgScale", "vae", "encoder", "tokenizerDir", "strictGate"] as const) {
      expect(cmd("swap").fields[key]).toBeUndefined();
    }
    // but DOES keep the fields it actually supports
    for (const key of ["transformer", "seed", "width", "height", "steps", "output", "outputDir", "name", "noArtifacts"] as const) {
      expect(cmd("swap").fields[key]).toBeDefined();
    }
  });

  test("face-detail command is registered with its own flags", () => {
    const spec = cmd("face-detail");
    expect(spec.name).toBe("face-detail");
    expect(spec.writesImage).toBe(true);
    expect(Object.keys(spec.fields)).toContain("input");
    expect(Object.keys(spec.fields)).toContain("padding");
    expect(Object.keys(spec.fields)).toContain("minConfidence");
    expect(spec.fields.minConfidence?.flag).toBe("--min-confidence");
  });

  test("postprocess command spec has the expected shape", () => {
    const spec = cmd("postprocess");
    expect(spec).toBeDefined();
    expect(spec.name).toBe("postprocess");
    expect(spec.writesImage).toBe(true);
    expect(Object.keys(spec.fields)).toEqual(
      expect.arrayContaining(["input", "filmGrain", "sharpening", "skinContrast", "noiseClean", "seed", "output"]));
  });

  test("postprocess has no model-loading fields (pure pixel filters, no MLX load)", () => {
    for (const key of ["transformer", "vae", "encoder", "tokenizerDir"] as const) {
      expect(cmd("postprocess").fields[key]).toBeUndefined();
    }
  });

  test("upscale has no transformer/seed/vae/encoder/tokenizerDir (pure ESRGAN pass, no MLX path)", () => {
    for (const key of ["transformer", "seed", "vae", "encoder", "tokenizerDir"] as const) {
      expect(cmd("upscale").fields[key]).toBeUndefined();
    }
    // but DOES keep strictGate (upscale supports --strict-gate) and the bare output fields
    for (const key of ["strictGate", "output", "outputDir", "name", "noArtifacts"] as const) {
      expect(cmd("upscale").fields[key]).toBeDefined();
    }
  });

  test("buildArgs on swap/upscale's dropped fields never emits the now-invalid flags", () => {
    expect(buildArgs(cmd("swap"), { source: "a.png", reference: "b.png", vae: "x" } as any)).not.toContain("--vae");
    expect(buildArgs(cmd("upscale"), { input: "a.png", seed: 42 } as any)).not.toContain("--seed");
  });
});

describe("isPathComponent fields (model-selector names Swift joins onto a root itself)", () => {
  test("transformer/vae/encoder/tokenizerDir are marked isPathComponent on GEN_FIELDS-derived commands", () => {
    for (const key of ["transformer", "vae", "encoder", "tokenizerDir"] as const) {
      expect(cmd("t2i").fields[key]?.isPathComponent).toBe(true);
    }
  });

  test("scene/style's lora and upscale's model are marked isPathComponent", () => {
    expect(cmd("scene").fields.lora?.isPathComponent).toBe(true);
    expect(cmd("style").fields.lora?.isPathComponent).toBe(true);
    expect(cmd("upscale").fields.model?.isPathComponent).toBe(true);
  });

  test("verify-* diagnostic commands' equivalent fields are marked isPathComponent too", () => {
    expect(cmd("verify-vae").fields.vae?.isPathComponent).toBe(true);
    expect(cmd("verify-encoder").fields.encoder?.isPathComponent).toBe(true);
    expect(cmd("verify-tokenizer").fields.tokenizerDir?.isPathComponent).toBe(true);
    expect(cmd("verify-transformer").fields.transformer?.isPathComponent).toBe(true);
    expect(cmd("verify-e2e").fields.transformer?.isPathComponent).toBe(true);
    expect(cmd("verify-e2e").fields.encoder?.isPathComponent).toBe(true);
    expect(cmd("verify-e2e").fields.tokenizerDir?.isPathComponent).toBe(true);
    expect(cmd("verify-edit").fields.vae?.isPathComponent).toBe(true);
  });

  test("isPathComponent fields are never also marked isPath/isPathArray (mutually exclusive validation modes)", () => {
    for (const spec of COMMAND_LIST) {
      for (const [key, f] of Object.entries(spec.fields)) {
        if (f.isPathComponent) {
          expect(f.isPath, `${spec.name}.${key}`).toBeFalsy();
          expect(f.isPathArray, `${spec.name}.${key}`).toBeFalsy();
        }
      }
    }
  });
});
