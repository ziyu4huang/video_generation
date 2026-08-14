/**
 * Continuous-chain orchestration — the feedback half of the plan⇄wayfind loop.
 *
 * `syncChainState` reads the plan coordinator's published phase state via `globalThis[PLAN_PHASES_KEY]`
 * (per-phase `{id, status, ticketIds?}`), closes any wayfind ticket whose phase
 * reports `"completed"`, and records the closure on the effort's map.md. Idempotent.
 *
 * Pure-ish: reads globalThis + fs; NEVER imports the plan coordinator — the only
 * contact surface is the globalThis keys (see ADR-wayfind-0003). That keeps the two
 * extensions decoupled: wayfind closes tickets without knowing task_plan.md's
 * format, exactly as the plan coordinator publishes phase state without knowing
 * the ticket format.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_PHASES_KEY } from "./constants.js";
import {
  appendSettledVocabulary,
  buildPlanSeed,
  type GlossaryTerm,
  parseDecisions,
  parseGlossary,
  type ResolvedDecision,
} from "./grill.js";
import { appendDecision, closeTicket, readMap } from "./map.js";
import type { Ticket } from "./model.js";

/**
 * Structural mirror of the plan coordinator's `PhaseInfo` — NO cross-package
 * import (the seam is globalThis, typed structurally so the two packages never
 * depend on each other's types). `status` is widened to `string` so any unknown
 * token simply fails the `=== "completed"` check rather than failing to type-check.
 */
interface PlanPhaseInfo {
  id: string;
  status: string;
  ticketIds?: string[];
}

export interface ChainSyncResult {
  /** Ticket refs (id or stem) that were closed this call. */
  closed: string[];
  /** Ticket refs that matched no open ticket (missing, or already closed). */
  skipped: string[];
}

/** Find a ticket by a phase-header ref, accepting either the bare id (`03`) or
 *  the filename stem (`03-foo`) — humans and `/plan-seed` may write either. */
function findTicketByRef(tickets: Ticket[], ref: string): Ticket | undefined {
  return tickets.find((t) => t.id === ref || `${t.id}-${t.slug}` === ref);
}

/**
 * Close wayfind tickets whose plan phase reports complete — the feedback half
 * of the continuous chain loop (ADR-wayfind-0003).
 *
 * Reads phase state via `globalThis[PLAN_PHASES_KEY](cwd)`; for each complete phase's `ticketIds`,
 * closes the matching ticket (status → "closed", resolution set) and appends a
 * one-line decision to the effort's `map.md`.
 *
 * Idempotent: already-closed tickets are skipped (no duplicate decision line).
 * Graceful: returns `{closed:[], skipped:[]}` when no plan coordinator is
 * present (the `PLAN_PHASES_KEY` seam is undefined), no map exists, or no complete phase
 * references a ticket.
 */
export function syncChainState(cwd: string, effort: string): ChainSyncResult {
  const reader = (globalThis as Record<string, unknown> | undefined)?.[PLAN_PHASES_KEY];
  if (typeof reader !== "function") return { closed: [], skipped: [] };

  const phases = (reader as (cwd: string) => PlanPhaseInfo[])(cwd);
  const refsToClose = phases.flatMap((p) =>
    p.status === "completed" && p.ticketIds && p.ticketIds.length > 0 ? p.ticketIds : [],
  );
  if (refsToClose.length === 0) return { closed: [], skipped: [] };

  const map = readMap(cwd, effort);
  if (!map) return { closed: [], skipped: refsToClose };

  const closed: string[] = [];
  const skipped: string[] = [];
  for (const ref of refsToClose) {
    const ticket = findTicketByRef(map.tickets, ref);
    // No matching ticket, or already closed → skip (idempotent).
    if (!ticket || ticket.status === "closed") {
      skipped.push(ref);
      continue;
    }
    const resolution = "Closed by /wayfind sync — its plan phase reported complete.";
    if (closeTicket(cwd, effort, ticket, resolution)) {
      appendDecision(cwd, effort, {
        title: ticket.title,
        gist: resolution,
        link: `tickets/${ticket.id}-${ticket.slug}.md`,
      });
      closed.push(ref);
    } else {
      skipped.push(ref);
    }
  }
  return { closed, skipped };
}

// ─── forward bridge: tickets/decisions → task_plan.md (ADR-wayfind-0003 companion) ─────

/** Topo-sort tickets so each blocker precedes its dependents (DFS post-order).
 *  Missing blockers are tolerated; ascending id is the secondary key for
 *  deterministic output. Tolerates cycles (visited guard → no infinite loop). */
function topoSortTickets(tickets: Ticket[]): Ticket[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const result: Ticket[] = [];
  const visit = (t: Ticket): void => {
    if (visited.has(t.id)) return;
    visited.add(t.id);
    for (const b of t.blocking) {
      const dep = byId.get(b);
      if (dep) visit(dep);
    }
    result.push(t);
  };
  for (const t of [...tickets].sort((a, b) => a.id.localeCompare(b.id))) visit(t);
  return result;
}

/** Flatten a wayfind ticket set into a writing-plans-format plan body — the
 *  forward half of the chain (ticket 08). Lossless: every ticket becomes a Task,
 *  in dependency order, carrying its `What to build` + acceptance criteria as
 *  `- [ ]` steps. Task headers embed the ticket stem (`[id-slug]`) so the plan
 *  coordinator's `parsePlan` + wayfind's `syncChainState` can close the
 *  originating ticket when the Task's steps complete (ADR-wayfind-0003 round-trip). */
export function flattenTicketsToPlan(tickets: Ticket[], glossary: GlossaryTerm[]): string {
  const ordered = topoSortTickets(tickets);
  const lines: string[] = [
    "# Implementation Plan — seeded from wayfind tickets",
    "",
    "**Goal:** _(Seeded from wayfind tickets — sharpen into a one-sentence end state.)_",
    "",
  ];
  appendSettledVocabulary(lines, glossary);
  ordered.forEach((t, i) => {
    lines.push(`### Task ${i + 1} — [${t.id}-${t.slug}] ${t.title}`);
    if (t.whatToBuild) lines.push(`> ${t.whatToBuild.trim()}`);
    if (t.acceptance && t.acceptance.length > 0) {
      for (const c of t.acceptance) lines.push(`- [ ] ${c}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

/** Seed a writing-plans-format plan from CONTEXT.md `## Decisions` — one Task
 *  per resolved decision (ticket 08). The lossless grill→plan handoff (replaces
 *  the old skeleton seed that dropped decisions because they lived only in the
 *  conversation). */
export function seedFromDecisions(decisions: ResolvedDecision[], glossary: GlossaryTerm[]): string {
  const lines: string[] = [
    "# Implementation Plan — seeded from grill decisions",
    "",
    "**Goal:** _(Seeded from resolved grill decisions — sharpen into a one-sentence end state.)_",
    "",
  ];
  appendSettledVocabulary(lines, glossary);
  decisions.forEach((d, i) => {
    lines.push(`### Task ${i + 1} — ${d.title}`, `- ${d.answer}`, "");
  });
  return lines.join("\n");
}

/** Where a seed came from — surfaced in the /plan-seed notification. */
export type SeedSource = "tickets" | "decisions" | "skeleton";

export interface SeedResult {
  path: string;
  source: SeedSource;
  phaseCount: number;
}
export interface SeedRefused {
  refused: string;
}

/**
 * Route-aware seed — write a `task_plan.md` from whatever chain artifacts exist
 * at `cwd` (the forward half of the continuous chain loop):
 *   1. `effort` + tickets under `.planning/<effort>/` → flatten (topo) into phases.
 *   2. else CONTEXT.md `## Decisions` → one phase per decision.
 *   3. else CONTEXT.md glossary / topic → skeleton (legacy handoff shape).
 * Writes to `.planning/<effort>/task_plan.md` when `effort` is given, else root
 * `task_plan.md`. REFUSES to overwrite an existing plan (returns `{refused}`)
 * so an in-progress plan is never silently clobbered. Returns null only when
 * there is genuinely nothing to seed.
 */
export function seedPlan(cwd: string, opts: { effort?: string; topic?: string } = {}): SeedResult | SeedRefused | null {
  const { effort, topic } = opts;
  const targetDir = effort ? join(cwd, ".planning", effort) : cwd;
  const targetPath = join(targetDir, "task_plan.md");
  if (existsSync(targetPath)) return { refused: targetPath };

  // CONTEXT.md is project-level (where grill-me-with-docs writes it).
  const contextPath = join(cwd, "CONTEXT.md");
  let glossary: GlossaryTerm[] = [];
  let decisions: ResolvedDecision[] = [];
  if (existsSync(contextPath)) {
    const ctx = readFileSync(contextPath, "utf-8");
    glossary = parseGlossary(ctx);
    decisions = parseDecisions(ctx);
  }

  let body: string | null = null;
  let source: SeedSource = "skeleton";

  if (effort) {
    const map = readMap(cwd, effort);
    if (map && map.tickets.length > 0) {
      body = flattenTicketsToPlan(map.tickets, glossary);
      source = "tickets";
    }
  }
  if (body === null && decisions.length > 0) {
    body = seedFromDecisions(decisions, glossary);
    source = "decisions";
  }
  if (body === null) {
    body = buildPlanSeed([], glossary, topic);
    if (body === null) return null;
  }

  if (effort) mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetPath, body, "utf-8");
  const phaseCount = (body.match(/^### Task\b/gim) ?? []).length;
  return { path: targetPath, source, phaseCount };
}
