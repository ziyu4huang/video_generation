/**
 * The session-live wakeup registry (cc-parity-2 ticket 06, map D7): in-memory
 * pending wakeups for `/loop` + the `schedule_wakeup` tool. Wakeups are NOT
 * durable — they never enter `cron-store.ts`'s leased space, there is no
 * daemon, and they die with the session (`session_shutdown` clears the
 * registry). This matches CC's session-scoped ScheduleWakeup.
 *
 * One pending wakeup per loop id: a new schedule for the same id replaces the
 * pending one (fixed-mode reschedule and the tool both rely on this). A fixed
 * loop auto-reschedules after each fire; a dynamic loop re-arms only when the
 * model calls `schedule_wakeup` during the fired turn — if it doesn't, the
 * loop simply ends (no pending wakeup remains; see runWakeupTick for why no
 * `ended` event can exist for that case).
 *
 * Runaway guard: each entry counts fires against a hard cap (default 50) —
 * reaching the cap auto-stops the loop with an `ended` notification instead of
 * firing forever.
 */

import type { WorkflowLogger } from "./logger.js";

/** Hard cap on fires per loop per session (runaway guard; CC has no explicit counterpart). */
export const WAKEUP_FIRE_CAP = 50;

/** delaySeconds clamp bounds — mirrors CC's ScheduleWakeup. */
export const WAKEUP_MIN_DELAY_S = 60;
export const WAKEUP_MAX_DELAY_S = 3600;

/** Default fixed-cadence delay when `/loop <prompt>` is given no interval (CC default: 10m). */
export const WAKEUP_DEFAULT_DELAY_S = 600;

export const WAKEUP_TICK_MS = 30_000;

export interface WakeupEntry {
  /** Loop id — one pending wakeup per id; the fire footer cites it. */
  id: string;
  /** The ORIGINAL `/loop` prompt (fired verbatim each wake, plus a footer). */
  prompt: string;
  /** Epoch ms of the next fire. */
  dueAt: number;
  /** fixed: auto-reschedule at a constant delay; dynamic: the model re-arms via the tool. */
  mode: "fixed" | "dynamic";
  /** Fixed mode: the reschedule delay in seconds. */
  delaySeconds?: number;
  /** Last wakeup reason (from the tool or the footer instruction) — surfaced in the footer. */
  lastReason?: string;
  /** Fires so far this session (runaway cap). */
  fireCount: number;
}

export interface WakeupTickResult {
  /** Entries fired this tick: the fired prompt includes the loop footer. */
  fired: Array<{ id: string; prompt: string; fireCount: number }>;
  /** Loop ids that ended this tick (dynamic never re-armed / cap reached / told to stop). */
  ended: Array<{ id: string; reason: string }>;
}

/** The fire seam — the extension wires `pi.sendUserMessage(prompt, {deliverAs:
 *  "followUp"})` and marks the loop as the session's active one (the fired
 *  turn's schedule_wakeup call targets it). */
export type WakeupFire = (loopId: string, prompt: string) => void | Promise<void>;

/** Notification seam for loop-end events (display message + logger in the extension). */
export type WakeupNotify = (message: string) => void;

export class WakeupRegistry {
  private entries = new Map<string, WakeupEntry>();
  /** Snapshot of each loop's last-fired state — the dynamic tool re-arms from it. */
  private last = new Map<string, WakeupEntry>();

  /** Schedule (or replace) the pending wakeup for an id. */
  schedule(entry: Omit<WakeupEntry, "fireCount"> & { fireCount?: number }): WakeupEntry {
    const full: WakeupEntry = { fireCount: entry.fireCount ?? 0, ...entry };
    this.entries.set(entry.id, full);
    return full;
  }

  /** Cancel one loop. Returns true when a pending wakeup existed. */
  cancel(id: string): boolean {
    this.last.delete(id);
    return this.entries.delete(id);
  }

  /** Cancel every loop (session_shutdown / /loop off). */
  clear(): void {
    this.entries.clear();
    this.last.clear();
  }

  /** The pending wakeup for an id (undefined once it has fired). */
  get(id: string): WakeupEntry | undefined {
    return this.entries.get(id);
  }

  /** The last-FIRED state for an id (carries the original prompt + fireCount past a fire). */
  lastFired(id: string): WakeupEntry | undefined {
    return this.last.get(id);
  }

  list(): WakeupEntry[] {
    return [...this.entries.values()];
  }

  /** Entries due at `now` — removed from pending (fixed mode re-arms inside the tick;
   *  dynamic mode re-arms from the fired turn via `lastFired`). */
  due(now: Date): WakeupEntry[] {
    const due: WakeupEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.dueAt <= now.getTime()) due.push(entry);
    }
    for (const entry of due) {
      this.entries.delete(entry.id);
      this.last.set(entry.id, entry);
    }
    return due;
  }
}

/** The footer appended to the fired prompt: continue + schedule the next wakeup, or stop. */
export function buildWakeupFooter(entry: WakeupEntry, fireCount: number): string {
  const lines = [
    `--- [wakeup loop ${entry.id} — fire ${fireCount}/${WAKEUP_FIRE_CAP}]`,
    entry.lastReason ? `Last wakeup reason: ${entry.lastReason}` : null,
    entry.mode === "fixed"
      ? "This is a fixed-cadence /loop: carry out the task above; the next fire is already scheduled — do NOT call schedule_wakeup."
      : "Continue the /loop task above, then call schedule_wakeup with delaySeconds + reason to pace the next run (or stop: true when done). If you neither act nor schedule, the loop ends.",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * One wakeup pass. Exported for tests — the loop itself just calls this.
 *
 * Dynamic loops end SILENTLY when the model never re-arms (the tool call
 * happens inside the fired turn, AFTER `fire()` returns — a tick cannot see
 * it, so "did not schedule" is unknowable here by design). The only `ended`
 * event is the fire cap, checked BEFORE firing so a capped loop never fires.
 */
export function runWakeupTick(
  registry: WakeupRegistry,
  fire: WakeupFire,
  now: Date,
  notify?: WakeupNotify,
): WakeupTickResult {
  const result: WakeupTickResult = { fired: [], ended: [] };
  for (const entry of registry.due(now)) {
    if (entry.fireCount >= WAKEUP_FIRE_CAP) {
      result.ended.push({ id: entry.id, reason: `fire cap reached (${WAKEUP_FIRE_CAP}) — loop auto-stopped` });
      continue;
    }
    const fireCount = entry.fireCount + 1;
    const prompt = `${entry.prompt}\n\n${buildWakeupFooter(entry, fireCount)}`;
    result.fired.push({ id: entry.id, prompt, fireCount });
    try {
      fire(entry.id, prompt);
    } catch (err) {
      // The loop must survive its own fires — log via notify and keep going.
      notify?.(`wakeup: fire for loop ${entry.id} failed: ${(err as Error).message}`);
    }
    if (entry.mode === "fixed" && entry.delaySeconds != null) {
      // Auto-reschedule at the constant cadence from the FIRE time, not dueAt —
      // missed slots collapse into one (same anchor discipline as cron). The
      // pre-fire cap check above stops the loop on its next due pass.
      registry.schedule({ ...entry, dueAt: now.getTime() + entry.delaySeconds * 1000, fireCount });
    }
  }
  return result;
}

export interface WakeupLoopHandle {
  stop(): void;
}

/** Start the wakeup interval (sibling of `startCronSchedulerLoop`; same injectable
 *  tick contract). `tickMs` injectable so tests don't wait 30 s. */
export function startWakeupLoop(options: {
  registry: WakeupRegistry;
  fire: WakeupFire;
  notify?: WakeupNotify;
  logger?: WorkflowLogger;
  tickMs?: number;
}): WakeupLoopHandle {
  const { registry, fire, notify, logger, tickMs = WAKEUP_TICK_MS } = options;
  const tick = () => {
    try {
      const result = runWakeupTick(registry, fire, new Date(), notify);
      for (const f of result.fired) logger?.log(`wakeup: fired loop ${f.id} (${f.fireCount}/${WAKEUP_FIRE_CAP})`);
      for (const e of result.ended) notify?.(`[wakeup] loop "${e.id}" ended — ${e.reason}`);
    } catch (err) {
      logger?.warn(`wakeup: tick failed: ${(err as Error).message}`);
    }
  };
  const interval = setInterval(tick, tickMs);
  interval.unref?.();
  return {
    stop() {
      clearInterval(interval);
    },
  };
}
