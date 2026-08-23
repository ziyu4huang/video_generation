/**
 * src/hierarchical-retrieval.ts — OpenViking-style directory-recursive search
 * with score propagation, on the SurrealDB `card` index (kcard-parity ticket
 * 07, D19/D20).
 *
 * Deterministic per D5/D6 (D19): NO LLM intent analyzer — the query is the
 * caller's own string; typed narrowing is a caller-passed `type` filter
 * (D18), a tool argument rather than an analysis stage.
 *
 * Algorithm (D20):
 *   1. SEED — deterministic multi-query expansion, the existing blend
 *      posture: semantic lane = one KNN over the single `card` table
 *      (`vec <|k,ef|> $qv`, full hierarchy fields in one hop); lexical lane =
 *      per-token FTS over title/summary (snowball FTS is AND-only per query,
 *      ticket 03 P6, so tokens are queried individually and merged
 *      client-side). Seed score = α·lexRankNorm + (1−α)·cosNorm, α=0.18
 *      (SEMANTIC_ALPHA_DEFAULT — the measured blend).
 *   2. PROPAGATE — client-side priority-queue BFS DOWNWARD from seeded agg
 *      nodes: child score = max(own seed, γ·parent score), γ=0.5; ties broken
 *      by stem sort. Per-level expansion = one `WHERE parent = $stem` query
 *      (~40–50 ms/level, ticket 03). ≤ `maxSweeps` sweeps — with a ≤4-layer
 *      tree one downward sweep converges; the loop is the cycle guard.
 *   3. FILTER + RANK — leaves only (D18 default); optional `type` filter on
 *      `kind`; rank by score desc, stem asc.
 *
 * Graceful degradation: SurrealDB down → { ok:false } (caller falls back to
 * the lexical retrieveRecords default — this path is NOT the default, ticket
 * 09 owns that gate). Embedder down → semantic lane skipped, lexical-only
 * seeds.
 *
 * Library only — no ExtensionAPI.
 */
import { SurrealClient } from "@repo/s2-agent-core-interface";
import { embedQuery, minMaxNorm, SEMANTIC_ALPHA_DEFAULT, type Embedder } from "./semantic.ts";

export interface HierarchicalOptions {
	/** The caller's query string, verbatim (no analysis, D19). */
	query: string;
	topK?: number;
	/** KNN depth for the semantic seed lane (default 24). */
	seedTopN?: number;
	/** HNSW efSearch (default 100, ticket 03's measured knob). */
	efSearch?: number;
	/** Parent→child score decay (default 0.5). */
	gamma?: number;
	/** D18 typed filter — leaf kind must match exactly; omit for all kinds. */
	type?: string;
	/** Semantic lane model (default: per-call resolution, D22). */
	model?: string;
	/** Injectable embedder (tests). */
	embedder?: Embedder;
	/** Convergence bound (default 3 — one sweep suffices on a ≤4-layer tree). */
	maxSweeps?: number;
	/** Include the seed/expansion trace (A/B receipts). */
	includeTrace?: boolean;
}

export interface HierarchicalCard {
	stem: string;
	path: string;
	title: string;
	kind: string;
	/** Final score (seed, or propagated when viaTree). */
	score: number;
	/** True when the score arrived via hierarchy propagation rather than the
	 *  card's own seed — the OpenViking "found via directory" case. */
	viaTree: boolean;
	summary: string;
}

export interface HierarchicalTrace {
	semanticLane: boolean;
	tokens: string[];
	seedPool: number;
	seededAgg: number;
	expandedNodes: number;
	childQueries: number;
	sweeps: number;
	typeFilter: string | null;
	seedScores: Array<{ stem: string; kind: string; is_leaf: boolean; seed: number; lex: number; cos: number | null }>;
}

export interface HierarchicalResult {
	ok: boolean;
	/** Present when ok:false (caller decides the fallback). */
	reason?: string;
	cards: HierarchicalCard[];
	trace?: HierarchicalTrace;
}

// ---------------------------------------------------------------------------
// Pure scoring core (unit-testable offline — no Surreal)
// ---------------------------------------------------------------------------

export function hierTokenize(query: string): string[] {
	return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/g).filter((t) => t.length >= 2))].slice(0, 8);
}

/** Seed blend, mirroring the retrieveRecords semantic blend: α·lexRankNorm +
 *  (1−α)·cosNorm. lexRankNorm ranks the pool by lexical score (stem-sorted
 *  ties): (N−r)/N for matched cards, 0 for semantic-only cards. Pure. */
export function blendSeedScores(
	pool: Array<{ stem: string; lex: number; cos: number | null }>,
	alpha = SEMANTIC_ALPHA_DEFAULT,
): Map<string, number> {
	const byLex = [...pool].sort((a, b) => b.lex - a.lex || (a.stem < b.stem ? -1 : 1));
	const lexRankNorm = new Map<string, number>();
	byLex.forEach((p, r) => lexRankNorm.set(p.stem, p.lex > 0 ? (byLex.length - r) / byLex.length : 0));
	const cosNorm = minMaxNorm(pool.map((p) => p.cos ?? Math.min(...pool.map((q) => q.cos ?? 0))));
	const out = new Map<string, number>();
	pool.forEach((p, i) => out.set(p.stem, alpha * (lexRankNorm.get(p.stem) ?? 0) + (1 - alpha) * (cosNorm[i] ?? 0)));
	return out;
}

export interface PropagateRow {
	stem: string;
	is_leaf: boolean;
}

/**
 * Downward max-propagation (D20). `childrenOf` maps agg stem → child stems.
 * Returns best score per stem + the set of stems whose best score arrived via
 * propagation. Deterministic: expansion order is score desc / stem asc.
 * Pure — the DB layer only supplies adjacency.
 */
export function propagateScores(
	childrenOf: ReadonlyMap<string, readonly string[]>,
	rowsByStem: ReadonlyMap<string, PropagateRow & { seed: number }>,
	gamma: number,
	maxSweeps = 3,
): { best: Map<string, number>; viaTree: Set<string>; sweeps: number; expanded: number } {
	const best = new Map<string, number>();
	for (const [stem, r] of rowsByStem) best.set(stem, r.seed);
	const viaTree = new Set<string>();
	// Seed the frontier with agg nodes that HAVE children (leaves never expand).
	const frontier: Array<{ stem: string; score: number }> = [];
	for (const [stem, r] of rowsByStem) {
		if (!r.is_leaf && childrenOf.has(stem)) frontier.push({ stem, score: best.get(stem) ?? 0 });
	}
	let sweeps = 0;
	let expanded = 0;
	let active = frontier.sort((a, b) => b.score - a.score || (a.stem < b.stem ? -1 : 1));
	while (active.length > 0 && sweeps < maxSweeps) {
		sweeps++;
		const next: Array<{ stem: string; score: number }> = [];
		for (const node of active) {
			expanded++;
			for (const child of childrenOf.get(node.stem) ?? []) {
				const crow = rowsByStem.get(child);
				if (!crow) continue; // child not in the index row set
				const cand = gamma * (best.get(node.stem) ?? 0);
				if (cand > (best.get(child) ?? 0)) {
					best.set(child, cand);
					viaTree.add(child);
				}
				if (!crow.is_leaf && childrenOf.has(child)) next.push({ stem: child, score: best.get(child) ?? 0 });
			}
		}
		active = next.sort((a, b) => b.score - a.score || (a.stem < b.stem ? -1 : 1));
	}
	return { best, viaTree, sweeps, expanded };
}

// ---------------------------------------------------------------------------
// SurrealDB-facing retrieval
// ---------------------------------------------------------------------------

interface SeedRow {
	stem: string;
	path: string;
	title: string;
	kind: string;
	is_leaf: boolean;
	parent: string | null;
	summary: string;
	sim?: number;
}

export async function hierarchicalRetrieve(
	client: SurrealClient,
	opts: HierarchicalOptions,
): Promise<HierarchicalResult> {
	const topK = opts.topK ?? 10;
	const seedTopN = opts.seedTopN ?? 24;
	const efSearch = opts.efSearch ?? 100;
	const gamma = opts.gamma ?? 0.5;
	const maxSweeps = opts.maxSweeps ?? 3;
	const tokens = hierTokenize(opts.query);

	const byStem = new Map<string, SeedRow>();
	const cosByStem = new Map<string, number>();
	let semanticLane = false;

	// Semantic seed lane: one KNN hop over the single card table. embedQuery
	// degrades to null when the embedder/endpoint is down — lexical-only seeds.
	const qv = await embedQuery(opts.query, opts.model, opts.embedder);
	if (qv) {
		try {
			const rows = await client.query<SeedRow[]>(
				`SELECT stem, path, title, kind, is_leaf, parent, summary, vector::similarity::cosine(vec, $qv) AS sim FROM card WHERE vec <|${seedTopN},${efSearch}|> $qv;`,
				{ qv },
			);
			semanticLane = (rows ?? []).length > 0;
			for (const r of rows ?? []) {
				byStem.set(r.stem, r);
				if (typeof r.sim === "number") cosByStem.set(r.stem, r.sim);
			}
		} catch {
			// index down / no vec column — lexical-only seeds
		}
	}

	// Lexical seed lane: per-token FTS (AND-only analyzer, P6), merged client-side.
	const lexHits = new Map<string, number>();
	for (const tok of tokens) {
		try {
			const rows = await client.query<SeedRow[]>(
				"SELECT stem, path, title, kind, is_leaf, parent, summary FROM card WHERE title @@ $tok OR summary @@ $tok;",
				{ tok },
			);
			for (const r of rows ?? []) {
				if (!byStem.has(r.stem)) byStem.set(r.stem, r);
				lexHits.set(r.stem, (lexHits.get(r.stem) ?? 0) + 1);
			}
		} catch {
			// FTS lane unavailable for this token — skip it
		}
	}

	if (byStem.size === 0) {
		return {
			ok: false,
			reason: tokens.length === 0 && !semanticLane ? "empty-query" : "no-seeds",
			cards: [],
			trace: opts.includeTrace
				? { semanticLane, tokens, seedPool: 0, seededAgg: 0, expandedNodes: 0, childQueries: 0, sweeps: 0, typeFilter: opts.type ?? null, seedScores: [] }
				: undefined,
		};
	}

	// Seed blend (α over the union pool).
	const pool = [...byStem.values()].map((r) => ({
		stem: r.stem,
		lex: tokens.length > 0 ? (lexHits.get(r.stem) ?? 0) / tokens.length : 0,
		cos: cosByStem.has(r.stem) ? (cosByStem.get(r.stem) as number) : null,
	}));
	const seeds = blendSeedScores(pool);
	const rowsByStem = new Map(
		pool.map((p) => [
			p.stem,
			{ stem: p.stem, is_leaf: byStem.get(p.stem)!.is_leaf, seed: seeds.get(p.stem) ?? 0 },
		]),
	);

	// Adjacency for expansion (D20, reviewer F1 fix): level-batched BFS from
	// every seeded agg node — ONE `WHERE parent IN $stems` query per LEVEL,
	// repeated to maxSweeps, so propagation reaches through UNSEEDED
	// intermediate aggs (a seeded L2 whose L1 children never matched the query
	// still surfaces the subtree below them). Children outside the seed pool
	// get their metadata in ONE batched `stem IN $missing` query per level.
	const childrenOf = new Map<string, string[]>();
	let childQueries = 0;
	let frontier = [...rowsByStem.values()].filter((r) => !r.is_leaf).map((r) => r.stem);
	const seenAgg = new Set(frontier);
	for (let depth = 0; depth < maxSweeps && frontier.length > 0; depth++) {
		let kidsByParent: Array<{ stem: string; parent: string | null; is_leaf: boolean }> = [];
		try {
			kidsByParent = await client.query<Array<{ stem: string; parent: string | null; is_leaf: boolean }>>(
				"SELECT stem, parent, is_leaf FROM card WHERE parent IN $stems;",
				{ stems: [...frontier].sort() },
			);
			childQueries++;
		} catch {
			break; // expansion lane unavailable — evaluate what we already have
		}
		const missingMeta = new Set<string>();
		for (const k of kidsByParent ?? []) {
			const list = childrenOf.get(k.parent as string) ?? [];
			list.push(k.stem);
			childrenOf.set(k.parent as string, list);
			if (!rowsByStem.has(k.stem)) missingMeta.add(k.stem);
		}
		if (missingMeta.size > 0) {
			try {
				const rows = await client.query<SeedRow[]>(
					"SELECT stem, path, title, kind, is_leaf, parent, summary FROM card WHERE stem IN $stems;",
					{ stems: [...missingMeta].sort() },
				);
				for (const r of rows ?? []) {
					byStem.set(r.stem, r);
					rowsByStem.set(r.stem, { stem: r.stem, is_leaf: r.is_leaf, seed: 0 });
				}
			} catch {
				// metadata fetch failed — stubs below keep them propagatable
				for (const stem of missingMeta) {
					if (!rowsByStem.has(stem)) rowsByStem.set(stem, { stem, is_leaf: true, seed: 0 });
				}
			}
		}
		const next: string[] = [];
		for (const k of kidsByParent ?? []) {
			const row = rowsByStem.get(k.stem);
			if (row && !row.is_leaf && !seenAgg.has(k.stem)) {
				seenAgg.add(k.stem);
				next.push(k.stem);
			}
		}
		frontier = next.sort();
	}

	const seededAgg = [...rowsByStem.values()].filter((r) => !r.is_leaf).length;
	const { best, viaTree, sweeps, expanded } = propagateScores(childrenOf, rowsByStem, gamma, maxSweeps);

	// Leaves only (D18 default), optional typed filter, deterministic order.
	// Metadata-less stubs (batched fetch failed) are dropped — unrankable.
	const leaves = [...rowsByStem.values()]
		.filter((r) => r.is_leaf && byStem.has(r.stem))
		.map((r) => {
			const meta = byStem.get(r.stem)!;
			return { meta, score: best.get(r.stem) ?? 0, tree: viaTree.has(r.stem) };
		})
		.filter((x) => !opts.type || x.meta.kind === opts.type)
		.sort((a, b) => b.score - a.score || (a.meta.stem < b.meta.stem ? -1 : 1))
		.slice(0, topK);

	return {
		ok: true,
		cards: leaves.map((x) => ({
			stem: x.meta.stem,
			path: x.meta.path,
			title: x.meta.title,
			kind: x.meta.kind,
			score: Number(x.score.toFixed(6)),
			viaTree: x.tree,
			summary: x.meta.summary,
		})),
		trace: opts.includeTrace
			? {
					semanticLane,
					tokens,
					seedPool: byStem.size,
					seededAgg,
					expandedNodes: expanded,
					childQueries,
					sweeps,
					typeFilter: opts.type ?? null,
					seedScores: pool.map((p) => ({
						stem: p.stem,
						kind: byStem.get(p.stem)!.kind,
						is_leaf: byStem.get(p.stem)!.is_leaf,
						seed: Number((seeds.get(p.stem) ?? 0).toFixed(6)),
						lex: Number(p.lex.toFixed(3)),
						cos: p.cos === null ? null : Number(p.cos.toFixed(6)),
					})),
				}
			: undefined,
	};
}
