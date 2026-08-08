/** The canonical `__pi*` seam-key registry — single source of truth.
 *  Consumed by bun-apps/tests/seam-contract.test.ts (via SEAM_KEY_ENTRIES)
 *  and by src/seam.ts (SeamKey type for compile-time orphan prevention). */
export const SEAM_KEYS = {
  __piCoreTaskStatusWidget: { crossPackage: true },
  __piGoalActive:           { crossPackage: false },
  __piKickHeartbeat:        { crossPackage: false },
  __piPlanIncomplete:       { crossPackage: true },
  __piPlanPhases:           { crossPackage: true },
  __piPlanSummary:          { crossPackage: true },
  __piWayfindGrill:         { crossPackage: true },
  __piKnowledgePipeline:    { crossPackage: true },
} as const;

export type SeamKey = keyof typeof SEAM_KEYS;

/** Array form {key, crossPackage}[] consumed by the repo-level seam-contract guard. */
export const SEAM_KEY_ENTRIES: ReadonlyArray<{ key: string; crossPackage: boolean }> =
  Object.entries(SEAM_KEYS).map(([key, v]) => ({ key, crossPackage: v.crossPackage }));
