import { describe, expect, it } from "bun:test";
import {
  TRANSFORMER_DENOISE,
  parsePurifyResolution,
  purifyResolutionLabel,
  computePurifyDimensions,
  purifyOutputPathFor,
  probePngDimensions,
  runPurifyTransformerNative,
  type StyleTransferFn,
} from "./purify_native.ts";
import type { Flux2Details } from "@repo/s2-agent-ext-flux2";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("TRANSFORMER_DENOISE — mirrors image-purify.py's TRANSFORMER_DENOISE exactly", () => {
  it("has the exact 4 modes with the exact Python values", () => {
    expect(TRANSFORMER_DENOISE).toEqual({
      purify: 0.35,
      enhance: 0.55,
      deartifact: 0.7,
      redraw: 0.85,
    });
  });
});

describe("parsePurifyResolution — mirrors _parse_resolution's value half", () => {
  it('"same" (and the undefined default) parses to scale 1.0', () => {
    expect(parsePurifyResolution("same")).toBe(1.0);
    expect(parsePurifyResolution("SAME")).toBe(1.0);
    expect(parsePurifyResolution(undefined)).toBe(1.0);
  });

  it('"Nx" parses to a bare scale number', () => {
    expect(parsePurifyResolution("2x")).toBe(2);
    expect(parsePurifyResolution("2.5x")).toBe(2.5);
    expect(parsePurifyResolution("0.5x")).toBe(0.5);
  });

  it("a bare pixel string or number parses to a {pixels} target", () => {
    expect(parsePurifyResolution("2160")).toEqual({ pixels: 2160 });
    expect(parsePurifyResolution(2160)).toEqual({ pixels: 2160 });
  });

  it("throws on garbage input", () => {
    expect(() => parsePurifyResolution("not-a-resolution")).toThrow(/invalid resolution/);
  });
});

describe("purifyResolutionLabel — mirrors _parse_resolution's label half (filename component)", () => {
  it('"same" and undefined label as "same"', () => {
    expect(purifyResolutionLabel("same")).toBe("same");
    expect(purifyResolutionLabel(undefined)).toBe("same");
  });

  it('"Nx" labels with Python\'s str(float) formatting (whole numbers keep ".0")', () => {
    expect(purifyResolutionLabel("2x")).toBe("2.0x");
    expect(purifyResolutionLabel("2.5x")).toBe("2.5x");
  });

  it("a bare pixel value labels as its plain integer string", () => {
    expect(purifyResolutionLabel("2160")).toBe("2160");
    expect(purifyResolutionLabel(2160)).toBe("2160");
  });
});

describe("computePurifyDimensions — mirrors _run_transformer_backend's dimension math", () => {
  it("scale 1.0 (same) uses the input dims, rounded down to 16 (even 'same' rounds)", () => {
    // 1000x1500 -> floor(1000/16)*16=992, floor(1500/16)*16=1488
    expect(computePurifyDimensions(1000, 1500, 1.0)).toEqual({ width: 992, height: 1488 });
  });

  it("a non-1.0 scale multiplies both dims then rounds down to 16", () => {
    // 1000x1500 * 2 = 2000x3000 -> width 2000 is 16-divisible exactly;
    // height 3000 is NOT (3000/16=187.5) -> floor(3000/16)*16=2992
    expect(computePurifyDimensions(1000, 1500, 2)).toEqual({ width: 2000, height: 2992 });
    // 1000x1500 * 0.5 = 500x750 -> floor(500/16)*16=496, floor(750/16)*16=736
    expect(computePurifyDimensions(1000, 1500, 0.5)).toEqual({ width: 496, height: 736 });
  });

  it("a pixel target scales by shortest-side, then rounds down to 16", () => {
    // 1000x1500, target 2000 shortest-side: scale=2000/1000=2 -> 2000x3000
    // (height 3000 rounds down to 2992, same as the direct-scale case above)
    expect(computePurifyDimensions(1000, 1500, { pixels: 2000 })).toEqual({ width: 2000, height: 2992 });
  });

  it("never returns below 16 for a tiny input", () => {
    expect(computePurifyDimensions(4, 4, 1.0)).toEqual({ width: 16, height: 16 });
  });
});

describe("purifyOutputPathFor — mirrors _make_purify_paths' naming (next to input, not OUTPUT_DIR/output_XXXX)", () => {
  it("builds <base>_purify_<mode>_<res_label><ext> next to the input", () => {
    expect(purifyOutputPathFor("/out/photo.png", "enhance", "same")).toBe("/out/photo_purify_enhance_same.png");
    expect(purifyOutputPathFor("/out/photo.png", "redraw", "2x")).toBe("/out/photo_purify_redraw_2.0x.png");
    expect(purifyOutputPathFor("/out/photo.png", "purify", "2160")).toBe("/out/photo_purify_purify_2160.png");
  });

  it("preserves the input's extension (not forced to .png)", () => {
    expect(purifyOutputPathFor("/out/photo.jpg", "enhance", "same")).toBe("/out/photo_purify_enhance_same.jpg");
  });

  it("defaults extension to .png when the input has none", () => {
    expect(purifyOutputPathFor("/out/photo", "enhance", "same")).toBe("/out/photo_purify_enhance_same.png");
  });
});

describe("probePngDimensions — dependency-free PNG IHDR reader", () => {
  /** Builds a minimal (invalid-past-IHDR, but that's fine — we only read bytes 0-23) PNG buffer with a given width/height baked into the IHDR chunk. */
  function fakePngBuffer(width: number, height: number): Buffer {
    const buf = Buffer.alloc(24);
    // PNG signature
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    // bytes 8-11: IHDR chunk length (13, unused by the probe but realistic)
    buf.writeUInt32BE(13, 8);
    // bytes 12-15: "IHDR" (unused by the probe but realistic)
    buf.write("IHDR", 12, "ascii");
    // bytes 16-19 / 20-23: width / height
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
  }

  it("reads width/height from a real PNG-shaped file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purify-native-test-"));
    const path = join(dir, "fake.png");
    try {
      writeFileSync(path, fakePngBuffer(832, 1216));
      await expect(probePngDimensions(path)).resolves.toEqual({ width: 832, height: 1216 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a non-PNG file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purify-native-test-"));
    const path = join(dir, "fake.jpg");
    try {
      // JPEG magic bytes (0xFFD8FF), not the PNG signature.
      writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
      await expect(probePngDimensions(path)).rejects.toThrow(/not a PNG/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakePngBufferForOrchestrationTest(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function fakeStyleTransferDetails(overrides: Partial<Flux2Details> = {}): Flux2Details {
  return {
    ok: true, command: "styletransfer", exitCode: 0, aborted: false,
    output: "/out/photo_purify_enhance_same.png",
    outputs: [{ path: "/out/photo_purify_enhance_same.png", seed: 42, width: 992, height: 1488, sizeBytes: 12345 }],
    seed: 42, width: 992, height: 1488, gate: null,
    perf: { steps: 4, totalSeconds: 1.2, avgItPerSec: null, peakMemoryMB: null },
    manifestPath: null, runJsonPath: null,
    ...overrides,
  };
}

describe("runPurifyTransformerNative — computes params and delegates to styletransfer", () => {
  it("computes denoise/dims/output and forwards them to styletransfer, defaulting the prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purify-native-test-"));
    const inputPath = join(dir, "photo.png");
    try {
      writeFileSync(inputPath, fakePngBufferForOrchestrationTest(1000, 1500));

      const seen: { options: Record<string, unknown> | null; outputDir: string | undefined } = {
        options: null,
        outputDir: undefined,
      };
      const runStyleTransfer: StyleTransferFn = async (options, outputDir) => {
        seen.options = options;
        seen.outputDir = outputDir;
        return { details: fakeStyleTransferDetails(), summary: "restyled photo_purify_enhance_same.png", stderrTail: "" };
      };

      const out = await runPurifyTransformerNative(
        { inputImage: inputPath },
        runStyleTransfer,
      );

      expect(seen.options).toEqual({
        input: inputPath,
        prompt: "highly detailed, sharp focus, high quality, professional",
        strength: 0.55, // enhance (default mode)
        width: 992,     // 1000 -> floor(1000/16)*16
        height: 1488,   // 1500 -> floor(1500/16)*16
        seed: undefined,
        transformer: undefined,
        output: `${inputPath.slice(0, -4)}_purify_enhance_same.png`,
      });
      // outputDir is always the OUTPUT's own directory (dir), never a
      // caller-supplied value — this is what makes runFlux2's --output-dir
      // agree with --output's real location, so the manifest sidecar lookup
      // (s2-agent-ext-flux2's outputDirFromArgs) finds the right file and
      // width/height/seed parse correctly. See purify_native.ts's comment
      // at the runStyleTransfer call site for the real bug this prevents.
      expect(seen.outputDir).toBe(dir);
      expect(out.details.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the given mode/resolution/seed/prompt/transformer instead of defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purify-native-test-"));
    const inputPath = join(dir, "photo.png");
    try {
      writeFileSync(inputPath, fakePngBufferForOrchestrationTest(1000, 1000));

      const seen: { options: Record<string, unknown> | null } = { options: null };
      const runStyleTransfer: StyleTransferFn = async (options) => {
        seen.options = options;
        return { details: fakeStyleTransferDetails(), summary: "ok", stderrTail: "" };
      };

      await runPurifyTransformerNative(
        {
          inputImage: inputPath,
          mode: "redraw",
          resolution: "2x",
          seed: 7,
          prompt: "custom prompt",
          transformer: "kleinova-nsfw-v3",
        },
        runStyleTransfer,
      );

      expect(seen.options).toMatchObject({
        prompt: "custom prompt",
        strength: 0.85, // redraw
        width: 2000,
        height: 2000,
        seed: 7,
        transformer: "kleinova-nsfw-v3",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
