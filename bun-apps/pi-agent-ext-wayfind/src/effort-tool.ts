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
import { computeFrontier, type EffortMeta, readMap, validateEffortMap, type WayfindMap, writeMap } from "./map.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Today's date as YYYY-MM-DD (the manifest `created`/`last` convention). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

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
    };
  }
  const open = map.tickets.filter((t) => t.status === "open");
  const closed = map.tickets.filter((t) => t.status === "closed").length;
  const claimed = open.filter((t) => t.claimed).length;
  const frontier = computeFrontier(map.tickets).map((t) => ({ id: t.id, title: t.title, type: t.type }));
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
  };
}

// ─── text renderers (tool result `content`) ──────────────────────────────────

function renderCreate(r: EffortCreateResult): string {
  if (!r.ok) {
    return `Effort '${r.effort}' already exists at ${r.path} — create refused (edit it directly, or use /wayfind to chart).`;
  }
  return `Created effort manifest at ${r.path} (status: ${r.meta?.status ?? "active"}). Next: /wayfind ${r.effort} to chart the frontier, or add tickets under .planning/${r.effort}/tickets/.`;
}

function renderValidate(r: EffortValidateResult): string {
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
      "action:'status' returns a compact read-only summary (manifest + ticket counts + frontier). " +
      "Use this for the mechanical manifest/structure ops — the reflective charting/synthesis stays with the /wayfind commands.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("validate"), Type.Literal("status")], {
        description:
          "create = scaffold a new effort + manifest map.md; validate = conformance check; status = read-only summary.",
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
