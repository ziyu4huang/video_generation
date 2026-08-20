/**
 * bench/corpus.ts — synthetic memory corpus + query generator for the
 * hermes-memory backend A/B benchmark (wayfinder ticket 06).
 *
 * Determinism contract: `generateCorpus(n)` is SEEDED so the same `n` always
 * yields the byte-identical corpus regardless of when it runs. This makes the
 * A/B comparison fair: sqlite and surreal at the same scale insert the EXACT
 * same rows. `randomQuery()` uses its own seeded RNG so warm-workload queries
 * are reproducible too.
 *
 * Term pool source: parse `~/.pi/agent/pi-hermes-memory/{MEMORY,USER,failures}.md`
 * if present (split entries on "\n§\n" or YAML "---" blocks; collect words
 * length >= 3, lowercased, dedup). When the dir is absent or yields too few
 * words, fall back to a built-in ~200-word English pool.
 *
 * Written for the zk-spawn task. New file only — no existing file modified.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type BenchEntry = {
  content: string;
  target: "memory" | "user" | "failure";
};

// --- Built-in fallback pool (~200 common English words) ---------------------
const BUILTIN_POOL: string[] = [
  "memory", "session", "agent", "project", "config", "command", "module", "function",
  "async", "await", "promise", "error", "warning", "debug", "status", "result",
  "value", "object", "array", "string", "number", "boolean", "schema", "parser",
  "handler", "router", "queue", "cache", "buffer", "stream", "token", "context",
  "prompt", "model", "message", "review", "update", "create", "delete", "search",
  "index", "query", "table", "record", "column", "primary", "foreign", "unique",
  "nested", "iteration", "recursive", "compile", "runtime", "deploy", "version",
  "branch", "commit", "merge", "conflict", "resolve", "fallback", "default", "custom",
  "policy", "strategy", "priority", "schedule", "trigger", "listener", "observer", "signal",
  "channel", "socket", "request", "response", "header", "payload", "encrypt", "decrypt",
  "signature", "verify", "permit", "restrict", "scope", "global", "local", "shared",
  "atomic", "concurrent", "mutex", "lock", "unlock", "transient", "persist", "flush",
  "batch", "chunk", "slice", "segment", "fragment", "literal", "constant", "variable",
  "generic", "tuples", "mapping", "reduce", "filter", "collect", "gather", "scatter",
  "summarize", "condense", "overflow", "evict", "consolidate", "supersede", "dedupe", "archive",
  "frontend", "backend", "database", "server", "client", "proxy", "gateway", "tunnel",
  "latency", "throughput", "bandwidth", "payload", "checksum", "integrity", "corruption", "recovery",
  "snapshot", "backup", "restore", "migrate", "schema", "indexing", "ranking", "score",
  "weight", "decay", "recency", "frequency", "relevance", "semantic", "lexical", "graph",
  "vertex", "edge", "neighbor", "traverse", "expand", "prune", "rank", "threshold",
  "boundary", "limit", "offset", "cursor", "pagination", "window", "frame", "event",
  "compute", "allocate", "release", "measure", "profile", "benchmark", "sample", "metric",
  "percentile", "average", "median", "deviation", "variance", "outlier", "regression", "growth",
  "stale", "fresh", "recent", "ancient", "current", "future", "past", "present",
];

// --- Seeded PRNG (mulberry32) — deterministic, no Math.random leakage --------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed seed for corpus generation → reproducible corpora across runs/backends. */
const CORPUS_SEED = 0xc0ffee;
/** Separate seed for query generation → reproducible but independent stream. */
const QUERY_SEED = 0x5eed1e;

let _pool: string[] | null = null;

/** Tokenize a block of text into lowercased words of length >= 3. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z][A-Za-z0-9_-]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0].toLowerCase());
  }
  return out;
}

/**
 * Build the term pool. Parses the three hermes-memory markdown files if the
 * storage dir exists; entries are split on "\n§\n" delimiters or YAML "---"
 * frontmatter/section blocks, then tokenized. Falls back to the built-in pool
 * when the dir is absent or yields fewer than MIN_POOL_WORDS terms.
 */
export function buildTermPool(): string[] {
  if (_pool) return _pool;

  const MIN_POOL_WORDS = 40;
  const dir = path.join(os.homedir(), ".pi", "agent", "pi-hermes-memory");
  const files = ["MEMORY.md", "USER.md", "failures.md"];
  const words = new Set<string>();

  let dirExists = false;
  try {
    dirExists = fs.statSync(dir).isDirectory();
  } catch {
    dirExists = false;
  }

  if (dirExists) {
    for (const f of files) {
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(dir, f), "utf8");
      } catch {
        continue;
      }
      // Split into entry-ish blocks: "\n§\n" section delimiters first ...
      const blocks = raw.split(/\n§\n/);
      for (const block of blocks) {
        // ... then drop YAML frontmatter fences ("---") so metadata keys don't
        // pollute the pool, keeping the content bodies as the term source.
        const stripped = block.replace(/^---[\s\S]*?---/g, " ").replace(/---/g, " ");
        for (const w of tokenize(stripped)) words.add(w);
      }
    }
  }

  if (words.size >= MIN_POOL_WORDS) {
    _pool = Array.from(words).sort();
  } else {
    // Dir absent or too sparse → built-in pool (deduped, sorted).
    _pool = Array.from(new Set(BUILTIN_POOL)).sort();
  }
  return _pool;
}

/**
 * Generate `n` deterministic synthetic memory entries.
 *
 * Each entry: content = `Note ${i}: ` + a random sentence of 60..260 words
 * drawn from the pool (≈ 400..1800 chars). target cycles ["memory","user",
 * "failure"] by index. The same `n` always produces the identical corpus.
 */
export function generateCorpus(n: number): BenchEntry[] {
  const pool = buildTermPool();
  const rng = mulberry32(CORPUS_SEED);
  const targets: BenchEntry["target"][] = ["memory", "user", "failure"];
  const out: BenchEntry[] = [];

  const pick = (): string => pool[Math.floor(rng() * pool.length)];

  for (let i = 0; i < n; i++) {
    const wordCount = 60 + Math.floor(rng() * 201); // 60..260 inclusive
    const parts: string[] = [];
    for (let w = 0; w < wordCount; w++) parts.push(pick());
    const sentence = parts.join(" ");
    out.push({
      content: `Note ${i}: ${sentence}`,
      target: targets[i % 3],
    });
  }
  return out;
}

/**
 * A reproducible search query: 1..3 random lowercased terms from the pool,
 * space-joined. Uses an independent seeded RNG so the warm-workload query
 * stream is stable across runs.
 */
export function randomQuery(): string {
  const pool = buildTermPool();
  const rng = mulberry32(QUERY_SEED + (queryCounter++ & 0xffff));
  const k = 1 + Math.floor(rng() * 3); // 1..3 terms
  const parts: string[] = [];
  for (let i = 0; i < k; i++) parts.push(pool[Math.floor(rng() * pool.length)]);
  return parts.join(" ");
}

// Monotonic counter mixed into the query seed so successive calls stream
// through different query terms while staying reproducible per call index.
let queryCounter = 0;
