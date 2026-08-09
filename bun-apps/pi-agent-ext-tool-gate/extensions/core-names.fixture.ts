/** Shared TEST fixture: the 20 always-active core tool names.
 *
 * Mirrors the runtime owner-declared core (16 in-repo tools carrying
 * `gating:{ core: true }` + the 4 pi-coding-agent built-ins tool-gate injects
 * core onto via BUILTIN_CORE). Previously duplicated verbatim in
 * tool-gate.test.ts and self-promotion-interaction.test.ts; centralized here to
 * keep the two copies from drifting.
 *
 * NOTE #5 — `ask_user_question` and `todo` were gated OUT of this set (moved
 * from `gating:{ core: true }` to keyword gates) to slim the always-on
 * per-turn schema; they are NO LONGER always-active core and are recovered
 * via `enable_tool` on a miss. `goal_complete` (99 tok) stays core.
 *
 * NOTE: this is a TEST FIXTURE, not a runtime export — tool-gate discovers core
 * dynamically via buildEffectiveGates(); it never hardcodes this list. */
export const CORE_NAMES: string[] = [
	"read", "write", "edit", "bash",
	"goal_complete",
	"memory", "memory_search", "session_search",
	"enable_tool", "skill_manage", "grill_decision",
	"obsidian", "obsidian_help", "zk_card", "zk_ask", "zk_ingest", "knowledge_query",
	"web_search", "fetch_content", "get_search_content",
];
/** CORE_NAMES as a Set for has() checks. */
export const CORE_SET: Set<string> = new Set(CORE_NAMES);
/** A fresh spread of the core names. */
export const CORE_TOOLS_ARRAY = (): string[] => CORE_NAMES.slice();
