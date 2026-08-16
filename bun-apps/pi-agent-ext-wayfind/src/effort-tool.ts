/**
 * The `wayfind_effort` tool — the Layer-2 agent surface for effort manifests.
 *
 * Layer 1 landed the `EffortMeta` model + `parseMapFrontmatter`/`serializeMapFrontmatter`
 * + `validateEffortMap`. Layer 2 wraps them in ONE bare agent tool with three actions:
 *
 *   • create   — scaffold a fresh `.planning/<effort>/` dir with a manifest map.md
 *                (front-matter effort/created/last/status:active). Refuses if the map
 *                already exists (never clobbers a populated effort).
 *   • validate — run the conformance check (missing Destination, front-matter effort ≠
 *                folder). Surfaces the original failure mode: a hand-written map with
 *                non-canonical sections parsed to an empty Destination silently.
 *   • status   — compact read-only summary: manifest + open/closed/claimed counts + the
 *                frontier + fog.
 *
 * "Bare" = the tool performs the raw fs/data op and returns structured `details`; no
 * steering messages, no LLM orchestration (that stays with the `/wayfind` commands).
 * The cwd-based ops are exported so they're unit-testable with mkdtemp; the tool's
 * execute() is a thin dispatch that reads `ctx.cwd` and forwards.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type EventBus } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
import { Type } from "typebox";
import { type EffortListResult, type EffortSearchResult, listEfforts, searchEfforts } from "./effort-query.js";
import { readMap, writeMap } from "./map.js";
import {
  computeFrontier,
  type EffortMeta,
  type TicketStatus,
  today,
  validateEffortMap,
  type WayfindMap,
} from "./model.js";
import { readStaleDecisions } from "./stale-seam.js";

// ─── Gate family (wayfinder ticket 02 — demoted from core) ──────────────────
// wayfind_effort is planning-status inventory, on-demand (the reflective
// charting/synthesis stays with /wayfind commands). Demoted from always-active
// core to an on-demand gate; keywords are the effort/planning vocabulary.
GATE_DEFS["wayfind_effort"] = {
  id: "wayfind_effort",
  keywords: [
    "wayfind",
    "effort status",
    "planning status",
    "frontier",
    "ticket status",
    "effort list",
    "effort search",
    "計劃狀態",
    "進度",
  ],
  requires: {
    nouns: ["effort", "ticket", "frontier", "map", "planning", "計劃", "進度"],
    verbs: ["status", "list", "search", "validate", "create", "查詢", "列出", "搜尋"],
  },
  description: "Wayfinder effort status/list/search/validate (on-demand planning inventory)",
};

// ─── create ──────────────────────────────────────────────────────────────────

export interface EffortCreateInput {
  effort: string;
  destination: string;
  /** Optional manifest owner. */
  owner?: string;
  /** Optional ## Notes body. */
  notes?: string;
}

export interface EffortCreateResult {
  ok: boolean;
  effort: string;
  /** Repo-relative path, e.g. ".planning/<effort>/map.md". */
  path: string;
  /** True when the map already existed (create refused). */
  existed: boolean;
  meta: EffortMeta | null;
  /** Set only by the tool's missing-`effort` guard (throw-free ok:false). */
  error?: string;
}

/**
 * Scaffold a new effort: `.planning/<effort>/map.md` with a front-matter manifest
 * (status defaults to "active") + a `tickets/` dir. Refuses — without writing —
 * when the map already exists, so the agent can't clobber a populated effort.
 */
export function createEffort(cwd: string, input: EffortCreateInput): EffortCreateResult {
  const { effort, destination } = input;
  const path = `.planning/${effort}/map.md`;
  const existing = readMap(cwd, effort);
  if (existing) {
    return { ok: false, existed: true, effort, path, meta: existing.meta ?? null };
  }
  const meta: EffortMeta = {
    effort,
    created: today(),
    last: today(),
    status: "active",
    ...(input.owner ? { owner: input.owner } : {}),
  };
  const map: WayfindMap = {
    effort,
    destination: destination.trim(),
    notes: (input.notes ?? "").trim(),
    decisions: [],
    fog: [],
    outOfScope: [],
    tickets: [],
    meta,
  };
  writeMap(cwd, map);
  return { ok: true, existed: false, effort, path, meta };
}

// ─── validate ────────────────────────────────────────────────────────────────

export interface EffortValidateResult {
  ok: boolean;
  effort: string;
  /** False when there is no map at all. */
  exists: boolean;
  problems: string[];
  meta: EffortMeta | null;
  /** Set only by the tool's missing-`effort` guard (throw-free ok:false). */
  error?: string;
}

/** Run the conformance check on an effort's map (missing Destination, effort mismatch). */
export function validateEffort(cwd: string, effort: string): EffortValidateResult {
  const map = readMap(cwd, effort);
  if (!map) {
    return { ok: false, exists: false, effort, problems: [`no map at .planning/${effort}/map.md`], meta: null };
  }
  const v = validateEffortMap(map, effort);
  return { ok: v.ok, exists: true, effort, problems: v.problems, meta: map.meta ?? null };
}

// ─── status ──────────────────────────────────────────────────────────────────

export interface EffortFrontierTicket {
  id: string;
  title: string;
  type: string;
}

/** Budget-bounded low-res ticket row for the `status` action (#455 hardening).
 *  Carries ONLY {id,title,status,blocking} — never the verbatim bodies (Question /
 *  What-to-build / Acceptance / Resolution). Subagents read this inventory instead
 *  of whole map.md / ticket files so they can't exhaust the token budget. */
export interface EffortStatusTicket {
  id: string;
  title: string;
  status: TicketStatus;
  /** Bare ticket-number ids that must close before this one can start. */
  blocking: string[];
  /** 10-impl: true when this closed decision is stale (its cited/declared deps
   *  drifted since last validation). Set at the TOOL layer from the seam's stale
   *  card-id set; left unset when hermes is absent. */
  stale?: boolean;
}

export interface EffortStatusResult {
  ok: boolean;
  effort: string;
  /** False when there is no map at all. */
  exists: boolean;
  destination: string;
  meta: EffortMeta | null;
  open: number;
  closed: number;
  claimed: number;
  fog: number;
  frontier: EffortFrontierTicket[];
  /** Low-res per-ticket inventory (titles + statuses + blocking edges, NO bodies).
   *  Empty array on a missing effort or an effort with no tickets. */
  tickets: EffortStatusTicket[];
  /** 10-impl: # of stale decisions on this effort (deps changed since last
   *  validation). null = staleness unavailable (explicit); UNSET (undefined) =
   *  not enriched / hermes absent (render emits nothing); 0 = clean; N = count.
   *  Enriched at the TOOL layer (async) — the SYNC effortStatus leaves it unset. */
  stale?: number | null;
  /** Set only by the tool's missing-`effort` guard (throw-free ok:false). */
  error?: string;
}

/** Compact read-only summary: manifest + ticket counts + frontier + fog. */
export function effortStatus(cwd: string, effort: string): EffortStatusResult {
  const map = readMap(cwd, effort);
  if (!map) {
    return {
      ok: false,
      exists: false,
      effort,
      destination: "",
      meta: null,
      open: 0,
      closed: 0,
      claimed: 0,
      fog: 0,
      frontier: [],
      tickets: [],
    };
  }
  const open = map.tickets.filter((t) => t.status === "open");
  const closed = map.tickets.filter((t) => t.status === "closed").length;
  const claimed = open.filter((t) => t.claimed).length;
  const frontier = computeFrontier(map.tickets).map((t) => ({ id: t.id, title: t.title, type: t.type }));
  // Budget-bounded low-res inventory (#455): pick ONLY {id,title,status,blocking}
  // from each parsed ticket — explicitly DISCARD the verbatim body fields
  // (question / whatToBuild / acceptance / resolution) plus claimed/type/slug, so
  // the agent gets an inventory without ever reading a whole map/ticket body.
  const tickets: EffortStatusTicket[] = map.tickets.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    blocking: t.blocking,
  }));
  return {
    ok: true,
    exists: true,
    effort,
    destination: map.destination,
    meta: map.meta ?? null,
    open: open.length,
    closed,
    claimed,
    fog: map.fog.length,
    frontier,
    tickets,
  };
}

// ─── text renderers (tool result `content`) ──────────────────────────────────

function renderCreate(r: EffortCreateResult): string {
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
  } else {
    lines.push("frontier: (clear)");
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

function renderSearch(r: EffortSearchResult): string {
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

// ─── the tool ────────────────────────────────────────────────────────────────

export function makeWayfindEffortTool(events?: EventBus) {
  return defineTool({
    name: "wayfind_effort",
    label: "Wayfind Effort",
    description:
      "Bare agent ops on a wayfinder effort dir (.planning/<effort>/). " +
      "action:'create' scaffolds map.md with a front-matter manifest (refuses if it exists); " +
      "action:'validate' checks conformance (missing Destination, front-matter effort≠folder); " +
      "action:'status' returns a budget-bounded low-res summary — manifest + ticket counts + frontier + a per-ticket {id,title,status,blocking} inventory with NO verbatim bodies. " +
      "action:'list' enumerates every effort under .planning/ with a compact summary (status / ticket counts / frontier / fog / last); action:'search' runs a cross-effort keyword search over tickets + map decisions (term-frequency, field-weighted, ranked top-K, filterable by effort/status/type). " +
      +"Prefer action:'status' over reading whole map.md / ticket files for inventory or audit: it returns only titles, statuses, and blocking edges, never decision bodies, so it can't blow the token budget (failure memory #455). " +
      "Use this for the mechanical manifest/structure ops — the reflective charting/synthesis stays with the /wayfind commands.",
    gating: { gate: "wayfind_effort" }, // demoted from core (ticket 02)
    parameters: Type.Object({
      action: StringEnum(["create", "validate", "status", "list", "search"] as const, {
        description:
          "create = scaffold a new effort + manifest map.md; validate = conformance check; status = budget-bounded low-res inventory (titles + statuses + blocking edges, no verbatim bodies); list = enumerate every effort under .planning/ with a compact summary; search = cross-effort keyword search over tickets + decisions (ranked, filterable).",
      }),
      effort: Type.Optional(
        Type.String({
          description:
            "Effort slug — the .planning/<effort>/ folder name (e.g. '2026-08-02-core-task-review'). REQUIRED for create/validate/status; an optional scope filter for search; ignored by list.",
        }),
      ),
      destination: Type.Optional(
        Type.String({ description: "create only: the effort's one-line goal (writes ## Destination)." }),
      ),
      notes: Type.Optional(Type.String({ description: "create only: free-form notes (writes ## Notes)." })),
      owner: Type.Optional(Type.String({ description: "create only: owner recorded in the front-matter manifest." })),
      query: Type.Optional(
        Type.String({ description: "search: keyword query (term-frequency, field-weighted ranking)." }),
      ),
      statusFilter: Type.Optional(
        StringEnum(["open", "closed"] as const, {
          description: "search: restrict to a ticket status (drops decision docs).",
        }),
      ),
      typeFilter: Type.Optional(
        StringEnum(["research", "prototype", "grilling", "task"] as const, {
          description: "search: restrict to a ticket type (drops decision docs).",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      switch (params.action) {
        case "create": {
          if (!params.effort) {
            const r: EffortCreateResult = {
              ok: false,
              effort: "",
              path: "",
              existed: false,
              meta: null,
              error:
                "Missing required param 'effort' — create needs an effort slug (the .planning/<effort>/ folder name).",
            };
            return { content: [{ type: "text" as const, text: renderCreate(r) }], details: r };
          }
          const r = createEffort(cwd, {
            effort: params.effort,
            destination: params.destination ?? "",
            notes: params.notes,
            owner: params.owner,
          });
          return { content: [{ type: "text" as const, text: renderCreate(r) }], details: r };
        }
        case "validate": {
          if (!params.effort) {
            const r: EffortValidateResult = {
              ok: false,
              exists: false,
              effort: "",
              problems: [],
              meta: null,
              error:
                "Missing required param 'effort' — validate needs an effort slug (the .planning/<effort>/ folder name).",
            };
            return { content: [{ type: "text" as const, text: renderValidate(r) }], details: r };
          }
          const r = validateEffort(cwd, params.effort);
          return { content: [{ type: "text" as const, text: renderValidate(r) }], details: r };
        }
        case "status": {
          if (!params.effort) {
            const r: EffortStatusResult = {
              ok: false,
              exists: false,
              effort: "",
              destination: "",
              meta: null,
              open: 0,
              closed: 0,
              claimed: 0,
              fog: 0,
              frontier: [],
              tickets: [],
              error:
                "Missing required param 'effort' — status needs an effort slug (the .planning/<effort>/ folder name).",
            };
            return { content: [{ type: "text" as const, text: renderStatus(r) }], details: r };
          }
          const r = effortStatus(cwd, params.effort);
          // 10-impl T9: enrich the stale count + per-ticket markers from the
          // hermes seam (async). readStaleDecisions returns null when hermes is
          // absent → leave `stale` UNSET so renderStatus emits nothing (output
          // byte-identical to pre-T9). A non-null array → stale.length (0 =
          // clean) + a ⚠ marker on each ticket whose cardId is stale. The SYNC
          // effortStatus leaves `stale` unset; staleness is a tool-layer concern.
          try {
            const stale = await readStaleDecisions(params.effort, cwd);
            if (stale !== null) {
              r.stale = stale.length;
              const staleNos = new Set(stale.map((s) => s.cardId.split(":").pop() ?? ""));
              for (const t of r.tickets) if (staleNos.has(t.id)) t.stale = true;
            }
          } catch {
            // seam threw (defensive — readStaleDecisions already catches) → leave unset
          }
          // zk-spawn: mirror the rendered status into the webui's dedicated
          // "Wayfind" tab (mode md). Only on a real effort (r.ok) so an error
          // state never spawns a noisy tab. events?. is defensive — a
          // registered tool always has the bus, but no-arg callers stay safe.
          if (r.ok) {
            events?.emit("webui:render", { content: renderStatus(r), mode: "md", view: "wayfind", title: "Wayfind" });
          }
          return { content: [{ type: "text" as const, text: renderStatus(r) }], details: r };
        }
        case "list": {
          const r = listEfforts(cwd);
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
          // zk-spawn: mirror the rendered list into the webui's dedicated
          // "Wayfind" tab (mode md). Only on a successful read (r.ok) so a
          // catastrophic fs error never spawns a noisy tab. events?. is
          // defensive — a registered tool always has the bus, but no-arg
          // callers stay safe.
          if (r.ok) {
            events?.emit("webui:render", { content: renderList(r), mode: "md", view: "wayfind", title: "Wayfind" });
          }
          return { content: [{ type: "text" as const, text: renderList(r) }], details: r };
        }
        case "search": {
          const r = searchEfforts(cwd, params.query ?? "", {
            effort: params.effort,
            status: params.statusFilter,
            type: params.typeFilter,
          });
          return { content: [{ type: "text" as const, text: renderSearch(r) }], details: r };
        }
      }
    },
  });
}
