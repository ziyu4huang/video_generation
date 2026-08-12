/**
 * Configuration constants for pi-agent-ext-subagent (extracted from
 * pi-agent-ext-workflow/src/config.ts). Only symbols referenced by the moved
 * modules live here; workflow-side constants (WORKFLOW_*, MAX_AGENT_*,
 * normalizeKeywordTriggerWord, DEFAULT_*) remain in pi-agent-ext-workflow.
 */

/** User-level model tiers config file, relative to the home directory. */
export const MODEL_TIERS_FILE = ".pi/workflows/model-tiers.json";

/**
 * Named workflow subagent definitions directory. Resolved both project-relative
 * (cwd/.pi/agents) and home-relative (~/.pi/agents); project entries win on name
 * collision. Each `*.md` file is an agent definition (frontmatter + body prompt).
 */
export const AGENTS_DIR = ".pi/agents";

/**
 * Hard ceiling on parallel children in a `subagents` batch. Mirrors
 * pi-agent-ext-workflow's MAX_CONCURRENCY (kept local so this package stays
 * independent of the workflow engine). Unbounded fan-out cascades into
 * provider rate limits (cf. ~50 RPM at Anthropic Tier 1).
 */
export const MAX_CONCURRENCY = 16;

/**
 * Default parallelism for a `subagents` batch when the caller omits
 * `concurrency`. Moderate — read-only research/review fan-out rarely needs
 * more; the caller can raise it up to MAX_CONCURRENCY per call.
 */
export const DEFAULT_BATCH_CONCURRENCY = 4;

/** Hard ceiling on the number of tasks in one `subagents` batch. Mirrors
 *  pi-agent-ext-workflow's MAX_AGENTS_PER_RUN (kept local for package independence). */
export const MAX_BATCH_TASKS = 1000;
