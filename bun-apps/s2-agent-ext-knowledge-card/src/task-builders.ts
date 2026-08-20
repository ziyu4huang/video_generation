/** Pure zk task builders (split from extensions/knowledge-card.ts — hermes-arch-13 wave 2). */
import { relative } from "node:path";
import type { BlendMode } from "./zk-task-config.ts";


// ---------------------------------------------------------------------------
// Task builders — pure string templates, no I/O. Single source of truth:
// both this extension and `s2-agent cli`'s zk-* commands import these.
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
