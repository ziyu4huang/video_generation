// src/image-card-ingest.test.ts — ticket 07 T4: the file2md-emitted image card
// flows through the EXISTING hermes ingest/embed path unchanged (decision #2:
// text-embed of the merged content only), and a degraded (OCR-only) card
// ingests too (decision #5).
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImageCard, type OcrResult } from "@repo/pi-agent-ext-file2md";
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

/** Fake embedder absorbing the call shape: called as embedder(texts[], model)
 *  (batch signature, vector-backfill.ts `embedder(texts, embedModel)`); records
 *  every string it is handed. NOTE: must be a PLAIN FUNCTION — the plan's
 *  Proxy-over-{} fake is not callable, so the direct call threw inside the
 *  error-isolated task and silently skipped every embed. */
function recordingEmbedder(log: string[]): unknown {
  return async (texts: string | string[], _model: string) => {
    const arr = Array.isArray(texts) ? texts : [texts];
    log.push(...arr);
    return arr.map(() => new Array(8).fill(0.1));
  };
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

  it("walkAndIngest embeds an image card through the existing backfill path (text-embed of merged content)", async (t) => {
    const vault = tmpVault();
    t.after(() => rmSync(vault, { recursive: true, force: true }));
    const { markdown } = await extractImageCard(tmpImage(vault), {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: true, description: "A white image reading HELLO 123." }),
      now: () => "2026-08-14",
    });
    const [card] = new ImageSerializer().deserialize(markdown);
    const id = card!.id;
    writeFileSync(join(vault, "vault", `${id}.md`), markdown);

    // ADAPTATION (pre-plan runtime validation): the plan's verbatim block
    // called walkAndIngest({memoryDir, vectorBackfill}) — but the real
    // signature is walkAndIngest(input: string | string[], opts) (line 143),
    // and the vault-md→store mirror (step 8) is gated on the zk
    // `__piKnowledgePipeline` seam, which is ABSENT in unit tests — a
    // bare vault-dir call would never land the card in the store, so the
    // backfill (which reads store rows by kind) would see nothing. Mirror
    // production's persisted state instead: upsert the card at `memoryDir`
    // (exactly what test 3 proves works), then run walkAndIngest over the
    // vault dir — the fire-and-forget backfill opens the SAME store at
    // `memoryDir` and embeds kind=image rows through the UNCHANGED seam.
    const store = await createCardStore({ memoryDir: join(vault, "store") });
    await store.upsertCard(card!);
    await store.close();

    const embedded: string[] = [];
    const embedder = recordingEmbedder(embedded);
    // ADAPTATION (pre-plan runtime validation): getStoredHashes MUST return a
    // Map — the plan's verbatim `async () => undefined` fake made the in-task
    // `stored.get(mdId)` throw, so the error-isolated backfill silently skipped
    // every embed. Mirror the real VectorStore contract instead.
    const storedHashes = new Map<string, string>();
    const vectorStore = {
      getStoredHashes: async () => storedHashes,
      upsertVectors: async (entries: Array<{ mdId: string; contentHash: string }>) => {
        for (const e of entries) storedHashes.set(e.mdId, e.contentHash);
      },
    };
    // Impl-start pin: fireVectorBackfillBestEffort passes deps.vectorStore /
    // deps.embedder DIRECTLY to scheduleVectorBackfill (walk-and-ingest.ts
    // ~290) — they are values, not factories, so no `() => …` wrappers here.
    await walkAndIngest(join(vault, "vault"), {
      memoryDir: join(vault, "store"),
      vectorBackfill: {
        vectorStore: vectorStore as never,
        embedder: embedder as never,
        modelVersion: "test",
        embedModel: "nomic-embed-text-v1.5",
      },
    });
    await new Promise((r) => setTimeout(r, 200)); // fire-and-forget backfill window
    assert.ok(
      embedded.some((s) => s.includes("HELLO 123")),
      "merged image content reached the text embedder through the unchanged path",
    );
  });
});
