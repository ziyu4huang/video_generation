/**
 * purify_native.ts — native Bun port of `run.py image purify`'s
 * `--backend transformer` redraw path (`app/commands/image-purify.py`'s
 * `_run_transformer_backend`, `_parse_resolution`).
 *
 * `--backend transformer` is pure parameter computation (a mode→denoise
 * lookup table + a resolution-string parser) around a flux2-klein SDEdit
 * img2img call — a mechanism that already exists natively as
 * `swift/flux2-image-director`'s `styletransfer` command
 * (`Flux2EditPipeline.generate`'s `initImagePath`/`denoiseStrength`
 * params). Zero new Swift code.
 *
 * `--backend seedvr2` (the default) and `--remove` are OUT OF SCOPE — both
 * stay on `run.py image purify`, unchanged. See
 * .planning/specs/2026-08-05-purify-transformer-backend-swift-native-port-design.md.
 */
import { dirname, extname } from "node:path";
import { runFlux2, type Flux2Details } from "@repo/s2-agent-ext-flux2";

/** Mirrors image-purify.py's MODE_PRESETS keys (softness itself is seedvr2-only, unused here). */
export type PurifyMode = "purify" | "enhance" | "deartifact" | "redraw";

/** Mirrors TRANSFORMER_DENOISE exactly (image-purify.py:236). */
export const TRANSFORMER_DENOISE: Record<PurifyMode, number> = {
  purify: 0.35,
  enhance: 0.55,
  deartifact: 0.7,
  redraw: 0.85,
};

/** Mirrors _DEFAULT_TRANSFORMER_PROMPT exactly (image-purify.py:246). */
export const DEFAULT_TRANSFORMER_PROMPT =
  "highly detailed, sharp focus, high quality, professional";

/** A resolved resolution: either a scale factor (1.0 = same) or a shortest-side pixel target. */
export type PurifyResolution = number | { pixels: number };

/** Mirrors _parse_resolution's value half (image-purify.py:206-226). */
export function parsePurifyResolution(resStr: string | number | undefined): PurifyResolution {
  const s = String(resStr ?? "same").toLowerCase();
  if (s === "same") return 1.0;
  if (s.endsWith("x")) {
    const scale = Number.parseFloat(s.slice(0, -1));
    if (!Number.isFinite(scale)) throw new Error(`purify: invalid resolution "${resStr}"`);
    return scale;
  }
  const pixels = Number.parseInt(s, 10);
  if (!Number.isFinite(pixels)) throw new Error(`purify: invalid resolution "${resStr}"`);
  return { pixels };
}

/**
 * Mirrors _parse_resolution's label half — the filename component
 * (image-purify.py:206-226). Python's f"{scale}x" on a float always shows at
 * least one decimal digit (str(2.0) === "2.0"); JS's String(2) === "2" — the
 * whole-number branch below forces the ".0" to match Python's filenames
 * byte-for-byte.
 */
export function purifyResolutionLabel(resStr: string | number | undefined): string {
  const s = String(resStr ?? "same").toLowerCase();
  if (s === "same") return "same";
  if (s.endsWith("x")) {
    const scale = Number.parseFloat(s.slice(0, -1));
    return Number.isInteger(scale) ? `${scale}.0x` : `${scale}x`;
  }
  const pixels = Number.parseInt(s, 10);
  return String(pixels);
}

/**
 * Mirrors _run_transformer_backend's dimension math exactly
 * (image-purify.py:410-420), including the UNCONDITIONAL 16-divisible
 * rounding — applied even when resolution is 1.0 ("same").
 */
export function computePurifyDimensions(
  w0: number,
  h0: number,
  resolution: PurifyResolution,
): { width: number; height: number } {
  let outW: number;
  let outH: number;
  if (typeof resolution === "number") {
    if (resolution === 1.0) {
      outW = w0;
      outH = h0;
    } else {
      outW = Math.round(w0 * resolution);
      outH = Math.round(h0 * resolution);
    }
  } else {
    const scale = resolution.pixels / Math.min(w0, h0);
    outW = Math.round(w0 * scale);
    outH = Math.round(h0 * scale);
  }
  return {
    width: Math.max(16, Math.floor(outW / 16) * 16),
    height: Math.max(16, Math.floor(outH / 16) * 16),
  };
}

/**
 * Mirrors _make_purify_paths' naming (image-purify.py:342-360): next to the
 * input, NOT the OUTPUT_DIR/output_XXXX convention other flux2 commands use.
 */
export function purifyOutputPathFor(
  inputImage: string,
  mode: PurifyMode,
  resolution: string | number | undefined,
): string {
  const resLabel = purifyResolutionLabel(resolution);
  const realExt = extname(inputImage);
  const ext = realExt || ".png";
  const base = inputImage.slice(0, inputImage.length - realExt.length);
  return `${base}_purify_${mode}_${resLabel}${ext}`;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Dependency-free PNG dimension probe: reads only the 8-byte PNG signature +
 * the IHDR chunk's width/height (bytes 16-19 / 20-23, big-endian uint32) —
 * a 24-byte partial file read, no decode, no npm image-codec package.
 *
 * Throws on a non-PNG signature or a truncated file. Callers only reach this
 * after isNativePurifyRequest's own `.png` extension check already passed
 * (bridge.ts), so a throw here means a genuinely mislabeled/corrupt file —
 * surfaced as a real error, not a signal to reroute anywhere.
 */
export async function probePngDimensions(path: string): Promise<{ width: number; height: number }> {
  const buf = new Uint8Array(await Bun.file(path).slice(0, 24).arrayBuffer());
  if (buf.length < 24 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) {
    throw new Error(`probePngDimensions: ${path} is not a PNG (or is truncated)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

export interface PurifyTransformerOptions {
  inputImage: string;
  mode?: PurifyMode;
  resolution?: string | number;
  seed?: number;
  prompt?: string;
  transformer?: string;
  // No outputDir field: purifyOutputPathFor always places the output next to
  // the input, and runStyleTransfer is always called with dirname(output) as
  // its outputDir — see the comment at that call site. An outputDir option
  // here would silently do nothing, which is more confusing than not having
  // one at all.
}

/** Test seam: the real implementation calls runFlux2("styletransfer", ...) directly. */
export type StyleTransferFn = (
  options: Record<string, unknown>,
  outputDir?: string,
) => Promise<{ details: Flux2Details; summary: string; stderrTail: string }>;

const defaultRunStyleTransfer: StyleTransferFn = (options, outputDir) =>
  runFlux2({ command: "styletransfer", options, outputDir });

/**
 * Computes the transformer-backend's denoise/dimensions/output path (mirrors
 * _run_transformer_backend, image-purify.py:395-513) and delegates the
 * actual redraw to flux2's native `styletransfer` command.
 */
export async function runPurifyTransformerNative(
  opts: PurifyTransformerOptions,
  runStyleTransfer: StyleTransferFn = defaultRunStyleTransfer,
): Promise<{ details: Flux2Details; summary: string; stderrTail: string }> {
  const mode = opts.mode ?? "enhance";
  const denoise = TRANSFORMER_DENOISE[mode];
  const { width: w0, height: h0 } = await probePngDimensions(opts.inputImage);
  const resolution = parsePurifyResolution(opts.resolution);
  const { width, height } = computePurifyDimensions(w0, h0, resolution);
  const output = purifyOutputPathFor(opts.inputImage, mode, opts.resolution);
  return runStyleTransfer(
    {
      input: opts.inputImage,
      prompt: opts.prompt || DEFAULT_TRANSFORMER_PROMPT,
      strength: denoise,
      width,
      height,
      seed: opts.seed,
      transformer: opts.transformer,
      output,
    },
    // Always the output's own directory, NOT opts.outputDir verbatim: runFlux2
    // injects `--output-dir` from this value, and buildImageDetails's manifest
    // sidecar lookup (s2-agent-ext-flux2/src/result.ts's outputDirFromArgs)
    // prefers `--output-dir` over `--output`'s own dirname when both are
    // present — a mismatch here silently breaks width/height/seed parsing
    // (manifestPath/runJsonPath both resolve to null, Flux2Details still
    // reports ok:true but with null dims), confirmed via a real end-to-end
    // run against the built binary. purifyOutputPathFor always places output
    // next to input, so this is also the correct path-safety root — opts.outputDir
    // is never needed here.
    dirname(output),
  );
}
