/**
 * Text renderers for the `wayfind_effort` tool's result `content`.
 *
 * Extracted from effort-tool.ts (plan Task 10). Bodies moved verbatim —
 * byte-identical output is the acceptance bar; the `stale` undefined/null/0/N
 * rendering branches survive untouched. The create/validate/status result
 * interfaces stay in effort-tool.ts (imported type-only); the list/search
 * result types come from effort-query.js.
 */

import { type EffortListResult, type EffortSearchResult } from "./effort-query.js";
import type { EffortCreateResult, EffortStatusResult, EffortValidateResult } from "./effort-tool.js";

export function renderCreate(r: EffortCreateResult): string {
  if (r.error) return r.error;
  if (!r.ok) {
    return `Effort '${r.effort}' already exists at ${r.path} — create refused (edit it directly, or use /wayfind to chart).`;
  }
  return `Created effort manifest at ${r.path} (status: ${r.meta?.status ?? "active"}). Next: /wayfind ${r.effort} to chart the frontier, or add tickets under .planning/${r.effort}/tickets/.`;
}

export function renderValidate(r: EffortValidateResult): string {
  if (r.error) return r.error;
  if (!r.exists) return `No map at .planning/${r.effort}/map.md — nothing to validate.`;
  if (r.ok) return `Effort '${r.effort}' is valid (manifest present, Destination set).`;
  return `Effort '${r.effort}' is INVALID:\n  - ${r.problems.join("\n  - ")}`;
}

export function renderStatus(r: EffortStatusResult): string {
  if (r.error) return r.error;
  if (!r.ok) return `No map at .planning/${r.effort}/map.md.`;
  const status = r.meta?.status ?? "(no manifest)";
  const lines = [
    `[${r.effort}] open ${r.open} · closed ${r.closed} · claimed ${r.claimed} · fog ${r.fog} · status ${status}`,
    `destination: ${r.destination || "(unset)"}`,
  ];
  // 10-impl T9: staleness line (after destination). undefined = not enriched /
  // hermes absent → emit nothing (byte-identical to pre-T9); null = explicitly
  // unavailable; 0 = clean; N = stale count.
  const staleStr =
    r.stale === undefined
      ? ""
      : r.stale === null
        ? "staleness: unavailable"
        : r.stale === 0
          ? "stale: 0 (clean)"
          : `stale: ${r.stale}`;
  if (staleStr) lines.push(staleStr);
  if (r.frontier.length > 0) {
    lines.push("frontier:");
    for (const t of r.frontier) lines.push(`  ${t.id} ${t.title} [${t.type}]`);
  } else if (r.open > 0) {
    lines.push("frontier: (empty — all open tickets are blocked or claimed)");
  } else {
    lines.push("frontier: (clear — no open tickets; the way is found)");
    if (r.closed > 0) {
      lines.push("  → run `/wayfind done` for the closing ceremony (self-reflect + next-goal note)");
    }
  }
  // Budget-bounded ticket inventory: id/title/status/blocking ONLY (no bodies).
  if (r.tickets.length > 0) {
    lines.push("tickets:");
    for (const t of r.tickets) {
      const blk = t.blocking.length > 0 ? ` blocked-by ${t.blocking.join(",")}` : "";
      const stl = t.stale ? " ⚠ stale" : ""; // 10-impl T9: per-ticket stale marker
      lines.push(`  ${t.id} ${t.title} [${t.status}]${blk}${stl}`);
    }
  } else {
    lines.push("tickets: (none)");
  }
  return lines.join("\n");
}

export function renderList(r: EffortListResult): string {
  if (!r.ok) return r.error ? `Failed to list efforts: ${r.error}` : "Failed to list efforts under .planning/.";
  if (r.efforts.length === 0) return "No efforts found under .planning/.";
  const lines = [`${r.efforts.length} effort${r.efforts.length === 1 ? "" : "s"} under .planning/:`, ""];
  for (const e of r.efforts) {
    const c = e.ticketCounts;
    const last = e.lastModified ? `  last=${e.lastModified}` : "";
    // 10-impl T9: per-effort stale token. undefined = not enriched / hermes
    // absent → no token (byte-identical to pre-T9); null = unavailable; N = count.
    const staleToken = e.stale === undefined ? "" : e.stale === null ? "  stale=?" : `  stale=${e.stale}`;
    lines.push(
      `${e.slug}  [${e.status}]  open=${c.open} closed=${c.closed} claimed=${c.claimed}  frontier=${e.frontierSize}  fog=${e.fog}${last}${staleToken}`,
    );
    if (e.destination) lines.push(`    ${e.destination}`);
  }
  return lines.join("\n");
}

export function renderSearch(r: EffortSearchResult): string {
  if (!r.ok) return r.error ? `Search failed: ${r.error}` : "Search failed.";
  const filterParts: string[] = [];
  if (r.filters.effort) filterParts.push(`effort:${r.filters.effort}`);
  if (r.filters.status) filterParts.push(`status:${r.filters.status}`);
  if (r.filters.type) filterParts.push(`type:${r.filters.type}`);
  const filterStr = filterParts.length > 0 ? ` [${filterParts.join(", ")}]` : "";
  const header = `search: "${r.query}"${filterStr}`;
  if (r.matches.length === 0) return `${header}\nNo matches.`;
  const lines = [header, ""];
  r.matches.forEach((m, i) => {
    const n = i + 1;
    // Fall back to the title when the body snippet is empty (title-only match).
    const snippet = m.snippet || m.title;
    if (m.kind === "ticket") {
      lines.push(`${n}. [${m.effort}] #${m.ticketId} ${m.title} (${m.status},${m.type}) score=${m.score} — ${snippet}`);
    } else {
      lines.push(`${n}. [${m.effort}] · decision: ${m.title} — ${snippet}`);
    }
  });
  if (r.truncated) {
    lines.push(`… (truncated — more matches exist beyond the top ${r.matches.length})`);
  }
  return lines.join("\n");
}
