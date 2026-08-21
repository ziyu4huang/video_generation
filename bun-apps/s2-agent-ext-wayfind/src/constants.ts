/**
 * Shared constants for s2-agent-ext-wayfind.
 *
 * The globalThis seam-key strings live here so the wayfind side and any consumer
 * can import the canonical string — mirroring how the plan coordinator
 * (s2-agent-ext-task) centralizes its keys in its own constants module.
 * wayfind PUBLISHES `WAYFIND_GRILL_KEY` (read by hermes-memory); it only READS
 * the plan coordinator's `__piPlanPhases` key below (the plan-incomplete/summary keys were dead — no production reader ever landed; removed
 * 2026-08-21, decision D1).
 */

/** Package name, used for status-bar / notification prefixes. */
export const PKG_NAME = "s2-agent-ext-wayfind";

/**
 * globalThis key under which the plan coordinator publishes an
 * `(cwd: string) => PlanPhaseInfo[]` (per-phase `{id, status, ticketIds?}`).
 * Read by `syncChainState` (`/wayfind sync`) to close tickets whose phase
 * reports complete. Read-only on the wayfind side (graceful fallback → empty
 * when no publisher is present — the coordinator is now built as
 * s2-agent-ext-task; see ADR-0003).
 */
export const PLAN_PHASES_KEY = "__piPlanPhases";

/**
 * globalThis key under which wayfind publishes a GRILL-SPECIFIC active reader:
 * `(sessionId: string) => boolean`. Consumers that must scope to grills only
 * (e.g. hermes-memory's correction-detector yield) read THIS key.
 */
export const WAYFIND_GRILL_KEY = "__piWayfindGrill";
