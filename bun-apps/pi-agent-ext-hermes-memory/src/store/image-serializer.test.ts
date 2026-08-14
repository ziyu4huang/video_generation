import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { ImageSerializer } from "./image-serializer.js";
import { KnowledgeSerializer } from "./knowledge-serializer.js";

const IMAGE_MD = [
  "---",
  "id: img-deadbeef",
  "created: '2026-08-14'",
  "tags:",
  "  - zettel",
  "  - image",
  "record_type: image",
  "source_file: /abs/shot.png",
  "source_hash: aabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabb",
  "content_hash: ccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccdd",
  "extractor: vision-ocr+google/gemma-4-12b-qat",
  "format: png",
  "dimensions:",
  "  width: 800",
  "  height: 200",
  "locator: shot.png",
  "---",
  "# img-deadbeef",
  "",
  "## 核心想法",
  "OCR:",
  "HELLO 123",
  "",
  "Vision:",
  "A white image with the text HELLO 123.",
].join("\n");

const PLAIN_ZETTEL = [
  "---",
  "id: z-1",
  "created: '2026-08-14'",
  "tags:",
  "  - zettel",
  "record_type: lever",
  "---",
  "# z-1",
  "",
  "## 核心想法",
  "some lever text",
].join("\n");

describe("ImageSerializer (kind=image)", () => {
  const ser = new ImageSerializer();

  it("deserialize parses an image card (merged content + image fields + provenance)", () => {
    const cards = ser.deserialize(IMAGE_MD);
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.equal(c.kind, "image");
    assert.equal(c.id, "img-deadbeef");
    assert.match(c.content, /HELLO 123/); // merged OCR …
    assert.match(c.content, /Vision:/); // … + vision description in ONE field
    assert.equal(c.frontmatter.record_type, "image");
    assert.deepEqual(c.frontmatter.dimensions, { width: 800, height: 200 });
    assert.equal(c.frontmatter.format, "png");
    assert.equal(c.frontmatter.locator, "shot.png");
    assert.match(String(c.frontmatter.source_hash), /^[0-9a-f]{64}$/);
    assert.match(String(c.frontmatter.content_hash), /^[0-9a-f]{64}$/);
  });

  it("deserialize returns [] for a plain knowledge zettel (no image fields)", () => {
    assert.deepEqual(ser.deserialize(PLAIN_ZETTEL), []);
  });

  it("serialize→deserialize round-trips an image card", () => {
    const [c] = ser.deserialize(IMAGE_MD)!;
    const [c2] = ser.deserialize(ser.serialize(c!))!;
    assert.deepEqual(c2, c);
  });

  it("KnowledgeSerializer rejects record_type: image files (dispatch disambiguation)", () => {
    assert.deepEqual(new KnowledgeSerializer().deserialize(IMAGE_MD), []);
  });
});
