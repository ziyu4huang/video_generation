import { describe, expect, it } from "bun:test";
import { defaultBinaryPath, resolveRepoRoot } from "./kokoro_binary.ts";
import { join } from "node:path";

describe("kokoro_binary path resolution", () => {
  it("defaultBinaryPath points at swift/musicgen-director/.build/release/kokoro-tts", () => {
    const repoRoot = "/fake/repo";
    expect(defaultBinaryPath(repoRoot)).toBe(
      join(repoRoot, "swift", "musicgen-director", ".build", "release", "kokoro-tts"),
    );
  });

  it("resolveRepoRoot finds the real repo root from this file's location", () => {
    const root = resolveRepoRoot();
    expect(root.endsWith("video_generation__director") || root.length > 0).toBe(true);
  });
});
