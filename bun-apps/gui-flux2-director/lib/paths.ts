/**
 * paths.ts — repo/binary/model/output path resolution for the flux2 web UI.
 *
 * Mirrors the flux2 CLI's own resolution so the UI always scans what the CLI
 * writes: models root honors MLX_MODELS_DIR, output dir honors MLX_OUTPUT_DIR
 * with the CLI's `../video_generation__output` sibling default.
 */
import path from "path";
import { existsSync } from "fs";

export const PKG_DIR = path.resolve(import.meta.dir, "..");
export const REPO_DIR = path.resolve(PKG_DIR, "..", "..");

/**
 * flux2 release binary. ALWAYS release — debug builds hit a metallib crash at
 * runtime (see swift/flux2-image-director/README.md). Override for a
 * prebuilt/deployed binary via FLUX2_BIN.
 */
export const FLUX2_BIN = process.env.FLUX2_BIN
  ?? path.join(REPO_DIR, "swift", "flux2-image-director", ".build", "release", "flux2");

export function flux2BinExists(): boolean {
  return existsSync(FLUX2_BIN);
}

/**
 * MLX needs its Metal kernel library colocated with the binary — a plain
 * `swift build` doesn't produce it (SwiftPM can't compile Metal); it comes
 * from scripts/build-metallib.sh. Missing = every MLX compute call dies with
 * "Failed to load the default metallib".
 */
export const FLUX2_METALLIB = path.join(path.dirname(FLUX2_BIN), "mlx.metallib");

export function flux2MetallibExists(): boolean {
  return existsSync(FLUX2_METALLIB);
}

export const MODELS_DIR = process.env.MLX_MODELS_DIR
  ? path.resolve(process.env.MLX_MODELS_DIR)
  : path.join(REPO_DIR, "mlx-models");

/** Same default as the CLI's `--output-dir`: the sibling output tree. */
export const OUTPUT_DIR = process.env.MLX_OUTPUT_DIR
  ? path.resolve(process.env.MLX_OUTPUT_DIR)
  : path.resolve(REPO_DIR, "..", "video_generation__output");

/**
 * True when `candidate` resolves INSIDE `root` (path-containment check used
 * for every user-supplied path the server reads or passes to the CLI).
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
