import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
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

  it("persists + retrieves a planning-ticket Card", async () => {
    const card: Card = {
      id: "planning-ticket:fixture-effort:08",
      kind: "planning-ticket",
      content: "Hermes owns ingest + store",
      frontmatter: { id: "08", slug: "planning-card-model", type: "grilling", status: "closed" },
    };
    await store.upsertCard(card);
    const back = await store.getCard(card.id);
    assert.ok(back);
    assert.equal(back!.kind, "planning-ticket");
    assert.equal(back!.id, card.id);
    assert.equal(back!.frontmatter.slug, "planning-card-model");
  });

  it("re-ingesting a planning-effort id is idempotent", async () => {
    const card: Card = {
      id: "planning-effort:fixture-effort",
      kind: "planning-effort",
      content: "destination",
      frontmatter: { effort: "fixture-effort", status: "active" },
    };
    await store.upsertCard(card);
    await store.upsertCard(card);
    const ofKind = await store.getCardsByKind("planning-effort");
    assert.equal(ofKind.filter((c) => c.id === card.id).length, 1);
  });

  it("migrates a legacy 4-value target CHECK to 6-value (planning kinds allowed)", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "planning-migrate-"));
    try {
      // Seed a post-06a / pre-planning DB: 4-value target CHECK.
      const raw = new Database(join(legacyDir, "sessions.db"));
      raw.exec(
        `CREATE TABLE memories (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           target TEXT NOT NULL CHECK (target IN ('memory','user','failure','knowledge')),
           content TEXT NOT NULL,
           created DATE NOT NULL,
           last_referenced DATE NOT NULL
         )`,
      );
      raw.exec(
        "INSERT INTO memories (target, content, created, last_referenced) VALUES ('knowledge','seed','2026-01-01','2026-01-01')",
      );
      raw.close();
      // Opening the store runs initializeSchema -> migrateMemoriesTargetCheckAddPlanning fires.
      const migrated = await createCardStore({ memoryDir: legacyDir, dbBackend: "sqlite" });
      await migrated.upsertCard({
        id: "planning-ticket:e:01",
        kind: "planning-ticket",
        content: "post-migration",
        frontmatter: { id: "01" },
      });
      const back = await migrated.getCard("planning-ticket:e:01");
      assert.ok(back);
      assert.equal(back!.kind, "planning-ticket");
      await migrated.close();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
