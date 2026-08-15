/**
 * card-store.ts — the kind-agnostic Card store façade (06a task 5).
 *
 * A THIN additive surface over the active backend. It owns the knowledge-card
 * round-trip into the `memories` table and dispatches dedup per-kind through
 * the registered `DedupStrategy`. It does NOT replace `MemoryStore`'s memory
 * path — memory/user/failure cards keep their proven section-md + MemoryStore
 * path byte-for-byte unchanged. C5-lite ENABLES memory-kind persistence here
 * (persistableKinds) so kp ticket 13 is a pure write-path switch; MemoryStore
 * stays the memory write path until 13 flips it. `sqlite-memory-repo.ts` is
 * intentionally left untouched (the knowledge SQL lives here) to guarantee
 * zero memory-path drift.
 *
 * kp13 Wave A — dual-backend. Persistence lives behind an internal
 * `CardPersistence` seam with two implementations:
 *  - sqlite: the original 06a SQL against the concrete `SqliteBackend` handle
 *    (via the C5-lite factory seam — the sole sanctioned construction path);
 *  - surrealdb: built ON TOP of `SurrealMemoryRepository` — insert rides
 *    `addMemory` (so the C6 exact-dup dedup is inherited: same
 *    target+project+category+content returns the existing row, no duplicate),
 *    then stamps the card envelope (frontmatter/graph JSON) as SCHEMALESS
 *    free columns; read/update/delete go through the card-seam methods on the
 *    concrete repo. NO new Surreal record types are introduced.
 *
 * Backend-scoped surface, honestly documented:
 *  - `get/upsert/deleteCardMdHash` + `get/upsert/deleteCardDepHash` are
 *    SQLite-only (the `card_md_hash` / `card_dep_hash` tables have no Surreal
 *    schema). On the surreal branch they THROW a documented error instead of
 *    silently no-op'ing (the least-lie option): callers are the Tier-1
 *    planning mirrors, which are sqlite-scoped today.
 *
 * 06a scope still standing:
 *  - `upsertCard`/`getCard`/`getCardsByKind` are exercised on kind "knowledge".
 *  - `Card.embed` is NOT persisted/indexed here (04/06b); it round-trips as
 *    `undefined` through the SQLite path. `Card.graph` IS persisted (03): a
 *    nullable `graph` JSON column next to `frontmatter` (sqlite) / a free
 *    column (surreal).
 */

import { runWithTransientRetry } from "./sqlite/sqlite-backend.js";
import { createSqliteBackend } from "./backend-factory.js";
import type { SqliteBackend } from "./sqlite/sqlite-backend.js";
import type { SurrealMemoryRepository, SurrealCardRow } from "./surreal/surreal-memory-repo.js";
import type { MemoryTarget } from "./repository.js";
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
   *  is a 06b concern). On surreal the insert additionally rides addMemory's
   *  C6 exact-dup dedup (target+project+category+content). */
  upsertCard(card: Card): Promise<void>;
  /** 09-impl: Tier-1 md-wins refresh — UPDATE an EXISTING card's content +
   *  frontmatter (NOT a new row). Bypasses dedup (pure identity cannot express
   *  "update"; the sync-layer hash-compare decides WHEN to call this). */
  updateCard(card: Card): Promise<void>;
  /** 09-impl: hard-delete a card row by Card.id (md-wins reconciliation — the
   *  source md vanished). Also paired with deleteCardMdHash by the sweep. */
  deleteCard(id: string): Promise<void>;
  /** Fetch the Card whose canonical id (`memories.md_id` / surreal `mdId`)
   *  equals `id`, or null. */
  getCard(id: string): Promise<Card | null>;
  /** All Cards of one kind (`memories.target` = kind). */
  getCardsByKind(kind: CardKind): Promise<Card[]>;
  /** The registered serializer for a kind (spec §7 registry). The 06a SQLite
   *  path stores `Card.frontmatter` as JSON directly and does not invoke it;
   *  exposed for the 06b orchestrator's disk-read path. */
  serializerFor(kind: CardKind): CardSerializer | undefined;
  /** 09-impl: read the stored content-hash row for a card (by Card.id), or null.
   *  SQLITE-ONLY (`card_md_hash` table) — throws on the surreal branch. */
  getCardMdHash(cardId: string): Promise<{ hash: string; mirroredAt: string; kind: string } | null>;
  /** 09-impl: UPSERT a content-hash row (SQLite ON CONFLICT DO UPDATE).
   *  SQLITE-ONLY (`card_md_hash` table) — throws on the surreal branch. */
  upsertCardMdHash(cardId: string, hash: string, kind?: string): Promise<void>;
  /** 09-impl: delete the content-hash row for a card.
   *  SQLITE-ONLY (`card_md_hash` table) — throws on the surreal branch. */
  deleteCardMdHash(cardId: string): Promise<void>;
  /** 10-impl: read the stored dep-aggregate baseline hash for a card, or null.
   *  SQLITE-ONLY (`card_dep_hash` table) — throws on the surreal branch. */
  getCardDepHash(cardId: string): Promise<{ depHash: string; validatedAt: string } | null>;
  /** 10-impl: UPSERT a dep-aggregate baseline hash (SQLite ON CONFLICT DO UPDATE).
   *  SQLITE-ONLY (`card_dep_hash` table) — throws on the surreal branch. */
  upsertCardDepHash(cardId: string, depHash: string): Promise<void>;
  /** 10-impl: delete the dep-aggregate baseline hash for a card.
   *  SQLITE-ONLY (`card_dep_hash` table) — throws on the surreal branch. */
  deleteCardDepHash(cardId: string): Promise<void>;
  /** Release resources owned by THIS store. When the store was built on a
   *  bundle-provided backend (or the stateless surreal backend) this is a
   *  no-op — the backend's lifecycle belongs to the owner. */
  close(): Promise<void>;
}

export interface CreateCardStoreOptions {
  memoryDir: string;
  /** Backend selector (default "sqlite"). kp13 Wave A adds "surrealdb"
   *  (implemented over SurrealMemoryRepository). */
  dbBackend?: "sqlite" | "surrealdb";
  /** Bundle-join path (sqlite): reuse the bundle's already-initialized
   *  concrete backend instead of opening another handle on memoryDir. The
   *  store then does NOT own it (close() is a no-op — the bundle closes it). */
  sqliteBackend?: SqliteBackend;
  /** Surreal branch: the concrete repo the card persistence is built on
   *  (required when dbBackend === "surrealdb"). */
  surrealRepo?: SurrealMemoryRepository;
}

// ---------------------------------------------------------------------------
// Internal persistence seam (kp13 Wave A). One implementation per backend;
// `createCardStore` composes the shared per-kind registries + dedup flow on
// top. This interface is deliberately NOT exported — callers go through the
// `CardStore` façade.
// ---------------------------------------------------------------------------

interface CardPersistence {
  /** Post-dedup INSERT of a new card row. */
  insertCard(card: Card): Promise<void>;
  /** UPDATE an existing card row by Card.id (content + envelope). */
  updateCard(card: Card): Promise<void>;
  /** DELETE the card row by Card.id. */
  deleteCard(id: string): Promise<void>;
  /** One card by Card.id, or null. */
  getCard(id: string): Promise<Card | null>;
  /** All cards of one kind. */
  getCardsByKind(kind: CardKind): Promise<Card[]>;
  /** md/dep-hash accessors — SQLite-only schema; the surreal implementation
   *  throws the documented SQLITE_ONLY error. */
  getCardMdHash(cardId: string): Promise<{ hash: string; mirroredAt: string; kind: string } | null>;
  upsertCardMdHash(cardId: string, hash: string, kind?: string): Promise<void>;
  deleteCardMdHash(cardId: string): Promise<void>;
  getCardDepHash(cardId: string): Promise<{ depHash: string; validatedAt: string } | null>;
  upsertCardDepHash(cardId: string, depHash: string): Promise<void>;
  deleteCardDepHash(cardId: string): Promise<void>;
}

/** The documented sqlite-only exception for the md/dep-hash accessors on the
 *  surreal branch (least-lie option: a loud error beats a silent no-op). */
const SQLITE_ONLY = (op: string): Error =>
  new Error(
    `card-store.${op}: the card_md_hash / card_dep_hash tables are SQLite-only schema; ` +
      "this store is on the surrealdb backend and the Tier-1 planning mirrors that use " +
      "these accessors are sqlite-scoped today.",
  );

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

/** Map a surreal card-seam row → Card through the shared rowToCard (same
 *  envelope decoding; field-name adapter mdId→md_id). */
function surrealRowToCard(row: SurrealCardRow): Card {
  return rowToCard({
    target: row.target,
    md_id: row.mdId,
    content: row.content,
    frontmatter: row.frontmatter,
    graph: row.graph,
  });
}

/** kp13 Wave B: memory-kind envelope → `memories` row columns. The card
 *  envelope (serializer-derived from the canonical §-md bytes) is the mirror's
 *  payload; the `state`/`severity`/`pin` COLUMNS must track it so repo-seam
 *  readers (`MemoryEntry.state` via getMemories/searchMemories) stay faithful
 *  instead of seeing the INSERT defaults. Absent envelope fields fall back to
 *  the schema defaults; non-memory kinds never carry these envelope fields, so
 *  their derived values equal the insert defaults (idempotent on update). */
function envelopeMemoryColumns(card: Card): {
  state: string;
  severity: number | null;
  pin: number;
} {
  const fm = card.frontmatter as Record<string, unknown> | null | undefined;
  const state = typeof fm?.state === "string" && fm.state ? fm.state : "active";
  const severity = typeof fm?.severity === "number" ? fm.severity : null;
  const pin = fm?.pin === true ? 1 : 0;
  return { state, severity, pin };
}

// ---------------------------------------------------------------------------
// SQLite implementation — the 06a SQL, moved verbatim behind the seam.
// ---------------------------------------------------------------------------

function createSqliteCardPersistence(backend: SqliteBackend): CardPersistence {
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

  return {
    async insertCard(card: Card): Promise<void> {
      // Card row mapping (spec §7): target=card.kind (knowledge OR planning-*),
      // md_id=Card.id (the join key), content=Card.content,
      // frontmatter=JSON envelope, graph=JSON Card.graph (03; NULL when
      // absent). Memory-specific columns (category/failure_reason/tool_state/
      // corrected_to/supersedes*/mw_*/parent_ids) are NULL; the NOT NULL
      // columns get their defaults EXCEPT state/severity/pin, which track the
      // memory-kind envelope (kp13 Wave B — see envelopeMemoryColumns).
      const mem = envelopeMemoryColumns(card);
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `INSERT INTO memories
                 (project, target, category, content, failure_reason, tool_state, corrected_to,
                  created, last_referenced, mw_success, mw_fail, status, md_id, state, severity, pin, frontmatter, graph)
               VALUES (?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, 0, 0, 'active', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              null,
              card.kind,
              card.content,
              today(),
              today(),
              card.id,
              mem.state,
              mem.severity,
              mem.pin,
              JSON.stringify(card.frontmatter),
              card.graph ? JSON.stringify(card.graph) : null,
            );
        }),
      );
    },

    async updateCard(card: Card): Promise<void> {
      const mem = envelopeMemoryColumns(card);
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `UPDATE memories
                 SET content = ?, frontmatter = ?, graph = ?, last_referenced = ?,
                     state = ?, severity = ?, pin = ?
               WHERE md_id = ?`,
            )
            .run(
              card.content,
              JSON.stringify(card.frontmatter),
              card.graph ? JSON.stringify(card.graph) : null,
              today(),
              mem.state,
              mem.severity,
              mem.pin,
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
  };
}

// ---------------------------------------------------------------------------
// Surreal implementation — built ON TOP of SurrealMemoryRepository (kp13 Wave
// A). Insert rides addMemory (C6 exact-dup dedup inherited: same
// target+project+category+content returns the EXISTING row — no duplicate),
// then stamps the card envelope as SCHEMALESS free columns (the same
// frontmatter/graph JSON SQLite keeps in dedicated columns). NO new Surreal
// record types. The md/dep-hash accessors throw SQLITE_ONLY (documented).
// Caveat, documented honestly: when C6 returns an existing row written by a
// different flow (e.g. a memory-mirror row with identical content), that
// row keeps ITS mdId — the card is not readable by this card.id. This mirrors
// SQLite (whose INSERT would add a second md_id row); identity collisions
// across flows are the sync layer's concern (Wave B), not the store's.
// ---------------------------------------------------------------------------

function createSurrealCardPersistence(repo: SurrealMemoryRepository): CardPersistence {
  return {
    async insertCard(card: Card): Promise<void> {
      const entry = await repo.addMemory({
        content: card.content,
        // CardKind ⊋ MemoryTarget: Surreal stores target as a plain string;
        // the cast is type-level only (no runtime validation on either side).
        target: card.kind as MemoryTarget,
        mdId: card.id,
      });
      await repo.setCardEnvelopeBySeq(
        Number(entry.id),
        JSON.stringify(card.frontmatter),
        card.graph ? JSON.stringify(card.graph) : null,
      );
    },

    async updateCard(card: Card): Promise<void> {
      await repo.updateCardByMdId(card.id, {
        content: card.content,
        frontmatter: JSON.stringify(card.frontmatter),
        graph: card.graph ? JSON.stringify(card.graph) : null,
      });
    },

    async deleteCard(id: string): Promise<void> {
      await repo.deleteCardByMdId(id);
    },

    async getCard(id: string): Promise<Card | null> {
      const row = await repo.getCardByMdId(id);
      return row && row.mdId !== null ? surrealRowToCard(row) : null;
    },

    async getCardsByKind(kind: CardKind): Promise<Card[]> {
      return (await repo.listCardsByTarget(kind)).map(surrealRowToCard);
    },

    async getCardMdHash(): Promise<null> {
      throw SQLITE_ONLY("getCardMdHash");
    },
    async upsertCardMdHash(): Promise<void> {
      throw SQLITE_ONLY("upsertCardMdHash");
    },
    async deleteCardMdHash(): Promise<void> {
      throw SQLITE_ONLY("deleteCardMdHash");
    },
    async getCardDepHash(): Promise<null> {
      throw SQLITE_ONLY("getCardDepHash");
    },
    async upsertCardDepHash(): Promise<void> {
      throw SQLITE_ONLY("upsertCardDepHash");
    },
    async deleteCardDepHash(): Promise<void> {
      throw SQLITE_ONLY("deleteCardDepHash");
    },
  };
}

export async function createCardStore(options: CreateCardStoreOptions): Promise<CardStore> {
  const dbBackend = options.dbBackend ?? "sqlite";

  let persistence: CardPersistence;
  /** Non-null ONLY when THIS store constructed its sqlite backend (the
   *  standalone quick path) — only then does close() release it. A
   *  bundle-provided backend (and the stateless surreal backend) is closed
   *  by its owner. */
  let ownedSqliteBackend: SqliteBackend | null = null;
  switch (dbBackend) {
    case "sqlite": {
      // Construct the backend through the C5-lite factory seam — the sole
      // sanctioned construction path (see `createSqliteBackend` in
      // backend-factory.ts; the sole-source gate bans the raw SqliteBackend
      // constructor outside the factory). The factory returns the CONCRETE
      // handle this façade's SQL needs (getDb / withCorruptionRecovery — on
      // the class, not the `Backend` interface) without requiring a
      // MemoryConfig; the bundle-join path instead reuses the bundle's
      // already-initialized backend (one handle, one lifecycle).
      if (options.sqliteBackend) {
        persistence = createSqliteCardPersistence(options.sqliteBackend);
      } else {
        ownedSqliteBackend = await createSqliteBackend(options.memoryDir);
        persistence = createSqliteCardPersistence(ownedSqliteBackend);
      }
      break;
    }
    case "surrealdb": {
      if (!options.surrealRepo) {
        throw new Error(
          'createCardStore: dbBackend "surrealdb" requires surrealRepo (the bundle-provided ' +
            "SurrealMemoryRepository the card persistence is built on).",
        );
      }
      persistence = createSurrealCardPersistence(options.surrealRepo);
      break;
    }
    default:
      throw new Error(`createCardStore: unknown dbBackend "${dbBackend}"`);
  }

  // Per-kind registries (spec §7). One serializer per kind; the memory dedup
  // strategy is kind-agnostic in logic, so one instance covers memory/user/
  // failure. The dedup registry IS used by upsertCard; the serializer registry
  // is exposed via serializerFor (06b's disk-read path consumes it).
  // C5-lite note: memory/user/failure persistence reuses the ALREADY-
  // registered `MemoryDedupStrategy` verbatim (kp13 Wave B: IDENTITY-keyed —
  // same md_id → skip, distinct md_id → keep; md is canonical and its layer
  // already refuses exact dups / warns-only on near-dups before mirroring).
  // The near-dup/topic primitives stay live in MemoryStore's md-layer warnings.
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

  const store: CardStore = {
    async upsertCard(card: Card): Promise<void> {
      const strategy = dedupStrategies.get(card.kind);
      if (!strategy) {
        throw new Error(`createCardStore: no dedup strategy registered for kind "${card.kind}"`);
      }
      const existing = await persistence.getCardsByKind(card.kind);
      const decision = strategy.dedup(card, existing);
      // 06a: keep → INSERT; skip/merge → no-op (memory merge is the existing
      // MemoryStore consolidation path; knowledge merge is 06b).
      if (decision.action !== "keep") return;
      if (!persistableKinds.has(card.kind)) {
        throw new Error(
          `createCardStore.upsertCard: kind "${card.kind}" has no persistence decision registered ` +
            "(add a serializer + dedup strategy first).",
        );
      }
      await persistence.insertCard(card);
    },

    updateCard(card: Card): Promise<void> {
      return persistence.updateCard(card);
    },

    deleteCard(id: string): Promise<void> {
      return persistence.deleteCard(id);
    },

    getCard(id: string): Promise<Card | null> {
      return persistence.getCard(id);
    },

    getCardsByKind(kind: CardKind): Promise<Card[]> {
      return persistence.getCardsByKind(kind);
    },

    serializerFor(kind: CardKind): CardSerializer | undefined {
      return serializers.get(kind);
    },

    getCardMdHash(cardId: string): Promise<{ hash: string; mirroredAt: string; kind: string } | null> {
      return persistence.getCardMdHash(cardId);
    },

    upsertCardMdHash(cardId: string, hash: string, kind = "mirror"): Promise<void> {
      return persistence.upsertCardMdHash(cardId, hash, kind);
    },

    deleteCardMdHash(cardId: string): Promise<void> {
      return persistence.deleteCardMdHash(cardId);
    },

    getCardDepHash(cardId: string): Promise<{ depHash: string; validatedAt: string } | null> {
      return persistence.getCardDepHash(cardId);
    },

    upsertCardDepHash(cardId: string, depHash: string): Promise<void> {
      return persistence.upsertCardDepHash(cardId, depHash);
    },

    deleteCardDepHash(cardId: string): Promise<void> {
      return persistence.deleteCardDepHash(cardId);
    },

    async close(): Promise<void> {
      // Release ONLY a backend this store constructed (the standalone sqlite
      // quick path). A bundle-provided backend belongs to the bundle; the
      // surreal backend is stateless HTTP.
      if (ownedSqliteBackend) await ownedSqliteBackend.close();
    },
  };

  return store;
}
