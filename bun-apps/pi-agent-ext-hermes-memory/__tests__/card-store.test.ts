import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCardStore } from "../src/store/card-store.js";
import type { Card } from "../src/store/card.js";

const dir = mkdtempSync(join(tmpdir(), "card-store-"));

describe("card-agnostic store (SQLite round-trip)", () => {
  let store: ReturnType<typeof createCardStore>;
  // `before`/`after` are this Bun `node:test` shim's beforeAll/afterAll.
  before(async () => {
    store = await createCardStore({ memoryDir: dir, dbBackend: "sqlite" });
  });
  after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists + retrieves a knowledge Card through SQLite", async () => {
    const card: Card = {
      id: "ltx:cfg-scale-7-lever",
      kind: "knowledge",
      content: "LTX prefers cfg-scale 7",
      frontmatter: {
        id: "ltx:cfg-scale-7-lever",
        record_type: "lever",
        status: "active",
        confidence: 0.93,
      },
    };
    await store.upsertCard(card);
    const back = await store.getCard(card.id);
    assert.ok(back);
    assert.equal(back!.kind, "knowledge");
    assert.equal(back!.id, card.id);
    assert.equal(back!.content, card.content);
    assert.equal(back!.frontmatter.record_type, "lever");
    assert.equal(back!.frontmatter.confidence, 0.93);
  });

  it("re-ingesting the same knowledge id is idempotent (no dup row)", async () => {
    const card: Card = { id: "dup:test", kind: "knowledge", content: "x", frontmatter: { id: "dup:test" } };
    await store.upsertCard(card);
    await store.upsertCard(card);
    const ofKind = await store.getCardsByKind("knowledge");
    assert.equal(ofKind.filter((c) => c.id === "dup:test").length, 1);
  });

  it("getCardsByKind('knowledge') returns only knowledge cards", async () => {
    const ofKind = await store.getCardsByKind("knowledge");
    assert.ok(ofKind.every((c) => c.kind === "knowledge"));
  });
});
