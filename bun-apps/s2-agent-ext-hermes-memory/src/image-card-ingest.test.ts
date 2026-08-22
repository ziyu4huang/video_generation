// src/image-card-ingest.test.ts — ticket 07 T4: the file2md-emitted image card
// deserializes + persists through the hermes card store unchanged, and a
// degraded (OCR-only) card ingests too (decision #5). (The vector-backfill
// embed leg was retired 2026-08-22 — context-lifecycle ticket 03.)
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImageCard, type OcrResult } from "@repo/s2-agent-ext-file2md";
import { ImageSerializer } from "./store/image-serializer.js";
import { createCardStore } from "./store/card-store.js";
import { walkAndIngest } from "./walk-and-ingest.js";

const OCR_OK: OcrResult = { text: "HELLO 123", width: 800, height: 200, format: "png" };

function tmpVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "hermes-img-"));
  mkdirSync(join(dir, "vault"), { recursive: true });
  return dir;
}

function tmpImage(vault: string): string {
  const p = join(vault, "shot.png");
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  return p;
}

describe("image card ingest (file2md → hermes, ticket 07 T4)", () => {
  it("extractImageCard markdown deserializes as kind=image via ImageSerializer", async (t) => {
    const vault = tmpVault();
    t.after(() => rmSync(vault, { recursive: true, force: true }));
    const { markdown } = await extractImageCard(tmpImage(vault), {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: true, description: "A white image reading HELLO 123." }),
      now: () => "2026-08-14",
    });
    const cards = new ImageSerializer().deserialize(markdown);
    assert.equal(cards.length, 1);
    const card = cards[0]!;
    assert.equal(card.kind, "image");
    assert.match(card.content, /HELLO 123/);
    assert.match(card.content, /Vision:/);
    assert.equal(card.frontmatter.format, "png");
    assert.deepEqual(card.frontmatter.dimensions, { width: 800, height: 200 });
    assert.equal(card.frontmatter.locator, "shot.png");
    assert.match(String(card.frontmatter.source_hash), /^[0-9a-f]{64}$/);
    assert.match(String(card.frontmatter.content_hash), /^[0-9a-f]{64}$/);
  });

  it("degraded (OCR-only) card still deserializes as a valid image card", async (t) => {
    const vault = tmpVault();
    t.after(() => rmSync(vault, { recursive: true, force: true }));
    const { markdown } = await extractImageCard(tmpImage(vault), {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: false, error: "lm-studio unavailable" }),
      now: () => "2026-08-14",
    });
    const [card] = new ImageSerializer().deserialize(markdown);
    assert.equal(card!.kind, "image");
    assert.match(card!.content, /HELLO 123/);
    assert.ok(!card!.content.includes("Vision:"));
  });

  it("the image card persists through the SQLite store", async (t) => {
    const vault = tmpVault();
    t.after(() => rmSync(vault, { recursive: true, force: true }));
    const { markdown } = await extractImageCard(tmpImage(vault), {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: true, description: "A white image reading HELLO 123." }),
      now: () => "2026-08-14",
    });
    const [card] = new ImageSerializer().deserialize(markdown);
    // Impl-start pin: `createCardStore` is async in
    // src/store/card-store.ts:134 (`export async function createCardStore`),
    // `upsertCard(card): Promise<void>` at card-store.ts:42 — awaited below.
    const store = await createCardStore({ memoryDir: join(vault, "store") });
    await store.upsertCard(card!);
    const got = await store.getCard(card!.id);
    assert.equal(got?.kind, "image");
    assert.deepEqual(got?.frontmatter.dimensions, { width: 800, height: 200 });
    await store.close();
  });


});
