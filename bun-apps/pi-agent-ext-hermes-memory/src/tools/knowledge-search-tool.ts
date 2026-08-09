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

/** Narrow the pi surface to exactly what this tool uses (registerTool). The
 *  full ExtensionAPI is structurally assignable, so index.ts passes its pi
 *  unchanged — no cast needed at the wiring site or in tests. */
export interface ToolRegistrar {
  registerTool(def: ToolDefinition): void;
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
export function registerKnowledgeSearchTool(pi: ToolRegistrar, vaultResolver: () => string): ToolDefinition {
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
      const result = await kp.retrieveRecords({
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

      const text = formatKnowledgeSearchText(query, result);
      return { content: [{ type: "text" as const, text }], details: result };
    },
  });
  pi.registerTool(definition);
  return definition;
}
