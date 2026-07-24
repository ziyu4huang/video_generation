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
