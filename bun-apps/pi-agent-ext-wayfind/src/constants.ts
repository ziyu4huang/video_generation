/**
 * Shared constants for pi-agent-ext-wayfind.
 *
 * The coordination seam keys live here so both the wayfind side (publisher) and
 * any consumer can import the canonical string — mirroring how
 * pi-agent-ext-planning-with-files centralizes its keys in src/constants.ts.
 */

/** Package name, used for status-bar / notification prefixes. */
export const PKG_NAME = "pi-agent-ext-wayfind";

/** Custom message type for wayfind-originated injected context. */
export const CUSTOM_TYPE = "pi-wayfind";

/**
 * globalThis key under which wayfind publishes an `() => boolean` telling
 * planning-with-files whether a grill / wayfinder session is currently active.
 * Process-singleton (survives jiti module-identity gaps) — same pattern as
 * planning-with-files' `__piGoalActive`.
 */
export const WAYFIND_ACTIVE_KEY = "__piWayfindActive";

/**
 * globalThis key under which planning-with-files publishes an
 * `(cwd: string) => boolean` telling wayfind whether a plan is incomplete.
 * Read-only on the wayfind side (graceful fallback → false when absent).
 */
export const PLAN_INCOMPLETE_KEY = "__piPlanIncomplete";

/**
 * globalThis key under which planning-with-files publishes an
 * `(cwd: string) => string` returning a one-line plan summary. Read-only here.
 */
export const PLAN_SUMMARY_KEY = "__piPlanSummary";
