/**
 * Hermes-staleness enrichment + webui mirroring for the `wayfind_effort` tool.
 *
 * Extracted verbatim from the tool's `status`/`list` action cases (plan Task 10):
 *   • enrichStatusStaleness — the try/catch `readStaleDecisions` call that sets
 *     `r.stale` + the per-ticket `⚠` markers.
 *   • enrichListStaleness   — the per-effort stale-count loop.
 *   • emitWayfindView       — the guarded `webui:render` emit (mode md, view
 *     "wayfind"). Callers gate on `r.ok` so an error state never spawns a tab.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { type EffortListResult } from "./effort-query.js";
import type { EffortStatusResult } from "./effort-tool.js";
import { readStaleDecisions } from "./stale-seam.js";

export async function enrichStatusStaleness(r: EffortStatusResult, cwd: string): Promise<void> {
  // 10-impl T9: enrich the stale count + per-ticket markers from the
  // hermes seam (async). readStaleDecisions returns null when hermes is
  // absent → leave `stale` UNSET so renderStatus emits nothing (output
  // byte-identical to pre-T9). A non-null array → stale.length (0 =
  // clean) + a ⚠ marker on each ticket whose cardId is stale. The SYNC
  // effortStatus leaves `stale` unset; staleness is a tool-layer concern.
  try {
    const stale = await readStaleDecisions(r.effort, cwd);
    if (stale !== null) {
      r.stale = stale.length;
      const staleNos = new Set(stale.map((s) => s.cardId.split(":").pop() ?? ""));
      for (const t of r.tickets) if (staleNos.has(t.id)) t.stale = true;
    }
  } catch {
    // seam threw (defensive — readStaleDecisions already catches) → leave unset
  }
}

export async function enrichListStaleness(r: EffortListResult, cwd: string): Promise<void> {
  // 10-impl T9: per-effort stale count from the hermes seam. Each call
  // opens an ephemeral store in hermes; N efforts = N calls (acceptable
  // for a manual list, not a hot path). null = hermes absent → leave
  // `stale` UNSET so renderList emits no token (byte-identical to pre-T9).
  for (const e of r.efforts) {
    try {
      const stale = await readStaleDecisions(e.slug, cwd);
      if (stale !== null) e.stale = stale.length;
    } catch {
      // seam threw → leave unset
    }
  }
}

export function emitWayfindView(events: EventBus | undefined, content: string): void {
  // zk-spawn: mirror the rendered content into the webui's dedicated
  // "Wayfind" tab (mode md). events?. is defensive — a registered tool
  // always has the bus, but no-arg callers stay safe.
  events?.emit("webui:render", { content, mode: "md", view: "wayfind", title: "Wayfind" });
}
