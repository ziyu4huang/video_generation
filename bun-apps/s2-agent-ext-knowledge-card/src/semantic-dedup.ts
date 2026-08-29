/**
 * src/semantic-dedup.ts — vector pre-filter + gray-zone LLM dedup for ingest
 * (ticket 13, context-lifecycle P3 — the OpenViking ExtractLoop dedup shape).
 *
 * The wiki-aware Jaccard matcher (similarity.ts, 0.85) only catches near-dups
 * that SHARE tokens; a re-stated lesson with different wording mints a
 * parallel card. This module adds an embedding pre-filter over the
 * `.knowledge-semantic` card cache (BGE-M3, D3) plus — only in the gray
 * band — ONE local-LLM skip/create/merge decision:
 *
 *   cosine ≥ 0.90 (top-1)  → deterministic merge (wikiMergeIntoCard, the D4
 *                            merge-op table; first-wins id policy unchanged)
 *   0.75 ≤ cosine < 0.90   → gray zone: ONE chatJson call (temp 0.3, the
 *                            llm-chat retry envelope). Output is ADVISORY
 *                            WITH GUARDRAILS: `merge` must name a candidate
 *                            card id; anything malformed/unparseable/failed
 *                            → create (fail-open to today's behavior).
 *   cosine < 0.75          → straight create.
 *
 * OFFLINE-SAFE by construction: a cache/embedder miss (LM Studio down, empty
 * folder, corrupt cache) returns null and ingest keeps today's Jaccard-only
 * path — the LLM is never reached without a working embedder.
 *
 * Library only — no ExtensionAPI. The embedder and the chat fetch are
 * injectable (`IngestOptions._testEmbedder` / `_dedupFetch`) so tests run
 * hermetic; the seams mirror retrieve.ts and the summary condense.
 */
import { cosine, getCardEmbeddings, embedQuery, type Embedder } from "./semantic.ts";
import { chatJson } from "./llm-chat.ts";
import type { KnowledgeRecord } from "./types.ts";

/** Top-1 at/above this → deterministic merge (no LLM). */
export const DEDUP_MERGE_THRESHOLD_DEFAULT = 0.90;
/** Below this → straight create (no LLM). The band [gray, merge) is the
 *  gray zone where the ONE advisory LLM decision fires. */
export const DEDUP_GRAY_THRESHOLD_DEFAULT = 0.75;
/** How many in-band candidates the gray-zone prompt may choose among. */
export const DEDUP_GRAY_CANDIDATES = 3;

export interface DedupCandidate {
	/** Card basename (filename sans .md) — the merge target key. */
	basename: string;
	/** Card source_id frontmatter (== basename fallback when absent). */
	sourceId: string;
	sim: number;
}

export type DedupPlan =
	| { kind: "merge"; candidate: DedupCandidate }
	| { kind: "gray"; candidates: DedupCandidate[] }
	| { kind: "create" };

export type DedupDecision =
	| { decision: "merge"; target: DedupCandidate; via: "vector" | "llm" }
	| { decision: "skip"; via: "llm" }
	| { decision: "create"; via: "below-gray" | "no-candidates" | "embed-failed" | "llm" | "llm-malformed" | "llm-failed" };
// "no-candidates" is produced by ingest when a decided merge names a target
// absent from the folder snapshot (stale cache) — the fall-through to create
// rewrites the decision so the receipt never claims a merge that did not land.

/** Trace entry recorded on IngestSummary.dedupDecisions — the merge receipt. */
export interface DedupDecisionEntry {
	id: string;
	sim: number | null;
	via: DedupDecision["via"];
	target: string | null;
}

/** Record text for the query embedding — mirrors semantic.ts's private
 *  cardEmbedText shape (title + tags + first 800 chars of prose) so the two
 *  sides of the cosine live in the same text regime. */
export function recordEmbedText(rec: KnowledgeRecord): string {
	const body = rec.detail.slice(0, 800);
	return `${rec.title}. ${rec.tags.join(" ")}. ${body}`.replace(/\s+/g, " ").trim().slice(0, 1000);
}

/** Vector pre-filter: cosine of `queryVec` against every cached card vector.
 *  Pure + deterministic (stable sort by (-sim, path)). */
export function planDedup(
	queryVec: number[] | null,
	paths: string[],
	vectors: number[][],
	sourceIdByBasename: Map<string, string>,
	mergeThreshold = DEDUP_MERGE_THRESHOLD_DEFAULT,
	grayThreshold = DEDUP_GRAY_THRESHOLD_DEFAULT,
): DedupPlan {
	if (!queryVec) return { kind: "create" };
	const sims: DedupCandidate[] = [];
	for (let i = 0; i < paths.length; i++) {
		const vec = vectors[i];
		if (!vec) continue;
		// paths are "<folder>/<basename>" (no .md) — match the ingest map key.
		const basename = paths[i]!.slice(paths[i]!.lastIndexOf("/") + 1);
		const sim = cosine(queryVec, vec);
		if (Number.isFinite(sim)) sims.push({ basename, sourceId: sourceIdByBasename.get(basename) ?? basename, sim });
	}
	sims.sort((a, b) => b.sim - a.sim || a.basename.localeCompare(b.basename));
	const top = sims[0];
	if (top && top.sim >= mergeThreshold) return { kind: "merge", candidate: top };
	const gray = sims.filter((c) => c.sim >= grayThreshold).slice(0, DEDUP_GRAY_CANDIDATES);
	if (gray.length > 0) return { kind: "gray", candidates: gray };
	return { kind: "create" };
}

/** Resolve a gray-zone plan to a decision via ONE local chat call. Advisory
 *  with guardrails: `merge` must name a candidate (basename OR sourceId);
 *  anything else — including chatJson's null (HTTP/timeout/parse failures
 *  after the retry) — fails OPEN to create. */
export async function llmDedupDecision(
	rec: KnowledgeRecord,
	candidates: DedupCandidate[],
	fetchImpl?: typeof fetch,
): Promise<DedupDecision> {
	const candLines = candidates
		.map((c, i) => `${i + 1}. id: ${c.sourceId} (file: ${c.basename}, similarity ${c.sim.toFixed(2)})`)
		.join("\n");
	const prompt = [
		"You are deduplicating a knowledge base. Decide whether an incoming record restates an existing card.",
		"Incoming record:",
		`id: ${rec.id}`,
		`title: ${rec.title}`,
		`detail: ${rec.detail.slice(0, 500)}`,
		"",
		"Existing candidate cards:",
		candLines,
		"",
		'Reply with ONLY JSON, no prose: {"decision":"merge","target":"<existing card id>"} if the incoming record restates a candidate (target = that card\'s id);',
		'{"decision":"skip"} if the incoming record adds nothing new and fits no candidate; {"decision":"create"} if it is new distinct knowledge.',
	].join("\n");

	const seen = new Set<string>();
	for (const c of candidates) {
		seen.add(c.sourceId);
		seen.add(c.basename);
	}
	const parsed = await chatJson<{ decision?: unknown; target?: unknown }>(
		prompt,
		(text) => {
			const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
			const j = JSON.parse(stripped) as { decision?: unknown; target?: unknown };
			if (typeof j.decision !== "string") throw new Error("decision not a string");
			return j;
		},
		{ _fetchImpl: fetchImpl, reasoningEffort: "none" },
	);
	if (parsed === null) return { decision: "create", via: "llm-failed" };
	const d = parsed.decision;
	const target = typeof parsed.target === "string" ? parsed.target : null;
	if (d === "skip") return { decision: "skip", via: "llm" };
	if (d === "create") return { decision: "create", via: "llm" };
	if (d === "merge") {
		if (!target || !seen.has(target)) return { decision: "create", via: "llm-malformed" };
		const hit = candidates.find((c) => c.sourceId === target || c.basename === target)!;
		return { decision: "merge", target: hit, via: "llm" };
	}
	return { decision: "create", via: "llm-malformed" };
}

/** Load the cached card embeddings for the folder under the injectable
 *  embedder (test seam) or the production default. null → caller degrades. */
export async function loadDedupEmbeddings(
	vaultPath: string,
	folder: string,
	embedder?: Embedder,
): Promise<{ paths: string[]; vectors: number[][] } | null> {
	const emb = await getCardEmbeddings(vaultPath, folder, undefined, embedder);
	if (!emb || emb.paths.length === 0) return null;
	return { paths: emb.paths, vectors: emb.vectors };
}

/** Embed one incoming record (null on any failure → degrade to create). */
export function embedRecordText(rec: KnowledgeRecord, embedder?: Embedder): Promise<number[] | null> {
	return embedQuery(recordEmbedText(rec), undefined, embedder);
}
