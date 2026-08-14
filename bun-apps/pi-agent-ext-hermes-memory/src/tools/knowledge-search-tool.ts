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
import { Type } from "typebox";
import type { RetrieveResult } from "@repo/pi-agent-ext-core-interface";
import { getKnowledgePipeline } from "../knowledge-pipeline-seam.js";
import { KNOWLEDGE_FOLDER_DEFAULT } from "../knowledge-vault-path.js";
import type { VectorStore } from "../store/surreal/vector-store.js";
import type { Embedder } from "../store/surreal/embedder.js";
import { SqliteBackend } from "../store/sqlite/sqlite-backend.js";
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
    const backend = new SqliteBackend(memoryDir);
    try {
      await backend.init();
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
      await backend.close().catch(() => {});
    }
    return out;
  };
}

const KNOWLEDGE_SEARCH_DESCRIPTION = `Search the knowledge graph (vault-md cards written by zk's ingest pipeline) for lessons, gotchas, and patterns relevant to the current task.

Use cases:
- Recall a resolved decision or gotcha before re-deriving it: knowledge_search("cfg-scale tuning")
- Find patterns/levers tagged with a topic: knowledge_search(query="diffusion", tags=["sampler"])
- Look up prior lessons before repeating work

Returns matching knowledge cards with tags + a digest. Knowledge cards live in the obsidian vault graph (not the memory store); semantic retrieval needs the embed index (ticket 04) and is off by default.`;

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
    gating: { core: true },
    description: KNOWLEDGE_SEARCH_DESCRIPTION,
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language query (tokenized into tags for the lexical path; passed as queryText for the semantic path).",
      }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional explicit tag filter (overrides query tokenization when present).",
        }),
      ),
      topK: Type.Optional(Type.Number({ description: "Maximum results (default 10)." })),
      semantic: Type.Optional(
        Type.Boolean({
          description: "Enable semantic retrieval (needs the embed index = ticket 04; default false).",
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
