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
 *
 * The hermes-side semantic opt-in (KnowledgeSemanticOpts + the SurrealDB
 * card_vectors HNSW warm path + its vector backfill) was retired 2026-08-22
 * (context-lifecycle ticket 03 / D1): the `vectors` database was never created,
 * so every armed query served a zero-row fallback — the 0/20 recall audit
 * (`.planning/knowledge/hermes-recall-audit.md`). Recall routes through kcard
 * `retrieveRecords` (knowledge-card ext); this tool stays lexical/tags-only.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import { Type } from "typebox";
import type { RetrieveResult } from "@repo/s2-agent-core-interface";
import { getKnowledgePipeline } from "../knowledge-pipeline-seam.js";
import { KNOWLEDGE_FOLDER_DEFAULT } from "../knowledge-vault-path.js";

/** Narrow the pi surface to exactly what this tool uses (registerTool). The
 *  full ExtensionAPI is structurally assignable, so index.ts passes its pi
 *  unchanged — no cast needed at the wiring site or in tests. */
export interface ToolRegistrar {
  registerTool(def: ToolDefinition): void;
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

const KNOWLEDGE_SEARCH_DESCRIPTION = `Search knowledge-graph cards (vault-md, from zk ingest) for lessons, gotchas, patterns — recall before re-deriving. Returns cards with tags + digest. Cards live in the vault graph, not the memory store; lexical/tag search over the zk graph.`;

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
): ToolDefinition {
  const definition = defineTool({
    name: "knowledge_search",
    label: "Knowledge search",
    gating: { gate: "knowledge_search" }, // demoted from core (ticket 02)
    description: KNOWLEDGE_SEARCH_DESCRIPTION,
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language query (tokenized to tags for the lexical path).",
      }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Explicit tag filter (overrides query tokenization).",
        }),
      ),
      topK: Type.Optional(Type.Number({ description: "Maximum results (default 10)." })),
      excludeIds: Type.Optional(Type.Array(Type.String(), { description: "Record ids to exclude." })),
    }),
    async execute(_toolCallId, params): Promise<KnowledgeSearchToolResult> {
      const { query, tags, topK, excludeIds } = params;

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
      const result = await kp.retrieveRecords({
        vaultPath,
        folder,
        tags: tags ?? tokenize(query),
        queryText: query,
        topK: topK ?? 10,
        bodyMatch: true,
        slugDom: true,
        excludeIds,
      });

      const text = formatKnowledgeSearchText(query, result);
      return { content: [{ type: "text" as const, text }], details: result };
    },
  });
  pi.registerTool(definition);
  return definition;
}


/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of runtime gating).
 * Consumed by s2-agent-ext-tool-gate/qa/collect-probes.ts. Controls-only
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
