// src/handlers/planning-backfill.ts — background backfill of the .planning card
// mirror (Phase-2 / 09-impl T6). Mirrors session-backfill.ts house-style: deferred
// via setTimeout(0) so session_start resolves first; run-state guard so two
// backfills never overlap in-process; MAX_FILES bound so a huge corpus can't
// stall startup. Idempotency = the mirror's hash-skip (re-mirroring unchanged
// files is a cheap hash-compare no-op — there is NO separate run-state file; a
// re-run resumes because unchanged cards hash-match-skip).
//
// The actual mirror reuses walkAndIngest's planning path (hash-compare
// INSERT/UPDATE/skip + conflict-marker flag — delete reconciliation is
// SUPPRESSED here via partialWalk, see below). It is
// invoked PLANNING-ONLY (opts.planningOnly) so the zk knowledge path is skipped
// entirely — planning is hermes-internal and has no zk dependency, and passing
// the bounded file list scopes the walk to exactly the .planning corpus (no
// full-repo re-walk on every startup).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { walkAndIngest } from "../walk-and-ingest.js";
import { createCardStore } from "../store/card-store.js"; // 10-impl T5 — sweep's short-lived store
import { computeStaleness } from "../store/planning-staleness.js"; // 10-impl T5 — compare-only sweep

export const PLANNING_BACKFILL_MAX_FILES = 50;

type NotifyLevel = "info" | "warning" | "error";
type NotifyFn = (message: string, level: NotifyLevel) => void;
type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

export interface PlanningBackfillState {
  inProgress: boolean;
  promise: Promise<void> | null;
}

export const planningBackfillState: PlanningBackfillState = {
  inProgress: false,
  promise: null,
};

export interface SchedulePlanningBackfillOptions {
  notify?: NotifyFn;
  state?: PlanningBackfillState;
  setTimeoutFn?: SetTimeoutFn;
  maxFiles?: number;
}

/** Collect up to `maxFiles` planning-card md files under <repoRoot>/.planning.
 *  A cheap .planning-scoped recursive scan (NOT the full-repo walk) so startup
 *  cost stays bounded. Non-card .planning md (specs/plans/flat/sdd) is collected
 *  too but later classified out by walkKnowledgeSources (only map.md and
 *  tickets/NN-slug.md are real planning-cards) — collecting them is harmless
 *  (a few extra lstats) and keeps this scan a pure directory walk. */
function collectPlanningMdFiles(repoRoot: string, maxFiles: number): string[] {
  const out: string[] = [];
  const planningDir = join(repoRoot, ".planning");
  const recurse = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) recurse(abs);
      else if (name.endsWith(".md")) out.push(abs);
    }
  };
  recurse(planningDir);
  return out;
}

function notifyBestEffort(notify: NotifyFn | undefined, message: string, level: NotifyLevel): void {
  try {
    notify?.(message, level);
  } catch {
    /* Notification failures must never affect backfill. */
  }
}

/** Schedule a best-effort, bounded background re-mirror of .planning/. Mirrors
 *  scheduleSessionBackfill: deferred setTimeout(0); run-state guard; MAX_FILES
 *  bound; best-effort notify. The actual mirror reuses walkAndIngest's planning
 *  path in PLANNING-ONLY + PARTIAL-WALK mode (hash-compare INSERT/UPDATE/skip +
 *  conflict-marker scan; the hash-skip makes unchanged files cheap). Reconcile
 *  is SUPPRESSED (the bounded list is a subset, not a complete present-set —
 *  09-impl final review A). Returns true when a backfill was scheduled; false
 *  when skipped (already in progress). */
export function schedulePlanningBackfill(
  repoRoot: string,
  memoryDir: string,
  options: SchedulePlanningBackfillOptions = {},
): boolean {
  const state = options.state ?? planningBackfillState;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const maxFiles = options.maxFiles ?? PLANNING_BACKFILL_MAX_FILES;

  if (state.inProgress) return false;

  state.inProgress = true;
  state.promise = new Promise<void>((resolve) => {
    setTimeoutFn(async () => {
      try {
        const files = collectPlanningMdFiles(repoRoot, maxFiles);
        if (files.length === 0) return;
        // walkAndIngest runs the hash-compare mirror + conflict-marker scan
        // against these files in PLANNING-ONLY mode. partialWalk:true SUPPRESSES
        // delete reconciliation — the bounded file list is a subset, not a
        // complete present-set, so reconcile would mass-delete out-of-window
        // cards whose md still exists (09-impl final review A). Reconcile runs
        // only on the full knowledge-ingest walk. The planning classifier keys
        // off the `.planning` segment in each abs path, which the collected
        // paths retain — so the bounded file list scopes the mirror exactly.
        await walkAndIngest(files, { memoryDir, planningOnly: true, partialWalk: true });
        // 10-impl T5: staleness sweep — seed dep baselines for newly-mirrored
        // planning-ticket cards + FLAG stale (compare-only after the first-touch
        // seed). MUST NOT re-baseline drifted cards: that would wipe stale state
        // on every session_start, contradicting γ (staleness survives until an
        // explicit re-validate via refreshStaleness — the sole re-baseline op).
        // The sweep's observable WRITE is seeding baselines so a dep change DURING
        // a session is detectable at graduation. Best-effort: a staleness failure
        // must NEVER break the mirror/backfill (outer + per-card try/catch).
        // Runs AFTER walkAndIngest so the ticket rows exist to enumerate.
        try {
          const stStore = await createCardStore({ memoryDir });
          try {
            const tickets = await stStore.getCardsByKind("planning-ticket");
            for (const t of tickets) {
              try {
                await computeStaleness(stStore, t.id, repoRoot);
              } catch {
                /* one bad card must not abort the sweep */
              }
            }
          } finally {
            await stStore.close();
          }
        } catch {
          /* staleness sweep is best-effort */
        }
        notifyBestEffort(options.notify, `🧠 Planning backfill complete: scanned ${files.length} .planning file(s).`, "info");
      } catch (err) {
        notifyBestEffort(
          options.notify,
          `⚠️ Planning backfill failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      } finally {
        state.inProgress = false;
        state.promise = null;
        resolve();
      }
    }, 0);
  });
  return true;
}

/** Wait briefly for an in-progress planning backfill before shutdown (mirrors
 *  waitForSessionBackfill). */
export async function waitForPlanningBackfill(
  timeoutMs = 5000,
  state: PlanningBackfillState = planningBackfillState,
): Promise<boolean> {
  const promise = state.promise;
  if (!state.inProgress || !promise) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
