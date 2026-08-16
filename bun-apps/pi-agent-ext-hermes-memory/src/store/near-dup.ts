/**
 * Near-duplicate detection for the memory store.
 * Wayfinder effort 2026-07-30-self-reflection-to-fix-these-error ticket 02.
 *
 * The store's existing dup-check is EXACT-match only (stripped-content
 * equality) + the error-detector dedups on a normalised first-line key. Neither
 * catches NEAR-duplicates — the same lesson re-captured with different wording
 * (mupdf ×3, SurrealDB ×2-3 in the failure store). This module adds a
 * containment-based near-dup detector used as a write-time WARNING gate in
 * MemoryStore._addInner (the entry is still added, but flagged so the agent
 * sees the overlap and consolidates instead of accumulating).
 *
 * Metric: containment of the NEW entry's filtered tokens in an existing
 * entry's filtered tokens — |new ∩ existing| / |new| — i.e. "is most of what
 * this new entry says already said by an existing entry?". (Jaccard over full
 * text under-weights long entries that share a core lesson but differ in
 * surrounding prose; the existing exact-dup check already handles the identical
 * case.) Tokens are lowercased, split on non-word chars, with sub-4-char tokens
 * + a stopword set + pure numbers dropped, and a leading bracketed category
 * prefix ([tool-quirk]…) stripped (metadata, not content).
 */

const STOPWORDS = new Set<string>([
	"the", "and", "for", "that", "this", "with", "from", "into", "have", "will",
	"are", "was", "were", "been", "not", "but", "you", "your", "use", "using",
	"used", "when", "then", "there", "their", "them", "these", "those", "which",
	"what", "they", "can", "all", "any", "via", "per", "than", "too", "also",
	"its", "over", "into", "some", "such", "each", "both", "does", "doesnt",
]);

const MIN_TOKEN_LEN = 4;
/** Below this many distinctive tokens, content is too short to judge reliably. */
export const MIN_CONTENT_TOKENS = 6;
/**
 * Tuned per the 2026-08-07 near-dup baseline: recall 54.5% → 95.5%, zero
 * precision loss at every measured threshold. Env override
 * PI_MEMORY_NEAR_DUP_THRESHOLD unchanged.
 */
export const DEFAULT_NEAR_DUP_THRESHOLD = 0.3;

/** Strip a leading bracketed category prefix like "[tool-quirk] ". */
function stripCategoryPrefix(text: string): string {
	return text.replace(/^\s*\[[^\]]*\]\s*/, "");
}

/** Normalize text to a content-bearing token set for near-dup comparison. */
export function nearDupTokens(text: string): Set<string> {
	const body = stripCategoryPrefix(text).toLowerCase();
	const tokens = new Set<string>();
	for (const raw of body.split(/[^a-z0-9_]+/)) {
		if (raw.length < MIN_TOKEN_LEN) continue;
		if (/^\d+$/.test(raw)) continue; // pure numbers
		if (STOPWORDS.has(raw)) continue;
		tokens.add(raw);
	}
	return tokens;
}

/** Containment of `a` in `b`: |a ∩ b| / |a| (asymmetric). 0 if `a` is empty. */
export function containment(a: Set<string>, b: Set<string>): number {
	if (a.size === 0) return 0;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return shared / a.size;
}

export interface NearDupHit {
	/** Index into the `existing` array of the matched entry. */
	index: number;
	/** Containment similarity, 0..1. */
	similarity: number;
	/** First ~60 chars of the matched existing entry. */
	preview: string;
}

/**
 * Find the most-similar existing entry to `content` at or above `threshold`
 * (containment of content's tokens in the existing entry's tokens). Returns
 * null if none reach the threshold, or if content has fewer than
 * MIN_CONTENT_TOKENS distinctive tokens (too short to judge). `existing` entries
 * are assumed already metadata-stripped by the caller (as MemoryStore does).
 */
export function findNearDuplicate(
	content: string,
	existing: string[],
	threshold = DEFAULT_NEAR_DUP_THRESHOLD,
): NearDupHit | null {
	const contentTokens = nearDupTokens(content);
	if (contentTokens.size < MIN_CONTENT_TOKENS) return null;
	let best: NearDupHit | null = null;
	for (let i = 0; i < existing.length; i++) {
		const entry = existing[i] ?? "";
		const sim = containment(contentTokens, nearDupTokens(entry));
		if (sim >= threshold && (best === null || sim > best.similarity)) {
			best = { index: i, similarity: sim, preview: entry.slice(0, 60).trim() };
		}
	}
	return best;
}
