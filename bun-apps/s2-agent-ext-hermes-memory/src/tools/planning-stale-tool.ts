// src/tools/planning-stale-tool.ts — the `planning_stale` execute body (Phase-2 / 10-impl).
// The user-facing `stale:` query surface for the staleness dependency graph:
//   - action 'query' (query "stale" / "stale:<effort>") returns closed planning-
//     ticket decisions whose cited/declared source-file deps changed since last
//     validation (each result is stale by construction — δ: the result set IS the
//     `stale` flag); and
//   - action 'revalidate' (cardId) re-baselines one decision against its current
//     dependency bytes (the agent re-grill "re-validate" step, clearing the stale
//     flag) and reports whether it HAD drifted.
// The pure resolvers (runStaleQuery / revalidateCard / parseStaleQuery) are
// exported for unit testing WITHOUT the pi API.

import { createCardStore } from "../store/card-store.js";
import { getStaleCards, type StaleCard } from "../store/planning-staleness.js";
import { readSourceCard, refreshStaleness } from "../store/planning-sync-state.js";

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
 *  expose missing — the query path surfaces it via StaleCard.missingDeps).
 *  An unknown/unresolvable cardId (no planning source md) is a FAILURE
 *  (`ok:false`) — the old `planning_stale` tool semantics — NOT a silent
 *  "was current" no-op (refreshStaleness alone returns false for a ghost id). */
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
    const card = await readSourceCard(store, cardId, fsRoot);
    if (!card) {
      return { ok: false, stale: false, missing: [], error: `unknown cardId '${cardId}' (no planning source md resolved)` };
    }
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

/** Parameters for executePlanningStale (was the planning_stale tool schema). */
export interface PlanningStaleParams {
  /** 'query' — list stale planning decisions; 'revalidate' — re-baseline one decision against current deps. */
  action: "query" | "revalidate";
  /** query action: 'stale' (all efforts) or 'stale:<effort>' (scope to one effort). */
  query?: string;
  /** revalidate action: the planning-ticket card id (planning-ticket:<effort>:<no>) to re-baseline. */
  cardId?: string;
}

/** Execute the `planning_stale` tool body (query + revalidate). `opts.memoryDir`
 *  is the hermes memory DB dir (the SAME `globalDir` createCardStore / the
 *  planning mirror use) — passed per call, mirroring the registrar's captured
 *  `opts.memoryDir`. The repo root (`fsRoot`) is the process cwd at call time. */
export async function executePlanningStale(
  opts: { memoryDir: string },
  params: PlanningStaleParams,
): Promise<string> {
  const cwd = process.cwd();
  if (params.action === "revalidate") {
    if (!params.cardId) {
      return "✗ Missing 'cardId' for revalidate.";
    }
    const r = await revalidateCard(opts.memoryDir, params.cardId, cwd);
    const text = r.ok
      ? `✓ Re-validated ${params.cardId}: ${r.stale ? "had drifted (now re-baselined)" : "was current"}${r.missing.length > 0 ? `; missing deps: ${r.missing.join(", ")}` : ""}.`
      : `✗ Re-validate failed: ${r.error}`;
    return text;
  }
  // query (the default path when action !== 'revalidate')
  const r = await runStaleQuery(opts.memoryDir, params.query ?? "stale", cwd);
  const text = r.ok ? renderStale(r.stale) : `✗ stale: query failed: ${r.error}`;
  return text;
}
