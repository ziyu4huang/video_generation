/**
 * Stable reminder strings, limits, and data markers for planning-with-files.
 *
 * Ported from the upstream planning-with-files Pi adapter (v3.4.0). The cache-safe
 * reminders MUST stay byte-stable: cache-safe mode is chosen precisely so the
 * injected text never varies turn-to-turn, preserving provider KV-cache hits.
 */

export const PKG_NAME = "planning-with-files";
export const CUSTOM_TYPE = "planning-with-files";

export const PLAN_DATA_BEGIN = "===BEGIN PLAN DATA===";
export const PLAN_DATA_END = "===END PLAN DATA===";

/** Stable reminder used in cache-safe mode (before_agent_start). */
export const CACHE_SAFE_REMINDER =
  "[planning-with-files] Read task_plan.md for current phase and status. " +
  "Read findings.md for research context. Read progress.md for recent changes. " +
  "Continue from the current phase.";

/** Stable reminder used in cache-safe mode (PreToolUse steer). */
export const PRE_TOOL_CACHE_SAFE_REMINDER =
  "[planning-with-files] Before tool use, read task_plan.md for the active phase and constraints.";

/** Reminder appended to write/edit tool results in parity mode. */
export const POST_WRITE_REMINDER =
  "[planning-with-files] Update progress.md with what you just did. If a phase is now complete, update task_plan.md status.";

/** Prefix for the tamper-detected injection block. */
export const TAMPERED_PREFIX = "[planning-with-files] [PLAN TAMPERED — injection blocked]";

/** Max auto-continue follow-ups per (session, plan) pair. */
export const AUTO_CONTINUE_LIMIT = 3;

/** Default plan-loop tick interval (10 minutes). */
export const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Default plan-loop tick prompt. De-Pythonized: the upstream referenced the
 * legacy `scripts/check-complete.sh` shell helper, which is not shipped in this
 * pure-TS package. Phase completion is instead derived in-process from
 * readPlanStatus (see plan.ts), so the prompt asks the agent to read the plan
 * files directly.
 */
export const DEFAULT_LOOP_PROMPT =
  "Read task_plan.md and progress.md. Review task_plan.md phase statuses " +
  "(Status: complete / in_progress / pending) to see what remains. " +
  "If no progress.md entry has been added since the last loop tick, write one summarizing the current state. " +
  "If a phase finished, update its Status: line in task_plan.md. Continue the next phase if work remains.";

/** Default goal condition surfaced by /plan-goal default. */
export const DEFAULT_GOAL_CONDITION =
  "all phases in task_plan.md report Status: complete and the plan reports ALL PHASES COMPLETE";

/**
 * Close marker for a plan that has been finished or abandoned. Written by
 * `/plan done`. Two equivalent spellings are recognized (see isCloseMarker in
 * plan.ts): an inert HTML comment and a visible heading. The comment form is
 * preferred for programmatic writes because it renders as nothing in markdown
 * preview and is unlikely to collide with human-authored content.
 */
export const CLOSE_MARKER_COMMENT = "<!-- pwf: closed -->";

/** Human-readable blurb appended alongside the close marker. */
export const CLOSE_MARKER_NOTE =
  "> **[planning-with-files] Plan closed via /plan done.** Hooks deactivated for this plan. " +
  "Remove this line + the `<!-- pwf: closed -->` marker above to reactivate.";
