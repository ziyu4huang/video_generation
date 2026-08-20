/**
 * composition/events/session-shutdown.ts — slice 08b2-3 of the index.ts decomposition.
 *
 * Extracted VERBATIM (behavior preserved) from index.ts L672-732:
 * - registerSessionShutdown ← the `pi.on("session_shutdown", ...)` block, the
 *   final shutdown slice (12 of the original registration sequence): stale-seam
 *   teardown, drain of in-flight background writers, session indexing +
 *   session_files meta upsert, and the backend close (WAL truncation).
 *
 * The last-registration comment block above the handler is KEPT verbatim: this
 * must stay the final session_shutdown registration so close() runs after the
 * session-flush handler.
 *
 * De-closured: every closure variable the body captured from index.ts scope
 * becomes a `ctx` field read on HermesCtx (sessionRepo, perf, bundle —
 * `currentBundle` → ctx.bundle.get()). Module imports stay module imports
 * (unpublishStaleCheck, parseSessionFile, the waitFor* drains + timeout
 * constants, node:fs require).
 *
 * The pi session_shutdown event context is renamed `ctx` → `evt` so it cannot
 * shadow the HermesCtx `ctx` param; usage sites are unchanged otherwise.
 *
 * index.ts still holds its own copy until the rewire slice — this module
 * must typecheck standalone; it is not imported yet.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HermesCtx } from "../stores.js";
import { waitForSessionBackfill, SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS } from "../../handlers/session-backfill.js";
import { waitForPlanningBackfill } from "../../handlers/planning-backfill.js";
import { waitForLiveSessionIndex, SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS } from "../../handlers/session-live-index.js";
import { parseSessionFile } from "../../store/session-parser.js";
import { unpublishStaleCheck } from "../../stale-seam.js";

/** ← L672-732: the session_shutdown handler, de-closured onto HermesCtx. */
export function registerSessionShutdown(pi: ExtensionAPI, ctx: HermesCtx): void {
  // Registered last, so this runs after the session-flush shutdown handler and
  // is the final DB activity. Closing here truncates the WAL via
  // PRAGMA wal_checkpoint(TRUNCATE); without it the WAL only grows to its
  // high-water mark and is never reclaimed across sessions.
  //
  // Ordering is safe: Pi's ExtensionRunner.emit() runs same-extension handlers
  // sequentially in registration order and awaits each one, so the flush above
  // fully completes before close() runs. WARNING: do not register another
  // DB-writing session_shutdown handler after this block — it would run after
  // close() and silently no-op.
  pi.on("session_shutdown", async (_event, evt) => {
    // 10-impl T7: clear the staleness reverse seam first (best-effort) so the
    // globalThis reader is gone even if the DB drain below throws. Mirrors
    // unpublishWayfindGrill's lifecycle.
    try {
      unpublishStaleCheck();
    } catch {
      /* best effort */
    }
    // DRAIN in-flight background writers (live-index + backfill) BEFORE
    // indexSession. These background tasks share the DB's write lock with
    // indexSession; running them concurrently made indexSession block under
    // transient retry and its contended commit failed to persist. Draining
    // first lets indexSession run uncontended and commit cleanly. Applies to
    // the SQLite fallback path (single write lock) and is a harmless ordering
    // guarantee on the active Surreal backend.
    try {
      await Promise.all([
        waitForSessionBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
        waitForLiveSessionIndex(SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS),
        // T6(a): drain in-flight planning backfill too (graceful shutdown,
        //  consistency with session backfill, prevents orphaned timers).
        waitForPlanningBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
      ]);
    } catch { /* best-effort drain — never block shutdown */ }

    try {
      const sessionFile = evt.sessionManager.getSessionFile();
      if (sessionFile && require("node:fs").existsSync(sessionFile)) {
        const sessionData = parseSessionFile(sessionFile);
        if (sessionData) {
          // The repository methods already wrap recovery + transient retry, so
          // there is no need to wrap them in backend.withCorruptionRecovery here.
          await ctx.perf.timed("shutdown.indexSession", () => ctx.sessionRepo.indexSession(sessionData));
          // Keep session_files metadata in sync with the final on-disk state.
          // Pi appends the closing session entry on shutdown after the last
          // message_end, so without this upsert the stored size/mtime would be
          // stale and the next startup would re-parse this file unnecessarily.
          await ctx.sessionRepo.upsertSessionFileMeta(sessionFile, sessionData.id);
        }
      }
    } catch { /* Silent fail — don't block shutdown */ }
    finally {
      try {
        await ctx.bundle.get().backend.close();
      } catch { /* best effort — never block shutdown */ }
    }
  });
}
