/**
 * core/sniff.ts — mechanical file-kind detection for file2md v2.
 *
 * Layers:
 *   1. Image magic bytes (png/jpeg/gif/webp/bmp/tiff) — cheap, local.
 *   2. DSH Cowork's sniff for the document family (pdf + OOXML zip + ipynb).
 *   3. Text passthrough family (txt/md/csv/html) by content peek + extension.
 *
 * The OOXML family needs the zip central directory, so sniff is async.
 */
import { extname } from "node:path";
import { DocError } from "../../vendored/dsh-cowork-core@0.1.0/src/safety.ts";
import { sniff as dshSniff } from "../../vendored/dsh-cowork-core@0.1.0/src/sniff.ts";
import type { SniffedFile, TextInKind } from "./types.ts";

const TEXT_EXT: Record<string, TextInKind> = {
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
  ".csv": "csv",
  ".html": "html",
  ".htm": "html",
};

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"]);

/** True when the buffer starts with a recognized image signature. */
export function isImageBytes(data: Uint8Array): boolean {
  const head = data.subarray(0, 12);
  // PNG
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true;
  // JPEG
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
  // GIF ("GIF8")
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return true;
  // WebP ("RIFF" ... "WEBP" at offset 8)
  if (
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  )
    return true;
  // BMP ("BM")
  if (head[0] === 0x42 && head[1] === 0x4d) return true;
  // TIFF ("II*\0" or "MM\0*")
  if (
    (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a)
  )
    return true;
  return false;
}

function textKindByPath(path: string): TextInKind | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".json" || ext === ".xml") return "txt"; // reported as txt passthrough
  return TEXT_EXT[ext];
}

/**
 * Sniff a buffer (with an extension hint for wobbly cases) into a FileKind.
 * Throws DocError for explicit rejections (macro formats, legacy OLE2).
 */
export async function detectKind(data: Uint8Array, path?: string): Promise<SniffedFile> {
  if (isImageBytes(data)) return { kind: "image" };

  if (path !== undefined && path !== "") {
    const extHint = textKindByPath(path);
    if (extHint && !isPdfOrZip(data)) {
      return { kind: "text", textKind: extHint };
    }
  }

  const sniffed = await dshSniff(data, path);
  switch (sniffed.format) {
    case "pdf":
      return { kind: "pdf" };
    case "docx":
      return { kind: "docx" };
    case "xlsx":
      return { kind: "xlsx" };
    case "pptx":
      return { kind: "pptx" };
    case "ipynb":
      return { kind: "ipynb", byContent: sniffed.byContent };
    case "ole2":
      throw new DocError(
        "UNSUPPORTED_FORMAT",
        "legacy binary Office formats (.xls/.doc/.ppt) are not supported; save as the modern OOXML format and retry",
      );
    case "xlsm":
    case "docm":
    case "pptm":
      throw new DocError("MACRO_FORMAT_REJECTED", `macro-enabled ${sniffed.format.slice(-1)} formats are rejected`);
    default:
      // Not a doc/archive/magic binary — text passthrough (or a hard fail
      // downstream when the bytes are not printable at all).
      return { kind: "text", textKind: textKindByPath(path ?? "") ?? "txt" };
  }
}

function isPdfOrZip(data: Uint8Array): boolean {
  const head = data.subarray(0, 4);
  return (
    (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) ||
    (head[0] === 0x50 && head[1] === 0x4b)
  );
}
