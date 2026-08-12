/**
 * Document classification for `file2md`.
 *
 * Two layers:
 *
 *   1. `classifyKind(path)` — MECHANICAL, local. Sniffs magic bytes / extension
 *      to determine the file format: "pdf" (needs rasterization) or "image".
 *      No LLM involved; cheap and deterministic.
 *
 *   2. `classifyProfile(imagePath)` — SEMANTIC, via a VLM subagent. Looks at
 *      the rasterized page-1 image and decides the content profile
 *      ("paper" | "slides" | "poster" | "diagram" | "image"). This selects the
 *      per-page system prompt used for actual extraction.
 *
 *      Implemented in `vlm/classify-vlm.ts` (it needs a model session).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export type DocKind = "pdf" | "image" | "unknown";

/** Semantic content profile that selects a system prompt. */
export type DocProfile = "paper" | "slides" | "poster" | "diagram" | "image";

/** The set of profiles the VLM classifier may emit. */
export const ALL_PROFILES: DocProfile[] = ["paper", "slides", "poster", "diagram", "image"];

export interface ClassifiedKind {
  kind: DocKind;
  /** Absolute input path. */
  path: string;
  /** Best-effort human label (basename). */
  name: string;
}

/** Sniff the first bytes of a file to determine its true kind. */
function sniffKind(path: string): DocKind {
  try {
    const buf: Buffer = readFileSync(path);
    const head = buf.subarray(0, 16);
    // PDF: "%PDF"
    if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
      return "pdf";
    }
    // PNG: 89 50 4E 47
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      return "image";
    }
    // JPEG: FF D8 FF
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return "image";
    }
    // GIF: "GIF8"
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
      return "image";
    }
    // WebP: "RIFF"...."WEBP"
    if (
      head[0] === 0x52 &&
      head[1] === 0x49 &&
      head[2] === 0x46 &&
      head[3] === 0x46 &&
      head[8] === 0x57 &&
      head[9] === 0x45 &&
      head[10] === 0x42 &&
      head[11] === 0x50
    ) {
      return "image";
    }
    // BMP: "BM"
    if (head[0] === 0x42 && head[1] === 0x4d) {
      return "image";
    }
  } catch {
    /* fall back to extension */
  }
  return "unknown";
}

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"]);

/** Mechanical classification: file-format kind only. */
export function classifyKind(path: string): ClassifiedKind {
  if (!existsSync(path)) {
    throw new Error(`Input not found: ${path}`);
  }
  if (!statSync(path).isFile()) {
    throw new Error(`Input is not a regular file: ${path}`);
  }
  let kind = sniffKind(path);
  if (kind === "unknown") {
    const ext = extname(path).toLowerCase();
    if (ext === ".pdf") kind = "pdf";
    else if (IMG_EXT.has(ext)) kind = "image";
  }
  if (kind === "unknown") {
    throw new Error(`Unsupported input "${path}". Supported: PDF, PNG, JPG, WebP, GIF, BMP.`);
  }
  return { kind, path, name: basename(path) };
}

/** mimeType for an image content block, by kind/extension. */
export function imageMimeType(doc: { kind: DocKind; path: string }): string {
  if (doc.kind === "pdf") return "image/png"; // we always rasterize to png
  const ext = extname(doc.path).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    default:
      return "image/png";
  }
}
