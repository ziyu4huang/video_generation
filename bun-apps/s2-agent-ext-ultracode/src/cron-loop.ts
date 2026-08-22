/**
 * The session-live cron loop (ticket 08): a 30 s interval started at
 * `session_start`, stopped at `session_shutdown`. Each tick sweeps expired
 * recurring definitions, finds definitions with a due fire, claims the
 * `(id, due)` fire-record (the cross-session double-fire guard), resolves the
 * workflow script, and dispatches via `WorkflowManager.startInBackground`.
 *
 * Firing is SESSION-LIVE ONLY (map D8): no daemon — when no session is open,
 * nothing fires; missed slots are skipped, not replayed (the fire anchor jumps
 * to the fire time, so at most one catch-up fire per definition per tick).
 */

import { type CronFields, nextFire, parseCronExpression } from "./cron-scheduler.js";
import type { CronStore } from "./cron-store.js";
import type { WorkflowLogger } from "./logger.js";

/** The dispatch seam — WorkflowManager satisfies this; tests pass a fake. */
export interface CronDispatch {
  startInBackground(script: string, args?: unknown): { runId: string };
}

/** Script seam — resolves a workflow name/path to script text (null = gone). */
export type CronScriptResolver = (workflow: string) => string | null;

export const CRON_TICK_MS = 30_000;

export interface CronTickResult {
  /** Definitions that fired this tick: [id, dueMs, runId]. */
  fired: Array<{ id: string; dueMs: number; runId: string }>;
  /** Due slots skipped because another live session claimed the fire-record. */
  lostClaims: string[];
  /** Due slots whose workflow could not be resolved (fired as an error, no retry). */
  failed: string[];
  /** Expired recurring definitions swept this tick. */
  expired: string[];
}

/** One scheduler pass. Exported for tests — the loop itself just calls this. */
export function runCronTick(
  store: CronStore,
  dispatch: CronDispatch,
  resolveScript: CronScriptResolver,
  now: Date,
  logger?: WorkflowLogger,
): CronTickResult {
  const result: CronTickResult = { fired: [], lostClaims: [], failed: [], expired: store.sweepExpired(now) };

  for (const def of store.list()) {
    if (def.expiresAt && Date.parse(def.expiresAt) <= now.getTime()) continue; // swept above; guard races
    let fields: CronFields | undefined;
    try {
      fields = parseCronExpression(def.cron);
    } catch (err) {
      // A hand-edited definitions.json can hold garbage — quarantine, don't crash the loop.
      logger?.warn(
        `cron: definition ${def.id} has invalid expression "${def.cron}" (${(err as Error).message}); skipping`,
      );
      continue;
    }
    // Anchor on the last fire (or creation) — missed slots before `now` fire at
    // most once: the claim key is the due minute, and markFired moves the anchor.
    const anchor = new Date(def.lastFiredAt ?? def.createdAt);
    const due = nextFire(fields, anchor);
    if (!due || due.getTime() > now.getTime()) continue;

    const claim = store.claimFire(def.id, due.getTime());
    if (!claim) {
      result.lostClaims.push(def.id);
      continue;
    }
    const script = resolveScript(def.workflow);
    if (script == null) {
      // Record the failure so a deleted/renamed workflow doesn't retry every 30 s.
      store.completeFire(claim, { error: `workflow "${def.workflow}" could not be resolved` });
      store.markFired(def.id, now.toISOString());
      result.failed.push(def.id);
      logger?.warn(`cron: definition ${def.id}: workflow "${def.workflow}" unresolvable; fire recorded as failed`);
      continue;
    }
    const { runId } = dispatch.startInBackground(script, def.args);
    store.completeFire(claim, { runId });
    store.markFired(def.id, now.toISOString());
    result.fired.push({ id: def.id, dueMs: due.getTime(), runId });
    logger?.log(`cron: fired ${def.name} (${def.id}) → run ${runId}`);
  }
  return result;
}

export interface CronLoopHandle {
  stop(): void;
}

/** Start the 30 s interval. Returns a handle whose stop() clears it (wired to
 *  `session_shutdown`). `tickMs` is injectable so tests don't wait 30 s. */
export function startCronSchedulerLoop(options: {
  store: CronStore;
  dispatch: CronDispatch;
  resolveScript: CronScriptResolver;
  logger?: WorkflowLogger;
  tickMs?: number;
}): CronLoopHandle {
  const { store, dispatch, resolveScript, logger, tickMs = CRON_TICK_MS } = options;
  const tick = () => {
    try {
      runCronTick(store, dispatch, resolveScript, new Date(), logger);
    } catch (err) {
      // The loop must survive its own ticks — log and keep scheduling.
      logger?.warn(`cron: tick failed: ${(err as Error).message}`);
    }
  };
  // First pass soon after start (a definition may already be due), then interval.
  const initial = setTimeout(tick, 1_000);
  const interval = setInterval(tick, tickMs);
  initial.unref?.();
  interval.unref?.();
  return {
    stop() {
      clearTimeout(initial);
      clearInterval(interval);
    },
  };
}
