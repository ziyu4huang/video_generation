## Question
The completion act — delete the hardcoded `CORE_TOOLS` set + simplify `buildEffectiveGates` now that every member is owner-declared. Mirror ticket 15's GATES deletion: remove `export const CORE_TOOLS`; drop the `fallbackCore: Set<string> = CORE_TOOLS` param + its fallback loop in `buildEffectiveGates` (the dead path — every name now handled by owner declaration); fix `TRACKED_TOOLS = new Set(CORE_TOOLS)` → derive from owner-declared core (or empty if nothing falls back); update runtime inits (`effectiveCore`, `sticky`) to read owner-declared core instead of CORE_TOOLS; re-route any remaining CORE_TOOLS consumers (grep repo-wide, incl. cross-package); run the full suite + `bun run qa`. After this, always-on is owner-declared end-to-end with no legacy fallback. (If ticket 03 leaves a residual built-in set, delete CORE_TOOLS minus that residual per 03's outcome.)

type: task
blocked by: 02, 03
status: open
