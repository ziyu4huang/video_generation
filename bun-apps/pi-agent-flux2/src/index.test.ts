import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PathSafetyError, runFlux2 } from "./index.ts";

// These tests exercise the validation layers that run BEFORE flux2 is ever
// spawned (unknown command / path-safety / extraArgs allow-list), so they
// stay fast and don't require a built binary or model weights.

describe("runFlux2 — pre-spawn validation", () => {
  test("throws a plain Error for an unknown command", async () => {
    await expect(
      runFlux2({ command: "not-a-real-command" as any, options: {} }),
    ).rejects.toThrow(/Unknown flux2 command/);
  });

  test("throws PathSafetyError for an input path outside every allowed root", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "pi-flux2-outside-"));
    const sneaky = join(outsideDir, "sneaky.png");
    writeFileSync(sneaky, "x");

    await expect(
      runFlux2({ command: "upscale", options: { input: sneaky } }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a flag-like value smuggled into a free-form field", async () => {
    await expect(
      runFlux2({ command: "t2i", options: { prompt: "--models-root=/etc" } }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a required path field that does not exist", async () => {
    await expect(
      runFlux2({ command: "upscale", options: { input: "/definitely/does/not/exist.png" } }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a flag-like value inside a string[] field (e.g. lora)", async () => {
    // Regression: the flag-injection guard used to only check `typeof v === "string"`,
    // silently skipping array-typed fields like `lora` entirely.
    await expect(
      runFlux2({ command: "scene", options: { prompt: "a scene", lora: ["legit-lora", "--models-root"] } }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a '..'-traversal value in a model-selector field (transformer/vae/encoder/lora/model)", async () => {
    // Regression: transformer/vae/encoder/tokenizerDir/lora/model reached the
    // flux2 CLI with only a leading-dash check — the Swift binary joins them
    // onto a models-tree root with NO ".."-sanitization of its own.
    await expect(
      runFlux2({ command: "t2i", options: { prompt: "x", transformer: "../../../../etc" } }),
    ).rejects.toThrow(PathSafetyError);
    // scene has no required-to-exist path fields when `ref` is omitted, so
    // this isolates the array-typed isPathComponent field (`lora`) cleanly.
    await expect(
      runFlux2({ command: "scene", options: { prompt: "x", lora: ["../../etc"] } }),
    ).rejects.toThrow(PathSafetyError);
  });
});
