/**
 * The ONE embedder/cosine/fence-split leaf shared across the knowledge layer
 * (hoisted L2, effort 2026-08-17-knowledge-pipeline-polish). Replaces the
 * deliberate mirrors: hermes store/surreal/embedder.ts, hermes
 * store/card-vectors-cache.ts cosineSimilarity, hermes
 * store/frontmatter-codec.ts splitFencedYaml, and zk semantic.ts' local leaf.
 * Pure library — no ExtensionAPI. Every public entry degrades gracefully
 * (null/false, never throws) so callers can fall through.
 */
import { parse as parseYaml } from "yaml";

/** The default embedding model id served by LM Studio (768-dim). */
export const SEMANTIC_MODEL_DEFAULT = "text-embedding-nomic-embed-text-v1.5";

/** Injectable embedder: texts → vectors. Default hits LM Studio; tests pass a
 *  deterministic mock. */
export type Embedder = (texts: string[], model: string) => Promise<number[][]>;

/** Structural fetch contract — deliberately NOT `typeof fetch`. This leaf is
 *  compiled by every consumer of the package's types entry, and some of them
 *  typecheck under lib:["ESNext"] with a DOM-less global `Response` that lacks
 *  ok/status/json (ext-entry typecheck broke on @types/bun-1.3.14 packages).
 *  The real global fetch satisfies this shape at runtime; default references
 *  are cast through `unknown` so no program needs DOM types to check us. */
export interface FetchLikeResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export interface FetchLikeInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface DefaultEmbedderOptions {
	/** LM Studio base URL, e.g. http://127.0.0.1:1234. */
	baseUrl: string;
	/** Per-request embedding batch size (LM Studio /v1/embeddings is batched). */
	batchSize?: number;
	/** Injectable fetch (tests). Defaults to the global fetch. */
	fetch?: FetchLike;
}

/** Build an `Embedder` backed by LM Studio's OpenAI-compatible `/v1/embeddings`
 *  endpoint. Requests are batched (default 32 texts/req). Throws on a non-OK
 *  response — callers wrap it (embedQuery swallows; search falls through). */
export function defaultEmbedder(opts: DefaultEmbedderOptions): Embedder {
	const baseUrl = opts.baseUrl.replace(/\/+$/, "");
	const batchSize = opts.batchSize ?? 32;
	const fetchFn = opts.fetch ?? (fetch as unknown as FetchLike);
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
 *  (1.5s timeout). Never throws — a down server is a graceful `false`. */
export async function lmStudioAvailable(
	baseUrl: string,
	model: string = SEMANTIC_MODEL_DEFAULT,
	fetchImpl: FetchLike = fetch as unknown as FetchLike,
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
	/** Injectable embedder (tests pass a deterministic mock). */
	embedder?: Embedder;
}

/** Embed a single query string. Returns null on ANY failure (LM Studio down,
 *  model missing, network error) — callers treat null as graceful degrade. */
export async function embedQuery(text: string, opts: EmbedQueryOptions = {}): Promise<number[] | null> {
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

/** Cosine similarity. Vectors need not be pre-normalised; defensive on
 *  length mismatch and zero vectors (returns 0). */
export function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

const FENCE = "---";

/** Split a leading `---` YAML frontmatter block from the body. Returns null on
 *  a missing/malformed fence (never throws). The single source of truth for
 *  "how a fenced card splits". */
export function splitFencedYaml(raw: string): { data: Record<string, unknown>; body: string } | null {
	const lines = raw.split("\n");
	if (lines.length === 0 || lines[0]!.trim() !== FENCE) return null;
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]!.trim() === FENCE) {
			end = i;
			break;
		}
	}
	if (end === -1) return null;
	let data: Record<string, unknown>;
	try {
		const parsed = parseYaml(lines.slice(1, end).join("\n"));
		data = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return null;
	}
	return { data, body: lines.slice(end + 1).join("\n") };
}
