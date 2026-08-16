/**
 * composition/events/session-start.ts — slice 08b2-2 of the index.ts decomposition.
 *
 * Extracted VERBATIM (behavior preserved) from index.ts L355-463:
 * - registerSessionStart ← the `pi.on("session_start", ...)` block through its
 *   closing `});`, registering the session-start lifecycle: backend notify,
 *   extension-root migration guard, perf notifier wiring, skill-context
 *   refresh, disk loads, stable-id backfill, session + planning backfills,
 *   and the UPSP §5/§9 prompt-assembly capture.
 *
 * De-closured: every closure variable the body captured from index.ts scope
 * becomes a `ctx` field read on HermesCtx (config, store, projectStore,
 * skillStore, sessionRepo, sessionsDir, globalDir, legacyGlobalDir, perf,
 * backend, projectName, activeSession, surfacedSignatures,
 * shouldMigrateExtensionRoot/migrationDone). The two `let` locals map to
 * holders: `extensionRootMigrated` → ctx.migrationDone()/ctx.markMigrationDone(),
 * `activeSessionId` → ctx.activeSession.get()/set(). `backendLabel` /
 * `backendFellBack` → ctx.backend.get().label / ctx.backend.fellBack.
 *
 * The pi session_start event context is renamed `ctx` → `evt` so it cannot
 * shadow the HermesCtx `ctx` param; usage sites are unchanged otherwise.
 *
 * Helpers called directly: migrateExtensionRoot, refreshSkillProjectContext
 * (its 08b2-1 de-closured signature: skillStore + projectsMemoryDir + cwd),
 * scheduleSessionBackfill, schedulePlanningBackfill, captureAssembly,
 * buildPromptAssembly.
 *
 * index.ts still holds its own copy until the rewire slice — this module
 * must typecheck standalone; it is not imported yet.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HermesCtx } from "../stores.js";
import { migrateExtensionRoot } from "../../extension-root-migration.js";
import { refreshSkillProjectContext } from "../project-skills.js";
import { scheduleSessionBackfill } from "../../handlers/session-backfill.js";
import { schedulePlanningBackfill } from "../../handlers/planning-backfill.js";
import { captureAssembly } from "../../handlers/session-assembly.js";
import { buildPromptAssembly } from "../../prompt-context.js";

/** ← L355-463: the session_start handler, de-closured onto HermesCtx. */
export function registerSessionStart(pi: ExtensionAPI, ctx: HermesCtx): void {
  pi.on("session_start", async (_event, evt) => {
    // Surface the active memory/search backend once per session start so the
    // user can see at a glance whether hermes-memory is on sqlite or surrealdb
    // (and where). Transient info notify; no-op if the host provides no ui.
    {
      const ui = (evt as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
      ui?.notify?.(`🧠 hermes-memory backend: ${ctx.backend.get().label}`, "info");
      if (ctx.backend.fellBack) {
        ui?.notify?.(`⚠️ SurrealDB was unreachable — hermes-memory fell back to sqlite for this session. Start SurrealDB then /memory-switch-backend surrealdb to restore.`, "warn");
      }
    }
    if (ctx.shouldMigrateExtensionRoot && !ctx.migrationDone()) {
      try {
        await migrateExtensionRoot(ctx.legacyGlobalDir, ctx.globalDir);
      } catch {
        // best effort migration only
      }
      ctx.markMigrationDone();
    }

    // Wire perf breach alerts to the TUI for this session.
    ctx.perf.setNotifier((r) => {
      const why = r.reason === "roundTrips" ? `${r.roundTrips} HTTP round-trips` : `${r.ms}ms`;
      const ui = (evt as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
      // Consolidation is an expected, always-logged event — surface at info, not
      // an alarming ⚠️ breach warn.
      if (r.kind === "consolidation") {
        ui?.notify?.(`hermes perf: ${r.op} ran ${why} (backend=${r.backend})`, "info");
      } else {
        ui?.notify?.(`⚠️ hermes perf: ${r.op} took ${why} (backend=${r.backend})`, "warn");
      }
    });

    refreshSkillProjectContext(ctx.skillStore, ctx.config.projectsMemoryDir, evt.cwd);
    await ctx.skillStore.migrateLegacySkills();
    await ctx.skillStore.ensureDiscoveredRoots();
    await ctx.store.loadFromDisk();
    if (ctx.projectStore) await ctx.projectStore.loadFromDisk();

    // Task 4: one-shot idempotent backfill of the 5d stable-id migration. Runs
    // AFTER loadFromDisk() so the in-memory `.md` entries are populated. Wrapped
    // in try/catch so a backfill failure NEVER aborts agent startup or trips
    // the sqlite fallback — the per-entry DB mirror is already best-effort inside
    // backfillStableIds(); this outer guard covers load/parse/disk-write faults.
    try {
      await ctx.store.backfillStableIds();
      await ctx.projectStore?.backfillStableIds();
    } catch {
      /* never block startup */
    }

    scheduleSessionBackfill(ctx.sessionRepo, ctx.sessionsDir, {
      timed: ctx.perf.timed,
      notify: (message, level) => {
        const ui = (evt as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
        if (ui?.notify) {
          ui.notify(message, level);
        } else if (level === "error" || level === "warning") {
          console.warn(message);
        } else {
          console.info(message);
        }
      },
    });

    // Phase-2 (knowledge-pipeline / ticket 09 T6): background re-mirror of
    // .planning/. Best-effort, bounded, run-state-guarded — mirrors
    // scheduleSessionBackfill. Deferred via setTimeout(0) so session_start
    // resolves first; heals .planning drift without blocking startup. A failure
    // must NEVER abort agent startup.
    try {
      schedulePlanningBackfill(evt.cwd, ctx.globalDir, {
        notify: (message, level) => {
          const ui = (evt as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
          if (ui?.notify) ui.notify(message, level);
          else if (level === "error" || level === "warning") console.warn(message);
          else console.info(message);
        },
      });
    } catch {
      /* never block startup */
    }

    // Per-session prompt-provenance (UPSP §5): capture the assembled md_id set
    // + block hash ONCE per session. Best-effort — never abort startup. Mirrors
    // the backfillStableIds guard: a missing sid / null assembly (policy-only or
    // empty store) skips the record; a throwing recordAssembly is swallowed.
    //
    // UPSP §9 / Task 6: bind the active session id (read by setupUsedDetection's
    // turn_end closure) and hand captureAssembly an `onReceipt` callback that
    // populates `surfacedSignatures` from the SAME receipt #05 just recorded —
    // the §5↔§9 join invariant (one build feeds both record + the matcher). The
    // populate is gated on `usedDetection !== false` (default on, INDEPENDENT of
    // worthScoring): disabled ⇒ onReceipt is undefined ⇒ the set stays empty ⇒
    // matchAndForget always returns [] ⇒ markUsed never fires.
    ctx.activeSession.set((evt as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.());
    await captureAssembly({
      getSessionId: () => ctx.activeSession.get(),
      build: () => buildPromptAssembly(ctx.config, ctx.store, ctx.projectStore, ctx.projectName),
      record: (sid, mdIds, hash) => ctx.sessionRepo.recordAssembly(sid, mdIds, hash),
      onReceipt: ctx.config.usedDetection !== false
        ? (r) => ctx.surfacedSignatures.populate(r.signatures)
        : undefined,
    });
  });
}
