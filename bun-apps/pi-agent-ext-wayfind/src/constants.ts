/**
 * Shared constants for pi-agent-ext-wayfind.
 *
 * The coordination seam keys live here so both the wayfind side (publisher) and
 * any consumer can import the canonical string — mirroring how the plan
 * coordinator centralizes its keys in its own constants module.
 */

/** Package name, used for status-bar / notification prefixes. */
export const PKG_NAME = "pi-agent-ext-wayfind";

/** Custom message type for wayfind-originated injected context. */
export const CUSTOM_TYPE = "pi-wayfind";

/**
 * globalThis key under which wayfind publishes an `() => boolean` telling
 * the plan coordinator whether a grill / wayfinder session is currently active.
 * Process-singleton (survives jiti module-identity gaps) — same pattern as
 * the goal side's `__piGoalActive`.
 */
export const WAYFIND_ACTIVE_KEY = "__piWayfindActive";

/**
 * globalThis key under which the plan coordinator publishes an
 * `(cwd: string) => boolean` telling wayfind whether a plan is incomplete.
 * Read-only on the wayfind side (graceful fallback → false when absent).
 */
export const PLAN_INCOMPLETE_KEY = "__piPlanIncomplete";

/**
 * globalThis key under which the plan coordinator publishes an
 * `(cwd: string) => string` returning a one-line plan summary. Read-only here.
 */
export const PLAN_SUMMARY_KEY = "__piPlanSummary";

/**
 * globalThis key under which the plan coordinator publishes an
 * `(cwd: string) => PlanPhaseInfo[]` (per-phase `{id, status, ticketIds?}`).
 * Read by `syncChainState` (`/wayfind sync`) to close tickets whose phase
 * reports complete. Read-only on the wayfind side (graceful fallback → empty
 * when no publisher is present — the coordinator is now built as
 * pi-agent-ext-core-task; see ADR-0003).
 */
export const PLAN_PHASES_KEY = "__piPlanPhases";

/**
 * globalThis key under which wayfind publishes a GRILL-SPECIFIC active reader:
 * `(sessionId: string) => boolean`. Distinct from WAYFIND_ACTIVE_KEY, which
 * conflates grill + wayfinder. Consumers that must scope to grills only (e.g.
 * hermes-memory's correction-detector yield) read THIS key.
 */
export const WAYFIND_GRILL_KEY = "__piWayfindGrill";
