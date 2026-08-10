### Task 2: content-hash + sync-state accessor (pure hash + store accessors)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` (add `getCardMdHash` / `upsertCardMdHash` / `deleteCardMdHash` to the `CardStore` interface + impl)

**Interfaces:**
- Consumes: `Card` from `./card.js`; `hashEntry` from `./merge-plan.js`; `today` from `./memory-format.js`; `CardStore` (extended).
- Produces:
  - `planningContentHash(card: Card): string` — pure; `hashEntry(canonicalCardBytes(card))` (16-hex-char sha256).
  - `getStoredHash(store, cardId)` / `upsertHash(store, cardId, hash, kind='mirror')` / `deleteHash(store, cardId)` — thin wrappers over the new `CardStore` hash accessors.
  - `CardStore.getCardMdHash(cardId)` / `.upsertCardMdHash(cardId, hash, kind)` / `.deleteCardMdHash(cardId)` — the SQL-backed accessors.

**Canonical byte form (PINNED — the exact definition of "what is hashed"):**
```ts
/** Canonical byte form of a Card for content-hashing: a STABLE JSON serialization
 *  of the Tier-1 md-canonical fields (content + frontmatter) + a defensive `kind`.
 *  Frontmatter is a JSON object whose key order is NOT stable across runs, so keys
 *  are sorted recursively (stable stringify). Arrays (e.g. blockedBy) are left in
 *  serializer-determined order (PlanningTicketSerializer builds them deterministically
 *  via parseBlockedBy). Identical cards always hash identically; ANY content or
 *  frontmatter change changes the hash. */
function canonicalCardBytes(card: Card): string {
  return JSON.stringify({
    kind: card.kind,
    content: card.content,
    frontmatter: sortKeysDeep(card.frontmatter),
  });
}

/** Recursive key-sort for deterministic JSON (mirrors the stable-stringify idiom). */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeysDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return value;
}

export function planningContentHash(card: Card): string {
  return hashEntry(canonicalCardBytes(card));
}
```

- [ ] **Step 1: Write the failing test**

Create `src/store/planning-sync-state.test.ts`:
```ts
import { describe, it } from "node:test";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: FAIL — `Cannot find module "./planning-sync-state.js"` (and `getCardMdHash` not on CardStore).

- [ ] **Step 3: Add the hash accessors to CardStore**

In `src/store/card-store.ts`, extend the `CardStore` interface (additive — after `serializerFor`):
```ts
  /** 09-impl: read the stored content-hash row for a card (by Card.id), or null. */
  getCardMdHash(cardId: string): Promise<{ hash: string; mirroredAt: string; kind: string } | null>;
  /** 09-impl: UPSERT a content-hash row (SQLite ON CONFLICT DO UPDATE). */
  upsertCardMdHash(cardId: string, hash: string, kind?: string): Promise<void>;
  /** 09-impl: delete the content-hash row for a card. */
  deleteCardMdHash(cardId: string): Promise<void>;
```
Implement them on the `store` object (same `runWithTransientRetry(() => backend.withCorruptionRecovery(() => …))` envelope as `getCard`/`upsertCard`):
```ts
    getCardMdHash(cardId: string): Promise<{ hash: string; mirroredAt: string; kind: string } | null> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          const row = getDb()
            .prepare("SELECT content_hash, mirrored_at, kind FROM card_md_hash WHERE card_id = ?")
            .get(cardId) as { content_hash: string; mirrored_at: string; kind: string } | undefined;
          return row ? { hash: row.content_hash, mirroredAt: row.mirrored_at, kind: row.kind } : null;
        }),
      );
    },

    upsertCardMdHash(cardId: string, hash: string, kind = "mirror"): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `INSERT INTO card_md_hash (card_id, content_hash, mirrored_at, kind)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(card_id) DO UPDATE SET
                 content_hash = excluded.content_hash,
                 mirrored_at = excluded.mirrored_at,
                 kind = excluded.kind`,
            )
            .run(cardId, hash, today(), kind);
        }),
      );
    },

    deleteCardMdHash(cardId: string): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb().prepare("DELETE FROM card_md_hash WHERE card_id = ?").run(cardId);
        }),
      );
    },
```

- [ ] **Step 4: Write the planning-sync-state module**

Create `src/store/planning-sync-state.ts`:
```ts
// src/store/planning-sync-state.ts — pure content-hash + thin sync-state accessors
// for the .planning card mirror (Phase-2 / ticket 09, Tier-1 md-wins drift).
//
// The DB SQL lives on CardStore (getCardMdHash/upsertCardMdHash/deleteCardMdHash,
// implemented in card-store.ts alongside all other memories/card SQL — the single
// SQL home). This module owns the PURE hash function (planningContentHash, reusing
// merge-plan.hashEntry) + the sync-layer wrappers the mirror/sweep/refresh code
// imports. Hash = 16-hex-char sha256 of canonicalCardBytes(card), keyed by Card.id.
import type { Card } from "./card.js";
import type { CardStore } from "./card-store.js";
import { hashEntry } from "./merge-plan.js";

/** See "Canonical byte form" in the plan: stable JSON of {kind, content, frontmatter}
 *  with recursively-sorted keys. Identical cards hash identically; any content or
 *  frontmatter change changes the hash. */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeysDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return value;
}

function canonicalCardBytes(card: Card): string {
  return JSON.stringify({
    kind: card.kind,
    content: card.content,
    frontmatter: sortKeysDeep(card.frontmatter),
  });
}

/** Content-hash of a planning card (reuses merge-plan.hashEntry: sha256 → 16 hex). */
export function planningContentHash(card: Card): string {
  return hashEntry(canonicalCardBytes(card));
}

/** Read the stored mirror hash for a card, or null when none has been written. */
export async function getStoredHash(
  store: CardStore,
  cardId: string,
): Promise<{ hash: string; mirroredAt: string; kind: string } | null> {
  return store.getCardMdHash(cardId);
}

/** UPSERT the mirror hash for a card (default kind='mirror'; 10 uses 'validated'). */
export async function upsertHash(
  store: CardStore,
  cardId: string,
  hash: string,
  kind = "mirror",
): Promise<void> {
  await store.upsertCardMdHash(cardId, hash, kind);
}

/** Delete the hash row for a card (paired with hard-delete of the memories row). */
export async function deleteHash(store: CardStore, cardId: string): Promise<void> {
  await store.deleteCardMdHash(cardId);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: PASS.

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning content-hash + sync-state accessors (09-impl T2)"
```

**DoD:** `planningContentHash` is deterministic (key-order-invariant), 16-hex; the 3 store accessors round-trip against `card_md_hash`; full suite green.

---

