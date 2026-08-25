/**
 * src/resource-recursive.ts — the directory-recursive retrieval lane over the
 * resource tier (effort 2026-08-25-kcard-resource-tier, ticket 03, map D6).
 *
 * The upstream OpenViking heap algorithm (hierarchical_retriever.py
 * `_recursive_search`), adapted to this schema:
 *
 *   1. SEED — a global pass over the level 0/1 tier rows ranks directories
 *      against the query and seeds a best-first max-heap. Tier rows are few
 *      (O(directories), 4 on USB4), so this pass is an exact scan with the
 *      cosine computed in the SELECT — the exact-KNN limit at tier scale, no
 *      HNSW predicate ladder to fall through (the v3.2.3 combined-predicate
 *      trap resourceKnnQuery guards against cannot fire here). Seeds enqueue
 *      ONLY (upstream shape, reviewer S2): a tier row joins the hit pool as a
 *      descent child of its parent directory — with a propagated score, never
 *      an unmixed raw one that displaces file hits.
 *   2. DESCENT — pop ≤4 directories per round (upstream
 *      MAX_PARALLEL_CHILD_SEARCHES), fetch their direct children scoped
 *      `WHERE tree = $t AND parent = $p` (plain resource_parent index; cosine
 *      again computed in the SELECT so vectors never cross the wire), keep the
 *      top max(2·limit, 20) per directory (upstream's search_children limit).
 *   3. PROPAGATE — every child's final score is `α·childSim + (1−α)·dirScore`
 *      (upstream's score_propagation_alpha; when the parent score is 0 the raw
 *      child sim rides, the upstream `if current_score` quirk kept verbatim).
 *      Only L0/L1 children re-enqueue — L2 files are terminal hits.
 *   4. CONVERGE — stop after 3 rounds with an unchanged top-limit set, 3
 *      stagnant rounds (pool not growing), or a drained heap.
 *
 * Client-side like the card lane's D20 BFS (Surreal server-side recursion
 * times out — parity build fact). Deterministic: every sort breaks ties by
 * tree then uri ascending, so a fixture run is byte-stable.
 *
 * Library only — no ExtensionAPI, no LLM, no fs (the CLI owns tiered loading).
 */
import type { SurrealClient } from "@repo/s2-agent-core-interface";
import { embedQuery, type Embedder } from "./semantic.ts";
import { ABSTRACT_SIDEFILE, OVERVIEW_SIDEFILE } from "./resource-tiers.ts";
import { RESOURCE_LEVEL_FILE, type ResourceHit } from "./resource-index.ts";

/** Upstream constants, kept by name. */
export const RECURSIVE_MAX_CONVERGENCE_ROUNDS = 3;
export const RECURSIVE_MAX_PARALLEL_CHILD_SEARCHES = 4;
/** α default for THIS lane (ticket 03). Upstream's own config default is 1.0
 *  (child-only propagation, `retrieval_config.py`); 0.5 is the ticket's
 *  measured starting point — re-measured in ticket 04's eval. */
export const RECURSIVE_DEFAULT_ALPHA = 0.5;
/** Upstream default threshold: scores must be strictly > 0 to survive. */
const RECURSIVE_THRESHOLD = 0;

export interface RecursiveHit extends ResourceHit {
	/** The child's own cosine before propagation — with `sim` holding the
	 *  propagated final score, `sim === alpha*rawSim + (1-alpha)*dirScore` is
	 *  inspectable on every hit (the propagation-arithmetic receipt). */
	rawSim: number;
	/** The tree the hit lives in (heap entries carry it; hits expose it). */
	tree: string;
	/** Descent path that produced the hit: the seed tier row's uri, then every
	 *  tier row uri descended through, then this hit's own uri — which path
	 *  produced each hit (ticket 03's trajectory contract). */
	trajectory: string[];
}

export interface RecursiveQueryResult {
	tree: string | null;
	query: string;
	semantic: boolean;
	alpha: number;
	hits: RecursiveHit[];
	/** Tier rows the seed pass ranked above threshold. */
	seedCount: number;
	/** Descent rounds executed (each pops ≤4 directories). */
	rounds: number;
	/** Distinct directories expanded (visited). */
	expandedDirs: number;
	/** Scoped child queries issued (one per expanded directory). */
	childSearches: number;
	/** Why the loop stopped — the convergence-bound receipt. */
	stop: "converged" | "stagnant" | "drained";
	elapsedMs: number;
}

/** One heap entry: a directory to expand, reached via `rowPath` tier rows. */
interface HeapEntry {
	score: number;
	tree: string;
	/** Tree-relative directory path ("" = tree root) — children have
	 *  `parent === dir` (null for the root). */
	dir: string;
	/** Tier row uris from the seed to the row that named this directory. */
	rowPath: string[];
}

/** The directory a tier sidecar row describes: `pages/.overview.md` → "pages",
 *  the root sidecar → "". Non-sidecar uris map to their own dirname (defensive
 *  — only level<2 rows are ever enqueued). */
export function describedDirOf(uri: string): string {
	for (const side of [OVERVIEW_SIDEFILE, ABSTRACT_SIDEFILE]) {
		if (uri === side) return "";
		if (uri.endsWith(`/${side}`)) return uri.slice(0, -side.length - 1);
	}
	const slash = uri.lastIndexOf("/");
	return slash === -1 ? "" : uri.slice(0, slash);
}

/** Best-first queue: highest score first, tree then dir ascending on ties
 *  (deterministic pop order — the heap-order tests pin it). */
class DirHeap {
	private entries: HeapEntry[] = [];

	push(e: HeapEntry): void {
		this.entries.push(e);
		this.entries.sort(
			(a, b) =>
				b.score - a.score ||
				(a.tree < b.tree ? -1 : a.tree > b.tree ? 1 : 0) ||
				(a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0),
		);
	}

	pop(): HeapEntry | undefined {
		return this.entries.shift();
	}

	get size(): number {
		return this.entries.length;
	}
}

type SelectRow = {
	tree?: string;
	uri: string;
	name: string;
	abstract: string;
	level: number;
	parent: string | null;
	sim?: number;
};

function finite(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * The recursive lane. Mirrors resourceKnnQuery's degrade contract: embedder
 * down → `semantic:false` with empty hits; a Surreal failure mid-descent ends
 * the loop early with what was collected — never throws at the caller.
 */
export async function resourceRecursiveQuery(args: {
	client: SurrealClient;
	query: string;
	tree?: string;
	topK?: number;
	model?: string;
	embedder?: Embedder;
	/** Score propagation α (default 0.5; measured 0.3/0.5/0.7 in ticket 03). */
	alpha?: number;
	/** Max result level (upstream's `level` collection filter): rows above it
	 *  are skipped at COLLECTION time — the top-k is drawn from the filtered
	 *  pool, so a tier-capped query never starves the way a post-hoc filter
	 *  on a sliced top-k does (reviewer S1). Descent still runs through every
	 *  level — this shapes RESULTS, not the walk. */
	maxLevel?: number;
}): Promise<RecursiveQueryResult> {
	const started = Date.now();
	const limit = Math.max(1, Math.floor(args.topK ?? 10));
	const alpha = args.alpha ?? RECURSIVE_DEFAULT_ALPHA;
	const base: Omit<RecursiveQueryResult, "hits" | "seedCount" | "rounds" | "expandedDirs" | "childSearches" | "stop" | "elapsedMs"> = {
		tree: args.tree ?? null,
		query: args.query,
		semantic: false,
		alpha,
	};

	const qv = await embedQuery(args.query, args.model, args.embedder);
	if (!qv) {
		return { ...base, hits: [], seedCount: 0, rounds: 0, expandedDirs: 0, childSearches: 0, stop: "drained", elapsedMs: Date.now() - started };
	}

	// ── 1. Seed pass: exact scan over the tier rows ──────────────────────────
	// Seeds enqueue only (upstream shape, reviewer S2) — a tier row joins the
	// hit pool as a descent child of its parent directory, with a propagated
	// score. The seed row's uri is the root of every descent trajectory.
	const heap = new DirHeap();
	const collected = new Map<string, RecursiveHit>();
	let seedCount = 0;
	try {
		const treeFilter = args.tree ? ` AND tree = ${JSON.stringify(args.tree)}` : "";
		const seeds = await args.client.query<SelectRow[]>(
			`SELECT tree, uri, name, abstract, level, parent, vector::similarity::cosine(vec, $qv) AS sim FROM resource WHERE level IN [0, 1]${treeFilter};`,
			{ qv },
		);
		const ranked = (seeds ?? [])
			.filter((r) => r && r.uri && (!args.tree || r.tree === args.tree))
			.map((r) => ({ row: r, sim: finite(r.sim) }))
			.filter((s) => s.sim > RECURSIVE_THRESHOLD)
			.sort((a, b) => b.sim - a.sim || (a.row.uri < b.row.uri ? -1 : 1));
		for (const { row, sim } of ranked) {
			seedCount++;
			heap.push({ score: sim, tree: row.tree ?? args.tree ?? "", dir: describedDirOf(row.uri), rowPath: [row.uri] });
		}
	} catch {
		// seed pass failed — same contract as the flat lane: the index could
		// not be queried at all, so semantic:false (reviewer N3), never a
		// misleading "index may be empty".
		return { ...base, semantic: false, hits: [], seedCount: 0, rounds: 0, expandedDirs: 0, childSearches: 0, stop: "drained", elapsedMs: Date.now() - started };
	}

	// ── 2–4. Best-first descent with propagation + convergence ───────────────
	const visited = new Set<string>(); // `${tree}\0${dir}`
	const childLimit = Math.max(limit * 2, 20);
	let rounds = 0;
	let expandedDirs = 0;
	let childSearches = 0;
	let convergenceRounds = 0;
	let stagnantRounds = 0;
	let prevTopkKeys = new Set<string>();
	let prevPoolSize = 0;
	let stop: RecursiveQueryResult["stop"] = "drained";

	while (heap.size > 0) {
		// Pop this round's batch — visited dirs are skipped WITHOUT counting
		// against the batch size (upstream's `if current_uri in visited`).
		const batch: HeapEntry[] = [];
		while (heap.size > 0 && batch.length < RECURSIVE_MAX_PARALLEL_CHILD_SEARCHES) {
			const e = heap.pop()!;
			const key = `${e.tree}\0${e.dir}`;
			if (visited.has(key)) continue;
			visited.add(key);
			batch.push(e);
		}
		if (batch.length === 0) continue;
		rounds++;

		for (const entry of batch) {
			expandedDirs++;
			childSearches++;
			let children: SelectRow[];
			try {
				// The tree root's children carry parent null; a `parent = ''`
				// predicate would never match them.
				const parentPred = entry.dir === "" ? "parent IS NULL" : `parent = ${JSON.stringify(entry.dir)}`;
				const rows = await args.client.query<SelectRow[]>(
					`SELECT tree, uri, name, abstract, level, parent, vector::similarity::cosine(vec, $qv) AS sim FROM resource WHERE tree = ${JSON.stringify(entry.tree)} AND ${parentPred};`,
					{ qv },
				);
				children = rows ?? [];
			} catch {
				continue; // this directory's expansion failed — the rest of the descent rides
			}
			const ranked = children
				.filter((r) => r && r.uri)
				.map((r) => ({ row: r, sim: finite(r.sim) }))
				.sort((a, b) => b.sim - a.sim || (a.row.uri < b.row.uri ? -1 : 1))
				.slice(0, childLimit);

			for (const { row, sim } of ranked) {
				// Upstream propagation quirk, kept verbatim: a zero parent
				// score propagates the raw child score unmixed.
				const final = entry.score > 0 ? alpha * sim + (1 - alpha) * entry.score : sim;
				if (!(final > RECURSIVE_THRESHOLD)) continue;
				const key = `${entry.tree}/${row.uri}`;
				if (args.maxLevel === undefined || row.level <= args.maxLevel) {
					const previous = collected.get(key);
					if (previous === undefined || final > previous.sim) {
						collected.set(key, {
							uri: row.uri,
							name: row.name,
							abstract: row.abstract,
							level: row.level,
							parent: row.parent ?? null,
							sim: final,
							rawSim: sim,
							tree: entry.tree,
							trajectory: [...entry.rowPath, row.uri],
						});
					}
				}
				// Only L0/L1 children re-enqueue — L2 files are terminal.
				if (row.level !== RESOURCE_LEVEL_FILE && !visited.has(`${entry.tree}\0${describedDirOf(row.uri)}`)) {
					heap.push({
						score: final,
						tree: entry.tree,
						dir: describedDirOf(row.uri),
						rowPath: [...entry.rowPath, row.uri],
					});
				}
			}
		}

		// Convergence check after each round (upstream logic, including the
		// only-on-progress reset of the previous markers).
		const topk = [...collected.values()].sort((a, b) => b.sim - a.sim || (a.uri < b.uri ? -1 : 1)).slice(0, limit);
		const topkKeys = new Set(topk.map((h) => `${h.tree}/${h.uri}`));
		if (setsEqual(topkKeys, prevTopkKeys) && topkKeys.size >= limit) {
			convergenceRounds++;
			if (convergenceRounds >= RECURSIVE_MAX_CONVERGENCE_ROUNDS) {
				stop = "converged";
				break;
			}
		} else if (collected.size === prevPoolSize) {
			stagnantRounds++;
			if (stagnantRounds >= RECURSIVE_MAX_CONVERGENCE_ROUNDS) {
				stop = "stagnant";
				break;
			}
		} else {
			convergenceRounds = 0;
			stagnantRounds = 0;
			prevTopkKeys = topkKeys;
			prevPoolSize = collected.size;
		}
	}

	const hits = [...collected.values()]
		.sort((a, b) => b.sim - a.sim || (a.uri < b.uri ? -1 : 1))
		.slice(0, limit);
	return {
		...base,
		semantic: true,
		hits,
		seedCount,
		rounds,
		expandedDirs,
		childSearches,
		stop,
		elapsedMs: Date.now() - started,
	};
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const k of a) if (!b.has(k)) return false;
	return true;
}
