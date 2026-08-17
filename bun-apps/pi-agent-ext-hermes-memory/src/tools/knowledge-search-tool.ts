/**
 * knowledge_search tool — the agent-facing retrieve over zk's vault-md graph
 * (06b Decision 3). Mirrors `registerMemoryTool`/`registerMemorySearchTool`:
 * `gating:{core:true}`, typebox `Type.Object` params, a human-readable `text`
 * for the TUI + structured `details` carrying the raw `RetrieveResult`.
 *
 * Resolve the vault env-only (`resolveKnowledgeVaultPath`), read the
 * `KnowledgePipeline` seam defensively (graceful "zk not present" — never
 * throws), then `kp.retrieveRecords(...)`. Formats the matched cards (one line
 * per card: title + tags + detail) + the digest into `text`. The 06a DB mirror
 * is NOT the retrieve path in 06b (retrieve goes through zk's vault-md graph);
 * flagged for later (spec Open question 3).
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
import { Type } from "typebox";
import type { RetrieveResult } from "@repo/pi-agent-core-interface";
import { getKnowledgePipeline } from "../knowledge-pipeline-seam.js";
import { KNOWLEDGE_FOLDER_DEFAULT } from "../knowledge-vault-path.js";
import type { VectorStore } from "../store/surreal/vector-store.js";
import type { Embedder } from "@repo/pi-agent-core-interface";
import type { SqliteBackend } from "../store/sqlite/sqlite-backend.js";
import { createSqliteBackend } from "../store/backend-factory.js";
import { normalizeFts5Query, buildFallbackFts5Query, isFts5QueryError } from "../store/sqlite/fts-query.js";
// From core-interface (BELOW both tiers), not from knowledge-card. hermes is
// TIER-0 and may not import the hub — ADR-0001. Same module either way, so the
// query side and the card side still normalize identically.
import { extractEntities, normEntity } from "@repo/pi-agent-core-interface";
import { searchSemantic, type SemanticRelation } from "../store/semantic-search.js";

/** Narrow the pi surface to exactly what this tool uses (registerTool). The
 *  full ExtensionAPI is structurally assignable, so index.ts passes its pi
 *  unchanged — no cast needed at the wiring site or in tests. */
export interface ToolRegistrar {
  registerTool(def: ToolDefinition): void;
}

/** Optional semantic-search wiring (ticket 14 phase A). When `semantic` is
 *  opted-in AND a VectorStore is available, the tool probes the warm HNSW index
 *  and re-ranks the zk RetrieveResult cards by HNSW proximity (cards the warm
 *  path surfaced float to the top). Default (no wiring) → byte-identical to the
 *  pre-semantic baseline (#default-behavior-unchanged invariant).
 *
 *  Providers are LAZY (zero-cost unless semantic is opted-in at call time), so
 *  wiring them in index.ts never touches SurrealDB during normal operation. */
export interface KnowledgeSemanticOpts {
  /** Lazy VectorStore (returns undefined when no Surreal index is configured). */
  vectorStore?: () => VectorStore | undefined;
  /** Lazy embedder (returns undefined when LM Studio is unavailable). */
  embedder?: () => Embedder | undefined;
  /** Embedding model id (default nomic-embed-text-v1.5). */
  model?: string;
  /** HNSW exploration factor (default from config / 100). */
  ef?: number;
  /** Ticket 03 P2-T5 (LeanRAG ③): batched card-graph relations lookup wired
   *  into the warm path. Built by `buildGraphRelationsFetcher(memoryDir)` at
   *  registration time (index.ts) — one batched `SELECT graph BY md_id` over
   *  the SAME SQLite card-store DB the knowledge mirror writes. Consulted only
   *  on the warm HNSW path, so it rides the same semanticOpts gating as the
   *  vector store (unwired default → dedupByRelation stays dormant, unchanged
   *  behavior). */
  fetchRelations?: (mdIds: string[]) => Promise<Map<string, SemanticRelation[]>>;
  /** Ticket 20 T3: warm-path lexical recall signal — FTS membership over the
   *  knowledge-target rows of the same SQLite card-store DB (membership only;
   * FTS returns no relevance, so rank = ascending rowid (oldest-first) —
   * membership is what votes, rank only tie-breaks. Built
   * by `buildLexicalRecall(memoryDir)`; silent-skip contract — [] on any
   * failure, never breaks search. */
  lexicalRecall?: (queryText: string, topK: number) => Promise<Array<{ mdId: string; rank: number }>>;
  /** Ticket 20 T3: warm-path entity recall signal — query-side deterministic
   *  entity extraction (zk extractEntities) × a paged scan of card graph
   *  entities, ranked by match count. Built by `buildEntityRecall(memoryDir)`;
   * same silent-skip contract. */
  entityRecall?: (queryText: string, topK: number) => Promise<Array<{ mdId: string; rank: number }>>;
  /** Ticket 20 T2: dominance weight of the multi-signal frequency vote
   *  (PINNED: final = (signalCount - 1) * boostWeight + bestRankScore).
   *  Threaded from `config.boostWeight` at registration time (index.ts) and
   *  passed straight into `searchSemantic`; default 1.0 when unset
   *  (DEFAULT_BOOST_WEIGHT, constants.ts). */
  boostWeight?: number;
}

/** Ticket 03 P2-T5 (LeanRAG ③): build the PRODUCTION `fetchRelations` provider
 *  — a batched `memories.graph` lookup keyed by md_id against the SAME SQLite
 *  card-store DB the knowledge mirror writes (`createCardStore`'s DB; opened
 *  ephemerally per call, mirroring the planning-stale-tool pattern). One
 *  batched SELECT over the ranked ids (chunked to stay well under any
 *  SQLITE_MAX_VARIABLE_NUMBER bound) — never N+1. Decodes `Card.graph.relations`
 *  triples; missing rows / NULL graph / corrupt JSON / any backend failure are
 *  silently skipped (the seam's contract: relations absent, search unaffected). */
export function buildGraphRelationsFetcher(
  memoryDir: string,
): (mdIds: string[]) => Promise<Map<string, SemanticRelation[]>> {
  return async (mdIds: string[]): Promise<Map<string, SemanticRelation[]>> => {
    const out = new Map<string, SemanticRelation[]>();
    if (mdIds.length === 0) return out;
    let backend: SqliteBackend | undefined;
    try {
      backend = await createSqliteBackend(memoryDir);
      for (let i = 0; i < mdIds.length; i += 100) {
        const chunk = mdIds.slice(i, i + 100);
        const rows = backend
          .getDb()
          .prepare(
            `SELECT md_id, graph FROM memories WHERE md_id IN (${chunk.map(() => "?").join(",")})`,
          )
          .all(...chunk) as Array<{ md_id: string; graph: string | null }>;
        for (const row of rows) {
          if (!row.graph) continue; // NULL graph → card has none → silent skip
          try {
            const parsed = JSON.parse(row.graph) as { relations?: unknown };
            if (Array.isArray(parsed.relations)) {
              const rels = parsed.relations.filter(
                (r): r is SemanticRelation =>
                  typeof r === "object" &&
                  r !== null &&
                  typeof (r as SemanticRelation).s === "string" &&
                  typeof (r as SemanticRelation).rel === "string" &&
                  typeof (r as SemanticRelation).o === "string",
              );
              if (rels.length > 0) out.set(row.md_id, rels);
            }
          } catch {
            // corrupt graph JSON → silent skip, never blocks search
          }
        }
      }
    } catch {
      // backend open/query failure → empty map (search unaffected)
    } finally {
      await backend?.close().catch(() => {});
    }
    return out;
  };
}

/** Ticket 20 T3: build the PRODUCTION `lexicalRecall` signal — FTS membership
 *  over the knowledge-target rows of the SAME SQLite card-store DB (ephemeral
 *  backend per call, mirroring buildGraphRelationsFetcher). `memory_fts` is
 *  external-content FTS over the whole memories table (kind-agnostic), so the
 *  knowledge filter is applied in the outer query (`target = 'knowledge'`, md_id
 *  NOT NULL). FTS returns NO relevance ordering — rank = ascending rowid
 *  (oldest-first); membership is what votes, rank only tie-breaks, per the
 *  plan's rank/membership-only constraint). Query normalization goes through
 *  `normalizeFts5Query`, with a `buildFallbackFts5Query` retry on FTS syntax
 *  errors. Never throws: ANY failure (backend open, FTS error even after the
 *  fallback, malformed rows) → [] (the seam contract: a failing signal never
 *  breaks search). */
export function buildLexicalRecall(
  memoryDir: string,
): (queryText: string, topK: number) => Promise<Array<{ mdId: string; rank: number }>> {
  return async (queryText: string, topK: number): Promise<Array<{ mdId: string; rank: number }>> => {
    if (!queryText || !queryText.trim() || topK <= 0) return [];
    let backend: SqliteBackend | undefined;
    try {
      backend = await createSqliteBackend(memoryDir);
      const sql =
        `SELECT m.md_id FROM memories m ` +
        `WHERE m.id IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?) ` +
        `AND m.target = 'knowledge' AND m.md_id IS NOT NULL LIMIT ?`;
      let rows: Array<{ md_id: unknown }>;
      try {
        rows = backend.getDb().prepare(sql).all(normalizeFts5Query(queryText), topK) as Array<{
          md_id: unknown;
        }>;
      } catch (err) {
        if (!isFts5QueryError(err)) throw err; // non-FTS failure → outer catch → []
        const fallback = buildFallbackFts5Query(queryText);
        if (!fallback) throw err; // no broader form available → [] via outer catch
        rows = backend.getDb().prepare(sql).all(fallback, topK) as Array<{ md_id: unknown }>;
      }
      // Guard against malformed rows (rank = 0-based row index).
      return rows
        .filter((r): r is { md_id: string } => !!r && typeof r.md_id === "string")
        .map((r, i) => ({ mdId: r.md_id, rank: i }));
    } catch {
      return []; // backend open / FTS error even after fallback / anything → silent skip
    } finally {
      await backend?.close().catch(() => {});
    }
  };
}

/** Ticket 20 T3: build the PRODUCTION `entityRecall` signal — query-side
 *  deterministic entity extraction (`extractEntities`, pure) × a rowid-paged
 *  scan of the knowledge cards' `graph.entities` (batches of 100, mirroring the
 *  fetcher's chunk discipline). Both sides are normalized via `normEntity`, so
 *  "MLX" in prose matches "mlx" in a graph.
 *  Cards with ≥1 overlap are kept, ranked by matchCount desc then id asc.
 *  CHEAP SHORT-CIRCUIT: a query yielding no entities returns [] WITHOUT opening
 *  the DB. Never throws: any failure (extraction, backend, corrupt graph JSON)
 *  → [] / row silently skipped.
 *
 *  Both functions come from core-interface, which sits BELOW both tiers — not
 *  from zk. hermes calling zk at RUNTIME is the sanctioned spine direction; a
 *  static hermes→zk IMPORT is not, and conflating the two is what put this file
 *  in breach of ADR-0001 (the `__piKnowledgePipeline` seam exists precisely so
 *  the runtime call needs no upward edge). Sharing the module downward, rather
 *  than through the seam, keeps the two sides' normalization agreement
 *  structural and keeps the signal alive when zk is not loaded.
 *
 *  Full paged scan per warm query — revisit at the >2k-cards scale trigger
 *  (plan 03's persistent-index deferral). */
export function buildEntityRecall(
  memoryDir: string,
): (queryText: string, topK: number) => Promise<Array<{ mdId: string; rank: number }>> {
  return async (queryText: string, topK: number): Promise<Array<{ mdId: string; rank: number }>> => {
    if (topK <= 0) return [];
    let queryNames: Set<string>;
    try {
      queryNames = new Set(
        extractEntities(queryText ?? "").map((e) => {
          if (!e || typeof e.name !== "string") return "";
          return normEntity(e.name);
        }),
      );
    } catch {
      return []; // extraction itself failed → silent skip
    }
    queryNames.delete("");
    if (queryNames.size === 0) return []; // no query entities → no DB open at all
    let backend: SqliteBackend | undefined;
    try {
      backend = await createSqliteBackend(memoryDir);
      const stmt = backend.getDb().prepare(
        `SELECT id, md_id, graph FROM memories ` +
          `WHERE target = 'knowledge' AND graph IS NOT NULL AND id > ? ORDER BY id LIMIT 100`,
      );
      let cursor = 0;
      const matched: Array<{ mdId: string; id: number; matchCount: number }> = [];
      for (;;) {
        const rows = stmt.all(cursor) as Array<{ id: unknown; md_id: unknown; graph: unknown }>;
        for (const row of rows) {
          if (!row || typeof row.id !== "number" || typeof row.md_id !== "string") continue;
          if (typeof row.graph !== "string" || row.graph.length === 0) continue;
          try {
            const parsed = JSON.parse(row.graph) as { entities?: unknown };
            if (!Array.isArray(parsed.entities)) continue;
            let matchCount = 0;
            for (const ent of parsed.entities) {
              if (!ent || typeof ent !== "object") continue;
              const name = (ent as { name?: unknown }).name;
              if (typeof name === "string" && queryNames.has(normEntity(name))) matchCount += 1;
            }
            if (matchCount >= 1) matched.push({ mdId: row.md_id, id: row.id, matchCount });
          } catch {
            // corrupt graph JSON → silent skip, never blocks search
          }
        }
        if (rows.length < 100) break;
        const last = rows[rows.length - 1]!;
        if (typeof last.id !== "number") break;
        cursor = last.id;
      }
      matched.sort((a, b) => b.matchCount - a.matchCount || a.id - b.id);
      return matched.slice(0, topK).map((m, i) => ({ mdId: m.mdId, rank: i }));
    } catch {
      return []; // backend open / query failure → silent skip
    } finally {
      await backend?.close().catch(() => {});
    }
  };
}

GATE_DEFS["knowledge_search"] = {
  id: "knowledge_search",
  keywords: ["knowledge search", "knowledge graph", "recall a decision", "prior lesson", "patterns for", "gotcha", "知識搜尋", "過往經驗"],
  requires: {
    nouns: ["knowledge", "lesson", "pattern", "gotcha", "card", "經驗", "教訓"],
    verbs: ["search", "recall", "find", "look up", "搜尋", "查詢", "回憶"],
  },
  description: "Search the knowledge graph for lessons/gotchas/patterns",
};

const KNOWLEDGE_SEARCH_DESCRIPTION = `Search knowledge-graph cards (vault-md, from zk ingest) for lessons, gotchas, patterns — recall before re-deriving. Returns cards with tags + digest. Cards live in the vault graph, not the memory store; semantic needs the embed index (ticket 04), off by default.`;

/** Tokenize a natural-language query into lexical tags (lowercase alnum tokens)
 *  for the retrieveRecords lexical path. Mirrors zk's tag tokenization shape. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length > 0);
}

/** Format a RetrieveResult into a human-readable one-line-per-card summary
 *  (mirrors the memory-search-tool text shape). */
function formatKnowledgeSearchText(query: string, result: RetrieveResult): string {
  if (result.count === 0) {
    return `No knowledge cards matched "${query}" (scanned ${result.scanned}, excluded ${result.excluded}).`;
  }
  const lines: string[] = [
    `Found ${result.count} knowledge card${result.count === 1 ? "" : "s"} matching "${query}":`,
  ];
  for (const card of result.cards) {
    const tagStr = card.tags.length > 0 ? ` [${card.tags.join(", ")}]` : "";
    lines.push(`- ${card.title}${tagStr}`);
    if (card.detail) lines.push(`  ${card.detail}`);
  }
  if (result.digest) lines.push("", result.digest);
  return lines.join("\n");
}

/** The structured `details` this tool returns: the raw `RetrieveResult` on
 *  success (spec: "attaches RetrieveResult as details"), or `{ok:false,reason}`
 *  on the graceful-degradation paths (vault unset / zk seam absent). */
interface KnowledgeSearchToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: RetrieveResult | { ok: false; reason: string };
}

/** Register the `knowledge_search` tool. `vaultResolver` resolves the vault
 *  path (env-only); it MAY throw (e.g. env unset) — the tool surfaces a clear
 *  message at call time and never crashes session init. */
export function registerKnowledgeSearchTool(
  pi: ToolRegistrar,
  vaultResolver: () => string,
  semanticOpts?: KnowledgeSemanticOpts,
): ToolDefinition {
  const definition = defineTool({
    name: "knowledge_search",
    label: "Knowledge search",
    gating: { gate: "knowledge_search" }, // demoted from core (ticket 02)
    description: KNOWLEDGE_SEARCH_DESCRIPTION,
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language query (tags for lexical path; queryText for semantic path).",
      }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Explicit tag filter (overrides query tokenization).",
        }),
      ),
      topK: Type.Optional(Type.Number({ description: "Maximum results (default 10)." })),
      semantic: Type.Optional(
        Type.Boolean({
          description: "Semantic retrieval (needs embed index, ticket 04; default false).",
        }),
      ),
      excludeIds: Type.Optional(Type.Array(Type.String(), { description: "Record ids to exclude." })),
    }),
    async execute(_toolCallId, params): Promise<KnowledgeSearchToolResult> {
      const { query, tags, topK, semantic, excludeIds } = params;

      // Resolve the vault (env-only). The resolver may throw when the env is
      // unset/missing — surface a clear message (do NOT crash).
      let vaultPath: string;
      try {
        vaultPath = vaultResolver();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `✗ knowledge vault not configured: ${message}` }],
          details: { ok: false, reason: message },
        };
      }

      // Read the seam defensively — graceful "zk not present" (never throws).
      const kp = getKnowledgePipeline();
      if (!kp) {
        return {
          content: [
            {
              type: "text" as const,
              text: "✗ zk KnowledgePipeline seam not present — knowledge_search unavailable (zk not installed).",
            },
          ],
          details: { ok: false, reason: "zk KnowledgePipeline seam not present" },
        };
      }

      const folder = KNOWLEDGE_FOLDER_DEFAULT;
      let result = await kp.retrieveRecords({
        vaultPath,
        folder,
        tags: tags ?? tokenize(query),
        queryText: query,
        topK: topK ?? 10,
        semantic: semantic ?? false,
        bodyMatch: true,
        slugDom: true,
        excludeIds,
      });

      // Ticket 14 phase A: warm HNSW re-rank. When semantic is opted-in AND a
      // VectorStore + embedder are wired, probe the warm index and re-rank the
      // zk cards by HNSW proximity (warm hits float to the top). searchSemantic
      // is called WITHOUT kp/vaultPath so a warm MISS returns [] (no double
      // kp.retrieveRecords call) — on a miss the zk result stands unchanged.
      // Best-effort: a throw is swallowed (#default-behavior-unchanged).
      // Default (no semanticOpts / no store) → this block is skipped entirely.
      if (semantic && semanticOpts?.vectorStore && semanticOpts?.embedder) {
        const vs = semanticOpts.vectorStore();
        const embedder = semanticOpts.embedder();
        if (vs && embedder) {
          try {
            const warm = await searchSemantic({
              queryText: query,
              kind: "knowledge",
              topK: topK ?? 10,
              ef: semanticOpts.ef ?? 100,
              model: semanticOpts.model,
              embedder,
              vectorStore: vs,
              // ③ dedup substrate: attach card-graph relations for the ranked
              // hits (batched SQLite lookup; silent-skip inside the seam).
              fetchRelations: semanticOpts.fetchRelations,
              // Ticket 20 T3: production lexical (FTS membership) + entity
              // (extractEntities × graph scan) vote signals.
              lexicalRecall: semanticOpts.lexicalRecall,
              entityRecall: semanticOpts.entityRecall,
              // Ticket 20 T2: frequency-vote dominance weight from config
              // (constants → types → config 4-point registration).
              boostWeight: semanticOpts.boostWeight,
              // Deliberately omit kp/vaultPath: a warm miss must return []
              // (NOT re-run zk cosine) so the zk result above stands.
              excludeIds,
            });
            const hnsw = warm.filter((h) => h.source === "hnsw");
            if (hnsw.length > 0) {
              const order = new Map(hnsw.map((h, i) => [h.mdId, i]));
              const ranked = [...result.cards].sort(
                (a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
              );
              result = { ...result, cards: ranked };
            }
          } catch {
            // Warm-probe failure (SurrealDB down / embed error) → zk result stands.
          }
        }
      }

      const text = formatKnowledgeSearchText(query, result);
      return { content: [{ type: "text" as const, text }], details: result };
    },
  });
  pi.registerTool(definition);
  return definition;
}


/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of runtime gating).
 * Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts. Controls-only
 * (recallFloor 0, adversarial []): demoted from core in ticket 02; narrow
 * keywords are intentional, so we assert the predicate fires on its own
 * keyword/requires path, not paraphrased intent.
 */
export const __GATE_PROBES__ = {
  gate: "knowledge_search",
  recallFloor: 0,
  adversarial: [],
  controls: ['search the knowledge graph for the sampler gotcha', 'recall the lesson on cfg-scale tuning', 'search the knowledge cards for the lora gotcha', 'look up prior lessons on attention'],
};
