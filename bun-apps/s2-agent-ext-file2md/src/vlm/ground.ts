/**
 * vlm/ground.ts — deterministic grounding pre-check for vision descriptions
 * (effort 2026-09-09-file2md-kcard-scale, ticket 03; review finding 4).
 *
 * Vision output is INTERPRETATION, never ground truth (parent-map
 * guarantee). Before a vision bullet is admitted into a card's evidence
 * section, its checkable tokens must exist in the page's own text layer:
 * born-digital figures embed their labels as text, so a GROUNDED
 * description's numbers appear verbatim on the page. A bullet citing a
 * number the page never mentions is a hallucination flag.
 *
 * Contract (deliberate, mixed-language reality):
 *  - NUMBERS are the hard check — any number absent from the page text
 *    flags the claim ungrounded ("92%" vs "87%" is the target class).
 *  - Named runs (Latin multi-word / CJK) are checked ONLY against page
 *    text sharing their script: a Chinese description of an English page
 *    paraphrases by design, so CJK tokens cannot be required against a
 *    Latin-only page (and vice versa). Absent same-script runs are still
 *    reported as suspects.
 *
 * Pure and IO-free: the caller supplies the page text (file2md page-md or
 * OCR output). `ungrounded` means "needs eyes" — the bench's judge lane
 * (1b) upgrades this to entailment; this stays the free first gate.
 */

/** Result for one vision bullet. */
export interface GroundResult {
  claim: string;
  /** false ONLY when a number in the claim is absent from the page text. */
  grounded: boolean;
  /** Tokens not found in the page text (numbers = hard suspects; same-script named runs = soft suspects). */
  missing: string[];
}

/** Sentence-initial words trimmed from a named run before checking. */
const RUN_START_STOP = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "it",
  "in",
  "on",
  "as",
  "at",
  "we",
  "they",
  "if",
  "when",
  "figure",
  "fig",
  "table",
]);

/** Extract the CHECKABLE tokens from a claim: numbers + named runs. */
export function extractCheckableTokens(claim: string): string[] {
  const tokens = new Set<string>();
  // Numbers: 92%, 3.8x, 1,234, 7B, 0.75 — the highest-value hallucination
  // signal; unit/model suffixes (%, x, B) are part of the verbatim token.
  for (const m of claim.matchAll(/\d+(?:[.,]\d+)*(?:%|[A-Za-z]{1,2})?/g)) {
    tokens.add(m[0]);
  }
  // Latin named runs: 2+ consecutive capitalized words. A sentence-initial
  // stopword leading the run is trimmed ("The GMSBench" → "GMSBench").
  for (const m of claim.matchAll(/\b(?:[A-Z][\w.-]*\s+){1,}[A-Z][\w.-]*/g)) {
    let run = m[0].replace(/\s+$/, "");
    const words = run.split(/\s+/);
    while (words.length > 1 && RUN_START_STOP.has(words[0]!.toLowerCase())) {
      words.shift();
    }
    run = words.join(" ");
    if (words.length >= 2 && run.length >= 4) tokens.add(run);
  }
  // CJK named runs: 2+ consecutive CJK chars (labels like 壞散文).
  for (const m of claim.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    tokens.add(m[0]);
  }
  return [...tokens];
}

/**
 * Ground one claim against the page text. Numbers are hard-checked with
 * BOUNDARY-AWARE verbatim matching — a bare "234" must not ground via
 * "1,234", nor "7B" via "17B" (digit-subsumption is exactly the
 * hallucination shape this module exists to flag; full-review finding 1).
 * Named runs are checked only when the page text carries their script,
 * with word-boundary lookarounds so "RAG Flow" cannot ground via
 * "a drag flow".
 */
export function groundClaim(claim: string, pageText: string): GroundResult {
  const haystack = pageText.toLowerCase();
  const pageHasLatin = /[a-z]/i.test(pageText);
  const pageHasCjk = /[\u4e00-\u9fff]/.test(pageText);
  const missing: string[] = [];
  for (const token of extractCheckableTokens(claim)) {
    if (/^\d/.test(token)) {
      // number: hard, boundary-aware verbatim — digits/percent/letters
      // glued to the token disqualify a match (234 ⊄ 1,234; 7B ⊄ 17B).
      const re = new RegExp(`(?<![\\d.,])${escapeRe(token)}(?![\\d.,%A-Za-z])`, "i");
      if (!re.test(haystack)) missing.push(token);
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(token)) {
      if (pageHasCjk && !haystack.includes(token)) missing.push(token);
      continue;
    }
    if (pageHasLatin) {
      const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(token)}(?![A-Za-z0-9])`, "i");
      if (!re.test(haystack)) missing.push(token);
    }
  }
  return { claim, grounded: missing.length === 0, missing };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ground a whole vision description (split into lines/bullets first). */
export function groundClaims(visionDescription: string, pageText: string): GroundResult[] {
  return visionDescription
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(#|\*\*[^*]+\*\*$)/.test(line))
    .map((line) => groundClaim(line, pageText));
}
