/**
 * src/store/surreal/embedder.ts — embedding seam for the card_vectors HNSW
 * side-table (ticket 14 phase A).
 *
 * Mirrors `pi-agent-ext-knowledge-card/src/semantic.ts` so a shared index is
 * drop-in compatible: same default model (nomic-embed-text-v1.5, 768-dim),
 * same LM Studio `/v1/embeddings` contract, same injectable `Embedder` shape.
 *
 * Library only — no ExtensionAPI. The embedder is injectable so tests run with
 * a deterministic mock instead of a live LM Studio. Every public entry point
 * degrades gracefully: a network/model failure returns null / false (never
 * throws) so the caller (searchSemantic) can fall through to the T5(a)
 * graceful-degrade path.
 */

/** The default embedding model id served by LM Studio (768-dim). Mirrors zk's
 *  SEMANTIC_MODEL_DEFAULT so a shared index is compatible. */
export const SEMANTIC_MODEL_DEFAULT = "text-embedding-nomic-embed-text-v1.5";

/** Injectable embedder: texts → vectors. The default hits LM Studio; tests pass
 *  a deterministic mock. Kept structurally identical to zk's `Embedder` type. */
export type Embedder = (texts: string[], model: string) => Promise<number[][]>;

export interface DefaultEmbedderOptions {
  /** LM Studio base URL, e.g. http://127.0.0.1:1234. */
  baseUrl: string;
  /** Per-request embedding batch size (LM Studio /v1/embeddings is batched). */
  batchSize?: number;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Build an `Embedder` backed by LM Studio's OpenAI-compatible
 *  `/v1/embeddings` endpoint. Requests are batched (default 32 texts/req) so a
 *  corpus re-embed stays bounded even at scale. Throws on a non-OK response —
 *  callers wrap it (embedQuery swallows; searchSemantic falls through). */
export function defaultEmbedder(opts: DefaultEmbedderOptions): Embedder {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const batchSize = opts.batchSize ?? 32;
  const fetchFn = opts.fetch ?? fetch;
  return async (texts, _model) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const res = await fetchFn(`${baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: _model, input: batch }),
      });
      if (!res.ok) throw new Error(`LM Studio embeddings HTTP ${res.status}`);
      const j = (await res.json()) as { data: { embedding: number[] }[] };
      for (const d of j.data) out.push(d.embedding);
    }
    return out;
  };
}

/** Is a local LM Studio reachable AND serving `model`? Cheap /v1/models probe
 *  (1.5s timeout). Never throws — a down server is a graceful `false`, which is
 *  the signal searchSemantic uses to skip the warm path before even embedding. */
export async function lmStudioAvailable(
  baseUrl: string,
  model: string = SEMANTIC_MODEL_DEFAULT,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { data: { id: string }[] };
    return j.data.some((m) => m.id === model);
  } catch {
    return false;
  }
}

export interface EmbedQueryOptions {
  /** Embedding model id (defaults to SEMANTIC_MODEL_DEFAULT). */
  model?: string;
  /** Injectable embedder (defaults to a LM Studio-backed one). */
  embedder?: Embedder;
}

/** Embed a single query string. Returns null on ANY failure (LM Studio down,
 *  model missing, network error) — the caller (searchSemantic) treats null as
 *  "fall through to T5(a) graceful degrade". Mirrors zk's embedQuery contract. */
export async function embedQuery(
  text: string,
  opts: EmbedQueryOptions = {},
): Promise<number[] | null> {
  const model = opts.model ?? SEMANTIC_MODEL_DEFAULT;
  const embedder = opts.embedder;
  try {
    const vs = embedder ? await embedder([text], model) : null;
    if (vs) return vs[0] ?? null;
    return null;
  } catch {
    return null;
  }
}
