// src/tools/planning-stale-tool.ts — the `planning_stale` tool (Phase-2 / 10-impl).
// The user-facing `stale:` query surface for the staleness dependency graph:
//   - action 'query' (query "stale" / "stale:<effort>") returns closed planning-
//     ticket decisions whose cited/declared source-file deps changed since last
//     validation (each result is stale by construction — δ: the result set IS the
//     `stale` flag); and
//   - action 'revalidate' (cardId) re-baselines one decision against its current
//     dependency bytes (the agent re-grill "re-validate" step, clearing the stale
//     flag) and reports whether it HAD drifted.
// Standalone tool mirroring the knowledge_search / knowledge_ingest house style
// (decision δ — memory-tool.ts carries no prefix-query grammar, so a standalone
// tool is the cleanest additive surface; it was also @ts-nocheck at the time,
// which is no longer true). The pure resolvers
// (runStaleQuery / revalidateCard / parseStaleQuery) are exported for unit testing
// WITHOUT the pi API.

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolRegistrar } from "./knowledge-search-tool.js";
import { createCardStore } from "../store/card-store.js";
import { getStaleCards, type StaleCard } from "../store/planning-staleness.js";
import { refreshStaleness } from "../store/planning-sync-state.js";

const PLANNING_STALE_DESCRIPTION = `Staleness dependency graph over .planning decisions.

action 'query' — pass a \`query\` of 'stale' (all efforts) or 'stale:<effort>' (scope to one effort). Returns closed planning-ticket decisions whose cited / declared (depends_on) source-file dependencies changed since last validation. Each returned card is stale by construction.

action 'revalidate' — pass a \`cardId\` (planning-ticket:<effort>:<no>). Re-baselines that decision against its CURRENT dependency bytes — call this AFTER re-grilling a stale decision to clear its stale flag. Reports whether the decision HAD drifted.

Use cases:
- Before acting on a stored planning decision, check its cited deps are still valid: planning_stale(action:'query', query:'stale')
- Scope staleness to one effort: planning_stale(action:'query', query:'stale:2026-08-08-knowledge-pipeline')
- After re-confirming a decision against changed code, clear its stale flag: planning_stale(action:'revalidate', cardId:'planning-ticket:<effort>:<no>')`;

/** Parse a `stale[:<effort>]` query string. Lenient: "stale" / "" / unknown →
 *  unscoped ({}); "stale:<effort>" → scoped. */
export function parseStaleQuery(query: string): { effort?: string } {
  const q = (query ?? "").trim();
  if (q.startsWith("stale:")) {
    const effort = q.slice("stale:".length).trim();
    return effort.length > 0 ? { effort } : {};
  }
  return {};
}

/** Run a `stale:` query against the store: returns closed planning decisions
 *  flagged stale (deps changed since last validation). Each returned card is
 *  stale by construction (δ — the result set IS the `stale` flag). Opens an
 *  ephemeral store (hermes holds no long-lived planning store), scoped to the
 *  parsed `effort` when `query` is `"stale:<effort>"`. */
export async function runStaleQuery(
  memoryDir: string,
  query: string,
  fsRoot: string,
): Promise<{ ok: boolean; stale: StaleCard[]; error?: string }> {
  const { effort } = parseStaleQuery(query);
  let store;
  try {
    store = await createCardStore({ memoryDir });
  } catch (err) {
    return { ok: false, stale: [], error: msg(err) };
  }
  try {
    const stale = await getStaleCards(store, effort, fsRoot);
    return { ok: true, stale };
  } catch (err) {
    return { ok: false, stale: [], error: msg(err) };
  } finally {
    try {
      await store.close();
    } catch {
      /* best effort */
    }
  }
}

/** Re-validate ONE decision (the agent re-grill step): recompute the dep
 *  aggregate, report whether it HAD drifted relative to the OLD baseline, AND
 *  re-baseline to the CURRENT bytes (clearing the stale flag). `stale` is the
 *  T5 `refreshStaleness` boolean (wasStale); `missing` is `[]` (T5 does not
 *  expose missing — the query path surfaces it via StaleCard.missingDeps). */
export async function revalidateCard(
  memoryDir: string,
  cardId: string,
  fsRoot: string,
): Promise<{ ok: boolean; stale: boolean; missing: string[]; error?: string }> {
  let store;
  try {
    store = await createCardStore({ memoryDir });
  } catch (err) {
    return { ok: false, stale: false, missing: [], error: msg(err) };
  }
  try {
    const wasStale = await refreshStaleness(store, cardId, fsRoot);
    return { ok: true, stale: wasStale, missing: [] };
  } catch (err) {
    return { ok: false, stale: false, missing: [], error: msg(err) };
  } finally {
    try {
      await store.close();
    } catch {
      /* best effort */
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Format the stale-card list into a human-readable one-line-per-card summary
 *  (mirrors the memory-search / knowledge-search text shape). */
function renderStale(stale: StaleCard[]): string {
  if (stale.length === 0) return "No stale planning decisions.";
  const lines: string[] = [
    `${stale.length} stale decision${stale.length === 1 ? "" : "s"} (deps changed since last validation):`,
    "",
  ];
  for (const s of stale) {
    const miss = s.missingDeps && s.missingDeps.length > 0 ? ` — missing: ${s.missingDeps.join(", ")}` : "";
    lines.push(`- [${s.effort}] ${s.cardId}${miss}`);
  }
  return lines.join("\n");
}

/** Register the `planning_stale` tool (query + revalidate). `memoryDir` is the
 *  hermes memory DB dir (the SAME `globalDir` createCardStore / the planning
 *  mirror use) — captured in a closure at registration, mirroring
 *  `registerKnowledgeSearchTool`'s `vaultResolver` + `registerKnowledgeIngestTool`'s
 *  `opts.memoryDir`. The repo root (`fsRoot`) comes from `ctx.cwd` at call time. */
GATE_DEFS["planning_stale"] = {
  id: "planning_stale",
  keywords: ["planning stale", "stale decision", "stale planning", "revalidate decision", "stale query", "過期決策", "重新驗證"],
  requires: {
    nouns: ["decision", "planning", "dependency", "card", "決策", "計劃"],
    verbs: ["query", "revalidate", "check", "stale", "查詢", "驗證", "檢查"],
  },
  description: "Query/revalidate stale planning-ticket decisions",
};

export function registerPlanningStaleTool(
  pi: ToolRegistrar,
  opts: { memoryDir: string },
): ToolDefinition {
  const definition = defineTool({
    name: "planning_stale",
    label: "Planning Stale",
    gating: { gate: "planning_stale" }, // demoted from core (ticket 02)
    description: PLANNING_STALE_DESCRIPTION,
    parameters: Type.Object({
      action: StringEnum(["query", "revalidate"] as const, {
        description: "'query' — list stale planning decisions; 'revalidate' — re-baseline one decision against current deps.",
      }),
      query: Type.Optional(
        Type.String({
          description: "query action: 'stale' (all efforts) or 'stale:<effort>' (scope to one effort).",
        }),
      ),
      cardId: Type.Optional(
        Type.String({
          description: "revalidate action: the planning-ticket card id (planning-ticket:<effort>:<no>) to re-baseline.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      if (params.action === "revalidate") {
        if (!params.cardId) {
          return {
            content: [{ type: "text" as const, text: "✗ Missing 'cardId' for revalidate." }],
            details: { ok: false, error: "missing cardId" },
          };
        }
        const r = await revalidateCard(opts.memoryDir, params.cardId, cwd);
        const text = r.ok
          ? `✓ Re-validated ${params.cardId}: ${r.stale ? "had drifted (now re-baselined)" : "was current"}${r.missing.length > 0 ? `; missing deps: ${r.missing.join(", ")}` : ""}.`
          : `✗ Re-validate failed: ${r.error}`;
        return { content: [{ type: "text" as const, text }], details: r };
      }
      // query (the default path when action !== 'revalidate')
      const r = await runStaleQuery(opts.memoryDir, params.query ?? "stale", cwd);
      const text = r.ok ? renderStale(r.stale) : `✗ stale: query failed: ${r.error}`;
      return { content: [{ type: "text" as const, text }], details: r };
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
  gate: "planning_stale",
  recallFloor: 0,
  adversarial: [],
  controls: ['query stale planning decisions', 'revalidate the stale decision card', 'check which planning tickets went stale', 'stale query for the tool-gate effort'],
};
