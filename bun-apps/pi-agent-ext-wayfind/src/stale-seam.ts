// src/stale-seam.ts — wayfind READER of hermes's staleness reverse seam.
//
// Mirrors grill-seam.ts: the key literal is duplicated from hermes's
// src/stale-seam.ts (globalThis is the contract — a cross-extension import is
// not reliable under jiti). If hermes is absent or the seam throws, this returns
// null → the graduation gate (wayfinder.closeEffortReflection, T8) degrades to a
// no-op, NEVER crashes. The StaleCard type is duplicated too (no shared import —
// ADR-0004); it is structurally compatible with hermes's StaleCard.

/** Duplicated literal — also defined in hermes-memory's src/stale-seam.ts. */
const HERMES_STALE_CHECK_KEY = "__piHermesStaleCheck";

/** Minimal cross-seam stale-decision descriptor. Duplicated (no shared import)
 *  from hermes-memory's StaleCard — structurally compatible. `missingDeps` is
 *  present only when one or more deps are absent on disk. */
export interface StaleCard {
  cardId: string;
  effort: string;
  missingDeps?: string[];
}

/** Read stale planning decisions for `effort` from hermes-memory via globalThis.
 *  Returns null when hermes is absent (`typeof fn !== "function"`) OR the seam
 *  throws — the T8 graduation gate then proceeds (no-op). Async because hermes
 *  computes staleness from the DB + source files at call time. */
export async function readStaleDecisions(effort: string, cwd: string): Promise<StaleCard[] | null> {
  const fn = (globalThis as Record<string, unknown> | undefined)?.[HERMES_STALE_CHECK_KEY];
  if (typeof fn !== "function") return null;
  try {
    const r = await (fn as (effort: string, cwd: string) => Promise<{ stale: StaleCard[] }>)(effort, cwd);
    return r?.stale ?? null;
  } catch {
    return null;
  }
}
