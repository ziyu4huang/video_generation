/**
 * Wakeup persistence — session-store snapshots of the PENDING wakeup entries
 * (cc-parity-task ticket 03, ported from ext-task's loop-persistence.ts).
 *
 * This is NOT the cron store and NOT cross-session durability: a snapshot is
 * appended as a session custom entry whenever the pending set mutates, and
 * `session_start` restores it only when the SAME session resumes — a restart
 * of a live session keeps its loops' cadence instead of losing them (map D7's
 * "never durable, no daemon" is about cross-session cron leases; a resumed
 * session's own branch is the loop's home).
 *
 * Restore semantics (the PR #2030 rules, kept verbatim): a future dueAt is
 * honored; a stale (past) one re-anchors instead of burst-firing — fixed mode
 * re-anchors a full interval from NOW, dynamic mode re-anchors to NOW (the
 * missed turn fires on the next tick ≤30s).
 *
 * Compat: ext-task's retired `loop-state` entries are NOT migrated — they are
 * inert session history once its loader is gone (decision recorded in the
 * ticket; session-scoped state, dropping is acceptable per ticket scope 4).
 */

import type { WakeupEntry } from "./wakeup-registry.js";
import { LOOP_MAX_AGE_MS } from "./wakeup-registry.js";

export const WAKEUP_STATE_ENTRY_TYPE = "wakeup-loop-state";

export interface WakeupPersistenceApi {
  appendEntry: (customType: string, data: unknown) => void;
}

function isWakeupEntry(v: unknown): v is WakeupEntry {
  const e = v as WakeupEntry | undefined;
  return (
    !!e &&
    typeof e.id === "string" &&
    typeof e.prompt === "string" &&
    typeof e.dueAt === "number" &&
    (e.mode === "fixed" || e.mode === "dynamic") &&
    typeof e.fireCount === "number" &&
    (e.startedAt === undefined || typeof e.startedAt === "number") &&
    (e.delaySeconds === undefined || typeof e.delaySeconds === "number") &&
    (e.lastReason === undefined || typeof e.lastReason === "string")
  );
}

/** Append a snapshot of the pending set (undefined/empty entries = cleared). */
export function persistWakeupEntries(api: WakeupPersistenceApi | undefined, entries: WakeupEntry[] | undefined): void {
  api?.appendEntry(WAKEUP_STATE_ENTRY_TYPE, { entries: entries ? entries.map((e) => ({ ...e })) : null });
}

/** Read the LAST snapshot's validated entries from a session branch. */
export function loadWakeupEntries(sessionManager: unknown): WakeupEntry[] {
  const sm = sessionManager as
    | {
        getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
        getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
      }
    | undefined;
  const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
  const entry = entries.filter((e) => e.type === "custom" && e.customType === WAKEUP_STATE_ENTRY_TYPE).pop();
  const data = entry?.data as { entries?: unknown } | undefined;
  if (!Array.isArray(data?.entries)) return [];
  return data.entries.filter(isWakeupEntry).map((e) => ({ ...e }));
}

/**
 * Pure re-anchor (PR #2030 rules): future dueAt kept; stale fixed re-anchors a
 * full delaySeconds from `now` (dropped when it has no delaySeconds — it can
 * never reschedule); stale dynamic re-anchors to NOW. Entries already past
 * the 7-day max-age (or with an invalid fixed cadence) are dropped — an
 * expired loop must not come back to life on restore.
 */
export function reanchorWakeupEntries(entries: WakeupEntry[], now: Date): WakeupEntry[] {
  const nowMs = now.getTime();
  const out: WakeupEntry[] = [];
  for (const entry of entries) {
    if (entry.startedAt !== undefined && nowMs - entry.startedAt >= LOOP_MAX_AGE_MS) continue;
    if (entry.dueAt > nowMs) {
      out.push(entry);
      continue;
    }
    if (entry.mode === "fixed") {
      if (entry.delaySeconds == null || entry.delaySeconds < 1) continue;
      out.push({ ...entry, dueAt: nowMs + entry.delaySeconds * 1000 });
    } else {
      out.push({ ...entry, dueAt: nowMs });
    }
  }
  return out;
}
