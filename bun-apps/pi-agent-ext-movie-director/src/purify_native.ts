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
import { extname } from "node:path";
import { runFlux2, type Flux2Details } from "@repo/pi-agent-ext-flux2";

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
