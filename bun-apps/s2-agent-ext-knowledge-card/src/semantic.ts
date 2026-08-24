/**
 * src/semantic.ts — OPT-IN semantic (embedding) recall for retrieveRecords.
 *
 * Network-bound: calls a local LM Studio embedding endpoint (canonical model
 * `text-embedding-bge-m3`, D3 effort 2026-08-22-context-lifecycle,
 * RE-CONFIRMED 2026-08-23 by ticket 07's eval gate: the English eval set
 * favors nomic 48/50 vs 47/50 hit@4, but the recall-audit battery regresses
 * under nomic 15/20 vs 17/20 — receipt output/d3-reeval/; see core-interface
 * embedding-leaf.ts).
 * retrieveRecords imports this module but invokes it ONLY when
 * `opts.semantic === true`; the default retrieval path stays deterministic +
 * offline (byte-identical baseline, drift-guard green). When LM Studio or the
 * embedding model is unavailable, every call degrades GRACEFULLY — the caller
 * gets back null / false and retrieveRecords falls back to pure lexical.
 *
 * Why this exists (recall-regime-change-eval, 2026-07-12): the deterministic
 * lexical arc ceilinged at 0.84 (#486 bodyMatch + #492 slugDom); the 4 residual
 * misses are symptom→cause semantic gaps the query's words cannot bridge. LOCAL
 * nomic-embed-text-v1.5 (a GENUINELY DIFFERENT model from the RETIRED vault-mind
 * multilingual) places symptom queries near cause cards in vector space without
 * guessing the vocabulary. Measured: lexical 0.84 → semantic-blend 1.00 (25/25,
 * zero regression, robust α∈[0.12,0.22], ~60-95ms warm). The blend is
 *   final = α·(lexical rank norm) + (1-α)·(cosine min-max norm), α=0.18.
 *
 * Library only — no ExtensionAPI. The embedder is injectable so tests run with a
 * deterministic mock instead of a live LM Studio.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const SEMANTIC_ALPHA_DEFAULT = 0.18;

// L2 (2026-08-17-knowledge-pipeline-polish): the embedder/cosine leaf is hoisted
// to @repo/s2-agent-core-interface. semantic.ts re-exports the leaf for its
// internal consumers (retrieve, graph-health, tests) and keeps only the blend
// engine + cache local. Endpoint+model resolution is ALSO the leaf's
// (resolveSemanticEmbedConfig, D3) — the ONE place env overrides are read.
import {
	SEMANTIC_MODEL_DEFAULT,
	resolveSemanticEmbedConfig,
	type Embedder,
	defaultEmbedder as makeDefaultEmbedder,
	lmStudioAvailable as lmStudioAvailableAt,
	cosine,
} from "@repo/s2-agent-core-interface";

export { cosine, SEMANTIC_MODEL_DEFAULT, type Embedder };

// D22 (kcard-parity ticket 07): config resolution is PER CALL, never captured
// at module load. The old shape (`const { baseUrl } = resolveSemanticEmbedConfig()`
// + a const embedder) froze the baseUrl at import time and DROPPED the model
// half of the resolution entirely — `SEMANTIC_EMBED_MODEL` and the
// `__piEmbeddingConfig` seam could never reach getCardEmbeddings/embedQuery,
// so an env-only "model control" run was silently single-model (memory:
// semantic-embed-model-env-override-trap; cost 4 debug rounds in ticket 07's
// D14 A/B). Lazy resolution also fixes seam TIMING: this module may load
// before the host publishes the seam, and a load-time capture would pin the
// pre-publish fallback for the process lifetime.
export const defaultEmbedder: Embedder = (texts, model) => {
	const cfg = resolveSemanticEmbedConfig();
	return makeDefaultEmbedder({ baseUrl: cfg.baseUrl })(texts, model || cfg.model);
};

export const lmStudioAvailable = (model?: string): Promise<boolean> => {
	const cfg = resolveSemanticEmbedConfig();
	return lmStudioAvailableAt(cfg.baseUrl, model || cfg.model);
};

/** Resolve the effective model for a cards-side call (seam → env → default),
 *  used wherever a caller omitted the per-call model arg. */
export function resolveCardEmbedModel(model?: string): string {
	return model || resolveSemanticEmbedConfig().model;
}


export interface CardEmbeddings {
	model: string;
	/** Vault-relative card paths WITHOUT the .md suffix (matches retrieveRecords). */
	paths: string[];
	vectors: number[][];
}

/** Card text for embedding: title + tags + first 800 chars of body prose. Mirrors
 *  the probe that measured 1.00. Frontmatter is stripped (tags read separately). */
function cardEmbedText(raw: string, title: string, tags: string[]): string {
	const body = raw.replace(/^---\n[\s\S]*?\n---/, "").slice(0, 800);
	return `${title}. ${tags.join(" ")}. ${body}`.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function readTitle(raw: string): string {
	const m = raw.match(/^#\s+(.+?)\s*$/m);
	return m ? m[1]!.trim() : "(untitled)";
}

function cachePath(vaultPath: string, model: string): string {
	const slug = model.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	return join(vaultPath, ".knowledge-semantic", `${slug}.json`);
}

/**
 * Load cached card embeddings for `folder`, rebuilding when the card set
 * (membership + mtimes) changes. Cache lives at
 * `<vault>/.knowledge-semantic/<model>.json`. Returns null if the embedder
 * fails (caller falls back to lexical).
 */
export async function getCardEmbeddings(
	vaultPath: string,
	folder: string,
	model?: string,
	embedder: Embedder = defaultEmbedder,
): Promise<CardEmbeddings | null> {
	model = resolveCardEmbedModel(model);
	const folderAbs = join(vaultPath, folder);
	if (!existsSync(folderAbs)) return null;
	// Non-FILE *.md entries (a directory named *.md passes the suffix filter —
	// EISDIR on read; ticket-02 receipt 2026-08-25) are skipped up front, so
	// they neither crash the pre-read nor ride the cache fingerprint: they
	// carry no embeddable text, exactly like buildCardRows' own read-skip.
	const names = readdirSync(folderAbs)
		.filter((n) => n.endsWith(".md"))
		.filter((n) => {
			try {
				return statSync(join(folderAbs, n)).isFile();
			} catch {
				return false;
			}
		})
		.sort();
	// Current fingerprint: name + mtime per card.
	const fingerprint = names.map((n) => `${n}:${statSync(join(folderAbs, n)).mtimeMs}`).join("|");
	const cache = cachePath(vaultPath, model);
	if (existsSync(cache)) {
		try {
			const cached = JSON.parse(readFileSync(cache, "utf8")) as CardEmbeddings & { fingerprint?: string };
			if (cached.model === model && cached.fingerprint === fingerprint && cached.paths?.length === names.length) {
				return { model, paths: cached.paths, vectors: cached.vectors };
			}
		} catch {
			// corrupt cache — fall through to rebuild
		}
	}
	// Rebuild: read each card, embed its text (batched). The reads live INSIDE
	// the try (same degrade contract as the embedder call below): a file that
	// stats readable but fails to read makes this return null → caller keeps
	// building rows with vec=null — never a crash out of buildCardRows.
	try {
		const texts: string[] = [];
		for (const n of names) {
			const raw = readFileSync(join(folderAbs, n), "utf8");
			const fmM = raw.match(/^---\n([\s\S]*?)\n---/);
			const tagsM = fmM?.[1]?.match(/^tags:\s*\[(.*?)\]/m);
			const tags = tagsM?.[1]?.split(",")?.map((s) => s.trim().replace(/"/g, "")) ?? [];
			texts.push(cardEmbedText(raw, readTitle(raw), tags));
		}
		const vectors: number[][] = [];
		const batchSize = 32;
		for (let i = 0; i < texts.length; i += batchSize) {
			const batch = texts.slice(i, i + batchSize);
			const vs = await embedder(batch, model);
			vectors.push(...vs);
		}
		const paths = names.map((n) => `${folder}/${n.slice(0, -3)}`); // no .md
		const out: CardEmbeddings & { fingerprint: string } = { model, paths, vectors, fingerprint };
		try {
			mkdirSync(join(vaultPath, ".knowledge-semantic"), { recursive: true });
			writeFileSync(cache, JSON.stringify(out));
		} catch {
			// cache write failure is non-fatal — embeddings still returned in-memory
		}
		return { model, paths, vectors };
	} catch {
		return null; // embedder failed — caller falls back to lexical
	}
}

/** Embed a single query string. Returns null on failure (caller falls back). */
export async function embedQuery(
	text: string,
	model?: string,
	embedder: Embedder = defaultEmbedder,
): Promise<number[] | null> {
	model = resolveCardEmbedModel(model);
	try {
		const vs = await embedder([text], model);
		return vs[0] ?? null;
	} catch {
		return null;
	}
}

/** Min-max normalise an array to [0,1] (degenerate → all 0). */
export function minMaxNorm(vals: number[]): number[] {
	if (vals.length === 0) return [];
	const min = Math.min(...vals);
	const max = Math.max(...vals);
	const range = max - min || 1;
	return vals.map((v) => (v - min) / range);
}

/** The semantic-blend score: α·(lexical rank norm) + (1-α)·(cosine min-max norm).
 *  Pure — extracted so the blend math is unit-testable without the retrieveRecords
 *  integration (which is proven end-to-end by the faithful eval harness /
 *  probeB at 1.00 on the real vault). α∈[0.12,0.22] all measured 1.00; default 0.18. */
export function blendScore(lexRankNorm: number, cosNorm: number, alpha: number = SEMANTIC_ALPHA_DEFAULT): number {
	return alpha * lexRankNorm + (1 - alpha) * cosNorm;
}
