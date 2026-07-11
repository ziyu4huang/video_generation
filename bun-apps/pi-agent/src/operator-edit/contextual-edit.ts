/**
 * contextual-edit.ts — Smart operator editing system for the pi agent.
 *
 * Wraps / enhances pi's edit tool with:
 *   1. Matching by diff context instead of exact line numbers
 *   2. Pattern-based location (search tokens → surround lines)
 *   3. Splitting long files into semantic chunks
 *   4. Multiple edit passes with diff-apply as fallback
 *   5. Expand/retry cycle for failed match attempts
 *   6. Confidence scoring (0.0-1.0, threshold 0.75 for auto-apply)
 *
 * All functions are pure (given data in, data out) for testability.
 * No side effects — no fs reads/writes, no process.argv mutation.
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** A single edit operation as passed to the smart edit system. */
export interface EditOp {
  oldText: string;
  newText: string;
}

/** Result of matching a single edit's oldText against file content. */
export interface MatchResult {
  /** 0 = first char of content */
  startIndex: number;
  /** Length of the matched region in the original content. */
  matchLength: number;
  /** Confidence score 0.0–1.0. */
  confidence: number;
  /** Which strategy produced this match. */
  strategy: MatchStrategy;
  /** The content that was actually matched (before replacement). */
  matchedText: string;
  /** How many attempts the expand/retry cycle took. */
  retries: number;
  /** Context lines that were used for disambiguation (if any). */
  contextLines?: string[];
}

export type MatchStrategy =
  | "exact"
  | "fuzzy-unicode"
  | "fuzzy-whitespace"
  | "fuzzy-composite"
  | "diff-context"
  | "semantic-chunk";

/** Result of applying all edits to content. */
export interface EditResult {
  success: boolean;
  content: string;
  matches: MatchResult[];
  overallConfidence: number;
  applied: boolean;
}

/** A semantic chunk of a source file. */
export interface SemanticChunk {
  startLine: number;   // 0-indexed
  endLine: number;     // inclusive
  signature: string;   // first meaningful line
  body: string;
}

/** Configuration for the expand/retry cycle. */
export interface RetryConfig {
  /** Maximum number of retries per edit. */
  maxRetries: number;
  /** Lines of context to add on each retry. */
  contextExpandBy: number;
  /** Initial context lines to capture around a match. */
  initialContextLines: number;
}

/** Overall system configuration. */
export interface ContextualEditConfig {
  /** Auto-apply threshold (0.0–1.0). Default 0.75. */
  autoApplyThreshold: number;
  /** Minimum confidence to accept any match. Default 0.3. */
  minAcceptableConfidence: number;
  /** Whether to use semantic chunking for long files. Apply when lines > this. */
  semanticChunkThreshold: number;
  /** Retry configuration. */
  retry: RetryConfig;
}

// Default configuration
const DEFAULT_CONFIG: ContextualEditConfig = {
  autoApplyThreshold: 0.75,
  minAcceptableConfidence: 0.3,
  semanticChunkThreshold: 200,
  retry: {
    maxRetries: 3,
    contextExpandBy: 5,
    initialContextLines: 3,
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Text utilities (pure)
// ────────────────────────────────────────────────────────────────────────────

/** Normalize text to LF line endings. */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Split content into lines, preserving original structure. */
export function splitLines(text: string): string[] {
  return text.split("\n");
}

/** Join lines back with LF. */
export function joinLines(lines: string[]): string {
  return lines.join("\n");
}

/**
 * Normalize text for fuzzy matching — progressive Unicode normalization.
 * Matches what pi's internal edit-diff.js does for consistency.
 */
export function normalizeForFuzzy(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    // Smart single quotes → '
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    // Smart double quotes → "
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Dashes/hyphens → -
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // Special spaces → regular space
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/**
 * Compute token overlap ratio between two strings (0.0–1.0).
 * Tokens = whitespace-separated words.
 */
export function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.size / union.size;
}

/**
 * Jaccard similarity of character n-grams between two strings.
 * n=3 (trigram) is standard for code matching.
 */
export function ngramSimilarity(a: string, b: string, n: number = 3): number {
  const ngrams = (s: string): Set<string> => {
    const set = new Set<string>();
    // Normalize whitespace runs to single space for better matching
    const cleaned = s.replace(/\s+/g, " ").trim();
    if (cleaned.length < n) {
      set.add(cleaned);
      return set;
    }
    for (let i = 0; i <= cleaned.length - n; i++) {
      set.add(cleaned.slice(i, i + n));
    }
    return set;
  };

  const aNgrams = ngrams(a);
  const bNgrams = ngrams(b);

  if (aNgrams.size === 0 && bNgrams.size === 0) return 1.0;

  let intersection = 0;
  for (const ng of aNgrams) {
    if (bNgrams.has(ng)) intersection++;
  }

  const union = aNgrams.size + bNgrams.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute line-level edit distance (Levenshtein-like) between two strings.
 * Returns a normalized similarity 0.0–1.0 (1.0 = identical line by line).
 */
export function lineSimilarity(a: string, b: string): number {
  const linesA = splitLines(normalizeToLF(a));
  const linesB = splitLines(normalizeToLF(b));
  if (linesA.length === 0 && linesB.length === 0) return 1.0;
  if (linesA.length === 0 || linesB.length === 0) return 0.0;

  // Simple LCS-based similarity
  const dp: number[][] = Array.from({ length: linesA.length + 1 }, () =>
    Array(linesB.length + 1).fill(0),
  );

  for (let i = 1; i <= linesA.length; i++) {
    for (let j = 1; j <= linesB.length; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs = dp[linesA.length][linesB.length];
  return lcs / Math.max(linesA.length, linesB.length);
}

/**
 * Levenshtein edit distance between two strings at character level,
 * normalized to 0.0–1.0 (1.0 = identical).
 */
export function charSimilarity(a: string, b: string): number {
  // Quick check for identical
  if (a === b) return 1.0;
  if (a.length === 0 && b.length === 0) return 1.0;

  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;

  // For large differences, bail early
  const lenDiff = Math.abs(a.length - b.length);
  const ratio = lenDiff / maxLen;
  if (ratio > 0.5) return Math.max(0, 1.0 - ratio);

  // Standard Levenshtein with full matrix for accuracy (small strings only)
  // For strings > 200 chars, fall back to a sampled approach
  if (a.length > 200 || b.length > 200) {
    // Use prefix/suffix match heuristic for large strings
    const prefixLen = 50;
    const suffixLen = 50;
    const aPrefix = a.slice(0, prefixLen);
    const aSuffix = a.slice(-suffixLen);
    const bPrefix = b.slice(0, prefixLen);
    const bSuffix = b.slice(-suffixLen);
    const exactPrefix = aPrefix === bPrefix ? 1.0 : charSimilarity(aPrefix, bPrefix);
    const exactSuffix = aSuffix === bSuffix ? 1.0 : charSimilarity(aSuffix, bSuffix);
    return (exactPrefix + exactSuffix) / 2;
  }

  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  const maxDist = Math.max(m, n);
  return 1.0 - dp[m][n] / maxDist;
}

// ────────────────────────────────────────────────────────────────────────────
// ConfidenceScorer
// ────────────────────────────────────────────────────────────────────────────

export interface ScoreInput {
  /** The search text (oldText). */
  searchText: string;
  /** The text actually found in the content. */
  foundText: string;
  /** Whether the match was exact (byte-for-byte identical). */
  isExact: boolean;
  /** Whether the match was unique in the file (>1 occurrence). */
  isUnique: boolean;
  /** Total occurrences of the search pattern in the file. */
  occurrenceCount: number;
  /** Surrounding context lines captured for disambiguation. */
  capturedContext: string[];
  /** Expected context lines (from model-provided surrounding text, if any). */
  expectedContext?: string[];
  /** Strategy used. */
  strategy: MatchStrategy;
}

/**
 * Score the confidence of a match (0.0–1.0).
 *
 * Factors (weighted):
 *   - Exact match bonus (+0.25 if byte-for-byte identical)
 *   - Uniqueness bonus (unique = +0.15, otherwise proportional to 1/occurrences)
 *   - Char-level similarity (weight 0.20)
 *   - N-gram similarity (weight 0.15)
 *   - Token overlap (weight 0.10)
 *   - Context match bonus (+0.15 if expected context matches)
 *   - Strategy penalty (exact = 0, fuzzy = -0.05, diff = -0.15, chunk = -0.10)
 */
export function scoreConfidence(input: ScoreInput): number {
  const {
    searchText,
    foundText,
    isExact,
    isUnique,
    occurrenceCount,
    capturedContext,
    expectedContext,
    strategy,
  } = input;

  let score = 0.0;

  // 1. Exact match bonus (+0.25)
  if (isExact) {
    score += 0.25;
  }

  // 2. Uniqueness bonus (0.0–0.15)
  if (isUnique) {
    score += 0.15;
  } else {
    // Proportional bonus for non-unique: less confident when many occurrences
    score += 0.15 * (1 / Math.max(1, occurrenceCount));
  }

  // 3. Char-level similarity (weight 0.20)
  const charSim = charSimilarity(searchText, foundText);
  score += charSim * 0.20;

  // 4. N-gram similarity (weight 0.15)
  const ngSim = ngramSimilarity(searchText, foundText);
  score += ngSim * 0.15;

  // 5. Token overlap (weight 0.10)
  const tokOverlap = tokenOverlap(searchText, foundText);
  score += tokOverlap * 0.10;

  // 6. Context match bonus (+0.15 max, only if expected context provided)
  if (expectedContext && expectedContext.length > 0 && capturedContext.length > 0) {
    const contextSim = lineSimilarity(
      expectedContext.join("\n"),
      capturedContext.join("\n"),
    );
    score += contextSim * 0.15;
  }

  // 7. Strategy penalty
  switch (strategy) {
    case "exact":
      break; // no penalty
    case "fuzzy-unicode":
    case "fuzzy-whitespace":
    case "fuzzy-composite":
      score -= 0.05;
      break;
    case "diff-context":
      score -= 0.15;
      break;
    case "semantic-chunk":
      score -= 0.10;
      break;
  }

  // Clamp to [0.0, 1.0]
  return Math.max(0.0, Math.min(1.0, score));
}

// ────────────────────────────────────────────────────────────────────────────
// ContextMatcher
// ────────────────────────────────────────────────────────────────────────────

export interface MatchOptions {
  /** Number of context lines to capture around the match. */
  contextLines: number;
  /** Expected context (model-provided surrounding text) for disambiguation. */
  expectedContext?: string[];
}

/**
 * Try to match oldText in content using multiple strategies, in order of
 * precision. Returns the best match with confidence score.
 */
export function matchInContent(
  content: string,
  oldText: string,
  options: MatchOptions,
): MatchResult | null {
  const lfContent = normalizeToLF(content);
  const lfOldText = normalizeToLF(oldText);

  // Strategy 1: Exact match
  const exactIdx = lfContent.indexOf(lfOldText);
  if (exactIdx !== -1) {
    // Check uniqueness
    let count = 0;
    let pos = -1;
    while ((pos = lfContent.indexOf(lfOldText, pos + 1)) !== -1) count++;

    // Capture surrounding context
    const contextLines = extractContextLines(lfContent, exactIdx, lfOldText.length, options.contextLines);

    const confidence = scoreConfidence({
      searchText: lfOldText,
      foundText: lfContent.slice(exactIdx, exactIdx + lfOldText.length),
      isExact: true,
      isUnique: count === 1,
      occurrenceCount: count,
      capturedContext: contextLines,
      expectedContext: options.expectedContext,
      strategy: "exact",
    });

    return {
      startIndex: exactIdx,
      matchLength: lfOldText.length,
      confidence,
      strategy: "exact",
      matchedText: lfContent.slice(exactIdx, exactIdx + lfOldText.length),
      retries: 0,
      contextLines,
    };
  }

  // Strategy 2: Fuzzy match (normalized Unicode)
  const fuzzyContent = normalizeForFuzzy(lfContent);
  const fuzzyOldText = normalizeForFuzzy(lfOldText);

  // 2a: Normalized fuzzy (full NFKC + Unicode normalization)
  const fuzzyIdx = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIdx !== -1) {
    let count = 0;
    let pos = -1;
    while ((pos = fuzzyContent.indexOf(fuzzyOldText, pos + 1)) !== -1) count++;

    const contextLines = extractContextLines(lfContent, fuzzyIdx, fuzzyOldText.length, options.contextLines);

    const confidence = scoreConfidence({
      searchText: lfOldText,
      foundText: lfContent.slice(fuzzyIdx, fuzzyIdx + fuzzyOldText.length),
      isExact: false,
      isUnique: count === 1,
      occurrenceCount: count,
      capturedContext: contextLines,
      expectedContext: options.expectedContext,
      strategy: "fuzzy-unicode",
    });

    return {
      startIndex: fuzzyIdx,
      matchLength: fuzzyOldText.length,
      confidence,
      strategy: "fuzzy-unicode",
      matchedText: lfContent.slice(fuzzyIdx, fuzzyIdx + fuzzyOldText.length),
      retries: 0,
      contextLines,
    };
  }

  // 2b: Whitespace-tolerant fuzzy (collapse whitespace runs)
  const wsCollapsedContent = fuzzyContent.replace(/[ \t]+/g, " ");
  const wsCollapsedOldText = fuzzyOldText.replace(/[ \t]+/g, " ");

  if (wsCollapsedContent !== fuzzyContent || wsCollapsedOldText !== fuzzyOldText) {
    const wsIdx = wsCollapsedContent.indexOf(wsCollapsedOldText);
    if (wsIdx !== -1) {
      // Map back to original content position — approximate
      // For the found text, compute the mapping via the position in collapsed space
      let count = 0;
      let pos = -1;
      while ((pos = wsCollapsedContent.indexOf(wsCollapsedOldText, pos + 1)) !== -1) count++;

      const contextLines = extractContextLines(lfContent, wsIdx, wsCollapsedOldText.length, options.contextLines);

      const confidence = scoreConfidence({
        searchText: lfOldText,
        foundText: lfContent.slice(wsIdx, wsIdx + wsCollapsedOldText.length),
        isExact: false,
        isUnique: count === 1,
        occurrenceCount: count,
        capturedContext: contextLines,
        expectedContext: options.expectedContext,
        strategy: "fuzzy-whitespace",
      });

      return {
        startIndex: wsIdx,
        matchLength: wsCollapsedOldText.length,
        confidence,
        strategy: "fuzzy-whitespace",
        matchedText: lfContent.slice(wsIdx, wsIdx + wsCollapsedOldText.length),
        retries: 0,
        contextLines,
      };
    }
  }

  // Strategy 3: Diff-context matching
  // Find by searching for unique tokens from oldText, then match surrounding context
  const diffContextResult = matchByDiffContext(lfContent, lfOldText, options);
  if (diffContextResult) return diffContextResult;

  // No match found
  return null;
}

/**
 * Extract N lines of context around a character position in content.
 * Returns lines (without trailing newlines).
 */
export function extractContextLines(
  content: string,
  index: number,
  _matchLength: number,
  numLines: number,
): string[] {
  const lines = splitLines(content);
  if (lines.length === 1 && lines[0] === "") return [];
  let charCount = 0;
  let startLine = 0;

  // Find which line contains the match
  for (let i = 0; i < lines.length; i++) {
    if (charCount <= index && index < charCount + lines[i].length + 1) {
      startLine = i;
      break;
    }
    charCount += lines[i].length + 1;
  }

  // Adjust startLine to include leading context
  const contextStart = Math.max(0, startLine - numLines);
  // Include trailing context
  const endLine = Math.min(lines.length, startLine + numLines + 1);

  return lines.slice(contextStart, endLine);
}

/**
 * Match by searching for unique tokens in oldText, then validating
 * surrounding lines. This is the "diff-context" strategy.
 */
export function matchByDiffContext(
  content: string,
  oldText: string,
  options: MatchOptions,
): MatchResult | null {
  const contentLines = splitLines(content);
  const searchLines = splitLines(oldText);

  if (searchLines.length === 0) return null;

  // Extract significant tokens from the search text (non-trivial, code-like tokens)
  const significantTokens = extractSignificantTokens(oldText);

  if (significantTokens.length === 0) return null;

  // Build candidate blocks by sliding a window across content lines.
  // Use multiple window sizes (1x, 2x, 1.5x the search line count) to
  // handle cases where the model may have combined or split lines.
  const windowSizes = [
    Math.max(1, searchLines.length),
    Math.max(2, searchLines.length + 1),
    Math.max(2, Math.floor(searchLines.length * 1.5)),
  ];

  const candidates: Array<{ start: number; similarity: number; block: string }> = [];

  for (const winSize of new Set(windowSizes)) {
    for (let i = 0; i <= contentLines.length - winSize; i++) {
      const block = contentLines.slice(i, i + winSize).join("\n");
      const similarity = lineSimilarity(oldText, block);
      // Also compute token + ngram similarity for scoring
      const tokSim = tokenOverlap(oldText, block);
      const ngSim = ngramSimilarity(oldText, block);
      const combined = similarity * 0.5 + tokSim * 0.3 + ngSim * 0.2;
      if (combined > 0.4) {
        candidates.push({ start: i, similarity: combined, block });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Sort by similarity descending
  candidates.sort((a, b) => b.similarity - a.similarity);

  // Try the top candidates
  for (const candidate of candidates.slice(0, 5)) {
    const { start, block } = candidate;

    // Calculate the character position in the content
    const charPos = contentLines.slice(0, start).join("\n").length +
      (start > 0 ? 1 : 0);

    const contextLines = extractContextLines(content, charPos, block.length, options.contextLines);

    const confidence = scoreConfidence({
      searchText: oldText,
      foundText: block,
      isExact: false,
      isUnique: true,
      occurrenceCount: 1,
      capturedContext: contextLines,
      expectedContext: options.expectedContext,
      strategy: "diff-context",
    });

    return {
      startIndex: charPos,
      matchLength: block.length,
      confidence,
      strategy: "diff-context",
      matchedText: block,
      retries: 0,
      contextLines,
    };
  }

  return null;
}

/**
 * Extract significant tokens from text (whitespace-separated words >= 3 chars).
 */
export function extractSignificantTokens(text: string): string[] {
  return text
    .split(/[\s\n\r]+/)
    .filter((t) => t.length >= 3 && /[a-zA-Z0-9_]/.test(t))
    .map((t) => t.replace(/[^a-zA-Z0-9_]/g, ""));
}

// ────────────────────────────────────────────────────────────────────────────
// SemanticSplitter
// ────────────────────────────────────────────────────────────────────────────

/**
 * Identify the start of a top-level declaration based on line content.
 */
const DECLARATION_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+/,
  /^\s*(?:export\s+)?(?:async\s+)?class\s+/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+/,
  /^\s*(?:export\s+)?interface\s+/,
  /^\s*(?:export\s+)?type\s+/,
  /^\s*(?:export\s+)?enum\s+/,
  /^\s*(?:export\s+)?abstract\s+class\s+/,
  /^\s*(?:export\s+)?default\s+(?:function|class)\s+/,
  /^\s*module\s+/,
  /^\s*namespace\s+/,
  /^\s*import\s+/,
  /^\s*(?:export\s+)?default\s+/,
];

function isDeclarationStart(line: string): boolean {
  return DECLARATION_PATTERNS.some((p) => p.test(line));
}

/** Pattern to detect comment/multiline strings — skip these for chunk boundaries. */
const STRING_OR_COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*|\*\/|['"`])/;

/**
 * Split file content into semantic chunks based on top-level declarations.
 * Returns an array of chunks sorted by position.
 */
export function splitIntoChunks(content: string): SemanticChunk[] {
  if (!content) return [];
  const lines = splitLines(normalizeToLF(content));
  if (lines.length === 0) return [];

  const chunks: SemanticChunk[] = [];
  let chunkStart = 0;

  for (let i = 0; i < lines.length; i++) {
    // Skip comment / string-only lines as chunk starters
    if (STRING_OR_COMMENT_LINE.test(lines[i]) && !isDeclarationStart(lines[i])) {
      continue;
    }

    if (isDeclarationStart(lines[i]) || i === lines.length - 1) {
      // Close the previous chunk
      if (chunks.length > 0) {
        chunks[chunks.length - 1].endLine = i - 1;
      }

      // If first chunk starts at line 0 (header/imports), include it
      if (i === 0 || chunkStart < i) {
        chunks.push({
          startLine: chunkStart,
          endLine: i, // tentative, will be corrected
          signature: lines[chunkStart] || "(empty)",
          body: lines.slice(chunkStart, i + 1).join("\n"),
        });
        chunkStart = i;
      }

      if (i === 0) {
        chunkStart = i;
      }
    }
  }

  // Close the last chunk
  if (chunks.length > 0) {
    chunks[chunks.length - 1].endLine = lines.length - 1;
    chunks[chunks.length - 1].body = lines
      .slice(chunks[chunks.length - 1].startLine)
      .join("\n");
  } else if (lines.length > 0) {
    // No declarations found — whole file is one chunk (only if non-empty)
    const trimmed = lines.filter((l) => l.trim().length > 0);
    if (trimmed.length > 0 || content.length > 0) {
      chunks.push({
        startLine: 0,
        endLine: lines.length - 1,
        signature: lines[0] || "(empty)",
        body: content,
      });
    }
  }

  return chunks;
}

/**
 * Find which chunk a search text is most likely to belong to.
 * Returns the chunk index or -1 if no good match.
 */
export function findChunkForSearch(
  chunks: SemanticChunk[],
  oldText: string,
  minSimilarity: number = 0.1,
): number {
  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < chunks.length; i++) {
    const sim = tokenOverlap(oldText, chunks[i].body) +
      ngramSimilarity(oldText, chunks[i].body) * 0.5;

    if (sim > bestScore && sim >= minSimilarity) {
      bestScore = sim;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// ────────────────────────────────────────────────────────────────────────────
// MultiPassEditEngine
// ────────────────────────────────────────────────────────────────────────────

/**
 * Apply edits to content using multiple passes.
 *
 * Pass 1: Try exact+unique matches for all edits.
 * Pass 2: Try fuzzy matches for edits that failed in Pass 1.
 * Pass 3: Try diff-context matching for remaining failures.
 *
 * Each pass computes confidence. If overall confidence >= threshold, edits
 * are applied; otherwise they are collected but not applied.
 */
export function multiPassApply(
  content: string,
  edits: EditOp[],
  config: ContextualEditConfig = DEFAULT_CONFIG,
): EditResult {
  const lfContent = normalizeToLF(content);
  let workingContent = lfContent;
  const allMatches: MatchResult[] = [];
  let anySuccessful = false;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const normalizedOld = normalizeToLF(edit.oldText);
    const normalizedNew = normalizeToLF(edit.newText);

    // Skip if oldText is empty
    if (normalizedOld.length === 0) continue;

    // Pass 1: Exact match
    let match = matchInContent(workingContent, normalizedOld, {
      contextLines: config.retry.initialContextLines,
    });

    // Expand/retry cycle for failed matches
    let retries = 0;
    if (!match || match.confidence < config.minAcceptableConfidence) {
      for (let r = 1; r <= config.retry.maxRetries; r++) {
        retries++;
        const expandedContext = config.retry.initialContextLines + r * config.retry.contextExpandBy;

        // Split file into chunks (on retries) for better targeting
        const chunks = splitIntoChunks(workingContent);
        let chunkContent = workingContent;

        if (chunks.length > 1) {
          const chunkIdx = findChunkForSearch(chunks, normalizedOld);
          if (chunkIdx >= 0) {
            chunkContent = chunks[chunkIdx].body;
          }
        }

        match = matchInContent(chunkContent, normalizedOld, {
          contextLines: expandedContext,
        });

        if (match) {
          match.retries = retries;
          break;
        }
      }
    }

    if (match && match.confidence >= config.minAcceptableConfidence) {
      allMatches.push(match);

      // Apply the replacement
      if (match.confidence >= config.autoApplyThreshold) {
        workingContent =
          workingContent.slice(0, match.startIndex) +
          normalizedNew +
          workingContent.slice(match.startIndex + match.matchLength);
        anySuccessful = true;
      }
    } else {
      // No acceptable match found — add a placeholder match with zero confidence
      allMatches.push({
        startIndex: -1,
        matchLength: 0,
        confidence: 0,
        strategy: "exact",
        matchedText: "",
        retries,
      });
    }
  }

  // Compute overall confidence (average of all matches)
  const overallConfidence =
    allMatches.length > 0
      ? allMatches.reduce((sum, m) => sum + m.confidence, 0) / allMatches.length
      : 0;

  return {
    success: allMatches.every((m) => m.confidence >= config.minAcceptableConfidence),
    content: workingContent,
    matches: allMatches,
    overallConfidence,
    applied: overallConfidence >= config.autoApplyThreshold && anySuccessful,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ────────────────────────────────────────────────────────────────────────────

/**
 * Main entry: apply edits to file content with smart matching.
 *
 * Steps:
 *   1. If the file is long, split into semantic chunks for better matching.
 *   2. Run multi-pass edit engine on each edit.
 *   3. Compute overall confidence.
 *   4. If confidence >= threshold, apply edits; otherwise return unmodified.
 *
 * Returns the result with full diagnostic info.
 */
export function contextualEdit(
  content: string,
  edits: EditOp[],
  config: Partial<ContextualEditConfig> = {},
): EditResult {
  const fullConfig: ContextualEditConfig = { ...DEFAULT_CONFIG, ...config };
  const lfContent = normalizeToLF(content);

  // If the file is long, try semantic chunk-based matching first
  const lines = splitLines(lfContent);
  if (lines.length > fullConfig.semanticChunkThreshold) {
    const chunkResult = applyByChunks(lfContent, edits, fullConfig);
    if (chunkResult.success && chunkResult.overallConfidence >= fullConfig.autoApplyThreshold) {
      return chunkResult;
    }
    // If chunk-based failed or has low confidence, fall through to multi-pass
  }

  return multiPassApply(lfContent, edits, fullConfig);
}

/**
 * Apply edits by first locating the right chunk, then matching within it.
 */
function applyByChunks(
  content: string,
  edits: EditOp[],
  config: ContextualEditConfig,
): EditResult {
  const chunks = splitIntoChunks(content);

  if (chunks.length <= 1) {
    // Single chunk — fall through to normal multi-pass
    return multiPassApply(content, edits, config);
  }

  // For each edit, find the best chunk
  let workingContent = content;
  const allMatches: MatchResult[] = [];
  let anyApplied = false;
  let allSuccessful = true;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const normalizedOld = normalizeToLF(edit.oldText);
    if (normalizedOld.length === 0) continue;

    const chunkIdx = findChunkForSearch(chunks, normalizedOld);
    if (chunkIdx < 0) {
      // Chunk not found — fall back to full-content matching
      const result = multiPassApply(workingContent, [edit], config);
      allMatches.push(...result.matches);
      workingContent = result.content;
      if (result.applied) anyApplied = true;
      if (!result.success) allSuccessful = false;
      continue;
    }

    // Search within the chunk
    const chunk = chunks[chunkIdx];
    const match = matchInContent(chunk.body, normalizedOld, {
      contextLines: config.retry.initialContextLines,
    });

    if (match && match.confidence >= config.minAcceptableConfidence) {
      allMatches.push(match);

      if (match.confidence >= config.autoApplyThreshold) {
        // Apply replacement to the full content at the correct position
        // Calculate the chunk's starting character offset in the full content
        const chunkStartOffset = content
          .split("\n")
          .slice(0, chunk.startLine)
          .join("\n")
          .length + (chunk.startLine > 0 ? 1 : 0);

        const absolutePos = chunkStartOffset + match.startIndex;
        const normalizedNew = normalizeToLF(edit.newText);

        workingContent =
          workingContent.slice(0, absolutePos) +
          normalizedNew +
          workingContent.slice(absolutePos + match.matchLength);
        anyApplied = true;
      }
    } else {
      allSuccessful = false;
      allMatches.push({
        startIndex: -1,
        matchLength: 0,
        confidence: 0,
        strategy: "semantic-chunk",
        matchedText: "",
        retries: 0,
      });
    }
  }

  const overallConfidence =
    allMatches.length > 0
      ? allMatches.reduce((sum, m) => sum + m.confidence, 0) / allMatches.length
      : 0;

  return {
    success: allSuccessful,
    content: workingContent,
    matches: allMatches,
    overallConfidence,
    applied: anyApplied && overallConfidence >= config.autoApplyThreshold,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Utility: find-based search (pure, pattern location helper)
// ────────────────────────────────────────────────────────────────────────────

export interface FindLocation {
  lineIndex: number;
  charOffset: number;
  lineText: string;
}

/**
 * Find the location of a search pattern in content using multiple strategies.
 * Returns the best match with line-level information.
 */
export function findPatternLocation(
  content: string,
  pattern: string,
): FindLocation | null {
  const lfContent = normalizeToLF(content);
  const lfPattern = normalizeToLF(pattern);
  const lines = splitLines(lfContent);

  // Strategy 1: Exact line match
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(lfPattern);
    if (idx !== -1) {
      return { lineIndex: i, charOffset: idx, lineText: lines[i] };
    }
  }

  // Strategy 2: Fuzzy line match (normalized)
  const fuzzyPattern = normalizeForFuzzy(lfPattern);
  for (let i = 0; i < lines.length; i++) {
    const fuzzyLine = normalizeForFuzzy(lines[i]);
    const idx = fuzzyLine.indexOf(fuzzyPattern);
    if (idx !== -1) {
      return { lineIndex: i, charOffset: idx, lineText: lines[i] };
    }
  }

  // Strategy 3: Token overlap across lines (for multi-line patterns).
  // Return the BEST match (highest similarity), not the first one.
  const patternLines = splitLines(lfPattern);
  if (patternLines.length > 1) {
    let bestIdx = -1;
    let bestSimilarity = 0;
    for (let i = 0; i <= lines.length - patternLines.length; i++) {
      const block = lines.slice(i, i + patternLines.length).join("\n");
      const similarity = lineSimilarity(lfPattern, block);
      if (similarity > 0.6 && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      return { lineIndex: bestIdx, charOffset: 0, lineText: lines[bestIdx] };
    }
  }

  return null;
}

/**
 * Get surrounding lines around a location.
 */
export function getSurroundingLines(
  content: string,
  lineIndex: number,
  contextBefore: number,
  contextAfter: number,
): string[] {
  if (!content) return [];
  const lines = splitLines(normalizeToLF(content));
  if (lines.length === 1 && lines[0] === "") return [];
  const start = Math.max(0, lineIndex - contextBefore);
  const end = Math.min(lines.length, lineIndex + contextAfter + 1);
  return lines.slice(start, end);
}
