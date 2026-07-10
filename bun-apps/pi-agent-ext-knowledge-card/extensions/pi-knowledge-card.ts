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
 * (DISTILL_TOOLS / ADD_TOOLS / … / RAG_TOOLS). The bun-pi-agent-cli
 * zk-extract / zk-card / zk-ask commands import these same builders so the CLI
 * and the extension never drift apart.
 *
 * Env:
 *   OB_VAULT_PATH / OB_VAULT_DIR   vault resolution (passed through to obsidian)
 *   OB_SUBAGENT_TIMEOUT_MS         subagent timeout (default 5 min)
 */

import { relative } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	runSubagentWithRetry,
	resolveVault,
} from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";
import {
	ingestRecords,
	parseKnowledgeJsonl,
	adaptAutoMemoryMarkdown,
	collectInputFiles,
	formatSummary,
	type KnowledgeRecord,
	type SourceFamily,
} from "../src/ingest.ts";
import {
	retrieveRecords,
	type RetrieveOptions,
} from "../src/retrieve.ts";

// ---------------------------------------------------------------------------
// Tool allowlists (per command) — exported so the CLI reuses the exact same
// sets as this extension. Canonical form: string[] (natural TS). Extension
// call sites join(",") for runSubagentWithRetry's `toolsCsv` parameter.
// ---------------------------------------------------------------------------

export const DISTILL_TOOLS = [
	"read",
	"obsidian_distill",
	"obsidian_list",
	"obsidian_read",
	"obsidian_search",
];

export const ADD_TOOLS = [
	"obsidian_search",
	"obsidian_query",
	"obsidian_read",
	"obsidian_create",
	"obsidian_append_section",
	"obsidian_update_frontmatter",
	"obsidian_list",
];

export const FIND_TOOLS = [
	"obsidian_search",
	"obsidian_query",
	"obsidian_read",
	"obsidian_list",
];

export const UPDATE_TOOLS = [
	"obsidian_read",
	"obsidian_search",
	"obsidian_append",
	"obsidian_append_section",
	"obsidian_update_frontmatter",
];

export const REMOVE_TOOLS = [
	"obsidian_read",
	"obsidian_search",
	"obsidian_delete",
];

export const CHECK_TOOLS = [
	"obsidian_garden",
	"obsidian_list",
	"obsidian_read",
	"obsidian_search",
	"obsidian_query",
];

// Same tools as find — graph expansion is just a parameter to obsidian_search
// (graph:"neighbors"), so no separate tool is needed.
export const RAG_TOOLS = [
	"obsidian_search",
	"obsidian_query",
	"obsidian_read",
	"obsidian_list",
];

/** Three-way blend adds the vault-mind semantic (vector) seed. Kept out of the
 *  default allowlist because it needs a running vault-mind service. */
export const RAG_TOOLS_THREE_WAY = [
	...RAG_TOOLS,
	"obsidian_semantic_search",
];

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
// both this extension and bun-pi-agent-cli's zk-* commands import these.
// ---------------------------------------------------------------------------

const DISTILL_TASK_PREFIX =
	"Call the `obsidian_distill` tool immediately with the input files listed below. " +
	"Your FIRST action MUST be a tool call to `obsidian_distill` — do NOT write any text before invoking the tool.";

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
		"Input files (pass as the files parameter to obsidian_distill):",
		...rel,
		"",
		"After obsidian_distill returns, briefly report the number of notes created in Traditional Chinese.",
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
				"Layer 1: obsidian_search matchMode:fuzzy fields:title — check for similar titles",
				"Layer 2: obsidian_search matchMode:words fields:body — check for keyword overlap",
				"Layer 3: obsidian_query — check for matching tags",
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
		"2. New content is supplementary → obsidian_append_section to the relevant heading",
		"3. No relevant heading exists → obsidian_append to the end of the note",
		"4. New tags discovered → obsidian_update_frontmatter to union-merge tags",
		"5. New sources discovered → obsidian_update_frontmatter to append to sources[]",
		"",
		"After completion, report a summary of the changes made in Traditional Chinese.",
	].join("\n");
}

export function buildRemoveTask(notePath: string, force: boolean): string {
	if (force) {
		return [
			`--force mode: delete the following note: ${notePath}`,
			"",
			"1. Delete this note with obsidian_delete (including link cleanup).",
			"",
			"After completion, report the deletion result in Traditional Chinese.",
		].join("\n");
	}
	return [
		`Verify that the following note can be safely deleted, then delete it if so: ${notePath}`,
		"",
		"## Safe-delete protocol",
		"1. obsidian_read — confirm the note exists",
		"2. obsidian_search backlinks:true — find notes that link to this one",
		"3. If backlinks are found → abort: list the affected notes and advise using --force",
		"4. If no backlinks → obsidian_delete (confirm: true)",
		"",
		"After completion, report the result in Traditional Chinese.",
	].join("\n");
}

export const CHECK_TASK = [
	"Use obsidian_garden in audit mode to diagnose vault health.",
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
					"1. obsidian_search matchMode:fuzzy fields:title — title lexical (lexical:title)",
					"2. obsidian_search matchMode:words fields:tags — tag lexical (lexical:tags)",
					"3. obsidian_search matchMode:words fields:body — body keyword (lexical:body)",
					"4. obsidian_semantic_search query:\"<the question>\" limit:8 similarity_threshold:0.3 — vector (semantic).",
					"   If obsidian_semantic_search returns isError (vault-mind unreachable), skip it",
					"   and fall back to the 3 lexical strategies — never abort the pipeline.",
					folderScope,
					seedQualityGate,
				]
			: [
					"## Step 1: Seed retrieval (run all 3 strategies)",
					"Run all 3 strategies and integrate results to identify the top 3 seed note paths:",
					"1. obsidian_search matchMode:fuzzy fields:title — title similarity (highest priority)",
					"2. obsidian_search matchMode:words fields:tags — tag match",
					"3. obsidian_search matchMode:words fields:body — body keyword (lowest priority)",
					folderScope,
					seedQualityGate,
				],
		"",
		graphEnabled
			? [
					"## Step 2: Graph expansion",
					`For each seed note, run obsidian_search graph:"neighbors" up to ${safeDepth} hop(s).`,
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
					"  score = 0.4 × semantic   (cosine similarity from obsidian_semantic_search; 0 if not surfaced by it)",
					"        + 0.3 × lexical    (the search_score from obsidian_search; use 0.5 if unavailable, -1 sentinel → 0)",
					"        + 0.3 × link_count (number of [[wikilink]] occurrences in the note body)",
					"",
					"Provenance: for each selected note, record which mode(s) surfaced it —",
					"  semantic, lexical:title, lexical:tags, lexical:body, and/or graph (neighbor).",
					"  A note reached only as a graph neighbor of a semantic seed is tagged `semantic,graph`.",
				]
			: blend === "semantic-lexical"
			? [
					"  score = 0.55 × semantic  (cosine similarity from obsidian_semantic_search; 0 if not surfaced by it)",
					"        + 0.45 × lexical   (the search_score from obsidian_search; use 0.5 if unavailable, -1 sentinel → 0)",
					"        (NO link_count term — graph popularity is disabled in this blend)",
					"",
					"Provenance: for each selected note, record which mode(s) surfaced it —",
					"  semantic, lexical:title, lexical:tags, lexical:body. There is no graph neighbor tag.",
				]
			: [
					"  score = 0.7 × search_score  (the score field from obsidian_search; use 0.5 if unavailable)",
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
		`  Run obsidian_read. Truncate each note's content to ${maxNoteTokens} tokens`,
		"  (take from the beginning if it exceeds the limit).",
		assembleNote,
		"",
		"Tier 2 (snippet only): for all other notes:",
		"  Use the snippet from obsidian_search directly. Do NOT call obsidian_read.",
		"",
		"Feature surfacing (P1): when a note contains an Obsidian callout block",
		"(`> [!warning|tip|info|caution|...] ...`), surface the callout text FIRST in",
		"the context you pass to generation — the warning/tip line is usually the",
		"highest-signal sentence in a human-authored note and must not be buried in",
		"the truncated prose body. Quote it verbatim (including the `[!type]`).",
		"  BY-DESIGN: zk_ask SURFACES callouts (Step 4, after the note is read) but",
		"  does NOT boost them in the Step-3 score. retrieveRecords (the other read",
		"  path) DOES apply a +0.5 callout boost — because it reads frontmatter at",
		"  rank time, which the agent cannot here (notes are read via obsidian_read",
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
// Extension registration
// ---------------------------------------------------------------------------

export default function piKnowledgeCardExtension(pi: ExtensionAPI) {
	// zk_extract tool removed (Phase 1 de-dup): it was a 100% passthrough to
	// obsidian_distill. Use obsidian_distill directly. buildDistillTask remains
	// exported above for the CLI zk-extract command.

	// ---- Tool: zk_card ------------------------------------------------------
	pi.registerTool({
		name: "zk_card",
		label: "ZK Card",
		description: [
			"CRUD operations on Zettelkasten vault notes.",
			"Actions: add (new note with 4-layer duplicate check), find (multi-strategy search),",
			"update (smart-merge content into existing note), remove (backlink-safe delete),",
			"check (vault health audit: duplicates, orphans, dead links).",
		].join(" "),
		promptSnippet: "CRUD + health-check on Zettelkasten vault notes (add/find/update/remove/check)",
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
						"Override the subagent's model (provider/id[:thinking]). Omit to use the pi default — mirrors the CLI --model flag.",
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
			let toolsCsv: string;
			let tmpPrefix: string;

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
					toolsCsv = ADD_TOOLS.join(",");
					tmpPrefix = "pi-kc-add-";
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
					toolsCsv = FIND_TOOLS.join(",");
					tmpPrefix = "pi-kc-find-";
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
					toolsCsv = UPDATE_TOOLS.join(",");
					tmpPrefix = "pi-kc-update-";
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
					toolsCsv = REMOVE_TOOLS.join(",");
					tmpPrefix = "pi-kc-remove-";
					break;
				}
				case "check": {
					task = CHECK_TASK;
					toolsCsv = CHECK_TOOLS.join(",");
					tmpPrefix = "pi-kc-check-";
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

			const { output, exitCode, stderr, timedOut } = await runSubagentWithRetry(
				cwd,
				"",
				task,
				toolsCsv,
				signal,
				tmpPrefix,
				{ model: params.model, excludeTools: params.exclude_tools },
			);
			if (timedOut) {
				return {
					content: [
						{
							type: "text",
							text: `zk_card ${params.action} timed out.\n${output.slice(-2000)}`,
						},
					],
					isError: true,
					details: { timedOut, stderr },
				};
			}
			if (exitCode !== 0 && !output) {
				return {
					content: [
						{
							type: "text",
							text: `zk_card ${params.action} failed (exit ${exitCode}).\n${stderr.slice(-2000)}`,
						},
					],
					isError: true,
					details: { exitCode, stderr },
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
				details: { exitCode, stderr },
			};
		},
	});

	// ---- Tool: zk_ask -------------------------------------------------------
	pi.registerTool({
		name: "zk_ask",
		label: "ZK Ask",
		description: [
			"Graph-enhanced RAG over the Zettelkasten vault.",
			"Pipeline: seed retrieval (fuzzy title + tag + body keyword) →",
			"graph expansion (N-hop wiki-link traversal) →",
			"cluster & rank (0.7×search_score + 0.3×link_count) →",
			"context assembly (full read for top-K, snippet for rest) →",
			"synthesized answer in Traditional Chinese with reference list.",
		].join(" "),
		promptSnippet: "Graph-enhanced RAG answer over the Zettelkasten vault",
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
							"Retrieval blend mode. 'default' = lexical (title/tags/body) + graph — the vault-wide default, kept as default PERMANENTLY (a DECISION, not a pending measurement): across iter-3→iter-7 the semantic blends never won a regime on this corpus — iter-7 receipt 2026-07-07T01-00-52 (English queries) lexical mean rel 0.770 vs semantic-lexical 0.466 (lexical wins 4/5); iter-6 receipt 2026-07-05T22-57-51 (zh-TW queries) 0.332 vs 0.100. RETIRED from the default READ path — diagnostic/opt-in only; do NOT re-measure on the current corpus/regime (a genuinely NEW regime — a 10× vault, or a different vault-mind embedding model — would legitimately re-open it). The graph layer (wiki-link expansion) is the structure signal that bridges concepts across languages better than semantic vectors. 'three-way' adds a semantic (vector) seed via obsidian_semantic_search and rebalances the rank score to 0.4 semantic / 0.3 lexical / 0.3 graph. 'semantic-lexical' drops graph expansion entirely (0.55 semantic / 0.45 lexical, no link term). Both remain as explicit opt-in (`--blend`) for paraphrase / cross-lingual probes; both require a running vault-mind service and fall back gracefully. Default: 'default'.",
					},
				),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Override the RAG subagent's model (provider/id[:thinking]). Omit to use the pi default — mirrors the CLI --model flag.",
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
			const { output, exitCode, stderr, timedOut } = await runSubagentWithRetry(
				cwd,
				"",
				task,
				ragToolsFor(params.blend ?? "default").join(","),
				signal,
				"pi-kc-rag-",
				{ model: params.model, excludeTools: params.exclude_tools },
			);
			if (timedOut) {
				return {
					content: [
						{ type: "text", text: `zk_ask timed out.\n${output.slice(-2000)}` },
					],
					isError: true,
					details: { timedOut, stderr },
				};
			}
			if (exitCode !== 0 && !output) {
				return {
					content: [
						{
							type: "text",
							text: `zk_ask failed (exit ${exitCode}).\n${stderr.slice(-2000)}`,
						},
					],
					isError: true,
					details: { exitCode, stderr },
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
				details: { exitCode, stderr },
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
		description: [
			"Deterministically converge structured .knowledge.jsonl records into the shared Zettelkasten vault.",
			"One card per record (id/type/title/detail/tags/dimension/confidence/status/superseded_by/evidence),",
			"dedup'd by canonical record id (re-ingest upserts in place), cross-linked by shared tags,",
			"and indexed by a Knowledge Graph MOC. No LLM — lossless + idempotent, unlike obsidian_distill.",
			"This is the convergence sink that lets every self-improve loop's distilled knowledge flow",
			"into ONE queryable, backlinked graph that zk_ask can traverse cross-source.",
		].join(" "),
		promptSnippet:
			"Ingest structured .knowledge.jsonl records into the shared knowledge-graph vault",
		parameters: Type.Object({
			files: Type.Array(Type.String(), {
				description:
					"Paths to .knowledge.jsonl files (or memory .md when source=auto-memory). Absolute or relative to cwd. Each entry may also be a DIRECTORY — it is recursively expanded for the source's file type (.md for auto-memory/hermes, .knowledge.jsonl for workflow-jsonl); MEMORY.md/README.md index files are skipped.",
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
						"Source family label written to each card's frontmatter (default: workflow-jsonl).",
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
		description:
			"Query the project's Zettelkasten knowledge graph for cards matching given tags " +
			"or a natural-language question. Returns a compact digest of relevant stored " +
			"knowledge (gotchas, patterns, levers, avoid, false_positive, metric cards). " +
			"Call this BEFORE answering a question that may benefit from past workflow " +
			"lessons.",
		promptSnippet: "Query knowledge graph for relevant cards",
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
}
