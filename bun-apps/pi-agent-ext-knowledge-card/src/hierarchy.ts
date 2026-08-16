/**
 * src/hierarchy.ts — pure aggregation hierarchy core (effort
 * 2026-08-16-leanrag-hierarchy-port, ticket 02; LeanRAG ① semantic-aggregation
 * port).
 *
 * Design decisions (map.md):
 *   - D4: dependency-injected callables — `buildLayer` receives `embedFn` +
 *     `summarizeFn` from the ORCHESTRATOR (hermes supplies card_vectors +
 *     llm-chat). This module never imports a store, a vector DB, or an LLM
 *     client; zero new deps.
 *   - D5: deterministic greedy cosine agglomerative clustering (fixed
 *     threshold, id-sorted stable order) — NO GMM/UMAP (anti-deterministic,
 *     python-dep). A centroid merge pass folds clusters whose mutual cosine
 *     re-crosses the threshold after drift. No RNG anywhere.
 *   - D6: LLM token-budget gating — `summarizeFn` is called ONLY when a
 *     cluster's joined text exceeds `tokenBudget` (chars proxy); under budget
 *     the summary is a deterministic truncation. LLM tokens are spent only on
 *     genuinely-over-threshold clusters.
 *
 * Checkpoints (D2) are per-layer JSON (`hierarchy-layer-N.json`) written
 * tmp+rename so a crashed batch build resumes at the last complete layer.
 *
 * Library only — no ExtensionAPI, no network, no console.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Item shape accepted by `cluster` — id + dense vector (any dim ≥ 1). */
export interface ClusterItem {
	id: string;
	vector: number[];
}

export interface ClusterOptions {
	/** Minimum cosine to join / merge (default 0.72). */
	threshold?: number;
	/** Clusters smaller than this are dropped back to per-item singletons
	 *  (default 2 — lone items never masquerade as topics). */
	minSize?: number;
}

/** A card (or lower aggregation node) fed into `buildLayer`. `sources` is the
 *  contentHash lineage union carried upward into the node's frontmatter. */
export interface HierarchyCard {
	id: string;
	text: string;
	entities: string[];
	sources?: string[];
}

/** One aggregation level node — materializes later as a derived MOC card
 *  (D7: frontmatter parent/entities/sources/layer/clusterSize). */
export interface AggregationNode {
	/** `agg:${layer}:${i}` — deterministic per build. */
	id: string;
	/** Child ids (card ids at layer 0, lower node ids above). */
	parentOf: string[];
	/** Union of child entities, first-seen order. */
	entities: string[];
	/** Union of child sources (contentHash lineage). */
	sources: string[];
	summary: string;
	layer: number;
	clusterSize: number;
}

export interface BuildLayerInput {
	cards: HierarchyCard[];
	/** Injected embedder (D4) — batch over all card texts, one call. */
	embedFn(texts: string[]): Promise<number[][]>;
	/** Injected summarizer (D4/D6) — called only for over-budget clusters. */
	summarizeFn(clusterText: string, budget: number): Promise<string>;
	/** Chars proxy for the per-layer condense budget (D6). */
	tokenBudget: number;
	/** Cosine threshold for this layer (default 0.72). */
	threshold?: number;
	/** Depth cap (default 3). */
	maxDepth?: number;
	/** Layer index being built (default 0). */
	currentDepth?: number;
}

export interface BuildLayerResult {
	nodes: AggregationNode[];
	/** Number of summarizeFn invocations (the LLM cost of this layer). */
	llmCalls: number;
	/** true when no further layers are needed: ≤4 nodes or depth cap hit. */
	done: boolean;
}

// ---------------------------------------------------------------------------
// Cosine + clustering (D5)
// ---------------------------------------------------------------------------

/** Cosine similarity; 0 for zero/empty vectors (never joins). */
function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / Math.sqrt(na * nb);
}

/** Mean of member vectors (centroid). */
function centroid(vectors: number[][]): number[] {
	if (vectors.length === 0) return [];
	const c = new Array<number>(vectors[0].length).fill(0);
	for (const v of vectors) for (let i = 0; i < c.length; i++) c[i] += v[i] / vectors.length;
	return c;
}

/**
 * Deterministic greedy cosine agglomerative clustering (D5).
 *
 * Items are sorted by id (stable), each greedily joins the existing cluster
 * with the best centroid cosine if ≥ threshold, else seeds a new cluster. A
 * merge pass then folds cluster pairs whose CENTROID cosine re-crosses the
 * threshold (guards drift in higher dims), looping until stable. Clusters
 * under `minSize` are dropped back to per-item singleton lists. Pure — no RNG.
 */
export function cluster(items: ClusterItem[], opts: ClusterOptions = {}): string[][] {
	const threshold = opts.threshold ?? 0.72;
	const minSize = opts.minSize ?? 2;
	const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const vec = new Map<string, number[]>(sorted.map((it) => [it.id, it.vector]));
	const groups: string[][] = [];
	for (const it of sorted) {
		let best = -1;
		let bestSim = -Infinity;
		for (let g = 0; g < groups.length; g++) {
			const sim = cosine(it.vector, centroid(groups[g].map((id) => vec.get(id)!)));
			if (sim >= threshold && sim > bestSim) {
				bestSim = sim;
				best = g;
			}
		}
		if (best >= 0) groups[best].push(it.id);
		else groups.push([it.id]);
	}
	// Merge pass: fold centroid-similar clusters until stable (deterministic
	// i<j scan order).
	let merged = true;
	while (merged) {
		merged = false;
		outer: for (let i = 0; i < groups.length; i++) {
			for (let j = i + 1; j < groups.length; j++) {
				const ci = centroid(groups[i].map((id) => vec.get(id)!));
				const cj = centroid(groups[j].map((id) => vec.get(id)!));
				if (cosine(ci, cj) >= threshold) {
					groups[i].push(...groups[j]);
					groups.splice(j, 1);
					merged = true;
					break outer;
				}
			}
		}
	}
	// Drop under-minSize clusters back to singletons (kept, in id order).
	const kept: string[][] = [];
	const singletons: string[][] = [];
	for (const g of groups) (g.length >= minSize ? kept : singletons).push(g);
	return [...kept, ...singletons.flat().map((id) => [id])];
}

// ---------------------------------------------------------------------------
// buildLayer (D4 injection + D6 budget gating)
// ---------------------------------------------------------------------------

/** Deterministic under-budget summary: first 300 chars (+ "…" if cut). */
export function truncateSummary(text: string): string {
	const LIMIT = 300;
	return text.length > LIMIT ? text.slice(0, LIMIT) + "…" : text;
}

/**
 * Build one aggregation layer: embed → cluster → one node per cluster with
 * unioned entities/sources and a budget-gated summary (D6). `summarizeFn` is
 * invoked ONLY when the joined cluster text exceeds `tokenBudget`; under
 * budget the summary is the deterministic truncation. `done` = ≤4 nodes or
 * `currentDepth ≥ maxDepth` — the caller stops the batch loop on it.
 */
export async function buildLayer(input: BuildLayerInput): Promise<BuildLayerResult> {
	const depth = input.currentDepth ?? 0;
	const maxDepth = input.maxDepth ?? 3;
	const texts = input.cards.map((c) => c.text);
	const vectors = texts.length > 0 ? await input.embedFn(texts) : [];
	const items = input.cards.map((c, i) => ({ id: c.id, vector: vectors[i] ?? [] }));
	const groups = cluster(items, { threshold: input.threshold });
	const byId = new Map(input.cards.map((c) => [c.id, c]));
	const nodes: AggregationNode[] = [];
	let llmCalls = 0;
	for (let i = 0; i < groups.length; i++) {
		const members = groups[i]
			.map((id) => byId.get(id)!)
			.filter((c): c is HierarchyCard => Boolean(c));
		const entities: string[] = [];
		const sources: string[] = [];
		for (const m of members) {
			for (const e of m.entities) if (!entities.includes(e)) entities.push(e);
			for (const s of m.sources ?? []) if (!sources.includes(s)) sources.push(s);
		}
		const joined = members.map((m) => m.text).join("\n\n");
		let summary: string;
		if (joined.length > input.tokenBudget) {
			summary = await input.summarizeFn(joined, input.tokenBudget);
			llmCalls++;
		} else {
			summary = truncateSummary(joined);
		}
		nodes.push({
			id: `agg:${depth}:${i}`,
			parentOf: groups[i],
			entities,
			sources,
			summary,
			layer: depth,
			clusterSize: groups[i].length,
		});
	}
	return { nodes, llmCalls, done: nodes.length <= 4 || depth >= maxDepth };
}

// ---------------------------------------------------------------------------
// Checkpoints (D2) — per-layer JSON, tmp+rename
// ---------------------------------------------------------------------------

function checkpointPath(dir: string, layer: number): string {
	return join(dir, `hierarchy-layer-${layer}.json`);
}

/** Atomically-ish persist one layer's build result (tmp file + rename). */
export async function writeCheckpoint(dir: string, layer: number, data: unknown): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const final = checkpointPath(dir, layer);
	const tmp = `${final}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
	renameSync(tmp, final);
}

/** Read a layer checkpoint; null when absent (fresh build / layer not yet done). */
export async function readCheckpoint(dir: string, layer: number): Promise<unknown | null> {
	const path = checkpointPath(dir, layer);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

// ---------------------------------------------------------------------------
// parentChain — walk parentOf upward, cycle-safe
// ---------------------------------------------------------------------------

/**
 * Ancestor chain for `nodeId`: the node itself (if it is one) followed by
 * every aggregation node above it (nodes whose `parentOf` contains the child
 * below). Stops at the root, an unknown id, or a cycle — returning the partial
 * chain rather than looping.
 */
export function parentChain(nodeId: string, nodes: AggregationNode[]): AggregationNode[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const chain: AggregationNode[] = [];
	const seen = new Set<string>([nodeId]);
	const start = byId.get(nodeId);
	if (start) chain.push(start);
	let current = nodeId;
	for (;;) {
		const parent = nodes.find((n) => n.parentOf.includes(current) && !seen.has(n.id));
		if (!parent) return chain;
		chain.push(parent);
		seen.add(parent.id);
		current = parent.id;
	}
}
