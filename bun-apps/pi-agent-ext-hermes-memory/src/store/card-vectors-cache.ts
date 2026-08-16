import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** kp18 T5b (hermes-arch 10): hermes-side mirror of SurrealDB card_vectors so
 *  memory-card semantic search degrades to local cosine when SurrealDB is down.
 *  `embedModel` records the embedding ENDPOINT id (types.ts embedModel, e.g.
 *  nomic-embed-text-v1.5) — NOT the lineage MODEL_VERSION — because cosine
 *  across different embedding models is garbage; the query-side filter guards it. */
export interface CachedCardVector {
  mdId: string;
  kind: string;
  embedModel: string;
  contentHash: string;
  vec: number[];
}

const CACHE_FILE = "card-vectors-cache.json";

/** Load the cache; missing/corrupt file → empty map. Never throws. */
export function loadCardVectorsCache(memoryDir: string): Map<string, CachedCardVector> {
  try {
    const raw = readFileSync(join(memoryDir, CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw) as Record<string, CachedCardVector>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

/** Persist atomically-ish (tmp + rename). Never throws. */
export function saveCardVectorsCache(memoryDir: string, cache: Map<string, CachedCardVector>): void {
  try {
    mkdirSync(memoryDir, { recursive: true });
    const tmp = join(memoryDir, `${CACHE_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache)), "utf8");
    renameSync(tmp, join(memoryDir, CACHE_FILE));
  } catch {
    /* best-effort mirror: never break the caller */
  }
}

/** Delta-merge entries keyed by mdId, then save. Never throws. */
export function upsertCachedCardVectors(memoryDir: string, entries: CachedCardVector[]): void {
  if (entries.length === 0) return;
  const cache = loadCardVectorsCache(memoryDir);
  for (const e of entries) cache.set(e.mdId, e);
  saveCardVectorsCache(memoryDir, cache);
}

/** Drop entries (md removed / md-wins sweep). Never throws. */
export function removeCachedCardVectors(memoryDir: string, mdIds: string[]): void {
  if (mdIds.length === 0) return;
  const cache = loadCardVectorsCache(memoryDir);
  let touched = false;
  for (const id of mdIds) touched = cache.delete(id) || touched;
  if (touched) saveCardVectorsCache(memoryDir, cache);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
