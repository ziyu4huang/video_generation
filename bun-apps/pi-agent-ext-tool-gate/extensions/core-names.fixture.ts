/** Shared TEST fixture: the 20 always-active core tool names.
 *
 * Mirrors the runtime owner-declared core (16 in-repo tools carrying
 * `gating:{ core: true }` + the 4 pi-coding-agent built-ins tool-gate injects
 * core onto via BUILTIN_CORE). Previously duplicated verbatim in
 * tool-gate.test.ts and self-promotion-interaction.test.ts; centralized here to
 * keep the two copies from drifting.
 *
 * grill_decision removed with its tool (hermes ticket 03): the surface is now
 * memory / search / skill_manage (+ ungated skill_manage_help) — no core hit.
 *
 * NOTE: this is a TEST FIXTURE, not a runtime export — tool-gate discovers core
 * dynamically via buildEffectiveGates(); it never hardcodes this list. */
export const CORE_NAMES: string[] = [
  "read", "write", "edit", "bash",
  "todo", "goal_complete",
  "memory", "search",
  "ask_user_question", "enable_tool", "skill_manage",
  "obsidian", "obsidian_help", "zk_card", "zk_ask", "zk_ingest", "knowledge_query",
  "web_search", "fetch_content", "get_search_content",
];
/** CORE_NAMES as a Set for has() checks. */
export const CORE_SET: Set<string> = new Set(CORE_NAMES);
/** A fresh spread of the core names. */
export const CORE_TOOLS_ARRAY = (): string[] => CORE_NAMES.slice();
