/**
 * golden-schema.ts — the frozen ground-truth contract for fixture papers
 * (ticket T1). Authored ONCE from independent pdfjs re-extraction (never
 * file2md output — the anti-leak rule, planner D9), committed, and consumed
 * by every lane. `validateGolden` is the schema gate the fixtures test runs.
 */

export interface GoldenNumericClaim {
	/** Verbatim quote from the paper containing the number. */
	quote: string;
	/** 1-indexed page the quote appears on. */
	page: number;
	/** What the number attaches to, e.g. "Table 3" or "Figure 2". */
	anchor: string;
}

export interface GoldenQuestion {
	question: string;
	/** Answer text (from the paper only). Empty for unanswerable. */
	answer: string;
	/** 1-indexed page(s) supporting the answer. Empty for unanswerable. */
	pages: number[];
	/** false = deliberately unanswerable-but-plausible (refusal gate). */
	answerable: boolean;
}

export interface GoldenPaper {
	/** arXiv id, e.g. "2609.09156". */
	arxivId: string;
	title: string;
	/** Total page count from the re-extraction (anchors must be ≤ this). */
	numPages: number;
	numericClaims: GoldenNumericClaim[];
	questions: GoldenQuestion[];
	/** At least 2 per paper: plausible-sounding, but the paper cannot answer. */
	unanswerableNote?: string;
}

export function validateGolden(g: GoldenPaper): string[] {
	const errors: string[] = [];
	if (!/^\d{4}\.\d{4,5}$/.test(g.arxivId)) errors.push(`bad arxivId: ${g.arxivId}`);
	if (!Number.isInteger(g.numPages) || g.numPages < 1) errors.push(`bad numPages: ${g.numPages}`);
	const answerable = g.questions.filter((q) => q.answerable);
	const unanswerable = g.questions.filter((q) => !q.answerable);
	if (answerable.length < 8) errors.push(`expected ≥8 answerable questions, got ${answerable.length}`);
	if (unanswerable.length < 2) errors.push(`expected ≥2 unanswerable questions, got ${unanswerable.length}`);
	for (const q of g.questions) {
		if (q.answerable && (q.answer.trim().length === 0 || q.pages.length === 0)) {
			errors.push(`answerable question without answer/pages: ${q.question.slice(0, 60)}`);
		}
		for (const p of q.pages) {
			if (p < 1 || p > g.numPages) errors.push(`question page ${p} out of range (1..${g.numPages})`);
		}
	}
	for (const c of g.numericClaims) {
		if (c.page < 1 || c.page > g.numPages) errors.push(`claim page ${c.page} out of range`);
		if (!/\d/.test(c.quote)) errors.push(`numeric claim quote has no number: ${c.quote.slice(0, 60)}`);
		if (!c.anchor.trim()) errors.push(`numeric claim without anchor: ${c.quote.slice(0, 60)}`);
	}
	return errors;
}

/** Parse a GoldenPaper from fixture JSON. Non-numeric "numeric claims" (judge
 *  authoring artifact — qualitative quotes) are FILTERED, not rejected; hard
 *  shape violations (range, missing pages) still throw. */
export function loadGolden(json: unknown, source: string): GoldenPaper {
	const g = json as GoldenPaper;
	if (!g || typeof g !== "object") throw new Error(`${source}: not an object`);
	g.numericClaims = (g.numericClaims ?? []).filter((c) => /\d/.test(c.quote ?? ""));
	const errors = validateGolden(g);
	if (errors.length > 0) throw new Error(`${source}: ${errors.join("; ")}`);
	return g;
}
