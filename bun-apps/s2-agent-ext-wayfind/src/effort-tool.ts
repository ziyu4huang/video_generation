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
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import { Type } from "typebox";
import { emitWayfindView, enrichListStaleness, enrichStatusStaleness } from "./effort-enrich.js";
import { listEfforts, searchEfforts } from "./effort-query.js";
import { renderCreate, renderList, renderSearch, renderStatus, renderValidate } from "./effort-render.js";
import { readMap, writeFreshMap } from "./map.js";
import { computeFrontier, type EffortMeta, type TicketStatus, validateEffortMap } from "./model.js";

// Renderers live in effort-render.ts (ADR-wayfind-0007 §3); the re-export shim
// that used to live here was removed 2026-08-22 — import from effort-render.js.

// ─── Gate family (wayfinder ticket 02 — demoted from core) ──────────────────
// wayfind_effort is planning-status inventory, on-demand (the reflective
// charting/synthesis stays with /wayfind commands). Demoted from always-active
// core to an on-demand gate; keywords are the effort/planning vocabulary.
GATE_DEFS.wayfind_effort = {
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
  const map = writeFreshMap(cwd, effort, destination, input.notes ?? "", input.owner);
  return { ok: true, existed: false, effort, path, meta: map.meta ?? null };
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
          // 10-impl T9: hermes staleness enrichment (r.stale + per-ticket ⚠)
          // lives in effort-enrich.ts (plan Task 10).
          await enrichStatusStaleness(r, cwd);
          // zk-spawn: mirror the rendered status into the webui's "Wayfind" tab.
          // Only on a real effort (r.ok) so an error state never spawns a noisy tab.
          if (r.ok) emitWayfindView(events, renderStatus(r));
          return { content: [{ type: "text" as const, text: renderStatus(r) }], details: r };
        }
        case "list": {
          const r = listEfforts(cwd);
          // 10-impl T9: per-effort hermes stale counts live in effort-enrich.ts
          // (plan Task 10).
          await enrichListStaleness(r, cwd);
          // zk-spawn: mirror the rendered list into the webui's "Wayfind" tab.
          // Only on a successful read (r.ok) so a catastrophic fs error never
          // spawns a noisy tab.
          if (r.ok) emitWayfindView(events, renderList(r));
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
