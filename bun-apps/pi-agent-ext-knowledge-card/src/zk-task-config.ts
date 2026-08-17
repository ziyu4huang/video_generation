/** ZK task configuration: source allowlists, model resolution, blend scoring (split from extensions/knowledge-card.ts — hermes-arch-13 wave 2). */

// ---------------------------------------------------------------------------
// Tool allowlists (per command) — exported so the CLI reuses the exact same
// sets as this extension. Canonical form: string[] (natural TS). The zk_* call
// sites pass them as the `tools` array to zkSpawn (sub-project ①; was
// runSubagentWithRetry's `toolsCsv` parameter pre-migration).
// ---------------------------------------------------------------------------

// pi-agent-ext-obsidian's Phase-3 refactor folded all 18 granular obsidian_*
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

/** Three-way blend adds the vault-mind semantic (vector) seed via
 *  `obsidian` action:"semantic_search" — already covered by RAG_TOOLS since
 *  the fat `obsidian` tool dispatches every action, so this is currently
 *  identical to RAG_TOOLS. Kept as a separate export (rather than an alias)
 *  so a future need to gate the vault-mind-dependent action behind its own
 *  allowlist has a place to land without touching call sites. */
export const RAG_TOOLS_THREE_WAY = [...RAG_TOOLS];

// ---------------------------------------------------------------------------
// Distill / subagent model resolution.
//
// Knowledge-card's LLM-touching tools (zk_card CRUD, zk_ask graph-RAG) each
// spawn an isolated subagent. The subagent model is resolved here, with this
// precedence:
//   1. explicit `model` arg on the tool call  — highest (caller override)
//   2. KC_SUBAGENT_MODEL env                   — per-session / global override
//   3. DISTILL_MODEL_DEFAULT                   — google/gemma-4-12b
//
// The default is a LOCAL LM Studio model, deliberately: it keeps
// knowledge-card's LLM spend off the cloud bill. The deterministic paths
// (zk_ingest convergence, knowledge_query digest) use no model at all, so this
// resolver only governs the two subagent-backed tools.
// ---------------------------------------------------------------------------
export const DISTILL_MODEL_DEFAULT = "google/gemma-4-12b";
export function resolveDistillModel(explicit?: string): string {
	return explicit ?? process.env.KC_SUBAGENT_MODEL ?? DISTILL_MODEL_DEFAULT;
}

/** zk-ask retrieval blend mode.
 *  - default        : lexical (title/tags/body) + graph neighbors.
 *  - three-way      : semantic + lexical + graph (graph can dilute — see below).
 *  - semantic-lexical: semantic + lexical, NO graph expansion. The graph term
 *    (`link_count`) is a popularity signal — it boosts heavily-linked cards
 *    regardless of query relevance, so off-topic graph neighbors dilute the
 *    three-way top-k on paraphrase / cross-lingual queries (measured iter-4).
 *    Dropping graph entirely isolates the semantic win; add it back via gating
 *    if concept-linking queries regress. */
export type BlendMode = "default" | "three-way" | "semantic-lexical";

/** Per-note retrieval signals used by the blend score. Any field may be
 *  undefined when a mode did not produce it; undefined contributes 0. */
export interface BlendScoreParts {
	/** Vector similarity (0-1) from obsidian_semantic_search. */
	semantic?: number;
	/** Lexical search_score (0-1) from obsidian_search (title/tags/body). */
	lexical?: number;
	/** Count of [[wikilink]] occurrences in the note body (graph signal). */
	linkCount?: number;
}

/** Blend-score weights per mode. The default keeps the historical lexical+graph
 *  formula (0.7×lexical + 0.3×link) so existing behaviour is unchanged.
 *  three-way rebalances to 0.4 semantic / 0.3 lexical / 0.3 graph so the vector
 *  seed leads but cannot dominate — a card the graph strongly links still ranks
 *  even when both text modes miss it. */
const BLEND_WEIGHTS: Record<BlendMode, { semantic: number; lexical: number; link: number }> = {
	default: { semantic: 0.0, lexical: 0.7, link: 0.3 },
	"three-way": { semantic: 0.4, lexical: 0.3, link: 0.3 },
	// semantic-lexical: drop the link term entirely, rebalance so semantic still
	// leads (it carries the paraphrase / cross-lingual signal lexical misses).
	"semantic-lexical": { semantic: 0.55, lexical: 0.45, link: 0.0 },
};

/**
 * Pure, deterministic blend-score used by zk-ask's Step 3 ranking. Exported so
 * it can be unit-tested and re-used by the retrieval-quality loop. Undefined
 * signals contribute 0; negative inputs are clamped to 0 (a search_score of -1
 * sentinel from obsidian_search is treated as "no signal").
 */
export function rankBlendScore(parts: BlendScoreParts, mode: BlendMode = "default"): number {
	const w = BLEND_WEIGHTS[mode] ?? BLEND_WEIGHTS.default;
	const clamp = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
	return (
		w.semantic * clamp(parts.semantic) +
		w.lexical * clamp(parts.lexical) +
		w.link * clamp(parts.linkCount)
	);
}

/** Resolve the RAG tool allowlist for a blend mode. three-way and
 *  semantic-lexical both unlock the semantic vector tool; default keeps the
 *  lexical+graph set. */
export function ragToolsFor(blend: BlendMode = "default"): string[] {
	return blend === "three-way" || blend === "semantic-lexical"
		? [...RAG_TOOLS_THREE_WAY]
		: [...RAG_TOOLS];
}

/** LeanRAG ① hierarchy defaults (ticket 06). Budget is a CHARS proxy — the per-layer schedule halves it each level (LeanRAG (max_depth−layer)×80 analog, chars-scaled), floor 1200. */
export const HIERARCHY_DEFAULTS = { threshold: 0.72, maxDepth: 3, baseBudget: 10_000 } as const;
