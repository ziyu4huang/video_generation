/**
 * src/similarity.ts — shared token-set similarity primitives.
 *
 * Used by:
 *   - merge.ts  — near-duplicate card detection (Jaccard ≥ threshold, default 0.9)
 *   - ingest.ts — wiki-aware convergence (Jaccard ≥ 0.85 reuse match)
 *
 * Both consumers need the SAME deterministic tokenisation (lowercase, split on
 * non-alphanumeric/CJK, drop short English tokens + stopwords) so a card found
 * by the duplicate scanner and one found by the wiki-aware ingest matcher AGREE
 * on "is this the same concept?". Centralising here avoids divergence.
 *
 * Deterministic — no embedding model (deliberately; embeddings would re-open
 * the closed semantic-retrieval question per #370). The token-set Jaccard path
 * (ex-merge, retired L1) is reused for wiki-aware ingest,
 * keeping a single notion of "duplicate concept" across the pipeline.
 */

/** Common English + a few CJK glue tokens excluded so similarity keys on
 *  DISTINCTIVE tokens (argparse, fp8, metallib) not generic words (the, with). */
const STOPWORDS = new Set([
	"a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "of",
	"to", "in", "on", "at", "by", "with", "from", "as", "is", "are", "was",
	"were", "be", "been", "being", "this", "that", "these", "those", "it",
	"its", "into", "via", "use", "used", "using", "when", "while", "not",
	"no", "do", "does", "did", "has", "have", "had", "can", "will", "may",
	"might", "should", "would", "could", "all", "any", "each", "every",
	"卡片", "核心", "想法", "證據", "脈絡", "連結", "相關", "card",
]);

/**
 * Tokenise raw text into a Set of normalised tokens.
 *
 * - Lowercase.
 * - Split on any run of non-alphanumeric / non-CJK chars.
 * - Drop empty tokens.
 * - ASCII tokens: drop if < 3 chars or a stopword.
 * - CJK tokens: kept as-is (no stopword list — CJK tokens are already dense).
 */
export function tokeniseText(text: string): Set<string> {
	const lower = text.toLowerCase();
	const tokens = new Set<string>();
	for (const raw of lower.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
		const t = raw.trim();
		if (!t) continue;
		if (/^[a-z0-9]+$/.test(t)) {
			if (t.length < 3) continue;
			if (STOPWORDS.has(t)) continue;
		}
		tokens.add(t);
	}
	return tokens;
}

/**
 * Jaccard similarity between two token sets: |A∩B| / |A∪B|.
 * Returns 0 for two empty sets (no similarity signal).
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

/**
 * Find the best-matching card (by token-set Jaccard) for a query token set,
 * among a list of candidate token sets. Returns the index of the best match
 * at or above `threshold`, or -1 if none.
 *
 * Uses the same early-exit optimisation as `findDuplicatePairs`: skip the full
 * Jaccard unless the sets share at least one token (the inner `any` check).
 */
export function bestMatch(
	query: Set<string>,
	candidates: Set<string>[],
	threshold: number,
): { index: number; similarity: number } {
	let bestIdx = -1;
	let bestSim = 0;
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i]!;
		// Early-exit: no shared token → Jaccard is 0.
		let any = false;
		for (const t of query) {
			if (c.has(t)) {
				any = true;
				break;
			}
		}
		if (!any) continue;
		const sim = jaccard(query, c);
		if (sim >= threshold && sim > bestSim) {
			bestSim = sim;
			bestIdx = i;
		}
	}
	return { index: bestIdx, similarity: bestSim };
}
