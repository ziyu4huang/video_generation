/**
 * Heat-provider builder — the bridge across MemoryStore's DB-free boundary
 * (UPSP §1 decay, ticket #1b, Task 3).
 *
 * The store must NOT hold a direct `MemoryRepository`/`SessionRepository`
 * reference, so the per-entry heat score is computed here (where both repos
 * live) and handed back to the store as a pure `Map<mdId, heat>`. This mirrors
 * the established `setSupersededContentProvider` / `setStableIdBackfillProvider`
 * injection pattern — `index.ts` builds one closure per store (global store →
 * `project:null`, projectStore → `projectName`) and injects it.
 *
 * The closure is **best-effort by construction**: it NEVER throws — on any repo
 * failure it returns an empty `Map`, which the store's `computeHeats` helper
 * normalizes to `null` → callers fall back to current FIFO. Heat never blocks
 * eviction.
 */

import { computeHeat, resolveDecayConfig } from "../store/heat.js";
import type { HeatEntryInput } from "../store/memory-store.js";
import type { MemoryRepository, MemoryTarget, SessionRepository } from "../store/repository.js";

/** Repository surface `makeHeatProvider` needs (structural, for easy stubbing). */
export interface HeatProviderRepos {
  memoryRepo: Pick<MemoryRepository, "getMemories">;
  sessionRepo: Pick<SessionRepository, "getUsedMdIds">;
}

/** Raw decay config subset accepted by `resolveDecayConfig`. */
export type DecayConfigInput = Parameters<typeof resolveDecayConfig>[0];

/**
 * The disable-path gate (a first-class invariant). `decayEnabled` defaults to
 * `true`; ONLY an explicit `false` disables heat. When disabled, `index.ts`
 * does NOT attach the provider → the store sees `null` → eviction/consolidation
 * revert to pre-#1b FIFO (byte-identical parity). Extracted as a named function
 * so the disable invariant is unit-tested directly.
 */
export function shouldWireHeat(config: { decayEnabled?: boolean }): boolean {
  return config.decayEnabled !== false;
}

/**
 * Build a heat-provider closure that crosses MemoryStore's DB-free boundary.
 *
 * @param config   Raw decay config subset (knobs resolved via `resolveDecayConfig`).
 * @param repos    The two repos (memoryRepo for `mw_*`, sessionRepo for `used_at`).
 * @param project  This store's row scope (global store → `null`, projectStore →
 *                 `projectName`). Bound into the closure so the store itself
 *                 stays scope-agnostic. Note: `session_assembly` is a global
 *                 provenance ledger, so `getUsedMdIds`'s `project` is accepted
 *                 for interface symmetry but ignored (D4's global ever-used) —
 *                 passing the store's `project` here is harmless + symmetric.
 * @returns A `(target, entries) => Promise<Map<mdId, heat>>` that never throws.
 *
 * mw_* fetch method: a single batched `memoryRepo.getMemories({ target, project })`
 * — the whole target's rows in one SELECT, bounded by the `.md` char limit
 * (tens-to-low-hundreds). No per-mdId batch fetch method exists on the repo
 * (`getMemoryByMdId`/`getWorth` are absent), and a bounded loop would need one,
 * so this scoped SELECT is the best-fit existing batch method. Legacy entries
 * with no DB row → `mw_success=mw_fail=0` (neutral Laplace 0.5).
 */
export function makeHeatProvider(
  config: DecayConfigInput,
  repos: HeatProviderRepos,
  project: string | null,
): (target: MemoryTarget, entries: HeatEntryInput[]) => Promise<Map<string, number>> {
  const { memoryRepo, sessionRepo } = repos;
  return async (target, entries) => {
    try {
      // Empty entries → empty Map (no repo calls). The store normalizes this to
      // `null` via computeHeats, but the provider contract still returns a Map.
      if (entries.length === 0) return new Map();

      const mdIds = entries.map((e) => e.mdId);
      const want = new Set(mdIds);

      // One batched SELECT for the whole target's rows; keep only the worth
      // triples for mdIds we were asked about. First row per mdId wins (md_id is
      // unique per scope; superseded rows are already purged from the `.md`
      // before heat is consulted, but the first-wins guard is harmless).
      const rows = await memoryRepo.getMemories({ target, project });
      const worth = new Map<string, { mwSuccess: number; mwFail: number }>();
      for (const r of rows) {
        if (r.mdId && want.has(r.mdId) && !worth.has(r.mdId)) {
          worth.set(r.mdId, { mwSuccess: r.mwSuccess ?? 0, mwFail: r.mwFail ?? 0 });
        }
      }

      // Global ever-used boolean (D4): `session_assembly` is project-agnostic.
      const used = await sessionRepo.getUsedMdIds(mdIds, { project });

      const cfg = resolveDecayConfig(config);
      const now = new Date();
      const heats = new Map<string, number>();
      for (const e of entries) {
        // No DB row (legacy / not-yet-synced) → neutral Laplace 0.5 (heat
        // reflects recency + used-only). This is the safe direction: an unknown
        // entry must never be inflated by a phantom worth signal.
        const w = worth.get(e.mdId) ?? { mwSuccess: 0, mwFail: 0 };
        heats.set(
          e.mdId,
          computeHeat(
            {
              lastReferenced: e.lastReferenced,
              created: e.created,
              mwSuccess: w.mwSuccess,
              mwFail: w.mwFail,
              usedExists: used.has(e.mdId),
              now,
            },
            cfg,
          ),
        );
      }
      return heats;
    } catch {
      // Best-effort envelope: NEVER let a repo failure escape. An empty Map →
      // the store's computeHeats normalizes to null → FIFO fallback. Heat must
      // never block eviction.
      return new Map();
    }
  };
}
