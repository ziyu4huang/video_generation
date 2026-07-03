import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PathSafetyError, runLtx } from "./index.ts";

// These tests exercise the validation layers that run BEFORE ltx-video is
// ever spawned (unknown command / path-safety / extraArgs allow-list), so
// they stay fast and don't require a built binary or model weights.

describe("runLtx — pre-spawn validation", () => {
  test("throws a plain Error for an unknown command", async () => {
    await expect(runLtx({ command: "not-a-real-command" as any, options: {} })).rejects.toThrow(
      /Unknown ltx-video command/,
    );
  });

  test("throws PathSafetyError for an input path outside every allowed root", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "pi-ltx-outside-"));
    const sneaky = join(outsideDir, "sneaky.mp4");
    writeFileSync(sneaky, "x");

    await expect(runLtx({ command: "upscale", options: { input: sneaky } })).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a flag-like value smuggled into a free-form field", async () => {
    await expect(
      runLtx({ command: "t2i", options: { prompt: "--models-root=/etc" } }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a required path field that does not exist", async () => {
    await expect(
      runLtx({ command: "upscale", options: { input: "/definitely/does/not/exist.mp4" } }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a flag-like value inside a string[] positional field (gate's videos)", async () => {
    await expect(
      runLtx({ command: "gate", options: { videos: ["--strict"] } }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a '..'-traversal value in a model-selector field (transformer)", async () => {
    await expect(
      runLtx({ command: "t2i", options: { prompt: "x", transformer: "../../../../etc" } }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for the path portion of a path[:strength] spec that doesn't exist (native-i2v's loras)", async () => {
    await expect(
      runLtx({ command: "native-i2v", options: { prompt: "x", loras: ["/definitely/does/not/exist.safetensors:0.8"] } }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a '..'-traversal value hidden in a path[:strength] spec's path portion", async () => {
    await expect(
      runLtx({ command: "native-i2v", options: { prompt: "x", loras: ["--models-root:0.8"] } }),
    ).rejects.toThrow(PathSafetyError);
  });
});
