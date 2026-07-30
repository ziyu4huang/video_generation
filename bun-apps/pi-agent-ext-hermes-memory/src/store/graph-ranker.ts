/**
 * Shared, backend-neutral ranker for graph-augmented memory search.
 *
 * Both the SQLite and SurrealDB repositories feed their merged candidate pool
 * (lexical matches + graph neighbors) through this pure function so that the
 * final ordering is IDENTICAL across backends — the repository contract
 * (`searchMemories → MemoryEntry[]`) stays unchanged; this is an internal
 * recall/ranking booster only.
 *
 * See .planning/2026-07-28-hermes-surrealdb-graph-search/spec.md.
 */
import type { MemoryEntry } from "./repository.js";

export interface RankInput {
  /** All candidates to rank: lexical matches + graph neighbors. */
  candidates: MemoryEntry[];
  /** Ids of the lexical-match set (the seeds). Drives lexicalMatch + graphProximity. */
  lexicalMatchIds: Set<number>;
  /** Final result cap. */
  limit: number;
  /** "now" for recency decay; injectable for deterministic tests. */
  now?: Date;
}

// Scoring weights (centralized; tunable, equivalence-neutral).
const W_LEX = 1.0;
const W_GRAPH = 0.5;
const W_RECENCY = 0.25;

interface Scored {
  entry: MemoryEntry;
  score: number;
}

/** Collect the implicit-tag values present in the seed (lexical-match) set. */
function collectSeedTags(candidates: MemoryEntry[], lexicalMatchIds: Set<number>): Set<string> {
  const tags = new Set<string>();
  for (const c of candidates) {
    if (!lexicalMatchIds.has(c.id)) continue;
    if (c.project != null) tags.add(`project:${c.project}`);
    if (c.category != null) tags.add(`category:${c.category}`);
    if (c.target != null) tags.add(`target:${c.target}`);
  }
  return tags;
}

/** Count of {project,category,target} the entry shares with the seed set (0..3). */
function sharedTagCount(entry: MemoryEntry, seedTags: Set<string>): number {
  let n = 0;
  if (entry.project != null && seedTags.has(`project:${entry.project}`)) n++;
  if (entry.category != null && seedTags.has(`category:${entry.category}`)) n++;
  if (entry.target != null && seedTags.has(`target:${entry.target}`)) n++;
  return n;
}

/** Worth multiplier from Laplace-smoothed success probability. 0/0 → 1.0. */
function worthMultiplier(entry: MemoryEntry): number {
  const s = entry.mwSuccess ?? 0;
  const f = entry.mwFail ?? 0;
  return ((s + 1) / (s + f + 2)) / 0.5; // Laplace-smoothed; 0/0 → (1/2)/0.5 = 1.0
}

export function rankMemoryEntries({
  candidates,
  lexicalMatchIds,
  limit,
  now = new Date(),
}: RankInput): MemoryEntry[] {
  const seedTags = collectSeedTags(candidates, lexicalMatchIds);
  const nowMs = now.getTime();

  const scored: Scored[] = candidates.map((entry) => {
    const lexical = lexicalMatchIds.has(entry.id) ? 1 : 0;
    const graphProximity = sharedTagCount(entry, seedTags) / 3;
    const ageDays = (nowMs - Date.parse(entry.lastReferenced)) / 86_400_000;
    const recencyNorm = 1 / (1 + ageDays / 30);
    const score = (W_LEX * lexical + W_GRAPH * graphProximity + W_RECENCY * recencyNorm) * worthMultiplier(entry);
    return { entry, score };
  });

  // Highest score first; deterministic tiebreak by id ascending.
  scored.sort((x, y) => y.score - x.score || x.entry.id - y.entry.id);

  return scored.slice(0, limit).map((s) => s.entry);
}
