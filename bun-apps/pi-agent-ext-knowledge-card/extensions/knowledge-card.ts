/**
 * pi-knowledge-card — Zettelkasten knowledge-management extension.
 *
 * Registers four tools that wrap the knowledge CRUD / RAG workflows as pi
 * tools. Each tool spawns an isolated subagent (via pi-obsidian's runner)
 * with the appropriate obsidian tools loaded — so this extension requires
 * pi-obsidian to be available in the same session.
 *
 * Tools:
 *   zk_card          CRUD over vault notes: add | find | update | remove | check
 *   zk_ask           graph-enhanced RAG query over the vault
 *   zk_ingest        deterministic convergence of .knowledge.jsonl → cards
 *   knowledge_query  deterministic cross-workflow tag-ranked digest (no LLM)
 *
 * Phase 1 de-dup (2026-07-11): zk_extract removed (was a 100% passthrough to
 *   obsidian_distill — use obsidian_distill directly). graph_health removed
 *   (merged into obsidian_garden with engine:deterministic|llm param). The
 *   library functions (graphHealth/healGraph in retrieve.ts) remain exported
 *   for the CLI knowledge-pipeline command.
 *
 * knowledge_query is the hub's direct agent surface over the retrieve.ts
 * library — it does NOT spawn a subagent (no LLM, no network), so it works
 * even where the subagent-backed zk_* tools are heavier.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the task builders
 * (buildDistillTask / buildAddTask / … / buildRagTask) and tool allowlists
 * (DISTILL_TOOLS / ADD_TOOLS / … / RAG_TOOLS). The `pi-agent cli`
 * zk-extract / zk-card / zk-ask commands import these same builders so the CLI
 * and the extension never drift apart.
 *
 * Env:
 *   OB_VAULT_PATH / OB_VAULT_DIR   vault resolution (passed through to obsidian)
 *   OB_SUBAGENT_TIMEOUT_MS         subagent timeout (default 5 min)
 *   KC_SUBAGENT_MODEL              distill/CRUD/RAG subagent model (default
 *                                  google/gemma-4-12b — a LOCAL LM Studio
 *                                  model, keeps knowledge-card's LLM spend
 *                                  off the cloud bill; override per-call via
 *                                  the tool's `model` arg). Does NOT honor the
 *                                  sibling OB_SUBAGENT_MODEL (that one defaults
 *                                  to a cloud model); use KC_SUBAGENT_MODEL to
 *                                  override knowledge-card specifically.
 */

import { relative, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { zkRetrieve, zkIngest, zkHealth, zkHeal } from "../src/host-fns.ts";
import {
	resolveVault,
	registerDeterministicHealthCheck,
} from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";
import {
	ingestRecords,
	parseKnowledgeJsonl,
	adaptAutoMemoryMarkdown,
	adaptHermesMarkdown,
	adaptGenericMarkdown,
	collectInputFiles,
	formatSummary,
	type KnowledgeRecord,
	type SourceFamily,
} from "../src/ingest.ts";
import {
	retrieveRecords,
	type RetrieveOptions,
	graphHealth,
	healGraph,
	formatHealth,
} from "../src/retrieve.ts";
import { runConvergenceLoop } from "../src/loop.ts";
import {
	publishKnowledgePipeline,
	unpublishKnowledgePipeline,
} from "../src/knowledge-pipeline-seam.ts";
import {
	spawnSubagent as __defaultSpawnSubagent,
	type SpawnSubagentOptions,
	type SpawnSubagentResult,
} from "@repo/pi-agent-ext-subagent";
import { runGate } from "../src/distill/gate.ts";
import { runConverge } from "../src/distill/converge.ts";
import { onKnowledge } from "../src/emit.ts";
import { convergeKnowledgeEmission } from "../src/converge.ts";
import { readState } from "../src/distill/state.ts";
import type { MemoryEntry, EnrichedNote, ConvergeMetrics } from "../src/distill/types.ts";

// ---------------------------------------------------------------------------
// zk_* spawn seam (sub-project ①) — zk_card / zk_ask spawn through this
// swappable fn so the transport is injectable (tests) and converges on ONE
// path (spawnSubagent, in-process createAgentSession) instead of pi-obsidian's
// child-process runner. parentExtensionTools is captured at session_start for
// the R2 bridge (obsidian tools reach the child in manifest AND `-e` dev mode).
// ---------------------------------------------------------------------------
export type ZkSpawnFn = (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
let zkSpawn: ZkSpawnFn = __defaultSpawnSubagent;
let parentExtensionTools: ToolDefinition[] | undefined;
/** @internal test-only override of the zk_* spawner. null restores the default. */
export function __setZkSpawnForTest(fn: ZkSpawnFn | null): void {
	zkSpawn = fn ?? __defaultSpawnSubagent;
}

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

/** One-line vault header prepended to every zk_* tool result so the active
 *  vault is always visible (never silently operating on the wrong one).
 *  Resolves independently of the subagent so it works even if the subagent
 *  itself fails. Best-effort: returns "" on resolution error. */
async function vaultHeader(cwd: string): Promise<string> {
	try {
		const v = await resolveVault(cwd);
		const stale = v.staleReason ? " ⚠stale" : "";
		return `vault: ${v.name} (${v.path}) [${v.source}]${stale}`;
	} catch {
		return "";
	}
}

/** Prepend the vault header to a result text block. */
function withVault(header: string, body: string): string {
	return header ? `${header}\n${body}` : body;
}

/** Resolve the convergence vault for the no-LLM knowledge tools
 *  (knowledge_query / graph_health). Delegates to pi-obsidian's multi-tier
 *  `resolveVault` (env → config → app → local) — the SAME resolver the native
 *  zk_* tools use. The hub asks its forward-dep (pi-obsidian) to serve vault
 *  resolution rather than rolling its own; this also reads the run-dir config
 *  (`obsidian_config.json` vault_path) that the simplified resolver missed.
 *  Throws if no vault can be resolved — callers catch and return isError.
 *  (Consolidation-cycle fix: the power-tool version only checked OB_VAULT_PATH
 *  + cwd/"vault", so it failed at runtime when the vault was config-registered
 *  but not env-set. Now it resolves exactly like the sibling zk_* tools.) */
// --- test seam (deterministic vault-failure injection) --------------------------
// resolveVault has a Tier-2 (Obsidian app) fallback that resolves the real
// open vault on any dev machine with Obsidian installed, so a unit test can't
// make resolution fail by clearing OB_VAULT_PATH. This seam lets the error-
// path test inject a failing resolver deterministically. Null = use real.
let __vaultResolver: ((cwd: string) => Promise<string>) | null = null;
/** @internal test-only override of the vault resolver (pass null to restore). */
export function __setVaultResolverForTest(
	fn: ((cwd: string) => Promise<string>) | null,
): void {
	__vaultResolver = fn;
}

async function resolveKnowledgeVault(cwd: string): Promise<string> {
	if (__vaultResolver) return __vaultResolver(cwd);
	return (await resolveVault(cwd)).path;
}

// ---------------------------------------------------------------------------
// Task builders — pure string templates, no I/O. Single source of truth:
// both this extension and `pi-agent cli`'s zk-* commands import these.
// ---------------------------------------------------------------------------

const DISTILL_TASK_PREFIX =
	'Call the `obsidian` tool with action:"distill" immediately, using the input files listed below. ' +
	'Your FIRST action MUST be a tool call to `obsidian` (action:"distill") — do NOT write any text before invoking the tool.';

export function buildDistillTask(
	files: string[],
	cwd: string,
	folder: string,
	maxNotes?: number,
): string {
	const rel = files.map((f) => `- ${relative(cwd, f) || f}`);
	const parts = [
		DISTILL_TASK_PREFIX,
		`Target folder: ${folder}`,
		maxNotes
			? `Hint: produce no more than ${maxNotes} notes total (quality over quantity).`
			: "",
		'Input files (pass as the `files` arg of action:"distill"):',
		...rel,
		"",
		'After the `obsidian` (action:"distill") call returns, briefly report the number of notes created in Traditional Chinese.',
	].filter(Boolean);
	return parts.join("\n");
}

export function buildAddTask(
	content: string,
	folder: string,
	force: boolean,
): string {
	const forceParts = force
		? [
				"--force is set. Skip the duplicate check and create the note.",
				"Record force_inserted: true and the duplicate_candidates list in the note's frontmatter, and add the tag #duplicate-candidate.",
			]
		: [
				"## Duplicate-check protocol (4 layers)",
				'Layer 1: obsidian action:"search" matchMode:fuzzy fields:title — check for similar titles',
				'Layer 2: obsidian action:"search" matchMode:words fields:body — check for keyword overlap',
				'Layer 3: obsidian action:"query" — check for matching tags',
				"Layer 4: compare top candidates against the new content",
				"",
				"Similarity thresholds:",
				'  > 85% → abort: report "Similar note already exists: [[X]] — use knowledge update"',
				"  60–85% → abort: list candidates and advise using --force to override",
				"  < 60% → proceed and create the note",
			];

	return [
		`Add the following content as a new atomic note in the Zettelkasten folder "${folder}".`,
		"",
		"## Content to add",
		content,
		"",
		...forceParts,
		"",
		"After completion, report the created note's path and a brief summary in Traditional Chinese.",
	].join("\n");
}

export function buildFindTask(
	query: string,
	contextLines: number,
	limit: number,
): string {
	const contextDesc =
		contextLines === 0
			? "Titles only (no context lines)"
			: `Include ${contextLines} context lines around each match`;

	return [
		`Search the Zettelkasten vault for: "${query}"`,
		"",
		"## Search strategy (priority order)",
		"1. Title fuzzy match (highest priority)",
		"2. Tag match",
		"3. Body keyword match (lowest priority)",
		"",
		`Return at most ${limit} results.`,
		"",
		"## Output format",
		contextDesc,
		"```",
		"[[Note Title]] (Zettelkasten/Note-Title.md)",
		"  > ...context line 1",
		"  > matched line",
		"  > ...context line 3",
		"```",
		"",
		"Summarise the results in Traditional Chinese.",
	].join("\n");
}

export function buildUpdateTask(notePath: string, content: string): string {
	return [
		`Update the following note using smart-merge rules: ${notePath}`,
		"",
		"## Content to add / update",
		content,
		"",
		"## Smart-merge rules (apply in order)",
		"1. New content already exists verbatim → SKIP (no duplicate insertion)",
		'2. New content is supplementary → obsidian action:"append_section" to the relevant heading',
		'3. No relevant heading exists → obsidian action:"append" to the end of the note',
		'4. New tags discovered → obsidian action:"update_frontmatter" to union-merge tags',
		'5. New sources discovered → obsidian action:"update_frontmatter" to append to sources[]',
		"",
		"After completion, report a summary of the changes made in Traditional Chinese.",
	].join("\n");
}

export function buildRemoveTask(notePath: string, force: boolean): string {
	if (force) {
		return [
			`--force mode: delete the following note: ${notePath}`,
			"",
			'1. Delete this note with obsidian action:"delete" (including link cleanup).',
			"",
			"After completion, report the deletion result in Traditional Chinese.",
		].join("\n");
	}
	return [
		`Verify that the following note can be safely deleted, then delete it if so: ${notePath}`,
		"",
		"## Safe-delete protocol",
		'1. obsidian action:"read" — confirm the note exists',
		'2. obsidian action:"search" backlinks:true — find notes that link to this one',
		"3. If backlinks are found → abort: list the affected notes and advise using --force",
		'4. If no backlinks → obsidian action:"delete" (confirm: true)',
		"",
		"After completion, report the result in Traditional Chinese.",
	].join("\n");
}

export const CHECK_TASK = [
	'Use obsidian action:"garden" mode:"audit" to diagnose vault health.',
	"",
	"Check for:",
	"- Duplicate notes (identical or near-identical content)",
	"- Orphan notes (no backlinks pointing to them)",
	"- Dead links (link targets that do not exist)",
	"- Unlinked related notes (thematically related but not connected)",
	"",
	"Report the diagnosis and recommended actions in Traditional Chinese.",
].join("\n");

export function buildRagTask(
	query: string,
	depth: number,
	topK: number,
	summarize: boolean,
	retrieveOnly: boolean,
	maxNeighbors: number = 5,
	maxNoteTokens: number = 2000,
	noRefine: boolean = false,
	folder?: string,
	blend: BlendMode = "default",
): string {
	const threeWay = blend === "three-way";
	// semantic-lexical and three-way both seed with the vector tool; default is
	// lexical-only. semantic-lexical drops graph expansion (Step 2) entirely.
	const semanticEnabled = blend === "three-way" || blend === "semantic-lexical";
	const graphEnabled = blend !== "semantic-lexical";
	const outputInstruction = retrieveOnly
		? [
				"## Step 5: Context output",
				summarize
					? "Skip generation. Output the per-cluster summaries assembled in Step 4 in Traditional Chinese."
					: "Skip generation. Output the assembled context (title, path, content of each note) in Traditional Chinese.",
			]
		: [
				"## Step 5: Generate answer",
				`Using the assembled context as grounding, answer the following question in Traditional Chinese:`,
				`<question>${query}</question>`,
				"",
				"Base your answer on vault knowledge. If you supplement with information outside the context, clearly indicate so.",
			];

	const tier1Count = Math.min(3, topK);

	const assembleNote = summarize
		? "After reading each cluster, write a 1–2 paragraph summary per cluster and use that as the context."
		: "Use the raw note content directly as context.";

	const seedQualityGate = noRefine
		? ""
		: [
				"",
				"### Seed quality gate",
				"After running the 3 strategies: if the top seed's search_score is below 0.4,",
				"rewrite the query by extracting core keywords or rephrasing with synonyms,",
				"then re-run Step 1's 3 strategies once more (maximum 1 retry).",
				"After the retry, proceed regardless of score.",
			].join("\n");

	const folderScope = folder
		? `Restrict all 3 seed searches to the folder: "${folder}".`
		: "";

	// Defensive clamp: depth <= 0 is nonsensical and would otherwise produce a
	// contradictory prompt ("up to 0 hops" + "run depth-1 neighbors"). Treat as 1.
	const safeDepth = Math.max(1, depth);
	const progressiveDeepening =
		safeDepth >= 2
			? `- Run depth-1 neighbors for all seeds first. Only proceed to depth-2 (and beyond up to ${safeDepth}) if the combined node count is still below ${topK}.`
			: `- Run depth-1 neighbors only (--depth 1). Do not expand further.`;

	return [
		`Execute the graph-enhanced RAG pipeline below to answer the following question:`,
		`<question>${query}</question>`,
		"",
		semanticEnabled
			? [
					`## Step 1: Seed retrieval (run all 4 strategies — ${blend} blend)`,
					"Run all 4 strategies and integrate results to identify the top 3 seed note paths.",
					"Track which mode(s) surfaced each seed — you will tag it in Step 3 provenance:",
					'1. obsidian action:"search" matchMode:fuzzy fields:title — title lexical (lexical:title)',
					'2. obsidian action:"search" matchMode:words fields:tags — tag lexical (lexical:tags)',
					'3. obsidian action:"search" matchMode:words fields:body — body keyword (lexical:body)',
					'4. obsidian action:"semantic_search" query:"<the question>" limit:8 similarity_threshold:0.3 — vector (semantic).',
					'   If action:"semantic_search" returns isError (vault-mind unreachable), skip it',
					"   and fall back to the 3 lexical strategies — never abort the pipeline.",
					folderScope,
					seedQualityGate,
				]
			: [
					"## Step 1: Seed retrieval (run all 3 strategies)",
					"Run all 3 strategies and integrate results to identify the top 3 seed note paths:",
					'1. obsidian action:"search" matchMode:fuzzy fields:title — title similarity (highest priority)',
					'2. obsidian action:"search" matchMode:words fields:tags — tag match',
					'3. obsidian action:"search" matchMode:words fields:body — body keyword (lowest priority)',
					folderScope,
					seedQualityGate,
				],
		"",
		graphEnabled
			? [
					"## Step 2: Graph expansion",
					`For each seed note, run obsidian action:"search" graph:"neighbors" up to ${safeDepth} hop(s).`,
					"",
					"Constraints (must follow):",
					progressiveDeepening,
					`- Limit to ${maxNeighbors} neighbor nodes per seed per hop.`,
					"- Merge all seed results and deduplicate to build the expanded node set.",
				]
			: [
					"## Step 2: No graph expansion (semantic-lexical blend)",
					"Skip wiki-link neighbor traversal entirely. Rank the Step 1 seed set directly —",
					"the link_count popularity term is disabled in Step 3, so graph neighbors carry no",
					"score and would only dilute the top-k. Proceed to Step 3 with the seed set as-is.",
				],
		"",
		"## Step 3: Cluster & rank",
		`Score each note in the candidate set using the formula below, then select the top ${topK}:`,
		"",
		blend === "three-way"
			? [
					'  score = 0.4 × semantic   (cosine similarity from action:"semantic_search"; 0 if not surfaced by it)',
					'        + 0.3 × lexical    (the search_score from action:"search"; use 0.5 if unavailable, -1 sentinel → 0)',
					"        + 0.3 × link_count (number of [[wikilink]] occurrences in the note body)",
					"",
					"Provenance: for each selected note, record which mode(s) surfaced it —",
					"  semantic, lexical:title, lexical:tags, lexical:body, and/or graph (neighbor).",
					"  A note reached only as a graph neighbor of a semantic seed is tagged `semantic,graph`.",
				]
			: blend === "semantic-lexical"
			? [
					'  score = 0.55 × semantic  (cosine similarity from action:"semantic_search"; 0 if not surfaced by it)',
					'        + 0.45 × lexical   (the search_score from action:"search"; use 0.5 if unavailable, -1 sentinel → 0)',
					"        (NO link_count term — graph popularity is disabled in this blend)",
					"",
					"Provenance: for each selected note, record which mode(s) surfaced it —",
					"  semantic, lexical:title, lexical:tags, lexical:body. There is no graph neighbor tag.",
				]
			: [
					'  score = 0.7 × search_score  (the score field from action:"search"; use 0.5 if unavailable)',
					"        + 0.3 × link_count    (number of [[wikilink]] occurrences in the note body)",
				],
		"",
		`List notes in descending score order and confirm the top ${topK} paths.`,
		"Group selected notes by tag (cluster).",
		"",
		"## Step 4: Context assembly",
		"",
		"Use a 2-tier strategy to assemble context:",
		"",
		`Tier 1 (full read): for notes ranked in the top ${tier1Count}, or with score ≥ 0.7:`,
		`  Run obsidian action:"read". Truncate each note's content to ${maxNoteTokens} tokens`,
		"  (take from the beginning if it exceeds the limit).",
		assembleNote,
		"",
		"Tier 2 (snippet only): for all other notes:",
		'  Use the snippet from action:"search" directly. Do NOT call action:"read".',
		"",
		"Feature surfacing (P1): when a note contains an Obsidian callout block",
		"(`> [!warning|tip|info|caution|...] ...`), surface the callout text FIRST in",
		"the context you pass to generation — the warning/tip line is usually the",
		"highest-signal sentence in a human-authored note and must not be buried in",
		"the truncated prose body. Quote it verbatim (including the `[!type]`).",
		"  BY-DESIGN: zk_ask SURFACES callouts (Step 4, after the note is read) but",
		"  does NOT boost them in the Step-3 score. retrieveRecords (the other read",
		"  path) DOES apply a +0.5 callout boost — because it reads frontmatter at",
		'  rank time, which the agent cannot here (notes are read via action:"read"',
		"  only in Step 4). See src/retrieve.ts + the drift-guard test.",
		...outputInstruction,
		"",
		"Append a reference list at the end:",
		"**Reference notes:**",
		semanticEnabled && retrieveOnly
			? graphEnabled
				? "- [[Note Title]] (path/to/note.md) [modes: semantic|lexical|graph] — one-line reason for inclusion"
				: "- [[Note Title]] (path/to/note.md) [modes: semantic|lexical] — one-line reason for inclusion"
			: "- [[Note Title]] (path/to/note.md) — one-line reason for inclusion",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic health check registration (Phase 1 de-dup)
// Register graphHealth/healGraph with pi-obsidian so the obsidian garden tool's
// deterministic engine can call them without a backwards import dependency.
// ---------------------------------------------------------------------------
registerDeterministicHealthCheck(async (opts) => {
	const hOpts = { vaultPath: opts.vaultPath, folder: opts.folder, mocPath: opts.mocPath };
	if (opts.fix) {
		const healed = await healGraph(hOpts);
		console.error(
			`  [garden:det] heal: MOC ${healed.mocRegenerated ? "regenerated" : "no change"}, ` +
			`${healed.deadLinksPruned} dead link(s) pruned in ${healed.cardsTouched.length} card(s)`,
		);
	}
	const h = await graphHealth(hOpts);
	return { health: h, text: formatHealth(h) };
});

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

/**
 * ADR-0001: converge hermes-memory §-entries into the vault knowledge graph.
 * Owned by the HUB (not hermes) so hermes stays a pure TIER-0 foundation with
 * no upward dependency edge. Reads every `.md` in `hermesDir`, adapts via
 * `adaptHermesMarkdown`, ingests via `ingestRecords` (idempotent by canonical
 * id). Returns the ingest summary, or null if the dir is absent (hermes not
 * installed) or holds no records. Directly testable (no resolveVault/env coupling).
 */
export async function convergeHermesMemory(
	vaultPath: string,
	hermesDir: string,
) {
	let files: string[];
	try {
		files = readdirSync(hermesDir).filter((f) => f.endsWith(".md"));
	} catch {
		return null; // hermes dir absent/unreadable — hermes not installed
	}
	const records = files.flatMap((f) =>
		adaptHermesMarkdown(readFileSync(join(hermesDir, f), "utf8")),
	);
	if (records.length === 0) return null;
	return ingestRecords(records, {
		vaultPath,
		source: "hermes",
		sourceLabel: "hermes:auto-converge",
		wikiAware: true,
	});
}

export default function piKnowledgeCardExtension(pi: ExtensionAPI) {
	// zk_extract tool removed (Phase 1 de-dup): it was a 100% passthrough to
	// obsidian_distill. Use obsidian_distill directly. buildDistillTask remains
	// exported above for the CLI zk-extract command.

	// Capture the parent session's extension tools so zk_* in-process subagents
	// (via spawnSubagent) reach obsidian tools in manifest AND `-e` dev mode (R2).
	pi.on("session_start", () => {
		try {
			parentExtensionTools =
				(pi as unknown as { getAllToolDefinitions?: () => ToolDefinition[] }).getAllToolDefinitions?.() ??
				parentExtensionTools;
		} catch {
			// getAllToolDefinitions is a runtime patch — absent in some contexts.
		}
		// Publish zk's 5-function knowledge surface as the __piKnowledgePipeline
		// seam (typed via @repo/pi-agent-ext-core-interface). Live for the session;
		// unpublishKnowledgePipeline() tears it down at session_shutdown.
		publishKnowledgePipeline({ collectInputFiles, ingestRecords, runConvergenceLoop, retrieveRecords, healGraph });
	});

	// ── Auto-converge hermes memory → graph on session_shutdown (ADR-0001) ──
	// Convergence ownership lives in the HUB, not in hermes. Hermes is a pure
	// TIER-0 foundation; this handler PULLS its memory files at shutdown and
	// converges them via convergeHermesMemory() — so there is NO hermes→hub
	// dependency edge. Best-effort + config-gated (OB_HERMES_AUTOCONVERGE=0
	// disables); convergeHermesMemory tolerates a missing hermes dir. Never
	// blocks shutdown.
	pi.on("session_shutdown", async (_event, ctx) => {
		// Unpublish the seam first — it was published unconditionally at
		// session_start, so it must be torn down unconditionally (before the
		// OB_HERMES_AUTOCONVERGE early-return below).
		unpublishKnowledgePipeline();
		if (process.env.OB_HERMES_AUTOCONVERGE === "0") return;
		try {
			const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			const vaultPath = (await resolveVault(cwd)).path;
			const hermesDir =
				process.env.OB_HERMES_MEMORY_DIR ?? join(homedir(), ".pi", "agent", "pi-hermes-memory");
			await convergeHermesMemory(vaultPath, hermesDir);
		} catch {
			// Silent fail — best-effort; never block shutdown.
		}
	});

	// ---- Tool: zk_card ------------------------------------------------------
	pi.registerTool({
		name: "zk_card",
		label: "ZK Card",
		gating: { core: true },
		description: [
			"CRUD operations on Zettelkasten vault notes.",
			"Actions: add (new note with 4-layer duplicate check), find (multi-strategy search),",
			"update (smart-merge content into existing note), remove (backlink-safe delete),",
			"check (vault health audit: duplicates, orphans, dead links).",
		].join(" "),
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("add"),
					Type.Literal("find"),
					Type.Literal("update"),
					Type.Literal("remove"),
					Type.Literal("check"),
				],
				{ description: "Operation to perform." },
			),
			content: Type.Optional(
				Type.String({
					description:
						"Note content — required for add; new content to merge for update.",
				}),
			),
			query: Type.Optional(
				Type.String({ description: "Search query — required for find." }),
			),
			note: Type.Optional(
				Type.String({
					description:
						"Vault-relative note path — required for update and remove.",
				}),
			),
			folder: Type.Optional(
				Type.String({
					description: "Target folder for add (default: Zettelkasten).",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"add: bypass duplicate threshold. remove: delete even with backlinks.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "find: max results (default: 10).",
					minimum: 1,
				}),
			),
			context_lines: Type.Optional(
				Type.Number({
					description:
						"find: context lines around each match (default: 3; 0 = titles only).",
					minimum: 0,
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Override the subagent's model (provider/id[:thinking]). Default: google/gemma-4-12b (local LM Studio); override session-wide via KC_SUBAGENT_MODEL env. Mirrors the CLI --model flag.",
				}),
			),
			exclude_tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Tool names to deny the subagent (mirrors the CLI --exclude-tools flag).",
				}),
			),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const { cwd } = ctx;
			const folder = params.folder ?? "Zettelkasten";

			let task: string;
			let tools: string[];

			switch (params.action) {
				case "add": {
					if (!params.content) {
						return {
							content: [
								{ type: "text", text: "zk_card add requires 'content'." },
							],
							isError: true,
							details: null,
						};
					}
					task = buildAddTask(params.content, folder, params.force ?? false);
					tools = ADD_TOOLS;
					break;
				}
				case "find": {
					if (!params.query) {
						return {
							content: [
								{ type: "text", text: "zk_card find requires 'query'." },
							],
							isError: true,
							details: null,
						};
					}
					task = buildFindTask(
						params.query,
						params.context_lines ?? 3,
						params.limit ?? 10,
					);
					tools = FIND_TOOLS;
					break;
				}
				case "update": {
					if (!params.note || !params.content) {
						return {
							content: [
								{
									type: "text",
									text: "zk_card update requires 'note' and 'content'.",
								},
							],
							isError: true,
							details: null,
						};
					}
					task = buildUpdateTask(params.note, params.content);
					tools = UPDATE_TOOLS;
					break;
				}
				case "remove": {
					if (!params.note) {
						return {
							content: [
								{ type: "text", text: "zk_card remove requires 'note'." },
							],
							isError: true,
							details: null,
						};
					}
					task = buildRemoveTask(params.note, params.force ?? false);
					tools = REMOVE_TOOLS;
					break;
				}
				case "check": {
					task = CHECK_TASK;
					tools = CHECK_TOOLS;
					break;
				}
				default: {
					return {
						content: [
							{ type: "text", text: `Unknown action: ${params.action}` },
						],
						isError: true,
						details: null,
					};
				}
			}

			const { output, failure } = await zkSpawn({
				cwd,
				task,
				tools,
				model: resolveDistillModel(params.model),
				excludeTools: params.exclude_tools,
				externalSignal: signal,
				extensionTools: parentExtensionTools,
			});
			if (failure?.kind === "timedout") {
				return {
					content: [
						{
							type: "text",
							text: `zk_card ${params.action} timed out.\n${output.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message },
				};
			}
			if (failure && !output) {
				return {
					content: [
						{
							type: "text",
							text: `zk_card ${params.action} failed.\n${failure.message.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: withVault(
							await vaultHeader(ctx.cwd),
							output || `(zk_card ${params.action} produced no output)`,
						),
					},
				],
				details: { status: failure?.kind ?? "done" },
			};
		},
	});

	// ---- Tool: zk_ask -------------------------------------------------------
	pi.registerTool({
		name: "zk_ask",
		label: "ZK Ask",
		gating: { core: true },
		description: [
			"Graph-enhanced RAG over the Zettelkasten vault.",
			"Pipeline: seed retrieval (fuzzy title + tag + body keyword) →",
			"graph expansion (N-hop wiki-link traversal) →",
			"cluster & rank (0.7×search_score + 0.3×link_count) →",
			"context assembly (full read for top-K, snippet for rest) →",
			"synthesized answer in Traditional Chinese with reference list.",
		].join(" "),
		parameters: Type.Object({
			question: Type.String({
				description:
					"Natural language question to answer from vault knowledge.",
			}),
			depth: Type.Optional(
				Type.Number({
					description: "Graph hop depth for neighbor expansion (default: 2).",
					minimum: 1,
				}),
			),
			top_k: Type.Optional(
				Type.Number({
					description: "Max notes to include in context (default: 8).",
					minimum: 1,
				}),
			),
			max_neighbors: Type.Optional(
				Type.Number({
					description: "Max neighbor nodes per seed per hop (default: 5).",
					minimum: 1,
				}),
			),
			max_note_tokens: Type.Optional(
				Type.Number({
					description:
						"Token limit per note in full-read tier (default: 2000).",
					minimum: 1,
				}),
			),
			summarize: Type.Optional(
				Type.Boolean({
					description: "Summarize each tag cluster before generating.",
				}),
			),
			retrieve_only: Type.Optional(
				Type.Boolean({
					description: "Return assembled context only, skip answer generation.",
				}),
			),
			no_refine: Type.Optional(
				Type.Boolean({
					description:
						"Skip seed quality gate (no query rewrite on poor seeds).",
				}),
			),
			folder: Type.Optional(
				Type.String({
					description: "Restrict seed search to this vault folder.",
				}),
			),
			blend: Type.Optional(
				Type.Union(
					[Type.Literal("default"), Type.Literal("three-way"), Type.Literal("semantic-lexical")],
					{
						description:
							"Retrieval blend mode. 'default' = lexical (title/tags/body) + graph — the vault-wide default, kept as default PERMANENTLY (a DECISION, not a pending measurement): across iter-3→iter-7 the semantic blends never won a regime on this corpus — iter-7 receipt 2026-07-07T01-00-52 (English queries) lexical mean rel 0.770 vs semantic-lexical 0.466 (lexical wins 4/5); iter-6 receipt 2026-07-05T22-57-51 (zh-TW queries) 0.332 vs 0.100. RETIRED from the default READ path — diagnostic/opt-in only; do NOT re-measure on the current corpus/regime (a genuinely NEW regime — a 10× vault, or a different vault-mind embedding model — would legitimately re-open it). The graph layer (wiki-link expansion) is the structure signal that bridges concepts across languages better than semantic vectors. 'three-way' adds a semantic (vector) seed via `obsidian` action:\"semantic_search\" and rebalances the rank score to 0.4 semantic / 0.3 lexical / 0.3 graph. 'semantic-lexical' drops graph expansion entirely (0.55 semantic / 0.45 lexical, no link term). Both remain as explicit opt-in (`--blend`) for paraphrase / cross-lingual probes; both require a running vault-mind service and fall back gracefully. Default: 'default'.",
					},
				),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Override the RAG subagent's model (provider/id[:thinking]). Default: google/gemma-4-12b (local LM Studio); override session-wide via KC_SUBAGENT_MODEL env. Mirrors the CLI --model flag.",
				}),
			),
			exclude_tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Tool names to deny the RAG subagent (mirrors the CLI --exclude-tools flag).",
				}),
			),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const { cwd } = ctx;
			const task = buildRagTask(
				params.question,
				params.depth ?? 2,
				params.top_k ?? 8,
				params.summarize ?? false,
				params.retrieve_only ?? false,
				params.max_neighbors ?? 5,
				params.max_note_tokens ?? 2000,
				params.no_refine ?? false,
				params.folder,
				params.blend ?? "default",
			);
			const { output, failure } = await zkSpawn({
				cwd,
				task,
				tools: ragToolsFor(params.blend ?? "default"),
				model: resolveDistillModel(params.model),
				excludeTools: params.exclude_tools,
				externalSignal: signal,
				extensionTools: parentExtensionTools,
			});
			if (failure?.kind === "timedout") {
				return {
					content: [
						{ type: "text", text: `zk_ask timed out.\n${output.slice(-2000)}` },
					],
					isError: true,
					details: { status: failure.kind, error: failure.message },
				};
			}
			if (failure && !output) {
				return {
					content: [
						{
							type: "text",
							text: `zk_ask failed.\n${failure.message.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: withVault(
							await vaultHeader(ctx.cwd),
							output || "(zk_ask produced no output)",
						),
					},
				],
				details: { status: failure?.kind ?? "done" },
			};
		},
	});

	// ---- Tool: zk_ingest ----------------------------------------------------
	// Deterministic convergence primitive (the only zk_* tool that does NOT
	// spawn a subagent). Maps structured .knowledge.jsonl records 1:1 onto
	// zettel cards in the shared vault, dedup'd by record id, cross-linked by
	// shared tags, indexed by a MOC. See src/ingest.ts for the schema mapping.
	pi.registerTool({
		name: "zk_ingest",
		label: "ZK Ingest",
		gating: { core: true },
		description: [
			"Deterministically converge structured .knowledge.jsonl records into the shared Zettelkasten vault.",
			"One card per record (id/type/title/detail/tags/dimension/confidence/status/superseded_by/evidence),",
			"dedup'd by canonical record id (re-ingest upserts in place), cross-linked by shared tags,",
			"and indexed by a Knowledge Graph MOC. No LLM — lossless + idempotent, unlike obsidian_distill.",
			"This is the convergence sink that lets every self-improve loop's distilled knowledge flow",
			"into ONE queryable, backlinked graph that zk_ask can traverse cross-source.",
			"Optionally, with action='gate'|'converge'|'status' it drives the agent self-triggered distill pipeline ",
			"(Gate→Enrich-in-agent→Converge) over hermes-memory entries.",
		].join(" "),
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union(
					[
						Type.Literal("gate"),
						Type.Literal("converge"),
						Type.Literal("status"),
					],
					{
						description:
							"Distill pipeline action (absent = deterministic ingest, the default). " +
							"'gate' filters raw hermes-memory entries (dedup/stale/malformed) and returns " +
							"survivors for in-context enrichment (read-only). 'converge' writes enriched " +
							"notes via the ingest path, supersedes the raw hermes/pi-memory card, and adjusts the " +
							"adaptive threshold. 'status' reports the current threshold + run history. " +
							"Workflow: status → gate → enrich survivors in your reasoning → converge.",
					},
				),
			),
			entries: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						target: Type.String(),
						content: Type.String(),
						created: Type.String(),
						last: Type.Optional(Type.String()),
					}),
					{ description: "Raw hermes-memory entries (required for action='gate')." },
				),
			),
			notes: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						type: Type.String(),
						title: Type.String(),
						detail: Type.String(),
						tags: Type.Array(Type.String()),
						dimension: Type.Optional(Type.String()),
						confidence: Type.Optional(Type.Number()),
						supersedesCardId: Type.Optional(Type.String()),
					}),
					{ description: "Enriched notes (required for action='converge')." },
				),
			),
			metrics: Type.Optional(
				Type.Object(
					{
						candidates: Type.Number(),
						killed: Type.Number(),
						survivors: Type.Number(),
					},
					{ description: "Gate metrics (required for action='converge')." },
				),
			),
			files: Type.Array(Type.String(), {
				description:
					"Paths to input files (absolute or relative to cwd). Each entry may also be a DIRECTORY — recursively expanded for the source's file type (.md for auto-memory/hermes/generic, .knowledge.jsonl for workflow-jsonl); MEMORY.md/README.md index files are skipped. For a random .md folder, use source=generic.",
			}),
			dir: Type.Optional(
				Type.String({
					description:
						"Convenience: a directory to expand (equivalent to files:[<dir>]). Common case for ingesting a whole memory directory.",
				}),
			),
			source: Type.Optional(
				Type.String({
					description:
						"Source family: workflow-jsonl (.knowledge.jsonl), hermes (§-separated memory .md), auto-memory (name/description .md), or generic (ANY .md — the universal adapter that accepts a random .md folder). Default: workflow-jsonl.",
					default: "workflow-jsonl",
				}),
			),
			source_label: Type.Optional(
				Type.String({
					description:
						"Human-readable provenance string. Defaults to '<source>:<first file basename>'.",
				}),
			),
			folder: Type.Optional(
				Type.String({
					description:
						"Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). All sources converge into the SAME folder so cross-source edges form.",
				}),
			),
			dry_run: Type.Optional(
				Type.Boolean({
					description:
						"Report what would be created/updated without writing anything.",
				}),
			),
			vault: Type.Optional(
				Type.String({
					description:
						"Override the vault path (else resolved via OB_VAULT_PATH / --vault-dir / cwd/vault through pi-obsidian).",
				}),
			),
		}),
		async execute(_id, params, _signal, _u, ctx) {
			// ── distill pipeline actions (folded from pi-agent-ext-distill) ──
			const action = params.action as "gate" | "converge" | "status" | undefined;
			if (action === "gate" || action === "converge" || action === "status") {
				let vaultPath: string;
				try {
					vaultPath = params.vault ?? (await resolveVault(ctx.cwd)).path;
				} catch (e) {
					return {
						content: [
							{
								type: "text",
								text: `zk_ingest: vault resolution failed: ${(e as Error).message}`,
							},
						],
						isError: true,
						details: { code: "vault_resolution_failed" },
					};
				}

				if (action === "status") {
					const state = readState(vaultPath);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									threshold: state.threshold,
									lastRun: state.lastRun,
									historyEntries: state.history.length,
									recentRuns: state.history.slice(-3),
								}),
							},
						],
						isError: false,
						details: null,
					};
				}

				if (action === "gate") {
					const entries = (params.entries ?? []) as MemoryEntry[];
					const result = runGate(entries, vaultPath);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									candidates: result.candidates,
									killed: result.killed.length,
									survivors: result.survivors.map((s) => ({
										id: s.entry.id,
										content: s.entry.content,
										target: s.entry.target,
										reason: s.reason,
									})),
									killReasons: result.killed.reduce(
										(acc: Record<string, number>, k) => {
											acc[k.reason] = (acc[k.reason] ?? 0) + 1;
											return acc;
										},
										{},
									),
								}),
							},
						],
						isError: false,
						details: null,
					};
				}

				// action === "converge"
				const notes = (params.notes ?? []) as EnrichedNote[];
				const metrics = (params.metrics ?? { candidates: 0, killed: 0, survivors: 0 }) as ConvergeMetrics;
				const result = await runConverge(notes, vaultPath, metrics);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					isError: false,
					details: null,
				};
			}

			const { cwd } = ctx;
			const inputs = [...(params.files ?? []), ...(params.dir ? [params.dir] : [])];
			if (inputs.length === 0) {
				return {
					content: [{ type: "text", text: "No input files provided." }],
					isError: true,
					details: null,
				};
			}
			const source = (params.source ?? "workflow-jsonl") as SourceFamily;
			// Expand directories + resolve to absolute, sorted, unique paths.
			const { files, skipped } = collectInputFiles(inputs, { source, cwd });
			if (files.length === 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`zk_ingest: no input files resolved` +
								(skipped.length
									? `; skipped: ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`
									: ""),
						},
					],
					isError: true,
					details: { code: "no_input_files", skipped },
				};
			}
			const sourceLabel =
				params.source_label ??
				`${source}:${files[0]!.split("/").pop()!.replace(/\.(knowledge\.jsonl|md)$/, "")}`;
			let vaultPath: string;
			try {
				vaultPath = params.vault ?? (await resolveVault(cwd)).path;
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `zk_ingest: vault resolution failed: ${(e as Error).message}`,
						},
					],
					isError: true,
					details: { code: "vault_resolution_failed" },
				};
			}

			const records: KnowledgeRecord[] = [];
			const parseErrors: { line: number; reason: string }[] = [];
			for (const abs of files) {
				let content: string;
				try {
					content = readFileSync(abs, "utf8");
				} catch (e) {
					parseErrors.push({
						line: 0,
						reason: `${abs}: read failed (${(e as Error).message})`,
					});
					continue;
				}
				if (source === "hermes") {
					// hermes inputs are .md memory files with MANY `§`-separated entries
					// (failures/MEMORY/USER) — adapt to one record per entry.
					const recs = adaptHermesMarkdown(content);
					if (recs.length === 0) {
						parseErrors.push({ line: 0, reason: `${abs}: no § entries parsed` });
						continue;
					}
					records.push(...recs);
				} else if (source === "auto-memory") {
					const rec = adaptAutoMemoryMarkdown(content);
					if (!rec) {
						parseErrors.push({ line: 0, reason: `${abs}: not a memory file` });
						continue;
					}
					records.push(rec);
				} else if (source === "generic") {
					// generic inputs are ANY .md files (no frontmatter/H1/tag
					// assumptions) — one record per file via the universal adapter.
					const rec = adaptGenericMarkdown(content, abs);
					if (!rec) {
						parseErrors.push({ line: 0, reason: `${abs}: empty or unparseable` });
						continue;
					}
					records.push(rec);
				} else {
					const parsed = parseKnowledgeJsonl(content);
					records.push(...parsed.records);
					parseErrors.push(...parsed.parseErrors);
				}
			}

			const summary = await ingestRecords(records, {
				vaultPath,
				source,
				sourceLabel,
				folder: params.folder,
				dryRun: params.dry_run === true,
			});
			summary.parseErrors.push(...parseErrors);
			const skippedNote = skipped.length
				? `\nSkipped: ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`
				: "";
			return {
				content: [
					{
						type: "text",
						text: withVault(await vaultHeader(cwd), formatSummary(summary) + skippedNote),
					},
				],
				details: { ...summary, skipped },
			};
		},
	});

	// ─── knowledge_query tool (migrated from pi-agent-ext-power-tool) ────────
	// Deterministic, no-LLM cross-workflow digest over the convergence folder.
	// This is the hub's direct agent surface over retrieve.ts — the same library
	// zk-query (CLI) consumes. Behavior-preserving move (consolidation cycle).
	pi.registerTool({
		name: "knowledge_query",
		label: "Knowledge Query",
		gating: { core: true },
		description:
			"Query the project's Zettelkasten knowledge graph for cards matching given tags " +
			"or a natural-language question. Returns a compact digest of relevant stored " +
			"knowledge (gotchas, patterns, levers, avoid, false_positive, metric cards). " +
			"Call this BEFORE answering a question that may benefit from past workflow " +
			"lessons.",
		parameters: Type.Object({
			tags: Type.Optional(Type.Array(Type.String(), {
				description: "Tags to match (ANY semantics). e.g. [\"argparse\", \"lora\"]",
			})),
			query: Type.Optional(Type.String({
				description: "Natural language query. If provided without tags, tags are inferred.",
			})),
			topK: Type.Optional(Type.Number({
				description: "Max cards to return (default 10)",
				default: 10,
			})),
			trace: Type.Optional(Type.Boolean({
				description:
					"Opt-in retrieval trace (Phase C observability). When true, the result's " +
					"`details.trace` carries per-card score/sharedTags/source provenance (lexical " +
					"vs semantic) for debugging why cards surfaced. The text digest is " +
					"unchanged. Default false.",
				default: false,
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let vaultPath: string;
			try {
				vaultPath = await resolveKnowledgeVault(ctx.cwd);
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `knowledge_query: vault resolution failed: ${(e as Error).message}` }],
					isError: true,
					details: { code: "vault_resolution_failed" },
				};
			}

			const tags: string[] = params.tags ?? [];
			const query: string = params.query ?? "";
			const topK: number = params.topK ?? 10;
			const includeTrace: boolean = params.trace === true;

			if (tags.length === 0 && !query) {
				return {
					content: [{ type: "text" as const, text: "Provide tags[], a query string, or both." }],
					details: null,
				};
			}

			// If no tags but a query is provided, split the query into word tokens as tags.
			const effectiveTags = tags.length > 0 ? tags : (
				query
					.toLowerCase()
					.replace(/[^a-z0-9-]+/g, " ")
					.trim()
					.split(/\s+/)
					.filter((t) => t.length >= 3 && t.length <= 30)
					.slice(0, 10)
			);

			const opts: RetrieveOptions = {
				vaultPath,
				folder: "Zettelkasten/knowledge-graph",
				tags: effectiveTags,
				topK,
				// Body-match recall (kg-improvement-plan follow-on): also surface cards
				// whose query tokens appear in body prose, not just tags. Blend score
				// (tag×2 + body + callout) — measured 0.48 → 0.80 hit-rate@4, zero
				// regression on the 25-query eval. This is knowledge_query's recall win.
				bodyMatch: true,
				// Slug-dominant precision (iter-2): a card whose slug overlaps ≥3 query
				// tokens scores by slug×4 — the topic fingerprint beats ubiquitous-tag
				// noise. Measured 0.80 → 0.84 hit-rate@4, zero regression. Composes
				// with bodyMatch; cheap (slug = filename, no extra read).
				slugDom: true,
				// Semantic (embedding) blend (recall-regime-change-eval, 2026-07-12):
				// union lexical top-12 with a nomic-embed cosine top-12, rerank by
				// α·lexRank + (1-α)·cosNorm. Bridges symptom→cause gaps lexical
				// retrieval cannot (measured 0.84 → 1.00 hit-rate@4, zero regression).
				// Graceful fallback: if LM Studio / nomic unavailable, retrieval is
				// pure lexical (the shipped 0.84 path) — no error.
				semantic: true,
				queryText: query,
				// Phase C observability: opt-in per-card provenance trace in `details`.
				includeTrace,
			};

			const result = await retrieveRecords(opts);

			if (result.count === 0) {
				return {
					content: [{ type: "text" as const, text: `No knowledge cards matched tags [${effectiveTags.join(", ")}].` }],
					details: result,
				};
			}

			const lines = [
				`Knowledge graph: ${result.count} card(s) matched (scanned ${result.scanned}, excluded ${result.excluded})`,
				"",
				result.digest,
			];

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: result,
			};
		},
	});

	// ── Workflow host-fn registration (sub-project ②) ────────────────────────
	// Register the four deterministic zk.* fns with the workflow runtime over the
	// in-process event bus. Idempotent (the runtime overwrites on re-register);
	// re-emit on `request` so we still register if we loaded before the workflow
	// extension's listener existed. No-op if the workflow ext is absent.
	const __hostFnBus = (pi as unknown as {
		events?: { emit: (ch: string, p: unknown) => void; on: (ch: string, cb: (p: unknown) => void) => void };
	}).events;
	const __registerZkHostFns = () => {
		if (!__hostFnBus) return;
		const entries = [
			{ ns: "zk", name: "retrieve", fn: zkRetrieve, timeoutMs: 30_000 },
			{ ns: "zk", name: "ingest", fn: zkIngest, timeoutMs: 120_000 },
			{ ns: "zk", name: "health", fn: zkHealth, timeoutMs: 60_000 },
			{ ns: "zk", name: "heal", fn: zkHeal, timeoutMs: 60_000 },
		];
		for (const e of entries) __hostFnBus.emit("workflow:hostfn:v1:register", e);
	};
	__registerZkHostFns();
	__hostFnBus?.on("workflow:hostfn:v1:request", __registerZkHostFns);

	// ── pi:knowledge sink — de-orphan the bus (file2md opt-in convergence) ──
	// ADR-0001: the HUB owns convergence. Foundation extensions (file2md) emit
	// on the bus without importing the hub; this subscriber converges them.
	// Best-effort: resolveVault/ingest failures are swallowed — a bus handler
	// must never throw (mirrors src/emit.ts's swallow-on-failure contract).
	// (Placed last in the factory so the sink test's single-capture fake pi —
	// which keeps the last events.on handler — observes this subscriber.)
	onKnowledge(pi, async (payload) => {
		try {
			const cwd = process.cwd();
			const vaultPath = (await resolveVault(cwd)).path;
			await convergeKnowledgeEmission(payload, { vaultPath, cwd });
		} catch {
			// best-effort: never throw from a bus handler
		}
	});
}
