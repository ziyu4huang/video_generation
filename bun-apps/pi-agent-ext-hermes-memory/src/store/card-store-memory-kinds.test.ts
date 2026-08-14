// src/store/card-store-memory-kinds.test.ts — C5-lite golden round-trip for
// the memory kinds (memory/user/failure) through the CardStore façade.
//
// Two invariants per kind, mirroring the planning golden style from #1343
// (planning-serializer.test.ts):
//  1. Serializer fixed point — s1 = serialize(deserialize(md)); s2 =
//     serialize(deserialize(s1)); s1 === s2 byte-for-byte (the section-md
//     codec is unchanged by enabling persistence).
//  2. card-store round-trip — the deserialized Card upserts (persistence is
//     ENABLED for memory kinds as of C5-lite), and getCard / getCardsByKind
//     read back id/kind/content/frontmatter exactly (deep-equal envelope).
//
// C5-lite scope note: persistence is enabled but the WRITE PATH is NOT
// switched — MemoryStore remains the memory write path until kp ticket 13.
// These tests pin the substrate 13 will switch onto.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCardStore } from "./card-store.js";
import { MemorySerializer } from "./memory-serializer.js";
import type { Card, CardKind } from "./card.js";

/** Representative section-md fixtures per memory kind (frontmatter shape; the
 *  failure kind carries the state/severity keys its decode path normalizes). */
const FIXTURES: Record<"memory" | "user" | "failure", string> = {
  memory: [
    "---",
    'id: "mem-c5-golden"',
    'created: "2026-08-15"',
    'last: "2026-08-15"',
    "provenance: verified",
    "---",
    "Prefers native MLX pipelines over CUDA forks on Apple Silicon.",
  ].join("\n"),
  user: [
    "---",
    'id: "user-c5-golden"',
    'created: "2026-08-15"',
    'last: "2026-08-16"',
    "pin: true",
    "---",
    "User works in zh-TW and wants written artifacts in English.",
  ].join("\n"),
  failure: [
    "---",
    'id: "failure-c5-golden"',
    'created: "2026-08-15"',
    'last: "2026-08-15"',
    "state: resolved",
    "severity: 2",
    "---",
    "bun install from the repo root silently diverges from bun-apps/bun.lock.",
  ].join("\n"),
};

function withStore(
  fn: (store: Awaited<ReturnType<typeof createCardStore>>) => Promise<void>,
): Promise<void> {
  const mem = mkdtempSync(join(tmpdir(), "card-store-memory-kinds-"));
  return (async () => {
    const store = await createCardStore({ memoryDir: mem });
    try {
      await fn(store);
    } finally {
      await store.close();
      rmSync(mem, { recursive: true, force: true });
    }
  })();
}

describe("golden round-trip: memory/user/failure through card-store (C5-lite)", () => {
  for (const kind of ["memory", "user", "failure"] as const) {
    it(`kind "${kind}" serializer fixed point + card-store persistence round-trip`, async () => {
      const ser = new MemorySerializer(kind);

      // 1. Serializer fixed point (byte-identity, mirrors the #1343 goldens).
      const [c1] = ser.deserialize(FIXTURES[kind]);
      assert.ok(c1, "fixture deserializes to one card");
      const s1 = ser.serialize(c1);
      const [c2] = ser.deserialize(s1);
      assert.ok(c2, "fixed-point pass deserializes");
      assert.equal(ser.serialize(c2), s1, "serialize(deserialize(s1)) === s1 byte-for-byte");
      assert.equal(c2.kind, kind);

      // 2. card-store round-trip: upsert → getCard/getCardsByKind → identity.
      await withStore(async (store) => {
        await store.upsertCard(c1);

        const got = await store.getCard(c1.id);
        assert.ok(got, "getCard returned the row");
        assertCardEquals(got, c1);

        const list = await store.getCardsByKind(kind as CardKind);
        const listed = list.find((c) => c.id === c1.id);
        assert.ok(listed, "card present in getCardsByKind");
        assertCardEquals(listed, c1);

        // Dedup guard: the SAME card upserted again must not insert a second
        // row (MemoryDedupStrategy exact stripped-equality → skip).
        await store.upsertCard(c1);
        const afterDedup = await store.getCardsByKind(kind as CardKind);
        assert.equal(afterDedup.filter((c) => c.id === c1.id).length, 1);
      });
    });
  }
});

/** Field-wise identity assert (avoids deepStrictEqual's absent-vs-undefined
 *  `graph` key asymmetry between deserialize output and rowToCard output). */
function assertCardEquals(actual: Card, expected: Card): void {
  assert.equal(actual.id, expected.id);
  assert.equal(actual.kind, expected.kind);
  assert.equal(actual.content, expected.content);
  assert.deepEqual(actual.frontmatter, expected.frontmatter);
}
