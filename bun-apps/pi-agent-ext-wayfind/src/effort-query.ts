/**
 * Effort-query Phase 1 — read-only cross-effort `list` (+ search in a later task).
 *
 * Lightweight, dependency-free enumeration + summary over `<cwd>/.planning/`.
 * Reuses the existing parsers `readMap` (map.ts) and `readEffortMeta`
 * (lifecycle.ts) — never re-parses tickets (uses `map.tickets`). Everything is
 * cwd-based and throw-free: each public function returns an `{ ok, error? }`-
 * shaped result and never throws.
 *
 *   enumerateEfforts(cwd)        -> string[]          (effort slugs, sorted)
 *   listEfforts(cwd)             -> EffortListResult  (per-effort summary)
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { readEffortMeta } from "./lifecycle.js";
import { readMap } from "./map.js";

// ─── types (list action) ─────────────────────────────────────────────────────

export interface EffortTicketCounts {
  open: number;
  closed: number;
  /** Open tickets that carry a `claimed:` label. */
  claimed: number;
}

export interface EffortListItem {
  slug: string;
  /** Manifest `status:` (defaults to "active" when there is no manifest). */
  status: string;
  destination: string;
  ticketCounts: EffortTicketCounts;
  /** # of tickets: open && !claimed && no blockers. */
  frontierSize: number;
  /** # of "Not yet specified" (fog) bullets. */
  fog: number;
  /** Manifest `last:` date, when present. */
  lastModified?: string;
}

export interface EffortListResult {
  ok: boolean;
  efforts: EffortListItem[];
  error?: string;
}

// ─── enumerateEfforts ────────────────────────────────────────────────────────

/**
 * Enumerate effort slugs under `<cwd>/.planning/`. Directories only (dotfile and
 * file entries skipped), sorted ascending. Throw-free: any fs error -> [].
 */
export function enumerateEfforts(cwd: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(cwd, ".planning"));
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue; // skip dotfiles / hidden dirs
    try {
      if (statSync(join(cwd, ".planning", entry)).isDirectory()) slugs.push(entry);
    } catch {
      // unreadable entry — skip, never fatal
    }
  }
  return slugs.sort((a, b) => a.localeCompare(b));
}

// ─── listEfforts ─────────────────────────────────────────────────────────────

/**
 * List every effort under `<cwd>/.planning/` with a compact per-effort summary
 * (status / ticket counts / frontier size / fog / last-modified). Throw-free:
 * a bad effort (missing map / parse error) is skipped, never fatal; returns
 * `{ ok: false, error }` only on a catastrophic failure.
 */
export function listEfforts(cwd: string): EffortListResult {
  let slugs: string[];
  try {
    slugs = enumerateEfforts(cwd);
  } catch (err) {
    return { ok: false, efforts: [], error: errMsg(err) };
  }

  const efforts: EffortListItem[] = [];
  for (const slug of slugs) {
    try {
      const meta = readEffortMeta(cwd, slug);
      const map = readMap(cwd, slug);
      const tickets = map?.tickets ?? [];
      const openTickets = tickets.filter((t) => t.status === "open");
      const ticketCounts: EffortTicketCounts = {
        open: openTickets.length,
        closed: tickets.filter((t) => t.status === "closed").length,
        claimed: openTickets.filter((t) => t.claimed).length,
      };
      const frontierSize = tickets.filter(
        (t) => t.status === "open" && !t.claimed && (t.blocking ?? []).length === 0,
      ).length;
      efforts.push({
        slug,
        status: meta?.status ?? "active",
        destination: map?.destination ?? "",
        ticketCounts,
        frontierSize,
        fog: map?.fog?.length ?? 0,
        ...(meta?.last ? { lastModified: meta.last } : {}),
      });
    } catch {
      // one bad effort must not fail the whole list — skip it
    }
  }
  return { ok: true, efforts };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
