/**
 * Continuous-chain orchestration — the feedback half of the pwf⇄wayfind loop.
 *
 * `syncChainState` reads pwf's published `globalThis.__piPlanPhases` (per-phase
 * `{id, status, ticketIds?}`), closes any wayfind ticket whose phase reports
 * `"complete"`, and records the closure on the effort's map.md. Idempotent.
 *
 * Pure-ish: reads globalThis + fs; NEVER imports planning-with-files — the only
 * contact surface is the globalThis keys (see ADR-0001). That keeps the two
 * extensions decoupled: wayfind closes tickets without knowing task_plan.md's
 * format, exactly as pwf publishes phase state without knowing the ticket
 * format.
 */
import { appendDecision, closeTicket, readMap, type Ticket } from "./map.js";

/**
 * Structural mirror of pwf's `PhaseInfo` — NO cross-package import (the seam is
 * globalThis, typed structurally so the two packages never depend on each
 * other's types). `status` is widened to `string` so any unknown token simply
 * fails the `=== "complete"` check rather than failing to type-check.
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
 * Close wayfind tickets whose planning-with-files phase reports complete — the
 * feedback half of the continuous chain loop (ADR-0001).
 *
 * Reads `globalThis.__piPlanPhases(cwd)`; for each complete phase's `ticketIds`,
 * closes the matching ticket (status → "closed", resolution set) and appends a
 * one-line decision to the effort's `map.md`.
 *
 * Idempotent: already-closed tickets are skipped (no duplicate decision line).
 * Graceful: returns `{closed:[], skipped:[]}` when pwf is absent
 * (`__piPlanPhases` undefined), no map exists, or no complete phase references a
 * ticket.
 */
export function syncChainState(cwd: string, effort: string): ChainSyncResult {
  const reader = (globalThis as Record<string, unknown> | undefined)?.__piPlanPhases;
  if (typeof reader !== "function") return { closed: [], skipped: [] };

  const phases = (reader as (cwd: string) => PlanPhaseInfo[])(cwd);
  const refsToClose = phases.flatMap((p) =>
    p.status === "complete" && p.ticketIds && p.ticketIds.length > 0 ? p.ticketIds : [],
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
    const resolution = "Closed by /chain-sync — its planning-with-files phase reported complete.";
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
