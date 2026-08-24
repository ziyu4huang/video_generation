import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OcrResult } from "../ocr/ocr.ts";
import { extractImageCard, isImageFile } from "./extract-image.js";
import { imageCardId, mergeImageContent, sha256Hex } from "./image-card.js";

const OCR_OK: OcrResult = { text: "HELLO 123", width: 800, height: 200, format: "png" };

function tmpImage(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "f2md-img-"));
  const path = join(dir, "shot.png");
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  return { dir, path };
}

describe("isImageFile", () => {
  it("matches image extensions case-insensitively", () => {
    assert.equal(isImageFile("/a/b/shot.png"), true);
    assert.equal(isImageFile("/a/b/shot.PNG"), true);
    assert.equal(isImageFile("/a/b/doc.pdf"), false);
  });
});

describe("mergeImageContent / hashes", () => {
  it("merges OCR + Vision into ONE content field", () => {
    assert.equal(mergeImageContent("HELLO 123", "white image"), "OCR:\nHELLO 123\n\nVision:\nwhite image");
    assert.equal(mergeImageContent("HELLO 123", undefined), "OCR:\nHELLO 123");
    assert.equal(mergeImageContent(undefined, undefined), "");
  });
  it("sha256Hex + imageCardId are stable", () => {
    const h = sha256Hex("x");
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(imageCardId(h), `img-${h.slice(0, 8)}`);
  });
});

describe("extractImageCard", () => {
  it("full path: OCR + vision → merged card with image+provenance front-matter", async (t) => {
    const { dir, path } = tmpImage();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = await extractImageCard(path, {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: true, description: "A white image with the text HELLO 123." }),
      now: () => "2026-08-14",
    });
    assert.equal(r.degraded, false);
    assert.deepEqual(r.warnings, []);
    assert.match(r.markdown, /^---\n/);
    assert.match(r.markdown, /record_type: image/);
    assert.match(r.markdown, /tags: \[zettel, image\]/);
    assert.match(r.markdown, /dimensions: \{width: 800, height: 200\}/);
    assert.match(r.markdown, /locator: shot\.png/);
    assert.match(r.markdown, /format: png/);
    assert.match(r.markdown, /extractor: vision-ocr\+google\/gemma-4-12b/);
    assert.match(r.markdown, /source_hash: [0-9a-f]{64}/);
    assert.match(r.markdown, /content_hash: [0-9a-f]{64}/);
    assert.match(r.markdown, /## 核心想法[\s\S]*OCR:\nHELLO 123[\s\S]*Vision:\nA white image/);
  });

  it("graceful degradation: describe fails → OCR-only card + warning (decision #5)", async (t) => {
    const { dir, path } = tmpImage();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = await extractImageCard(path, {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: false, error: "lm-studio unavailable" }),
      now: () => "2026-08-14",
    });
    assert.equal(r.degraded, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0] ?? "", /vision-LLM unavailable/);
    assert.match(r.markdown, /extractor: vision-ocr$/m);
    assert.ok(!r.markdown.includes("Vision:"), "no Vision block when degraded");
    assert.match(r.markdown, /OCR:\nHELLO 123/);
  });

  it("OCR unavailable but vision ok → description-only card + warning", async (t) => {
    const { dir, path } = tmpImage();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = await extractImageCard(path, {
      ocr: async () => undefined,
      describe: async () => ({ ok: true, description: "A diagram of the pipeline." }),
      now: () => "2026-08-14",
    });
    assert.equal(r.degraded, true);
    assert.match(r.markdown, /extractor: google\/gemma-4-12b$/m);
    assert.match(r.markdown, /dimensions: \{width: 0, height: 0\}/); // dims unknown without OCR
    assert.match(r.markdown, /Vision:\nA diagram of the pipeline\./);
  });

  it("OCR *rejects* (spawn EACCES etc.) → treated as unavailable, never escapes", async (t) => {
    const { dir, path } = tmpImage();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = await extractImageCard(path, {
      ocr: async () => {
        throw new Error("EACCES: permission denied");
      },
      describe: async () => ({ ok: true, description: "A white image." }),
      now: () => "2026-08-14",
    });
    assert.equal(r.degraded, true);
    assert.match(r.warnings[0] ?? "", /OCR unavailable/);
    assert.match(r.markdown, /Vision:\nA white image\./);
  });

  it("both stages fail → throws (never emit an empty card)", async (t) => {
    const { dir, path } = tmpImage();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    await assert.rejects(
      () =>
        extractImageCard(path, {
          ocr: async () => undefined,
          describe: async () => ({ ok: false, error: "down" }),
        }),
      /no OCR text and no vision description/,
    );
  });
});
