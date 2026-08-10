import { after, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planningContentHash, getStoredHash, upsertHash, deleteHash } from "./planning-sync-state.js";
import { createCardStore } from "./card-store.js";
import type { Card } from "./card.js";

const card = (overrides: Partial<Card> = {}): Card => ({
  id: "planning-ticket:e:01",
  kind: "planning-ticket",
  content: "body",
  frontmatter: { id: "01", slug: "x", status: "closed" },
  ...overrides,
});

describe("planningContentHash", () => {
  it("is deterministic for identical content + frontmatter", () => {
    assert.equal(planningContentHash(card()), planningContentHash(card()));
  });
  it("is 16 hex chars (hashEntry width)", () => {
    assert.match(planningContentHash(card()), /^[0-9a-f]{16}$/);
  });
  it("changes when content changes", () => {
    assert.notEqual(planningContentHash(card()), planningContentHash(card({ content: "edited" })));
  });
  it("is invariant to frontmatter key ORDER (stable stringify)", () => {
    const a = card({ frontmatter: { id: "01", slug: "x", status: "closed" } });
    const b = card({ frontmatter: { status: "closed", slug: "x", id: "01" } });
    assert.equal(planningContentHash(a), planningContentHash(b));
  });
  it("changes when a frontmatter VALUE changes", () => {
    assert.notEqual(
      planningContentHash(card()),
      planningContentHash(card({ frontmatter: { id: "01", slug: "x", status: "open" } })),
    );
  });
});

describe("card_md_hash round-trip (via CardStore accessors)", () => {
  const dir = mkdtempSync(join(tmpdir(), "planning-hash-rt-"));
  it("getStoredHash returns null when absent", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      assert.equal(await getStoredHash(store, "planning-ticket:e:01"), null);
    } finally {
      await store.close();
    }
  });
  it("upsertHash then getStoredHash round-trips (default kind='mirror')", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      await upsertHash(store, "planning-ticket:e:01", "abc123def456abcd");
      const got = await getStoredHash(store, "planning-ticket:e:01");
      assert.equal(got?.hash, "abc123def456abcd");
      assert.equal(got?.kind, "mirror");
      assert.ok(got?.mirroredAt);
    } finally {
      await store.close();
    }
  });
  it("upsertHash is idempotent UPSERT (re-write overwrites hash + mirrored_at)", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      await upsertHash(store, "planning-ticket:e:01", "firsthash0000000");
      await upsertHash(store, "planning-ticket:e:01", "secondhash0000000", "mirror");
      const got = await getStoredHash(store, "planning-ticket:e:01");
      assert.equal(got?.hash, "secondhash0000000");
    } finally {
      await store.close();
    }
  });
  it("deleteHash removes the row", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      await deleteHash(store, "planning-ticket:e:01");
      assert.equal(await getStoredHash(store, "planning-ticket:e:01"), null);
    } finally {
      await store.close();
    }
  });
  // Best-effort cleanup AFTER the round-trip suite shares one dir.
  after(() => rmSync(dir, { recursive: true, force: true }));
});
