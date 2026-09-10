/**
 * lanes/extraction.ts — bench lane 1a: extraction-faithfulness proxies
 * (deterministic, offline).
 *
 * IMPORTANT independence note (planner T3 risk): the reference text comes
 * from the SAME pdfjs engine file2md uses — independence lives at the
 * pageText/join layer, which is exactly what this lane tests (does the
 * pipeline preserve the engine's numbers and spans through its markdown
 * assembly, or does its windowing/regex layer drop them?).
 *
 * Proxies per design §3 lane 1a:
 *  - number-token recall: every number-token in the reference text appears
 *    VERBATIM in the conversion (plain substring — the preservation
 *    criterion; the boundary/standalone-quantity rule lives in the VISION
 *    gate ground.ts, where "is this a real quantity" matters. Here glued
 *    tokens like "3Ho" (from "3Host") must be preserved as-is);
 *  - span coverage: 20+ char reference lines found verbatim in the
 *    conversion;
 *  - table-row survival: reference lines with ≥3 numeric cells found
 *    (whitespace-tolerant) in the conversion.
 */

export interface ExtractionMetrics {
	numbersReference: number;
	numbersMissing: string[];
	numberRecall: number;
	spansReference: number;
	spansCovered: number;
	spanCoverage: number;
	tableRowsReference: number;
	tableRowsSurvived: number;
	tableRowSurvival: number;
}

/** Number tokens shared with the grounding gate's extraction rule. */
export function numberTokens(text: string): string[] {
	const seen = new Set<string>();
	for (const m of text.matchAll(/\d+(?:[.,]\d+)*(?:%|[A-Za-z]{1,2})?/g)) {
		const t = m[0];
		if (t.length >= 2 && !/^(19|20)\d{2}$/.test(t)) seen.add(t); // skip bare years
	}
	return [...seen];
}

export function measureExtraction(referenceText: string, convertedMd: string): ExtractionMetrics {
	// whitespace-collapsed: markdown reflows prose/tables, preservation is
	// about content, not line geometry
	const haystack = convertedMd.replace(/[ \t]+/g, " ");
	const numbers = numberTokens(referenceText);
	const numbersMissing = numbers.filter((n) => !haystack.includes(n));

	const refLines = referenceText.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
	const spans = refLines.filter((l) => l.length >= 20 && /[A-Za-z]{3}/.test(l) && !/^[[\]#-]/.test(l));
	const spansCovered = spans.filter((l) => {
		const probe = l.slice(0, 40);
		return haystack.toLowerCase().includes(probe.toLowerCase());
	}).length;

	const tableRows = refLines.filter((l) => (l.match(/\d+(?:\.\d+)?/g) ?? []).length >= 3);
	const tableRowsSurvived = tableRows.filter((row) => {
		const cells = row.split(/\s{2,}|\s*\|\s*/).filter((c) => /\d/.test(c)).slice(0, 6);
		const hit = cells.length > 0 && cells.every((c) => haystack.includes(c.trim()));
		return hit;
	}).length;

	return {
		numbersReference: numbers.length,
		numbersMissing,
		numberRecall: numbers.length === 0 ? 1 : (numbers.length - numbersMissing.length) / numbers.length,
		spansReference: spans.length,
		spansCovered,
		spanCoverage: spans.length === 0 ? 1 : spansCovered / spans.length,
		tableRowsReference: tableRows.length,
		tableRowsSurvived,
		tableRowSurvival: tableRows.length === 0 ? 1 : tableRowsSurvived / tableRows.length,
	};
}
