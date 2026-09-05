import { describe, expect, test } from "bun:test";

import { validateGenerate } from "../api/routes";

const ok = {
  prompt: "a cat",
  width: 1024,
  height: 1024,
  steps: 8,
  cfgScale: 1,
  seed: "42",
  lora: [{ name: "details-9b", scale: 0.8 }],
};

describe("validateGenerate", () => {
  test("accepts a valid expert payload", () => {
    const [params, err] = validateGenerate(ok);
    expect(err).toBeNull();
    expect(params?.prompt).toBe("a cat");
    expect(params?.lora).toEqual([{ name: "details-9b", scale: 0.8 }]);
  });

  test("requires a prompt", () => {
    expect(validateGenerate({ ...ok, prompt: "  " })[1]).toMatch(/prompt/);
  });

  test("size bounds + 16-px latent grid", () => {
    expect(validateGenerate({ ...ok, width: 100 })[1]).toMatch(/256..2048/);
    expect(validateGenerate({ ...ok, width: 1000 })[1]).toMatch(/multiples of 16/);
    expect(validateGenerate({ ...ok, height: 999 })[1]).toMatch(/multiples of 16/);
  });

  test("steps + cfg bounds", () => {
    expect(validateGenerate({ ...ok, steps: 0 })[1]).toMatch(/steps/);
    expect(validateGenerate({ ...ok, steps: 99 })[1]).toMatch(/steps/);
    expect(validateGenerate({ ...ok, cfgScale: 0.5 })[1]).toMatch(/cfgScale/);
  });

  test("seed must be digits (UInt64 string)", () => {
    expect(validateGenerate({ ...ok, seed: "-1" })[1]).toMatch(/seed/);
    expect(validateGenerate({ ...ok, seed: "12ab" })[1]).toMatch(/seed/);
    expect(validateGenerate({ ...ok, seed: undefined })[1]).toBeNull();
  });

  test("lora names are bare components (the CLI joins them onto models/lora/)", () => {
    expect(validateGenerate({ ...ok, lora: [{ name: "../evil", scale: 1 }] })[1]).toMatch(/bare name/);
    expect(validateGenerate({ ...ok, lora: [{ name: "a/b", scale: 1 }] })[1]).toMatch(/bare name/);
  });

  test("lora scale bounds", () => {
    expect(validateGenerate({ ...ok, lora: [{ name: "details-9b", scale: 5 }] })[1]).toMatch(/scale/);
    expect(validateGenerate({ ...ok, lora: [{ name: "details-9b", scale: 0 }] })[1]).toMatch(/scale/);
  });
});
