// src/store/card-store.test.ts — round-trip persistence for the CardStore façade.
//
// TDD red→green for ticket 03 Task 1: `Card.graph` must survive a SQLite
// round-trip (today it drops to `undefined` — see rowToCard/upsertCard/updateCard
// in card-store.ts which only touch `frontmatter`). Mirrors the frontmatter
// pattern: a nullable `graph TEXT` JSON column read/written next to frontmatter.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCardStore } from "./card-store.js";
import { SqliteBackend } from "./sqlite/sqlite-backend.js";
import type { Card, CardGraph } from "./card.js";

describe("CardStore graph round-trip (ticket 03 T1)", () => {
  // A memoryDir per test; clean up after. `createCardStore` constructs a real
  // SqliteBackend on this dir (the same init path the GUI uses).
  function withStore(
    fn: (store: Awaited<ReturnType<typeof createCardStore>>) => Promise<void>,
  ): Promise<void> {
    const mem = mkdtempSync(join(tmpdir(), "card-store-graph-"));
    return (async () => {
      const store = await createCardStore({ memoryDir: mem });
      try {
        await fn(store);
      } finally {
        rmSync(mem, { recursive: true, force: true });
      }
    })();
  }

  const graph: CardGraph = {
    links: ["some-slug"],
    entities: [{ type: "tool", name: "mflux" }],
    relations: [{ s: "a", rel: "references", o: "b" }],
  };

  it("persists Card.graph across an upsert → getCard round-trip", async () => {
    await withStore(async (store) => {
      const card: Card = {
        id: "knowledge:graph-round-trip",
        kind: "knowledge",
        content: "graph must survive the SQLite round-trip",
        frontmatter: { id: "knowledge:graph-round-trip", record_type: "lever" },
        graph,
      };
      await store.upsertCard(card);

      const got = await store.getCard(card.id);
      assert.ok(got, "getCard returned the row");
      assert.deepEqual(got.graph, graph);
    });
  });

  it("persists Card.graph across getCardsByKind (column appears in SELECT)", async () => {
    await withStore(async (store) => {
      const card: Card = {
        id: "knowledge:graph-list",
        kind: "knowledge",
        content: "graph must appear on the list read path too",
        frontmatter: { id: "knowledge:graph-list" },
        graph,
      };
      await store.upsertCard(card);

      const list = await store.getCardsByKind("knowledge");
      const got = list.find((c) => c.id === card.id);
      assert.ok(got, "card present in getCardsByKind");
      assert.deepEqual(got.graph, graph);
    });
  });

  it("keeps Card.graph up to date across updateCard", async () => {
    await withStore(async (store) => {
      const card: Card = {
        id: "knowledge:graph-update",
        kind: "knowledge",
        content: "v1",
        frontmatter: { id: "knowledge:graph-update" },
        graph,
      };
      await store.upsertCard(card);

      const next: Card = { ...card, content: "v2", graph: { links: ["other"] } };
      await store.updateCard(next);

      const got = await store.getCard(card.id);
      assert.ok(got);
      assert.deepEqual(got.graph, { links: ["other"] });
    });
  });

  it("a card with no graph round-trips as undefined (nullable column)", async () => {
    await withStore(async (store) => {
      const card: Card = {
        id: "knowledge:no-graph",
        kind: "knowledge",
        content: "no graph here",
        frontmatter: { id: "knowledge:no-graph" },
        // graph intentionally omitted
      };
      await store.upsertCard(card);

      const got = await store.getCard(card.id);
      assert.ok(got);
      assert.equal(got.graph, undefined);
    });
  });

  it("updateCard with graph omitted NULLs graph — documented current semantics", async () => {
    // NOTE (fix-wave 03 FIX4): this documents the CURRENT md-wins/NULL behavior —
    // updateCard writes the whole row as given, so an absent graph wipes it.
    // Merge semantics (read-modify-write for graph) is deliberately deferred.
    await withStore(async (store) => {
      const card: Card = {
        id: "knowledge:graph-wipe",
        kind: "knowledge",
        content: "v1",
        frontmatter: { id: "knowledge:graph-wipe" },
        graph,
      };
      await store.upsertCard(card);

      const next: Card = {
        id: card.id,
        kind: "knowledge",
        content: "v2",
        frontmatter: card.frontmatter,
        // graph intentionally omitted → UPDATE writes NULL
      };
      await store.updateCard(next);

      const got = await store.getCard(card.id);
      assert.ok(got, "row survives updateCard");
      assert.equal(got.content, "v2");
      assert.equal(got.graph, undefined, "omitted graph NULLs the column (current semantics)");
    });
  });

  it("malformed graph JSON in the row reads back as undefined (no throw)", async () => {
    // FIX5a (fix-wave 03): raw-SQL insert a knowledge row whose `graph` column
    // holds invalid JSON, then read it through the façade — rowToCard's
    // try/catch must map the parse failure to `undefined`, never throw.
    const mem = mkdtempSync(join(tmpdir(), "card-store-badgraph-"));
    try {
      const backend = new SqliteBackend(mem);
      await backend.init();
      backend
        .getDb()
        .prepare(
          `INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to,
             created, last_referenced, mw_success, mw_fail, status, md_id, state, severity, pin, frontmatter, graph)
           VALUES (NULL, 'knowledge', NULL, 'body', NULL, NULL, NULL, ?, ?, 0, 0, 'active', 'knowledge:bad-graph', 'active', NULL, 0, NULL, '{bad')`,
        )
        .run("2026-01-01", "2026-01-01");
      await backend.close();

      const store = await createCardStore({ memoryDir: mem });
      try {
        const got = await store.getCard("knowledge:bad-graph");
        assert.ok(got, "row is readable");
        assert.equal(got.graph, undefined, "malformed graph JSON → undefined, no throw");
      } finally {
        await store.close();
      }
    } finally {
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
