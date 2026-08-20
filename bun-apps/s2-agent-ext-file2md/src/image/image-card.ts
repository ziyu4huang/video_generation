// src/image/image-card.ts — pure builders for the kind=image vault-md card
// (ticket 07 #1: knowledge front-matter EXTENDED with format/dimensions/
// locator; content = single merged OCR+vision field; atomic one-image-one-card;
// #6: provenance hashes computed exactly like existing cards — sha256 hex).
import { createHash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable content-addressed card id: first 8 hex of the source (image-bytes) hash. */
export function imageCardId(sourceHash: string): string {
  return `img-${sourceHash.slice(0, 8)}`;
}

/** Merge OCR text + vision description into the single content field. */
export function mergeImageContent(ocrText: string | undefined, visionDescription: string | undefined): string {
  const parts: string[] = [];
  if (ocrText !== undefined && ocrText.trim() !== "") parts.push(`OCR:\n${ocrText.trim()}`);
  if (visionDescription !== undefined && visionDescription.trim() !== "") {
    parts.push(`Vision:\n${visionDescription.trim()}`);
  }
  return parts.join("\n\n");
}

export interface ImageCardInput {
  id: string;
  /** ISO date (YYYY-MM-DD). */
  created: string;
  /** Absolute path of the source image. */
  sourceFile: string;
  /** sha256 hex of the image bytes. */
  sourceHash: string;
  /** sha256 hex of the merged content string. */
  contentHash: string;
  format: string;
  width: number;
  height: number;
  /** Vault-facing location tag (image basename). */
  locator: string;
  /** Which stages produced this card, e.g. "vision-ocr+google/gemma-4-12b". */
  extractor: string;
  ocrText: string | undefined;
  visionDescription: string | undefined;
}

/** Emit the vault-md image card (zettel envelope + record_type: image).
 *  YAML is hand-emitted — every value below is a plain scalar/flow literal,
 *  so no yaml dependency is needed in this package. */
export function buildImageCardMarkdown(input: ImageCardInput): string {
  const fm: string[] = [
    "---",
    `id: ${input.id}`,
    `created: ${input.created}`,
    "tags: [zettel, image]",
    "record_type: image",
    `source_file: ${input.sourceFile}`,
    `source_hash: ${input.sourceHash}`,
    `content_hash: ${input.contentHash}`,
    `extractor: ${input.extractor}`,
    `format: ${input.format}`,
    `dimensions: {width: ${input.width}, height: ${input.height}}`,
    `locator: ${input.locator}`,
    "---",
  ];
  const body: string[] = [
    "",
    `# ${input.id}`,
    "",
    "## 核心想法",
    mergeImageContent(input.ocrText, input.visionDescription),
  ];
  return fm.concat(body).join("\n") + "\n";
}
