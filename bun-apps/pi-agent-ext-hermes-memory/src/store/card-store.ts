/**
 * card-store.ts — the kind-agnostic Card store façade (06a task 5).
 *
 * A THIN additive surface over the existing SQLite backend. It owns the
 * knowledge-card round-trip into the `memories` table directly (via the
 * concrete `SqliteBackend` handle) and dispatches dedup per-kind through the
 * registered `DedupStrategy`. It does NOT replace `MemoryStore`'s memory path
 * — memory/user/failure cards keep their proven section-md + MemoryStore path
 * byte-for-byte unchanged. C5-lite ENABLES memory-kind persistence here
 * (persistableKinds) so kp ticket 13 is a pure write-path switch; MemoryStore
 * stays the memory write path until 13 flips it. `sqlite-memory-repo.ts` is
 * intentionally left untouched (the knowledge SQL lives here) to guarantee
 * zero memory-path drift.
 *
 * 06a scope:
 *  - `upsertCard`/`getCard`/`getCardsByKind` are exercised on kind "knowledge".
 *  - SurrealDB knowledge persistence is a no-op placeholder (06a is SQLite-only
 *    for knowledge): `createCardStore` throws a clear error for non-sqlite
 *    backends rather than silently no-op'ing.
 *  - `Card.embed` is NOT persisted/indexed here (04/06b); it round-trips as
 *    `undefined` through the SQLite path. `Card.graph` IS persisted (03): a
 *    nullable `graph` JSON column next to `frontmatter`.
 */

import { runWithTransientRetry } from "./sqlite/sqlite-backend.js";
import { createSqliteBackend } from "./backend-factory.js";
import type { Card, CardKind, CardGraph } from "./card.js";
import type { CardSerializer } from "./card-serializer.js";
import type { DedupStrategy } from "./dedup-strategy.js";
import { MemorySerializer } from "./memory-serializer.js";
import { KnowledgeSerializer } from "./knowledge-serializer.js";
import { ImageSerializer } from "./image-serializer.js";
import { PlanningEffortSerializer } from "./planning-serializer.js";
import { PlanningTicketSerializer } from "./planning-serializer.js";
import { MemoryDedupStrategy } from "./memory-dedup.js";
import { KnowledgeDedupStrategy } from "./knowledge-dedup.js";
import { PlanningEffortDedupStrategy } from "./planning-dedup.js";
import { PlanningTicketDedupStrategy } from "./planning-dedup.js";
import { today } from "./memory-format.js";

export interface CardStore {
  /** Idempotent upsert of one Card through the per-kind dedup strategy.
   *  `keep` → INSERT; `skip`/`merge` → no-op in 06a (memory `merge` is already
   *  handled by the existing MemoryStore consolidation path; knowledge `merge`
   *  is a 06b concern). */
  upsertCard(card: Card): Promise<void>;
  /** 09-impl: Tier-1 md-wins refresh — UPDATE an EXISTING card's content +
   *  frontmatter (NOT a new row). Bypasses dedup (pure identity cannot express
   *  "update"; the sync-layer hash-compare decides WHEN to call this). */
  updateCard(card: Card): Promise<void>;
  /** 09-impl: hard-delete a card row by Card.id (md-wins reconciliation — the
   *  source md vanished). Also paired with deleteCardMdHash by the sweep. */
  deleteCard(id: string): Promise<void>;
  /** Fetch the Card whose canonical id (`memories.md_id`) equals `id`, or null. */
  getCard(id: string): Promise<Card | null>;
  /** All Cards of one kind (`memories.target` = kind). */
  getCardsByKind(kind: CardKind): Promise<Card[]>;
  /** The registered serializer for a kind (spec §7 registry). The 06a SQLite
   *  path stores `Card.frontmatter` as JSON directly and does not invoke it;
   *  exposed for the 06b orchestrator's disk-read path. */
  serializerFor(kind: CardKind): CardSerializer | undefined;
  /** 09-impl: read the stored content-hash row for a card (by Card.id), or null. */
  getCardMdHash(cardId: string): Promise<{ hash: string; mirroredAt: string; kind: string } | null>;
  /** 09-impl: UPSERT a content-hash row (SQLite ON CONFLICT DO UPDATE). */
  upsertCardMdHash(cardId: string, hash: string, kind?: string): Promise<void>;
  /** 09-impl: delete the content-hash row for a card. */
  deleteCardMdHash(cardId: string): Promise<void>;
  /** 10-impl: read the stored dep-aggregate baseline hash for a card, or null. */
  getCardDepHash(cardId: string): Promise<{ depHash: string; validatedAt: string } | null>;
  /** 10-impl: UPSERT a dep-aggregate baseline hash (SQLite ON CONFLICT DO UPDATE). */
  upsertCardDepHash(cardId: string, depHash: string): Promise<void>;
  /** 10-impl: delete the dep-aggregate baseline hash for a card. */
  deleteCardDepHash(cardId: string): Promise<void>;
  /** Close the backing backend (release the SQLite handle). */
  close(): Promise<void>;
}

export interface CreateCardStoreOptions {
  memoryDir: string;
  /** Backend selector. 06a exercises "sqlite"; "surrealdb" is rejected
   *  (knowledge persistence on Surreal is a 03/04/06b placeholder). */
  dbBackend?: "sqlite";
}

/** Columns the façade reads/maps for a Card. `frontmatter` is the 06a JSON
 *  envelope (knowledge only; NULL for memory kinds). `graph` is the 03
 *  Card.graph JSON (links/entities/relations; NULL when a card has none). */
const CARD_SELECT_COLUMNS = "target, md_id, content, frontmatter, graph";

type CardRow = {
  target: string;
  md_id: string | null;
  content: string;
  frontmatter: string | null;
  graph: string | null;
};

/** Map a `memories` row → Card. `frontmatter` JSON is decoded for knowledge
 *  rows; for memory kinds (NULL in 06a) a minimal envelope keeps the Card
 *  well-formed — the memory path is read by MemoryStore, not this façade.
 *  `graph` JSON is decoded when present; NULL maps to `undefined` (nullable). */
function rowToCard(row: CardRow): Card {
  let frontmatter: Record<string, unknown>;
  if (row.frontmatter) {
    try {
      const parsed = JSON.parse(row.frontmatter);
      frontmatter =
        parsed !== null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : { id: row.md_id };
    } catch {
      frontmatter = { id: row.md_id };
    }
  } else {
    frontmatter = { id: row.md_id };
  }
  let graph: CardGraph | undefined;
  if (row.graph) {
    try {
      const parsed = JSON.parse(row.graph);
      graph =
        parsed !== null && typeof parsed === "object"
          ? (parsed as CardGraph)
          : undefined;
    } catch {
      graph = undefined;
    }
  }
  return {
    id: row.md_id!,
    kind: row.target as CardKind,
    content: row.content,
    frontmatter,
    graph,
  };
}

export async function createCardStore(options: CreateCardStoreOptions): Promise<CardStore> {
  const dbBackend = options.dbBackend ?? "sqlite";
  if (dbBackend !== "sqlite") {
    throw new Error(
      `createCardStore (06a) supports only the sqlite backend for knowledge rows (got "${dbBackend}"); ` +
        "SurrealDB knowledge persistence is a 03/04/06b placeholder.",
    );
  }

  // Construct the backend through the C5-lite factory seam — the sole
  // sanctioned construction path (see `createSqliteBackend` in
  // backend-factory.ts; the sole-source gate bans the raw SqliteBackend
  // constructor outside the factory). The factory returns the CONCRETE handle this façade's SQL
  // needs (getDb / withCorruptionRecovery — on the class, not the `Backend`
  // interface) without requiring a MemoryConfig, which is exactly the
  // documented rationale for constructing directly; the seam satisfies it
  // instead of overriding it.
  const backend = await createSqliteBackend(options.memoryDir);

  // Per-kind registries (spec §7). One serializer per kind; the memory dedup
  // strategy is kind-agnostic in logic, so one instance covers memory/user/
  // failure. The dedup registry IS used by upsertCard; the serializer registry
  // is exposed via serializerFor (06b's disk-read path consumes it).
  // C5-lite note: memory/user/failure persistence reuses the ALREADY-
  // registered `MemoryDedupStrategy` verbatim (exact stripped-equality →
  // near-dup containment → topic-recurrence merge; identity-based, mirroring
  // the MemorySerializer/MemoryStore semantics) — no new dedup semantics.
  const serializers = new Map<CardKind, CardSerializer>([
    ["memory", new MemorySerializer("memory")],
    ["user", new MemorySerializer("user")],
    ["failure", new MemorySerializer("failure")],
    ["knowledge", new KnowledgeSerializer()],
    ["planning-effort", new PlanningEffortSerializer()],
    ["planning-ticket", new PlanningTicketSerializer()],
    ["image", new ImageSerializer()],
  ]);
  const memoryDedup = new MemoryDedupStrategy();
  const dedupStrategies = new Map<CardKind, DedupStrategy>([
    ["memory", memoryDedup],
    ["user", memoryDedup],
    ["failure", memoryDedup],
    ["knowledge", new KnowledgeDedupStrategy()],
    ["planning-effort", new PlanningEffortDedupStrategy()],
    ["planning-ticket", new PlanningTicketDedupStrategy()],
    ["image", new KnowledgeDedupStrategy()],
  ]);

  const getDb = () => backend.getDb();

  /** Read all Cards of one target kind, wrapped in the same retry/recovery
   *  envelope as `SqliteMemoryRepository`'s reads. */
  function fetchCardsByTarget(target: string): Promise<Card[]> {
    return runWithTransientRetry(() =>
      backend.withCorruptionRecovery(() => {
        const rows = getDb()
          .prepare(
            `SELECT ${CARD_SELECT_COLUMNS} FROM memories WHERE target = ? AND md_id IS NOT NULL ORDER BY id`,
          )
          .all(target) as CardRow[];
        return rows.map(rowToCard);
      }),
    );
  }

  const store: CardStore = {
    async upsertCard(card: Card): Promise<void> {
      const strategy = dedupStrategies.get(card.kind);
      if (!strategy) {
        throw new Error(`createCardStore: no dedup strategy registered for kind "${card.kind}"`);
      }
      const existing = await fetchCardsByTarget(card.kind);
      const decision = strategy.dedup(card, existing);
      // 06a: keep → INSERT; skip/merge → no-op (memory merge is the existing
      // MemoryStore consolidation path; knowledge merge is 06b).
      if (decision.action !== "keep") return;

      // C5-lite: ALL CardKinds are persistable. knowledge/planning-*/image are
      // card-store-managed; memory/user/failure persistence is ENABLED here so
      // kp ticket 13 becomes a pure write-path switch — MemoryStore REMAINS the
      // memory write path until 13 flips it (nothing writes memory kinds through
      // this façade today). The belt below guards against a future CardKind
      // landing here without a serializer/dedup decision.
      const persistableKinds = new Set<CardKind>([
        "memory",
        "user",
        "failure",
        "knowledge",
        "planning-effort",
        "planning-ticket",
        "image",
      ]);
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          if (!persistableKinds.has(card.kind)) {
            throw new Error(
              `createCardStore.upsertCard: kind "${card.kind}" has no persistence decision registered ` +
                "(add a serializer + dedup strategy first).",
            );
          }
          // Card row mapping (spec §7): target=card.kind (knowledge OR planning-*),
          // md_id=Card.id (the join key), content=Card.content,
          // frontmatter=JSON envelope, graph=JSON Card.graph (03; NULL when
          // absent). Memory-specific columns (category/failure_reason/tool_state/
          // corrected_to/supersedes*/mw_*/parent_ids) are NULL; the NOT NULL
          // columns get their defaults (state='active', pin=0, status='active',
          // mw_success/mw_fail=0, created/last_referenced = today).
          getDb()
            .prepare(
              `INSERT INTO memories
                 (project, target, category, content, failure_reason, tool_state, corrected_to,
                  created, last_referenced, mw_success, mw_fail, status, md_id, state, severity, pin, frontmatter, graph)
               VALUES (?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, 0, 0, 'active', ?, 'active', NULL, 0, ?, ?)`,
            )
            .run(
              null,
              card.kind,
              card.content,
              today(),
              today(),
              card.id,
              JSON.stringify(card.frontmatter),
              card.graph ? JSON.stringify(card.graph) : null,
            );
        }),
      );
    },

    async updateCard(card: Card): Promise<void> {
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `UPDATE memories
                 SET content = ?, frontmatter = ?, graph = ?, last_referenced = ?
               WHERE md_id = ?`,
            )
            .run(
              card.content,
              JSON.stringify(card.frontmatter),
              card.graph ? JSON.stringify(card.graph) : null,
              today(),
              card.id,
            );
        }),
      );
    },

    async deleteCard(id: string): Promise<void> {
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb().prepare("DELETE FROM memories WHERE md_id = ?").run(id);
        }),
      );
    },

    getCard(id: string): Promise<Card | null> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          const row = getDb()
            .prepare(`SELECT ${CARD_SELECT_COLUMNS} FROM memories WHERE md_id = ? LIMIT 1`)
            .get(id) as CardRow | undefined;
          return row && row.md_id !== null ? rowToCard(row) : null;
        }),
      );
    },

    getCardsByKind(kind: CardKind): Promise<Card[]> {
      return fetchCardsByTarget(kind);
    },

    serializerFor(kind: CardKind): CardSerializer | undefined {
      return serializers.get(kind);
    },

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

    getCardDepHash(cardId: string): Promise<{ depHash: string; validatedAt: string } | null> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          const row = getDb()
            .prepare("SELECT dep_hash, validated_at FROM card_dep_hash WHERE card_id = ?")
            .get(cardId) as { dep_hash: string; validated_at: string } | undefined;
          return row ? { depHash: row.dep_hash, validatedAt: row.validated_at } : null;
        }),
      );
    },

    upsertCardDepHash(cardId: string, depHash: string): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `INSERT INTO card_dep_hash (card_id, dep_hash, validated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(card_id) DO UPDATE SET
                 dep_hash = excluded.dep_hash,
                 validated_at = excluded.validated_at`,
            )
            .run(cardId, depHash, today());
        }),
      );
    },

    deleteCardDepHash(cardId: string): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb().prepare("DELETE FROM card_dep_hash WHERE card_id = ?").run(cardId);
        }),
      );
    },

    async close(): Promise<void> {
      await backend.close();
    },
  };

  return store;
}
