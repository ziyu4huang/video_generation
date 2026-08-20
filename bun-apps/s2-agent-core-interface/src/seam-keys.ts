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
  // __piToolGateStatus: the tool-gate LIVE-STATE seam (wayfinder ticket 06) —
  // tool-gate publishes a reader of its current session's effective gate state
  // (active count, per-gate fired/dormant + keywords + token cost, sticky set);
  // power-tool's inspect_context reads it to render the "tool gate" section of
  // the live context breakdown. The literal is duplicated verbatim across the
  // two packages (tool-gate publishes, power-tool reads) — crossPackage:true.
  __piToolGateStatus:       { crossPackage: true },
  __piKnowledgePipeline:    { crossPackage: true },
  // __piHermesStaleCheck: the staleness REVERSE seam added by #1242 — hermes
  // publishes the async reader (hermes-memory/src/stale-seam.ts), wayfind reads
  // it (wayfind/src/stale-seam.ts, the T8 graduation gate). The literal is
  // duplicated verbatim across the two packages (ADR-wayfind-0004: no cross-package
  // import), which is exactly the drift surface this registry exists to pin →
  // crossPackage:true. It shipped unregistered, so bun-apps/tests/
  // seam-contract.test.ts was RED on main until this line.
  __piHermesStaleCheck:     { crossPackage: true },
  // __piRateLimitState: the key LITERAL is owned solely in
  // s2-agent-core-runtime (rate-limiter.ts GLOBAL_KEY); subagent +
  // s2-agent-ext-workflow share the budget through the exported
  // getGlobalRateLimiter / setRateLimitCapResolver API — NO duplicated literal,
  // hence NO drift surface between packages. Per the seam-contract topology
  // (crossPackage:true requires the literal referenced by >=2 packages) this is
  // intra-package → crossPackage:false, exempt from the NO SELF-ONLY SEAMS
  // invariant.
  __piRateLimitState:       { crossPackage: false },
} as const;

export type SeamKey = keyof typeof SEAM_KEYS;

/** Array form {key, crossPackage}[] consumed by the repo-level seam-contract guard. */
export const SEAM_KEY_ENTRIES: ReadonlyArray<{ key: string; crossPackage: boolean }> =
  Object.entries(SEAM_KEYS).map(([key, v]) => ({ key, crossPackage: v.crossPackage }));
