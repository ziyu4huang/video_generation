/**
 * Pure signature-extraction helpers for the "used vs dropped" signal
 * (UPSP §9 / ticket #06, Task 1).
 *
 * These are PURE (no class state, no I/O) so they are fully unit-testable in
 * isolation and trivially reusable from both the manifest emit (entry →
 * signature) and the Task-5 turn-output matcher (scan text → normalized).
 *
 * Contract: `normalizeForSignature` is the SINGLE shared normalization. A
 * signature produced by `computeSignature` is, by construction, a substring of
 * the same body run through `normalizeForSignature` — so when the Task-5
 * matcher normalizes the turn's assistant text with the SAME function, a
 * present signature is guaranteed to substring-match. Keep these two sides
 * agreeing by never duplicating the normalization logic.
 */

/**
 * Leading-markdown-marker stripper. Repeatedly removes ONE leading marker per
 * iteration so nested markers ("> # Title", "- - bullet") collapse fully.
 * Markers handled: ATX headers (`#`..`######`), list bullets (`-`, `*`, `+`),
 * blockquotes (`>`). Each requires trailing whitespace so a bare `#hashtag` or
 * mid-line `*emphasis*` is NOT treated as a marker.
 */
function stripLeadingMarkers(line: string): string {
  let s = line;
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*)/, "");
  } while (s !== prev);
  return s;
}

/**
 * Normalize text for signature matching: lowercase, collapse all whitespace
 * runs (spaces, tabs, newlines) to a single space, strip markdown code-fence
 * delimiter lines (``` , ```ts, ...) and leading line markers (#, -, *, >, +).
 *
 * Markdown stripping is done LINE-WISE BEFORE the whitespace collapse, because
 * collapsing first would merge fence/header lines into surrounding prose and
 * make line-based stripping impossible. The final result is a single-line,
 * lowercased, whitespace-collapsed string — identical treatment on both the
 * entry body and the turn's scan text is what keeps substring matching sound.
 */
export function normalizeForSignature(text: string): string {
  const stripped = text
    .split("\n")
    .map((rawLine) => {
      const line = rawLine.trim();
      // Drop pure code-fence delimiter lines (with or without an info string).
      if (/^```/.test(line)) return "";
      return stripLeadingMarkers(line);
    })
    .join("\n");
  return stripped
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute the signature for an entry body: normalize it, split into candidate
 * fragments on sentence (`.`) and line (`\n`) boundaries, and return the
 * LONGEST normalized fragment whose length is ≥ `minChars`. Returns `null`
 * when no fragment qualifies — the entry is too generic/short to attribute, so
 * it gets no signature and is never credited as "used" (still surfaced, just
 * never matched). `minChars` defaults to 24 upstream via `MemoryConfig`.
 *
 * Fragments inherit their normalization from the single normalized body (only a
 * trim is applied to clean the leading space left by `.` splitting), so each
 * returned signature is itself a substring of `normalizeForSignature(body)`.
 */
export function computeSignature(body: string, minChars: number): string | null {
  const normalized = normalizeForSignature(body);
  if (!normalized) return null;
  const fragments = normalized
    .split(/[.\n]/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  let best: string | null = null;
  for (const f of fragments) {
    if (f.length >= minChars && (best === null || f.length > best.length)) {
      best = f;
    }
  }
  return best;
}
