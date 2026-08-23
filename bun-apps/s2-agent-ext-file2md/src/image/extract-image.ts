// src/image/extract-image.ts — image input branch (ticket 07 #3): OCR via the
// vendored tesseract-wasm layer (v2), optional describe via the shared VLM
// seam (askImage → vision tier), merged into ONE atomic kind=image vault-md
// card. Graceful degradation (decision #5): VLM failure → OCR-only card +
// stderr warning; both stages failing → throw.

import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { type OcrResult, ocrImageFile } from "../ocr/ocr.ts";
import { askImage } from "../vlm/ask.js";
import { buildImageCardMarkdown, imageCardId, mergeImageContent, sha256Hex } from "./image-card.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export function isImageFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXT.has(path.slice(dot).toLowerCase());
}

export interface DescribeResult {
  ok: boolean;
  description?: string;
  error?: string;
}

const DESCRIBE_PROMPT =
  "Describe this image factually for a knowledge base: the subject(s), the scene, any legible text, and notable details. 3-6 sentences, plain prose.";

/** Default describe stage: file2md's shared VLM seam. askImage already
 *  defaults to lm-studio google/gemma-4-12b (see ../vlm/ask.ts header). */
export async function askImageDescribe(imagePath: string): Promise<DescribeResult> {
  try {
    const r = await askImage(imagePath, DESCRIBE_PROMPT);
    if (r.ok && r.reply.trim() !== "") return { ok: true, description: r.reply.trim() };
    return { ok: false, error: r.error ?? "vlm-unavailable" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ExtractImageOpts {
  /** OCR stage — default ocrImageFile (vendored tesseract-wasm, bun-only). */
  ocr?: (imagePath: string) => Promise<OcrResult | undefined>;
  /** Describe stage — default askImageDescribe (askImage → lm-studio gemma). */
  describe?: (imagePath: string) => Promise<DescribeResult>;
  /** Clock for `created` — default today's ISO date. */
  now?: () => string;
}

export interface ExtractImageResult {
  /** The full vault-md image card (one image = one card, atomic — decision #4). */
  markdown: string;
  /** True when a stage was skipped (degraded card) — always paired with warnings. */
  degraded: boolean;
  warnings: string[];
}

export async function extractImageCard(imagePath: string, opts: ExtractImageOpts = {}): Promise<ExtractImageResult> {
  const abs = isAbsolute(imagePath) ? imagePath : resolve(imagePath);
  const ocr = opts.ocr ?? ocrImageFile;
  const describe = opts.describe ?? askImageDescribe;
  const created = (opts.now ?? (() => new Date().toISOString().slice(0, 10)))();
  const warnings: string[] = [];

  // Provenance (decision #6): source_hash over the image bytes.
  const sourceHash = sha256Hex(readFileSync(abs));

  const ocrRes = await ocr(abs).catch(() => undefined);
  if (ocrRes === undefined) {
    warnings.push(`[file2md] OCR unavailable for ${abs} (vision-ocr-cli missing or failed)`);
  }

  const descRes = await describe(abs);
  const visionDescription = descRes.ok && descRes.description ? descRes.description : undefined;
  if (visionDescription === undefined) {
    warnings.push(
      `[file2md] vision-LLM unavailable for ${abs} (${descRes.error ?? "unknown"}) — emitting OCR-only card`,
    );
  }

  const content = mergeImageContent(ocrRes?.text, visionDescription);
  if (content === "") {
    throw new Error(`image card extraction failed for ${abs}: no OCR text and no vision description`);
  }

  const extractor = [
    ocrRes !== undefined ? "vision-ocr" : undefined,
    visionDescription !== undefined ? "google/gemma-4-12b" : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join("+");

  const markdown = buildImageCardMarkdown({
    id: imageCardId(sourceHash),
    created,
    sourceFile: abs,
    sourceHash,
    contentHash: sha256Hex(content),
    format: ocrRes?.format ?? abs.slice(abs.lastIndexOf(".") + 1).toLowerCase(),
    width: ocrRes?.width ?? 0,
    height: ocrRes?.height ?? 0,
    locator: basename(abs),
    extractor,
    ocrText: ocrRes?.text,
    visionDescription,
  });

  for (const w of warnings) process.stderr.write(`${w}\n`);
  return { markdown, degraded: warnings.length > 0, warnings };
}
