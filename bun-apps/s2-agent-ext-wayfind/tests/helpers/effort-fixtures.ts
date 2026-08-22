/**
 * Test-only ticket fixtures — `resolveTicket` + `addTicket` moved out of
 * `src/wayfinder.ts` (ticket 07 trim: they had no production callers; the
 * agent writes tickets itself per procedures/wayfinder.md). Byte-identical
 * logic; they orchestrate the same store ops a production path would.
 */

import { appendDecision, readMap, writeTicket } from "../../src/map.js";
import type { Ticket } from "../../src/model.js";
import { slugify } from "../../src/wayfinder.js";

/** Next zero-padded ticket id for an effort (max existing + 1, or "01").
 *  Fixture-local: agents write tickets in production (per procedures/
 *  wayfinder.md), so numbering only ever happens in tests. */
function nextTicketId(tickets: Ticket[]): string {
  if (tickets.length === 0) return "01";
  const max = tickets.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  return String(max + 1).padStart(2, "0");
}

/** Resolve a ticket: record the resolution, close it, and append a one-line
 *  pointer to the map's Decisions so far. Returns the updated ticket, or null if
 *  the ticket id isn't found. */
export function resolveTicket(
  cwd: string,
  effort: string,
  ticketId: string,
  resolution: string,
  gist?: string,
): Ticket | null {
  const map = readMap(cwd, effort);
  if (!map) return null;
  const ticket = map.tickets.find((t) => t.id === ticketId);
  if (!ticket) return null;
  ticket.resolution = resolution.trim();
  ticket.status = "closed";
  ticket.claimed = undefined;
  writeTicket(cwd, effort, ticket);
  appendDecision(cwd, effort, {
    title: ticket.title,
    link: `tickets/${ticket.id}-${ticket.slug}.md`,
    gist: (gist ?? resolution).split(/\r?\n/)[0].slice(0, 120),
  });
  return ticket;
}

/** Add a new ticket to an effort (create-then-wire). Returns the new ticket. */
export function addTicket(
  cwd: string,
  effort: string,
  title: string,
  question: string,
  type: Ticket["type"] = "grilling",
  blocking: string[] = [],
): Ticket {
  const map = readMap(cwd, effort);
  const id = nextTicketId(map?.tickets ?? []);
  const slug = slugify(title);
  const ticket: Ticket = { id, slug, title, question, type, blocking, status: "open" };
  writeTicket(cwd, effort, ticket);
  return ticket;
}
