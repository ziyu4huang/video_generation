/**
 * Durable cron definitions + lease-claimed fire-records for the workflow cron
 * scheduler (ticket 08).
 *
 * Layout, under the ultracode state root (alongside runs/ — see
 * workflow-paths.ts):
 *   <stateRoot>/cron/definitions.json      — all definitions, atomic tmp+rename
 *   <stateRoot>/cron/fires/<id>-<due>.json — one fire-record per (definition,
 *                                            scheduled due-minute)
 *
 * Fire-records are the double-fire guard: claiming one uses an exclusive
 * `wx` create, so two concurrent live sessions both seeing a due definition
 * race for `<id>-<due>.json` and exactly one wins (mirrors run-persistence's
 * acquireRunLease, including dead-pid stale-lock recovery). Definitions are
 * durable across sessions, but FIRING stays session-live (map D8 — no daemon).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Recurring definitions auto-expire 7 days after creation (map D8 / spec §4). */
export const CRON_RECURRING_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface CronDefinition {
  /** Stable id (generated at create; safe in file names). */
  id: string;
  /** Optional human label; defaults to the workflow name. */
  name: string;
  /** 5-field cron expression (local time). */
  cron: string;
  kind: "one-shot" | "recurring";
  /** Saved-workflow / pack name (or path) resolved at fire time. */
  workflow: string;
  /** Args threaded into WorkflowManager.startInBackground. */
  args?: unknown;
  createdAt: string;
  /** ISO timestamp; set for recurring (createdAt + 7d), absent for one-shot. */
  expiresAt?: string;
  /** Number of times this definition has fired. */
  firedCount: number;
  /** ISO timestamp of the last fire; the resume anchor for due computation. */
  lastFiredAt?: string;
}

export interface CronFireRecord {
  definitionId: string;
  /** Scheduled due minute (epoch ms) this record guards. */
  dueMs: number;
  pid: number;
  claimedAt: string;
  /** Run ID once dispatched, or an error note when the fire failed. */
  runId?: string;
  error?: string;
}

export interface CronStore {
  list(): CronDefinition[];
  get(id: string): CronDefinition | null;
  /** Create + persist; `now` seeds createdAt/expiresAt. */
  create(input: {
    cron: string;
    workflow: string;
    kind: "one-shot" | "recurring";
    name?: string;
    args?: unknown;
  }): CronDefinition;
  delete(id: string): boolean;
  /**
   * Atomically claim the fire slot `(id, dueMs)`. Returns the claimed record,
   * or null when another LIVE process already owns it (dead-owner records are
   * swept and retried once). The winner is responsible for dispatching and
   * then calling markFired().
   */
  claimFire(id: string, dueMs: number): CronFireRecord | null;
  /** Stamp a claimed fire-record with the runId (or an error note). */
  completeFire(record: CronFireRecord, outcome: { runId?: string; error?: string }): void;
  /** Record a fire on the definition; one-shot definitions are deleted. */
  markFired(id: string, at: string): void;
  /** Drop definitions whose expiresAt has passed. Returns the removed ids. */
  sweepExpired(now: Date): string[];
  /**
   * Delete fire-records older than the recurring-expiry horizon (their
   * definitions have expired, so the slots can never be claimed again).
   * Fire-records otherwise accumulate one file per (definition, due-minute)
   * forever. Returns the number of records removed.
   */
  gcFireRecords(now: Date): number;
}

function generateId(now: Date): string {
  return `cron-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 probes liveness without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

export function createCronStore(stateRoot: string, opts: { now?: () => Date } = {}): CronStore {
  const now = opts.now ?? (() => new Date());
  const cronDir = join(stateRoot, "cron");
  const definitionsPath = join(cronDir, "definitions.json");
  const firesDir = join(cronDir, "fires");

  const ensureDir = () => {
    if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });
    if (!existsSync(firesDir)) mkdirSync(firesDir, { recursive: true });
  };

  const loadDefinitions = (): CronDefinition[] => {
    try {
      const raw = readFileSync(definitionsPath, "utf8");
      const parsed = JSON.parse(raw) as CronDefinition[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const saveDefinitions = (defs: CronDefinition[]): void => {
    ensureDir();
    // NOTE: read-modify-write across processes is deliberately unlocked — the
    // double-fire guard is the fire-record lease, not this file; a lost
    // concurrent write (e.g. a firedCount) degrades bookkeeping only. The
    // pid-suffixed tmp keeps two concurrent savers from clobbering each
    // other's tmp mid-rename.
    const json = JSON.stringify(defs, null, 2);
    const tmp = `${definitionsPath}.${process.pid}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, definitionsPath);
  };

  const fireRecordPath = (id: string, dueMs: number): string => join(firesDir, `${id}-${dueMs}.json`);

  const readFireRecord = (id: string, dueMs: number): CronFireRecord | null => {
    try {
      return JSON.parse(readFileSync(fireRecordPath(id, dueMs), "utf8")) as CronFireRecord;
    } catch {
      return null;
    }
  };

  return {
    list(): CronDefinition[] {
      return loadDefinitions();
    },

    get(id: string): CronDefinition | null {
      return loadDefinitions().find((d) => d.id === id) ?? null;
    },

    create(input): CronDefinition {
      const at = now();
      const def: CronDefinition = {
        id: generateId(at),
        name: input.name?.trim() || input.workflow,
        cron: input.cron,
        kind: input.kind,
        workflow: input.workflow,
        args: input.args,
        createdAt: at.toISOString(),
        expiresAt:
          input.kind === "recurring" ? new Date(at.getTime() + CRON_RECURRING_EXPIRY_MS).toISOString() : undefined,
        firedCount: 0,
      };
      saveDefinitions([...loadDefinitions(), def]);
      return def;
    },

    delete(id: string): boolean {
      const defs = loadDefinitions();
      const next = defs.filter((d) => d.id !== id);
      if (next.length === defs.length) return false;
      saveDefinitions(next);
      return true;
    },

    claimFire(id: string, dueMs: number): CronFireRecord | null {
      ensureDir();
      const path = fireRecordPath(id, dueMs);
      for (let attempt = 0; attempt < 2; attempt++) {
        const record: CronFireRecord = {
          definitionId: id,
          dueMs,
          pid: process.pid,
          claimedAt: now().toISOString(),
        };
        try {
          writeFileSync(path, JSON.stringify(record, null, 2), { flag: "wx" });
          return record;
        } catch (err) {
          if ((err as { code?: string }).code !== "EEXIST") throw err;
          // Existing record: a live owner blocks us; a dead owner is stale —
          // sweep once and retry (the winner crashed after claiming).
          // Known TOCTOU: between read and unlink a THIRD process can sweep +
          // re-claim (fresh live pid), which this unlink then deletes — two
          // owners for one slot. Requires a dead owner plus two interleaved
          // sweepers in the same instant; accepted (records also GC after the
          // 7-day horizon).
          const existing = readFireRecord(id, dueMs);
          if (existing && pidIsAlive(existing.pid)) return null;
          try {
            unlinkSync(path);
          } catch {
            return null;
          }
        }
      }
      return null;
    },

    completeFire(record, outcome): void {
      try {
        writeFileSync(
          fireRecordPath(record.definitionId, record.dueMs),
          JSON.stringify({ ...record, ...outcome }, null, 2),
        );
      } catch {
        // Fire-records are the double-fire guard, not a ledger — best effort.
      }
    },

    markFired(id: string, at: string): void {
      const defs = loadDefinitions();
      const idx = defs.findIndex((d) => d.id === id);
      const def = idx >= 0 ? defs[idx] : undefined;
      if (!def) return; // deleted meanwhile (e.g. by hand) — nothing to stamp
      if (def.kind === "one-shot") {
        // One-shot: the definition's single fire is done — delete it.
        saveDefinitions(defs.filter((d) => d.id !== id));
        return;
      }
      defs[idx] = { ...def, firedCount: def.firedCount + 1, lastFiredAt: at };
      saveDefinitions(defs);
    },

    sweepExpired(nowDate: Date): string[] {
      const defs = loadDefinitions();
      const expired = defs.filter((d) => d.expiresAt && Date.parse(d.expiresAt) <= nowDate.getTime());
      if (expired.length)
        saveDefinitions(defs.filter((d) => !d.expiresAt || Date.parse(d.expiresAt) > nowDate.getTime()));
      return expired.map((d) => d.id);
    },

    gcFireRecords(nowDate: Date): number {
      if (!existsSync(firesDir)) return 0;
      let removed = 0;
      const horizon = nowDate.getTime() - CRON_RECURRING_EXPIRY_MS;
      for (const file of readdirSync(firesDir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const record = JSON.parse(readFileSync(join(firesDir, file), "utf8")) as CronFireRecord;
          const claimedAt = Date.parse(record.claimedAt ?? "");
          if (Number.isFinite(claimedAt) && claimedAt < horizon) {
            unlinkSync(join(firesDir, file));
            removed += 1;
          }
        } catch {
          // Unreadable/unparseable record — leave it; it GCs once old, or a
          // claim attempt sweeps it if its pid is dead.
        }
      }
      return removed;
    },
  };
}
