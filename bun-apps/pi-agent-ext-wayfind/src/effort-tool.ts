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
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readMap, writeMap } from "./map.js";
import {
  computeFrontier,
  type EffortMeta,
  type TicketStatus,
  today,
  validateEffortMap,
  type WayfindMap,
} from "./model.js";

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
  if (!r.ok) {
    return `Effort '${r.effort}' already exists at ${r.path} — create refused (edit it directly, or use /wayfind to chart).`;
  }
  return `Created effort manifest at ${r.path} (status: ${r.meta?.status ?? "active"}). Next: /wayfind ${r.effort} to chart the frontier, or add tickets under .planning/${r.effort}/tickets/.`;
}

export function renderValidate(r: EffortValidateResult): string {
  if (!r.exists) return `No map at .planning/${r.effort}/map.md — nothing to validate.`;
  if (r.ok) return `Effort '${r.effort}' is valid (manifest present, Destination set).`;
  return `Effort '${r.effort}' is INVALID:\n  - ${r.problems.join("\n  - ")}`;
}

function renderStatus(r: EffortStatusResult): string {
  if (!r.ok) return `No map at .planning/${r.effort}/map.md.`;
  const status = r.meta?.status ?? "(no manifest)";
  const lines = [
    `[${r.effort}] open ${r.open} · closed ${r.closed} · claimed ${r.claimed} · fog ${r.fog} · status ${status}`,
    `destination: ${r.destination || "(unset)"}`,
  ];
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
      lines.push(`  ${t.id} ${t.title} [${t.status}]${blk}`);
    }
  } else {
    lines.push("tickets: (none)");
  }
  return lines.join("\n");
}

// ─── the tool ────────────────────────────────────────────────────────────────

export function makeWayfindEffortTool() {
  return defineTool({
    name: "wayfind_effort",
    label: "Wayfind Effort",
    description:
      "Bare agent ops on a wayfinder effort dir (.planning/<effort>/). " +
      "action:'create' scaffolds map.md with a front-matter manifest (refuses if it exists); " +
      "action:'validate' checks conformance (missing Destination, front-matter effort≠folder); " +
      "action:'status' returns a budget-bounded low-res summary — manifest + ticket counts + frontier + a per-ticket {id,title,status,blocking} inventory with NO verbatim bodies. " +
      "Prefer action:'status' over reading whole map.md / ticket files for inventory or audit: it returns only titles, statuses, and blocking edges, never decision bodies, so it can't blow the token budget (failure memory #455). " +
      "Use this for the mechanical manifest/structure ops — the reflective charting/synthesis stays with the /wayfind commands.",
    gating: { core: true },
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("validate"), Type.Literal("status")], {
        description:
          "create = scaffold a new effort + manifest map.md; validate = conformance check; status = budget-bounded low-res inventory (titles + statuses + blocking edges, no verbatim bodies).",
      }),
      effort: Type.String({
        description: "Effort slug — the .planning/<effort>/ folder name (e.g. '2026-08-02-core-task-review').",
      }),
      destination: Type.Optional(
        Type.String({ description: "create only: the effort's one-line goal (writes ## Destination)." }),
      ),
      notes: Type.Optional(Type.String({ description: "create only: free-form notes (writes ## Notes)." })),
      owner: Type.Optional(Type.String({ description: "create only: owner recorded in the front-matter manifest." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      switch (params.action) {
        case "create": {
          const r = createEffort(cwd, {
            effort: params.effort,
            destination: params.destination ?? "",
            notes: params.notes,
            owner: params.owner,
          });
          return { content: [{ type: "text" as const, text: renderCreate(r) }], details: r };
        }
        case "validate": {
          const r = validateEffort(cwd, params.effort);
          return { content: [{ type: "text" as const, text: renderValidate(r) }], details: r };
        }
        case "status": {
          const r = effortStatus(cwd, params.effort);
          return { content: [{ type: "text" as const, text: renderStatus(r) }], details: r };
        }
      }
    },
  });
}
