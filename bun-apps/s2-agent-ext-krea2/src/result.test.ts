import { describe, expect, test } from "bun:test";
import { buildImageDetails, parseSavedPath, summarize, type Krea2Details } from "./result.ts";
import type { InvokeResult } from "./invoke.ts";

function fakeRes(overrides: Partial<InvokeResult> = {}): InvokeResult {
  return {
    exitCode: 0,
    output: "",
    stdout: "",
    stderr: "",
    aborted: false,
    ...overrides,
  };
}

const T2I_STDOUT = [
  "[krea2] t2i (native) 1024x1024 steps=8 mu=1.15 seed=42",
  "[krea2] native 1024x1024 (latent 128x128) steps=8 mu=1.15 seed=42",
  "[1/4] text encoder (native)... ctx [1, 512, 12, 2560]",
  "[3/4] denoise... 2/8 4/8 6/8 8/8",
  "[4/4] VAE decode (native)...",
  "saved /abs/out/krea2_t2i_s42.png",
  "[krea2] saved /abs/out/krea2_t2i_s42.png",
].join("\n");

describe("parseSavedPath", () => {
  test("extracts the [krea2] saved <path> line", () => {
    expect(parseSavedPath(T2I_STDOUT)).toBe("/abs/out/krea2_t2i_s42.png");
  });

  test("returns the LAST match when multiple saved lines exist", () => {
    const stdout = "[krea2] saved /a/first.png\n[krea2] saved /b/second.png\n";
    expect(parseSavedPath(stdout)).toBe("/b/second.png");
  });

  test("returns null when no saved line is present", () => {
    expect(parseSavedPath("just some progress\nlines")).toBeNull();
  });

  test("returns null on empty input", () => {
    expect(parseSavedPath("")).toBeNull();
  });
});

describe("buildImageDetails", () => {
  test("ok run: parses output + lifts seed/width/height from opts", () => {
    const d = buildImageDetails("t2i", fakeRes({ stdout: T2I_STDOUT }), {
      seed: 42,
      width: 1024,
      height: 1024,
    });
    expect(d.ok).toBe(true);
    expect(d.output).toBe("/abs/out/krea2_t2i_s42.png");
    expect(d.seed).toBe(42);
    expect(d.width).toBe(1024);
    expect(d.height).toBe(1024);
    expect(d.outputs[0]?.path).toBe("/abs/out/krea2_t2i_s42.png");
  });

  test("ok run without parseable saved line → output null, empty outputs", () => {
    const d = buildImageDetails("t2i", fakeRes({ stdout: "no saved line" }), { seed: 7 });
    expect(d.ok).toBe(true);
    expect(d.output).toBeNull();
    expect(d.outputs).toEqual([]);
    // informational seed still lifted from opts
    expect(d.seed).toBe(7);
  });

  test("non-zero exit → ok false, no output parsing", () => {
    const d = buildImageDetails("i2i", fakeRes({ exitCode: 1, stdout: "[krea2] saved /x.png" }), {});
    expect(d.ok).toBe(false);
    expect(d.output).toBeNull();
    expect(d.exitCode).toBe(1);
  });

  test("aborted → ok false, output null", () => {
    const d = buildImageDetails("t2i", fakeRes({ aborted: true, exitCode: 143 }), {});
    expect(d.ok).toBe(false);
    expect(d.aborted).toBe(true);
    expect(d.output).toBeNull();
  });

  test("unset opts → null seed/width/height", () => {
    const d = buildImageDetails("t2i", fakeRes({ stdout: T2I_STDOUT }), {});
    expect(d.seed).toBeNull();
    expect(d.width).toBeNull();
    expect(d.height).toBeNull();
  });
});

describe("summarize", () => {
  test("ok → one-line with command + output + dims + seed", () => {
    const d: Krea2Details = {
      ok: true,
      command: "t2i",
      exitCode: 0,
      aborted: false,
      output: "/abs/out/x.png",
      outputs: [],
      seed: 42,
      width: 1024,
      height: 1024,
    };
    expect(summarize(d)).toBe("t2i ok → /abs/out/x.png  1024×1024 seed 42");
  });

  test("aborted → mentions aborted", () => {
    const d: Krea2Details = {
      ok: false,
      command: "i2i",
      exitCode: 143,
      aborted: true,
      output: null,
      outputs: [],
      seed: null,
      width: null,
      height: null,
    };
    expect(summarize(d)).toBe("i2i aborted (exit 143).");
  });

  test("failed → FAILED with stdout tail", () => {
    const d: Krea2Details = {
      ok: false,
      command: "t2i",
      exitCode: 2,
      aborted: false,
      output: null,
      outputs: [],
      seed: null,
      width: null,
      height: null,
      stdout: "line A\nline B\nboom",
    };
    expect(summarize(d)).toContain("t2i FAILED (exit 2)");
    expect(summarize(d)).toContain("boom");
  });
});
