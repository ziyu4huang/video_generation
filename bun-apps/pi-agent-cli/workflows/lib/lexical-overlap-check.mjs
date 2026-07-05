/**
 * lexical-overlap-check.mjs — adversarial-query lexical-overlap gate.
 *
 * Prevents the retrieval-quality loop from being rigged: if a generated
 * "adversarial" query shares a title/tag token with a card in the target
 * folder, lexical search matches on that token and wins by cheating, not by
 * semantic understanding. This module rejects such queries so the measurement
 * stays honest.
 *
 * TWO MODES
 * ---------
 * 1. Library (tested): exports `extractCardTerms`, `extractQueryTokens`,
 *    and `findLexicalOverlap` as pure functions.
 * 2. CLI (called by the workflow gate validator):
 *      node lexical-overlap-check.mjs \
 *        --queries /tmp/queries.json \
 *        --vault /path/to/vault \
 *        --folder "Zettelkasten/knowledge-graph"
 *    Reads card titles+tags from vault/folder (recursive .md), checks each query,
 *    prints { clean, overlaps, cardTermCount, queryCount } as JSON.
 *
 * TOKENIZATION
 * ------------
 * - Latin script: split on non-word chars, lowercase, keep tokens ≥3 chars,
 *   minus a small English stopword set.
 * - CJK (zh-TW cross-lingual): no word boundaries, so extract 2-char bigrams
 *   from titles/tags and check if any appears as a substring in the query.
 *   A shared CJK bigram = near-certain lexical overlap.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, extname } from "path";

// ── Stopwords (English only — CJK has no stopwords at this granularity) ──────
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was",
  "one", "our", "out", "has", "have", "had", "how", "what", "when", "who",
  "will", "your", "from", "they", "this", "that", "with", "into", "using",
  "use", "used", "get", "set", "run", "via", "via", "its", "any", "way",
  "try", "fix", "make", "makes", "made", "does", "did", "done", "about",
  "error", "issue", "problem", "thing", "things", "some", "such", "than",
  "then", "them", "these", "those", "very", "also", "just", "like", "want",
]);

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const isCjk = (ch) => CJK_RANGE.test(ch);
const hasCjk = (s) => typeof s === "string" && CJK_RANGE.test(s);

/**
 * Extract significant Latin word-tokens from a string.
 * Lowercased, ≥3 chars, minus the stopword set.
 */
export function extractLatinTokens(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Extract CJK bigrams (2-char sequences) from a string.
 * Returns [] for non-CJK strings. Used because Chinese has no word boundaries —
 * a shared 2-char substring is the smallest reliable lexical-overlap signal.
 */
export function extractCjkBigrams(text) {
  if (!text || !hasCjk(text)) return [];
  // Keep only CJK characters (strip punctuation/Latin), then slide a 2-char window.
  const cjkOnly = [...text].filter(isCjk).join("");
  const bigrams = [];
  for (let i = 0; i < cjkOnly.length - 1; i++) {
    bigrams.push(cjkOnly.slice(i, i + 2));
  }
  return bigrams;
}

/**
 * Extract the set of lexical "cheat tokens" from a card title or tag list.
 * Mixes Latin tokens + CJK bigrams so both script families are covered.
 */
export function extractCardTerms(title, tags = []) {
  const terms = new Set();
  const sources = [title, ...(Array.isArray(tags) ? tags : [])].filter(Boolean);
  for (const s of sources) {
    for (const t of extractLatinTokens(s)) terms.add(t);
    for (const b of extractCjkBigrams(s)) terms.add(b);
  }
  return terms;
}

/**
 * Extract the set of lookup tokens from a query (Latin tokens + CJK bigrams).
 * Must use the SAME tokenization as extractCardTerms for overlap to be meaningful.
 */
export function extractQueryTokens(query) {
  const terms = new Set();
  for (const t of extractLatinTokens(query)) terms.add(t);
  for (const b of extractCjkBigrams(query)) terms.add(b);
  return terms;
}

/**
 * Find lexical overlap between a query and a set of card terms.
 * @param {string} query the query text
 * @param {Set<string>} cardTerms terms extracted from card titles/tags
 * @returns {{ overlap: boolean, matchedTerms: string[] }}
 */
export function findLexicalOverlap(query, cardTerms) {
  const queryTokens = extractQueryTokens(query);
  const matched = [...queryTokens].filter((t) => cardTerms.has(t));
  return { overlap: matched.length > 0, matchedTerms: matched.sort() };
}

/**
 * Check a batch of queries against card terms.
 * @param {Array<{id?:*, text:string}>} queries
 * @param {Set<string>} cardTerms
 * @returns {{ clean: boolean, overlaps: Array<{queryId, matchedTerms}> }}
 */
export function checkQueriesForOverlap(queries, cardTerms) {
  const overlaps = [];
  for (const q of queries) {
    const { overlap, matchedTerms } = findLexicalOverlap(q.text ?? "", cardTerms);
    if (overlap) overlaps.push({ queryId: q.id ?? q.text, matchedTerms });
  }
  return { clean: overlaps.length === 0, overlaps };
}

// ── Vault reading (CLI mode) ─────────────────────────────────────────────────

function walkMarkdownFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkMarkdownFiles(full, out);
    else if (extname(full) === ".md") out.push(full);
  }
  return out;
}

/**
 * Parse a markdown note's frontmatter + H1 title to extract title + tags.
 * Returns { title, tags }.
 */
export function parseNoteMetadata(content) {
  let title = "";
  const tags = [];
  // Frontmatter (--- ... ---)
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const titleLine = fm.match(/^title:\s*(.+)$/m);
    if (titleLine) title = titleLine[1].replace(/^["']|["']$/g, "").trim();
    const tagsLine = fm.match(/^tags:\s*(.+)$/m);
    if (tagsLine) {
      const raw = tagsLine[1].replace(/^\[|\]$/g, "");
      for (const t of raw.split(",")) {
        const clean = t.replace(/^["']|["']$/g, "").replace(/^#/, "").trim();
        if (clean) tags.push(clean);
      }
    }
  }
  // Fallback: first H1
  if (!title) {
    const h1 = content.match(/^#\s+(.+)$/m);
    if (h1) title = h1[1].trim();
  }
  return { title, tags };
}

/**
 * Read all card terms from a vault folder. Walks vault/folder recursively for
 * parses each note's title + tags, and returns the union of all cheat-tokens.
 */
export function readCardTermsFromFolder(vault, folder) {
  const dir = join(vault, folder);
  const files = walkMarkdownFiles(dir);
  const terms = new Set();
  for (const f of files) {
    const content = readFileSync(f, "utf8");
    const { title, tags } = parseNoteMetadata(content);
    for (const t of extractCardTerms(title, tags)) terms.add(t);
  }
  return terms;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.queries || !args.vault || !args.folder) {
    process.stderr.write(
      "usage: lexical-overlap-check.mjs --queries <queries.json> --vault <path> --folder <folder>\n",
    );
    process.exit(2);
  }
  const queries = JSON.parse(readFileSync(args.queries, "utf8"));
  const cardTerms = readCardTermsFromFolder(args.vault, args.folder);
  const result = checkQueriesForOverlap(
    Array.isArray(queries) ? queries : queries.queries ?? [],
    cardTerms,
  );
  process.stdout.write(
    JSON.stringify({ ...result, cardTermCount: cardTerms.size, queryCount: (Array.isArray(queries) ? queries : queries.queries ?? []).length }) + "\n",
  );
}

// Only run CLI when invoked directly, not when imported by tests.
const isMain = process.argv[1] && process.argv[1].endsWith("lexical-overlap-check.mjs");
if (isMain) main();
