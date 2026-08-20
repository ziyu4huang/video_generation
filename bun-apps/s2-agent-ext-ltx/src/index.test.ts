import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRepoRoot, defaultBinaryPath } from "./binary.ts";
import { PathSafetyError, runLtx, withShotLanguage } from "./index.ts";

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

  test("throws PathSafetyError for the embedded path in a native-relay variant spec that doesn't exist", async () => {
    await expect(
      runLtx({
        command: "native-relay",
        options: { prompts: ["x"], variant: ["evil=/definitely/does/not/exist.safetensors:1.0"] },
      }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError for a flag-like value smuggled into a native-relay variant's embedded path", async () => {
    await expect(
      runLtx({ command: "native-relay", options: { prompts: ["x"], variant: ["evil=--models-root:1.0"] } }),
    ).rejects.toThrow(PathSafetyError);
  });

  // Machine-coupled: runLtx() spawns the ltx-video binary (or run.py fallback).
  // On GitHub Actions neither is built, so the spawn hangs despite the abort
  // signal → 5s timeout. Skip under CI=true (no Metal/swift build). See
  // .github/CI.md. Also skips locally when the ltx-video binary is unbuilt
  // (e.g. right after `git clean -dxf` removed .build/) — same hang risk.
  const LTX_BIN_PRESENT = existsSync(defaultBinaryPath(resolveRepoRoot()));
  test.skipIf(Boolean(process.env.CI) || !LTX_BIN_PRESENT)("does NOT throw PathSafetyError for a bare variant name with no embedded path (e.g. 'baseline')", async () => {
    // Pre-abort so this never actually runs a real (multi-minute)
    // generation — invokeLtx kills the process immediately post-spawn and
    // resolves with aborted:true rather than rejecting. The only thing this
    // exercises is that pre-spawn path-safety validation doesn't reject the
    // bare name itself (it would have thrown PathSafetyError synchronously,
    // before any process is even spawned, if it did).
    const controller = new AbortController();
    controller.abort();
    const result = await runLtx({
      command: "native-relay",
      options: { prompts: ["x"], variant: ["baseline"] },
      signal: controller.signal,
    });
    expect(result.details.aborted).toBe(true);
  });

  test("throws PathSafetyError when outputDir override escapes to an unrelated filesystem location", () => {
    // Regression for s2-agent-ext-ltx-self-improve's path-safety finding
    // (2026-07-05): outputDir used to be admitted into AllowedRoots verbatim,
    // making the "every path must resolve under an allowed root" guarantee
    // circular for this override.
    const outsideDir = mkdtempSync(join(tmpdir(), "pi-ltx-unrelated-root-"));
    expect(
      runLtx({ command: "t2i", options: { prompt: "x" }, outputDir: outsideDir }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("throws PathSafetyError when modelsRoot override escapes to an unrelated filesystem location", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "pi-ltx-unrelated-root-"));
    expect(
      runLtx({ command: "t2i", options: { prompt: "x" }, modelsRoot: outsideDir }),
    ).rejects.toThrow(PathSafetyError);
  });

  test("surfaces an ensureOutputDir mkdir failure as details.ok=false instead of an uncaught exception", async () => {
    // Regression for s2-agent-ext-ltx-self-improve's error-handling finding
    // (2026-07-05): ensureOutputDir()'s mkdirSync used to have no try/catch in
    // runOnce, so an ENOTDIR (a parent path segment already being a regular
    // file) propagated as a raw uncaught exception instead of the documented
    // details.ok=false contract.
    // Must live under repoRoot's own parent (the allowed sandbox for an
    // outputDir override, per the path-safety fix above) so this test
    // exercises the ENOTDIR failure itself, not the (already-tested)
    // override-location rejection.
    const repoRoot = resolveRepoRoot();
    const base = mkdtempSync(join(dirname(repoRoot), "pi-ltx-outputdir-enotdir-"));
    try {
      const blockerFile = join(base, "blocker");
      writeFileSync(blockerFile, "x"); // a regular file, not a directory
      const outputDir = join(blockerFile, "nested-out"); // mkdir under a FILE -> ENOTDIR
      const result = await runLtx({ command: "t2i", options: { prompt: "x" }, outputDir });
      expect(result.details.ok).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("withShotLanguage", () => {
  test("returns options unchanged when shotLanguage is undefined", () => {
    const options = { prompt: "a cat playing piano" };
    expect(withShotLanguage(options, undefined)).toBe(options);
  });

  test("merges the rendered clause into a string `prompt` field", () => {
    const merged = withShotLanguage({ prompt: "a cat playing piano" }, { shotSize: "close_up" });
    expect(merged.prompt).toBe("a cat playing piano, close-up.");
  });

  test("merges the rendered clause into every element of a `prompts` array field", () => {
    const merged = withShotLanguage(
      { prompts: ["cat walks in", "cat jumps out"] },
      { cameraMovement: "dolly_in" },
    );
    expect(merged.prompts).toEqual(["cat walks in, dollying in.", "cat jumps out, dollying in."]);
  });

  test("leaves non-string prompt/prompts fields untouched", () => {
    const merged = withShotLanguage({ prompt: 123, prompts: [1, 2] }, { shotSize: "close_up" });
    expect(merged.prompt).toBe(123);
    expect(merged.prompts).toEqual([1, 2]);
  });

  test("does not mutate the input options object", () => {
    const options = { prompt: "a cat playing piano" };
    withShotLanguage(options, { shotSize: "close_up" });
    expect(options.prompt).toBe("a cat playing piano");
  });
});

describe("runLtx — shotLanguage does not bypass path-safety validation", () => {
  test("an unrelated bad path still trips PathSafetyError when shotLanguage is also set", async () => {
    // Sanity check that adding shotLanguage doesn't short-circuit or reorder
    // the existing validation pipeline — reuses the same outside-root
    // pattern as the plain (no-shotLanguage) test above.
    const outsideDir = mkdtempSync(join(tmpdir(), "pi-ltx-shotlang-outside-"));
    const sneaky = join(outsideDir, "sneaky.mp4");
    writeFileSync(sneaky, "x");

    await expect(
      runLtx({
        command: "upscale",
        options: { input: sneaky },
        shotLanguage: { shotSize: "close_up" },
      }),
    ).rejects.toThrow(PathSafetyError);
  });
});
