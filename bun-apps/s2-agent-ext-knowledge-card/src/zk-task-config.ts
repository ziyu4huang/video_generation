/** ZK task configuration: source allowlists, model resolution, blend scoring (split from extensions/knowledge-card.ts — hermes-arch-13 wave 2). */

import { loadModelTierConfig, resolveModelRole, type ModelTierConfig } from "@repo/s2-agent-core-runtime";

// ---------------------------------------------------------------------------
// Tool allowlists (per command) — exported so the CLI reuses the exact same
// sets as this extension. Canonical form: string[] (natural TS). The zk_* call
// sites pass them as the `tools` array to zkSpawn (sub-project ①; was
// runSubagentWithRetry's `toolsCsv` parameter pre-migration).
// ---------------------------------------------------------------------------

// s2-agent-ext-obsidian's Phase-3 refactor folded all 18 granular obsidian_*
// tools (obsidian_list / obsidian_read / obsidian_search / obsidian_distill /
// obsidian_garden / …) into ONE action-dispatched `obsidian` tool — only
// `obsidian` and `obsidian_help` are real pi.registerTool()'d tools now (the
// old names are internal-only action handlers, no longer independently
// callable). Every list below collapses to the same two entries; they stay
// separate exports (rather than one shared constant) so each command's
// allowlist is independently auditable/overridable, matching
// OBSIDIAN_DISTILL_TOOLS / GARDEN_*_TOOLS in obsidian.ts.
/** Shared Obsidian-backed allowlist; each tool spreads a fresh copy so they stay independently mutable. */
const BASE_OBSIDIAN_TOOLS = ["obsidian", "obsidian_help"];

export const DISTILL_TOOLS = ["read", ...BASE_OBSIDIAN_TOOLS];
export const ADD_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const FIND_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const UPDATE_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const REMOVE_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const CHECK_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const RAG_TOOLS = [...BASE_OBSIDIAN_TOOLS];

// ---------------------------------------------------------------------------
// Distill / subagent model resolution.
//
// Knowledge-card's LLM-touching tools (zk_card CRUD, zk_ask graph-RAG) each
// spawn an isolated subagent. The subagent model is resolved here, with this
// precedence:
//   1. explicit `model` arg on the tool call  — highest (caller override)
//   2. KC_SUBAGENT_MODEL env                   — per-session / global override
//   3. central tiers.small (~/.pi/workflows/model-tiers.json — seeded by the
//      s2-agent host built-in; editable via /workflows-models; the "small"
//      tier is the local/budget slot in every shipped preset)
//   4. actionable throw (set tiers.small or KC_SUBAGENT_MODEL)
//
// The deterministic paths (zk_ingest convergence, knowledge_query digest) use
// no model at all, so this resolver only governs the two subagent-backed tools.
// ---------------------------------------------------------------------------
export function resolveDistillModel(
	explicit?: string,
	config: ModelTierConfig | null = loadModelTierConfig(),
): string {
	if (explicit) return explicit;
	const env = process.env.KC_SUBAGENT_MODEL;
	if (env) return env;
	const spec = resolveModelRole({ tier: "small" }, config);
	if (spec) return spec;
	throw new Error(
		"[knowledge-card] No distill model configured. Set model-tiers.json tiers.small (via /workflows-models) or export KC_SUBAGENT_MODEL.",
	);
}

// The semantic (vector) blend modes — `three-way` / `semantic-lexical`, seeded
// via obsidian's vault-mind `semantic_search` action — were REMOVED with the
// vault-mind retirement (context-lifecycle ticket 02, D2, 2026-08-22). zk-ask
// is lexical+graph only; semantic retrieval lives in knowledge_query /
// retrieveRecords (LM Studio embeddings via the shared embedding leaf).

/** LeanRAG ① hierarchy defaults (ticket 06). Budget is a CHARS proxy — the per-layer schedule halves it each level (LeanRAG (max_depth−layer)×80 analog, chars-scaled), floor 1200. `summaryBreaker` (ticket 02) is the hang-mode circuit-breaker K: consecutive empty/null summarizeFn results tolerated per layer before further LLM summary requests are skipped. */
export const HIERARCHY_DEFAULTS = {
	threshold: 0.72,
	maxDepth: 3,
	baseBudget: 10_000,
	summaryBreaker: 3,
} as const;
