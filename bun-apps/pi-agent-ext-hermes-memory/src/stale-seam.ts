// src/stale-seam.ts — hermes PUBLISHER of the staleness reverse seam.
//
// Mirrors wayfind's publishWayfindGrill (coordination.ts) but REVERSED: hermes
// owns staleness computation + publishes the reader; wayfind reads it (the
// graduation gate, T8). The key literal is the contract — duplicated verbatim in
// wayfind's src/stale-seam.ts (ADR-wayfind-0004: no cross-package import; globalThis is
// process-singleton, reliable across jiti-loaded extensions).
//
// The reader is ASYNC because staleness is computed from the DB + source files
// at call time (on-access, per ticket-10 Resolution γ). Hermes holds no
// long-lived planning store, so the closure opens an EPHEMERAL CardStore per
// call — exactly like mirrorPlanningToStore / runStaleQuery (T6). Null-safe: on
// ANY failure it returns { stale: [] } so the wayfind gate degrades to a no-op,
// NEVER a false block.
import { createCardStore } from "./store/card-store.js";
import { getStaleCards } from "./store/planning-staleness.js";

/** globalThis key under which hermes publishes the async staleness reader.
 *  Duplicated in wayfind's stale-seam.ts (the contract — no shared import). */
export const HERMES_STALE_CHECK_KEY = "__piHermesStaleCheck";

/** Publish the async staleness reader. `memoryDir` is the hermes memory DB dir
 *  (same dir the planning mirror + the planning_stale tool use). The closure
 *  lazily opens an ephemeral CardStore per call + closes it in a `finally`.
 *  Returns { stale: [] } on ANY failure so a wayfind graduation never
 *  false-blocks. */
export function publishStaleCheck(memoryDir: string): void {
  (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY] = async (
    effort: string | undefined,
    cwd: string,
  ): Promise<{ stale: Array<{ cardId: string; effort: string; missingDeps?: string[] }> }> => {
    let store;
    try {
      store = await createCardStore({ memoryDir });
    } catch {
      // Store won't open (missing/unwritable dir, locked DB) — degrade so the
      // wayfind gate proceeds. Nothing to close.
      return { stale: [] };
    }
    try {
      const stale = await getStaleCards(store, effort, cwd);
      return { stale };
    } catch {
      // compute threw — degrade rather than crash the caller.
      return { stale: [] };
    } finally {
      try {
        await store.close();
      } catch {
        /* best effort — never block on a close fault */
      }
    }
  };
}

/** Remove the reader (session_shutdown / unload). Mirrors unpublishWayfindGrill. */
export function unpublishStaleCheck(): void {
  delete (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY];
}
