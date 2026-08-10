import { after, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  planningContentHash,
  getStoredHash,
  upsertHash,
  deleteHash,
  refreshPlanningCard,
  refreshIfStale,
} from "./planning-sync-state.js";
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

describe("refreshPlanningCard — 08→09 migration cohort (09-impl final review B)", () => {
  it("UPDATEs an existing-but-unhashed card (drift), returning {action:'updated'}", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmig2-B-"));
    const mem = mkdtempSync(join(tmpdir(), "pmig2-B-mem-"));
    try {
      const effort = "mig2-eff";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      const id = `planning-ticket:${effort}:01`;
      // Pre-seed an 08-era row directly: OLD content, NO card_md_hash row
      // (stored===null — true for every existing planning card on first 09
      // touch). existing≠null + stored===null is the migration cohort the
      // existing T7 tests cannot reach (they hit UPDATE only via stored≠null).
      const store0 = await createCardStore({ memoryDir: mem });
      await store0.upsertCard({
        id,
        kind: "planning-ticket",
        content: "OLD 08-era body.",
        frontmatter: { id: "01", slug: "x", status: "closed" },
      });
      await store0.close();
      // Source md has DRIFTED to new (current) content relative to the DB row.
      writeFileSync(
        ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nNEW 09-era body.\n",
      );
      const store = await createCardStore({ memoryDir: mem });
      try {
        const r = await refreshPlanningCard(store, id, root);
        assert.equal(r.action, "updated", "existing-but-unhashed card must UPDATE, not insert-no-op");
        const c = await store.getCard(id);
        assert.match(c?.content ?? "", /NEW 09-era body\./, "DB row updated to current md");
        assert.doesNotMatch(c?.content ?? "", /OLD 08-era body\./, "08-era content must be overwritten");
        const hash = await store.getCardMdHash(id);
        assert.ok(hash, "hash seeded on first 09 touch");
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});

describe("refreshPlanningCard (09-impl T7)", () => {
  const root = mkdtempSync(join(tmpdir(), "prefresh-"));
  const mem = mkdtempSync(join(tmpdir(), "prefresh-mem-"));
  const effort = "refresh-eff";
  const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
  const id = `planning-ticket:${effort}:01`;

  it("inserts when no stored card exists", async () => {
    mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
    writeFileSync(ticketPath, "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nFirst.\n");
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "inserted");
    } finally {
      await store.close();
    }
  });

  it("updates when the source md changed (drift)", async () => {
    writeFileSync(ticketPath, "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nEDITED.\n");
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "updated");
      const c = await store.getCard(id);
      assert.match(c?.content ?? "", /EDITED\./);
    } finally {
      await store.close();
    }
  });

  it("is unchanged (no write) when the source md is the same", async () => {
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "unchanged");
      assert.equal(await refreshIfStale(store, id, root), false);
    } finally {
      await store.close();
    }
  });

  it("returns {action:'absent'} when the source md vanished (caller may delete)", async () => {
    rmSync(ticketPath);
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal((r as { action: string }).action, "absent");
    } finally {
      await store.close();
    }
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(mem, { recursive: true, force: true });
  });
});
