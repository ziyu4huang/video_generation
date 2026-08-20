// src/store/card-store-dual-backend.test.ts — kp13 Wave A contract tests.
//
// Wave A gate (plans/13-three-waves.md): the SAME card contract
// (upsert → getCard → getCardsByKind identity, updateCard, deleteCard) must
// hold on BOTH backends — sqlite (the 06a SQL) and surrealdb (the new
// implementation over SurrealMemoryRepository: insert rides addMemory so the
// C6 exact-dup dedup is inherited; the card envelope rides SCHEMALESS free
// columns). Plus: the BackendBundle carries a working cardStore on both
// branches, the fallback bundle keeps it, and a re-bundle (the live backend
// swap's build step) yields a cardStore that sees the same rows.
//
// Surreal tests run against an ISOLATED test namespace/database (created by
// SurrealBackend.init's idempotent bootstrap), never the agent's live data,
// and skip gracefully when no local SurrealDB server is reachable.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCardStore, type CardStore } from "./card-store.js";
import { createBackendBundle, createBackendBundleWithFallback } from "./backend-factory.js";
import { loadConfig } from "../config.js";
import type { MemoryTarget } from "./repository.js";
import { SurrealBackend } from "./surreal/surreal-backend.js";
import type { SurrealMemoryRepository } from "./surreal/surreal-memory-repo.js";
import type { Card } from "./card.js";

// ── Surreal reachability probe (isolated ns/db; skip when the server is down) ──

const TEST_SURREAL = { namespace: "test_hermes_kp13a", database: "kp13_wave_a" };

async function probeSurreal(): Promise<boolean> {
  try {
    const backend = new SurrealBackend(TEST_SURREAL);
    await backend.init();
    await backend.healthCheck();
    return true;
  } catch {
    return false;
  }
}
const SURREAL_UP = await probeSurreal();

/** Base config = pure defaults (a nonexistent config path leaves
 *  DEFAULT_CONFIG untouched — never the live agent's config file). */
function baseConfig(overrides: Record<string, unknown>) {
  return { ...loadConfig(join(tmpdir(), "kp13a-nonexistent-config.json")), ...overrides };
}

/** Reachability-gated surreal bundle. `undefined` when the server is down. */
async function surrealBundle(): Promise<
  Awaited<ReturnType<typeof createBackendBundle>> | undefined
> {
  if (!SURREAL_UP) return undefined;
  return createBackendBundle(
    baseConfig({ dbBackend: "surrealdb", surreal: TEST_SURREAL }),
    "unused-memory-dir",
  );
}

/** The SAME contract body run against both backends (contract-style test). */
async function contractRoundTrip(store: CardStore): Promise<void> {
  const knowledge: Card = {
    id: "knowledge:kp13a-contract",
    kind: "knowledge",
    content: "kp13 Wave A dual-backend contract round-trip",
    frontmatter: { id: "knowledge:kp13a-contract", record_type: "lever", tags: ["kp13"] },
    graph: { links: ["some-slug"], entities: [{ type: "tool", name: "mflux" }] },
  };
  const memory: Card = {
    id: "memory:kp13a-contract",
    kind: "memory",
    content: "kp13 Wave A memory-kind card round-trips through the same façade",
    frontmatter: { id: "memory:kp13a-contract", created: "2026-08-15" },
  };
  try {
    await store.upsertCard(knowledge);
    await store.upsertCard(memory);

    // getCard identity (content + envelope + graph) for BOTH kinds.
    const gotKnowledge = await store.getCard(knowledge.id);
    assert.ok(gotKnowledge, "getCard(knowledge) returned the row");
    assert.equal(gotKnowledge.kind, "knowledge");
    assert.equal(gotKnowledge.content, knowledge.content);
    assert.deepEqual(gotKnowledge.frontmatter, knowledge.frontmatter);
    assert.deepEqual(gotKnowledge.graph, knowledge.graph);

    const gotMemory = await store.getCard(memory.id);
    assert.ok(gotMemory, "getCard(memory) returned the row");
    assert.equal(gotMemory.kind, "memory");
    assert.equal(gotMemory.content, memory.content);
    assert.deepEqual(gotMemory.frontmatter, memory.frontmatter);

    // getCardsByKind lists both kinds by target.
    const knowledgeList = await store.getCardsByKind("knowledge");
    const listedKnowledge = knowledgeList.find((c) => c.id === knowledge.id);
    assert.ok(listedKnowledge, "knowledge card present in getCardsByKind");
    assert.deepEqual(listedKnowledge.frontmatter, knowledge.frontmatter);
    assert.deepEqual(listedKnowledge.graph, knowledge.graph);
    const memoryList = await store.getCardsByKind("memory");
    assert.ok(
      memoryList.some((c) => c.id === memory.id),
      "memory card present in getCardsByKind",
    );

    // updateCard refreshes content in place (Tier-1 md-wins refresh seam).
    await store.updateCard({ ...knowledge, content: "kp13 Wave A refreshed content" });
    const updated = await store.getCard(knowledge.id);
    assert.ok(updated, "getCard after updateCard");
    assert.equal(updated.content, "kp13 Wave A refreshed content");

    // deleteCard removes the row.
    await store.deleteCard(knowledge.id);
    assert.equal(await store.getCard(knowledge.id), null);
  } finally {
    // Best-effort cleanup (deleteCard is idempotent: no row → no-op).
    await store.deleteCard(knowledge.id).catch(() => {});
    await store.deleteCard(memory.id).catch(() => {});
  }
}

describe("card-store dual-backend contract (kp13 Wave A)", () => {
  it("sqlite quick path: upsert → getCard → getCardsByKind → update → delete", async () => {
    const mem = mkdtempSync(join(tmpdir(), "card-store-dual-sqlite-"));
    try {
      const store = await createCardStore({ memoryDir: mem });
      await contractRoundTrip(store);
      await store.close(); // quick path OWNS its backend
    } finally {
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("surreal (over SurrealMemoryRepository): the SAME contract holds", { skip: !SURREAL_UP }, async () => {
    const bundle = await surrealBundle();
    assert.ok(bundle, "bundle");
    try {
      await contractRoundTrip(bundle.cardStore);
    } finally {
      await bundle.backend.close();
    }
  });

  it("surreal: C6 exact-dup dedup rides on the insert path (same content twice → one row)", { skip: !SURREAL_UP }, async () => {
    const bundle = await surrealBundle();
    assert.ok(bundle, "bundle");
    const repo = bundle.memoryRepo as SurrealMemoryRepository;
    try {
      // Belt-level proof: addMemory (the call insertCard rides) dedups.
      const first = await repo.addMemory({
        content: "kp13a c6 dedup ride probe",
        // CardKind ⊋ MemoryTarget: type-level cast only (Surreal stores the
        // target string as-is; same cast the card-store insert path makes).
        target: "knowledge" as MemoryTarget,
        mdId: "knowledge:kp13a-c6-probe",
      });
      const second = await repo.addMemory({
        content: "kp13a c6 dedup ride probe",
        target: "knowledge" as MemoryTarget,
        mdId: "knowledge:kp13a-c6-probe",
      });
      assert.equal(second.id, first.id, "second addMemory returned the SAME row");
      const cards = await repo.listCardsByTarget("knowledge");
      assert.equal(
        cards.filter((c) => c.content === "kp13a c6 dedup ride probe").length,
        1,
        "exactly one row for the identical content",
      );

      // Façade-level idempotence: the same card upserted twice stays one row.
      await bundle.cardStore.upsertCard({
        id: "knowledge:kp13a-c6-upsert",
        kind: "knowledge",
        content: "kp13a upsert-twice stays one row",
        frontmatter: { id: "knowledge:kp13a-c6-upsert" },
      });
      await bundle.cardStore.upsertCard({
        id: "knowledge:kp13a-c6-upsert",
        kind: "knowledge",
        content: "kp13a upsert-twice stays one row",
        frontmatter: { id: "knowledge:kp13a-c6-upsert" },
      });
      const listed = await bundle.cardStore.getCardsByKind("knowledge");
      assert.equal(
        listed.filter((c) => c.id === "knowledge:kp13a-c6-upsert").length,
        1,
        "one row after two identical upserts",
      );
    } finally {
      await bundle.cardStore.deleteCard("knowledge:kp13a-c6-upsert").catch(() => {});
      await bundle.cardStore.deleteCard("knowledge:kp13a-c6-probe").catch(() => {});
      await bundle.backend.close();
    }
  });

  it("surreal: md-hash/dep-hash accessors throw the documented sqlite-only error", { skip: !SURREAL_UP }, async () => {
    const bundle = await surrealBundle();
    assert.ok(bundle, "bundle");
    try {
      await assert.rejects(
        bundle.cardStore.getCardMdHash("any"),
        /SQLite-only/,
        "getCardMdHash throws SQLITE_ONLY on surreal",
      );
      await assert.rejects(
        bundle.cardStore.upsertCardDepHash("any", "h"),
        /SQLite-only/,
        "upsertCardDepHash throws SQLITE_ONLY on surreal",
      );
    } finally {
      await bundle.backend.close();
    }
  });
});

describe("BackendBundle cardStore join (kp13 Wave A)", () => {
  it("sqlite branch: bundle carries a WORKING cardStore (shared backend handle)", async () => {
    const mem = mkdtempSync(join(tmpdir(), "card-store-bundle-sqlite-"));
    try {
      const bundle = await createBackendBundle(baseConfig({ dbBackend: "sqlite" }), mem);
      const card: Card = {
        id: "knowledge:kp13a-bundle",
        kind: "knowledge",
        content: "bundle-joined cardStore round-trips",
        frontmatter: { id: "knowledge:kp13a-bundle" },
      };
      await bundle.cardStore.upsertCard(card);
      const got = await bundle.cardStore.getCard(card.id);
      assert.ok(got, "bundle.cardStore round-trip");
      assert.equal(got.content, card.content);
      // The sqlite hash accessors stay functional through the bundle path.
      await bundle.cardStore.upsertCardMdHash(card.id, "deadbeef", "mirror");
      const hash = await bundle.cardStore.getCardMdHash(card.id);
      assert.ok(hash, "md-hash row through bundle.cardStore");
      assert.equal(hash?.hash, "deadbeef");
      await bundle.backend.close(); // bundle owns the handle (cardStore.close is a no-op on it)
    } finally {
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("surreal branch: bundle carries a WORKING cardStore", { skip: !SURREAL_UP }, async () => {
    const bundle = await surrealBundle();
    assert.ok(bundle, "bundle");
    try {
      const card: Card = {
        id: "knowledge:kp13a-bundle-surreal",
        kind: "knowledge",
        content: "surreal bundle-joined cardStore round-trips",
        frontmatter: { id: "knowledge:kp13a-bundle-surreal" },
      };
      await bundle.cardStore.upsertCard(card);
      const got = await bundle.cardStore.getCard(card.id);
      assert.ok(got, "bundle.cardStore round-trip (surreal)");
      assert.equal(got.content, card.content);
      await bundle.cardStore.deleteCard(card.id);
    } finally {
      await bundle.backend.close();
    }
  });

  it("fallback: unreachable surreal → sqlite bundle still carries a working cardStore", async () => {
    const mem = mkdtempSync(join(tmpdir(), "card-store-bundle-fallback-"));
    try {
      const { bundle, fellBackTo } = await createBackendBundleWithFallback(
        baseConfig({ dbBackend: "surrealdb", surreal: { endpoint: "http://127.0.0.1:59999" } }),
        mem,
      );
      assert.equal(fellBackTo, "sqlite", "fell back to sqlite");
      const card: Card = {
        id: "knowledge:kp13a-fallback",
        kind: "knowledge",
        content: "fallback bundle cardStore works",
        frontmatter: { id: "knowledge:kp13a-fallback" },
      };
      await bundle.cardStore.upsertCard(card);
      const got = await bundle.cardStore.getCard(card.id);
      assert.ok(got, "fallback bundle.cardStore round-trip");
      await bundle.backend.close();
    } finally {
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("hot-swap re-bundle: a fresh bundle's cardStore sees the SAME rows (same dir)", async () => {
    const mem = mkdtempSync(join(tmpdir(), "card-store-bundle-swap-"));
    try {
      const bundle1 = await createBackendBundle(baseConfig({ dbBackend: "sqlite" }), mem);
      const card: Card = {
        id: "knowledge:kp13a-swap",
        kind: "knowledge",
        content: "survives a re-bundle (live backend swap's build step)",
        frontmatter: { id: "knowledge:kp13a-swap" },
      };
      await bundle1.cardStore.upsertCard(card);
      await bundle1.backend.close();

      // switchTo builds a whole new bundle; the new cardStore must follow.
      const bundle2 = await createBackendBundle(baseConfig({ dbBackend: "sqlite" }), mem);
      const got = await bundle2.cardStore.getCard(card.id);
      assert.ok(got, "re-bundled cardStore sees the pre-swap row");
      assert.equal(got.content, card.content);
      await bundle2.backend.close();
    } finally {
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
