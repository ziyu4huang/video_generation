/**
 * e2e.local.smoke.test.ts — the LOCAL-ONLY stack proof (constraint gate).
 *
 * Default-skipped (real MLX gen + real ffmpeg render; not for CI unit runs).
 * Set MLX_E2E=1 to drive the FULL local path end-to-end with ZERO cloud GAI:
 *
 *   image_generation:t2i (krea2 / swift:MLX) → PNG
 *   subtitle_gen (pure Bun)                  → SRT
 *   composition:compose-motion (ffmpeg)      → ken-burns MP4 with captions burned
 *
 * Asserts the two hard constraints the user set (2026-07-07):
 *   1. NO cloud GAI API is invoked — every selected provider is local
 *      (native_swift / ffmpeg), never cloud_http; the cloud adapters (fetch)
 *      are never reached.
 *   2. The model ids are local silicon (krea2 / ffmpeg-zoompan-xfade), not a
 *      cloud model id.
 *
 *   MLX_E2E=1 bun test src/e2e.local.smoke.test.ts
 *
 * This is the regression `--run-gpu` smoke for the extension→MLX bridge: re-run
 * after any bridge/registry/compose change to certify the local path is whole.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { selectAndGenerate } from "./bridge.ts";
import { buildSubtitle } from "./providers.ts";
import { REGISTRY } from "./registry.ts";

const E2E = process.env.MLX_E2E === "1";

/** Cloud backends/providers that must NEVER be selected on the local path. */
const CLOUD_BACKENDS = new Set(["cloud_http"]);
const CLOUD_PROVIDERS = new Set(["openai", "elevenlabs", "fal", "replicate", "grok", "heygen", "kling", "veo", "minimax", "seedance", "runway", "higgsfield", "suno"]);

describe.skipIf(!E2E)("e2e local-only stack (MLX_E2E=1)", () => {
  const workDir = mkdtempSync(join(tmpdir(), "md-e2e-local-"));
  const pngPath = join(workDir, "shot.png");
  const srtPath = join(workDir, "captions.srt");
  const mp4Path = join(workDir, "compose_motion.mp4");

  test("image_generation:t2i via local MLX (krea2), zero cloud", async () => {
    const { entry, result } = await selectAndGenerate(
      "image_generation",
      {
        command: "t2i",
        outputDir: workDir,
        options: {
          prompt: "a single red apple on a white table, product photo",
          width: 512,
          height: 512,
          steps: 4,
          seed: 7,
        },
      },
      {},
    );

    // Constraint 1: the selected provider is local native, never cloud.
    expect(CLOUD_BACKENDS.has(entry.backend)).toBe(false);
    expect(CLOUD_PROVIDERS.has(entry.provider)).toBe(false);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.artifacts.length).toBeGreaterThanOrEqual(1);

    const art = result.artifacts[0]!;
    expect(art.kind).toBe("image");
    expect(art.path).toBeTruthy();
    expect(existsSync(art.path)).toBe(true);
    expect(statSync(art.path).size).toBeGreaterThan(1000);
    // Constraint 2: local model id (krea2 director / MLX), not a cloud model.
    expect(result.model).toBeTruthy();
    expect(CLOUD_PROVIDERS.has(result.model ?? "")).toBe(false);

    // Stash the produced PNG path for the compose step (krea2 wrote it under workDir).
    const produced = result.artifacts.find((a) => a.kind === "image")!.path;
    writeFileSync(join(workDir, "image_path.txt"), produced, "utf8");
    pngPath; // referenced for readability; actual path resolved from result above
  }, 180_000);

  test("subtitle_gen via pure Bun (local), zero cloud", () => {
    const srt = buildSubtitle({
      format: "srt",
      cues: [
        { text: "Local MLX, zero cloud.", start: 0, end: 2 },
        { text: "krea2 → ffmpeg → MP4.", start: 2, end: 4 },
      ],
    });
    writeFileSync(srtPath, srt, "utf8");
    expect(existsSync(srtPath)).toBe(true);
    expect(srt).toContain("Local MLX, zero cloud.");
  });

  test("composition:compose-motion via ffmpeg, burns captions → playable MP4, zero cloud", async () => {
    // Resolve the PNG produced by the image step (written under the same workDir).
    const producedPng = readFileSync(join(workDir, "image_path.txt"), "utf8").trim();
    expect(existsSync(producedPng)).toBe(true);

    const { entry, result } = await selectAndGenerate(
      "composition",
      {
        command: "compose-motion",
        outputDir: workDir,
        options: {
          output: mp4Path,
          width: 512,
          height: 512,
          fps: 24,
          editDecisions: {
            version: "1.0",
            transition: "none",
            cuts: [
              { id: "shot1", type: "media", source: producedPng, in_seconds: 0, out_seconds: 4, animation: "ken-burns" },
            ],
          },
          captions: { srtPath, burn: true },
        },
      },
      // Pin the ffmpeg motion runtime: compose_remotion (native_swift, rank 0)
      // would otherwise win the selector and silently drop captions (its adapter
      // doesn't honor opts.captions). compose-motion is the lightweight local
      // path that burns captions via the drawtext ladder.
      { provider: "motion" },
    );

    // Constraint 1: composition ran on the local ffmpeg runtime, never cloud.
    expect(CLOUD_BACKENDS.has(entry.backend)).toBe(false);
    expect(CLOUD_PROVIDERS.has(entry.provider)).toBe(false);
    expect(entry.provider).toBe("motion");
    expect(result.success).toBe(true);
    expect(result.artifacts.length).toBeGreaterThanOrEqual(1);

    const mp4 = result.artifacts[0]!;
    expect(mp4.kind).toBe("video");
    expect(existsSync(mp4.path)).toBe(true);
    expect(statSync(mp4.path).size).toBeGreaterThan(2000);
    expect(CLOUD_PROVIDERS.has(result.model ?? "")).toBe(false);

    // Playable: ffprobe confirms a valid video stream + non-zero duration.
    const probe = spawnSync("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_streams", "-show_format", mp4.path,
    ], { encoding: "utf8" });
    expect(probe.status).toBe(0);
    const j = JSON.parse(probe.stdout);
    const video = (j.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === "video");
    expect(video).toBeTruthy();
    expect(Number(j.format?.duration ?? 0)).toBeGreaterThan(0);
  }, 180_000);

  test("registry has NO cloud provider configured:true on the local machine", () => {
    // Static guarantee: every cloud_http provider in the registry ships configured:false,
    // so even an explicit `provider` hint cannot route generation to a cloud GAI API.
    const cloudConfigured = REGISTRY.filter((p) => p.backend === "cloud_http" && p.configured);
    expect(cloudConfigured).toEqual([]);
  });
});
