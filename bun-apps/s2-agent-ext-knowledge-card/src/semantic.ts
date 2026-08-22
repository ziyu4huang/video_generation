/**
 * src/semantic.ts — OPT-IN semantic (embedding) recall for retrieveRecords.
 *
 * Network-bound: calls a local LM Studio embedding endpoint (canonical model
 * `text-embedding-bge-m3`, D3 effort 2026-08-22-context-lifecycle; the 1.00
 * blend below was measured under nomic — the bge-m3 re-baseline is ticket 07's
 * eval gate, with nomic as the recorded fallback).
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

const { baseUrl: EMBED_BASE } = resolveSemanticEmbedConfig();

export const defaultEmbedder: Embedder = makeDefaultEmbedder({ baseUrl: EMBED_BASE });

export const lmStudioAvailable = (model: string = SEMANTIC_MODEL_DEFAULT): Promise<boolean> =>
	lmStudioAvailableAt(EMBED_BASE, model);


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
	model: string,
	embedder: Embedder = defaultEmbedder,
): Promise<CardEmbeddings | null> {
	const folderAbs = join(vaultPath, folder);
	if (!existsSync(folderAbs)) return null;
	const names = readdirSync(folderAbs).filter((n) => n.endsWith(".md")).sort();
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
	// Rebuild: read each card, embed its text (batched).
	const texts: string[] = [];
	for (const n of names) {
		const raw = readFileSync(join(folderAbs, n), "utf8");
		const fmM = raw.match(/^---\n([\s\S]*?)\n---/);
		const tagsM = fmM?.[1]?.match(/^tags:\s*\[(.*?)\]/m);
		const tags = tagsM?.[1]?.split(",")?.map((s) => s.trim().replace(/"/g, "")) ?? [];
		texts.push(cardEmbedText(raw, readTitle(raw), tags));
	}
	try {
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
	model: string = SEMANTIC_MODEL_DEFAULT,
	embedder: Embedder = defaultEmbedder,
): Promise<number[] | null> {
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
