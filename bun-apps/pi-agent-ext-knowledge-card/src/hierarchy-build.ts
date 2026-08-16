/**
 * src/hierarchy-build.ts — zk-side buildHierarchy orchestration (effort
 * 2026-08-16-leanrag-hierarchy-port, ticket 04a; LeanRAG ① seam method).
 *
 * Drives hierarchy.ts's per-layer `buildLayer` stack over `kbDir`:
 *
 *   readCheckpoint(layer) → hit? skip the layer (resume, D2)
 *                        : buildLayer → writeAggregationMocs(nodes)
 *                        → writeCheckpoint → next layer, feeding the layer's
 *                          nodes back in as pseudo-cards (id/text/entities/
 *                          sources — text = summary).
 *
 * Stops on buildLayer's `done` flag (≤4 nodes / depth cap). The loop is PURE:
 * imports only hierarchy.ts + aggregation-write.ts — the embedder and
 * summarizer are injected callables (D4), so no store/vector-DB/LLM client
 * dependency lives here.
 *
 * Library only — no ExtensionAPI, no network, no console.
 */
import {
	buildLayer,
	readCheckpoint,
	writeCheckpoint,
	type AggregationNode,
	type HierarchyCard,
} from "./hierarchy.ts";
import { writeAggregationMocs } from "./aggregation-write.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";

export interface HierarchyBuildOptions {
	kbDir: string;
	cards: { id: string; text: string; entities: string[]; sources?: string[] }[];
	embedFn(texts: string[]): Promise<number[][]>;
	summarizeFn(clusterText: string, budget: number): Promise<string>;
	tokenBudget?: number;
	threshold?: number;
	maxDepth?: number;
}

export interface HierarchyBuildResult {
	layers: number;
	nodes: { id: string; parentOf: string[]; entities: string[]; sources: string[]; summary: string; layer: number; clusterSize: number }[];
	llmCalls: number;
	resumed: boolean;
	skipped?: string;
}

/** One layer's checkpoint payload (D2 shape — mirrors hierarchy.test.ts). */
interface LayerCheckpoint {
	nodes: AggregationNode[];
	llmCalls: number;
	done: boolean;
}

/** Node → pseudo-card for the next layer up (text = summary). */
function nodeToCard(n: AggregationNode): HierarchyCard {
	return { id: n.id, text: n.summary, entities: n.entities, sources: n.sources };
}

/** Flatten one frontmatter list entry: a plain name string, an object-ish
 *  `{type, name}` entry, or a raw "name: y" line — always resolve to a name. */
function flattenEntry(entry: unknown): string | null {
	if (typeof entry === "string") {
		const m = /(?:^|\n)\s*name:\s*(.+)$/m.exec(entry);
		return (m ? m[1] : entry).trim() || null;
	}
	if (entry && typeof entry === "object") {
		const name = (entry as Record<string, unknown>).name;
		if (typeof name === "string" && name.trim()) return name.trim();
	}
	return null;
}

function flattenList(value: unknown): string[] {
	if (!Array.isArray(value)) return typeof value === "string" && value.trim() ? [value.trim()] : [];
	return value.map(flattenEntry).filter((s): s is string => s !== null);
}

/** Load HierarchyCards from kbDir's *.md files (agg-L*-* MoCs skipped).
 *  Entities/sources come from frontmatter, extracted defensively — entries
 *  may be name strings or `{type, name}`-ish objects depending on the writer. */
async function loadKbCards(kbDir: string): Promise<HierarchyCard[]> {
	const files = (await readdir(kbDir)).filter(
		(f) => f.endsWith(".md") && !/^agg-L\d+-\d+\.md$/.test(f),
	);
	const cards: HierarchyCard[] = [];
	for (const file of files) {
		const raw = await readFile(join(kbDir, file), "utf8");
		const { data, bodyStart } = parseFrontmatter(raw);
		const entities = flattenList(data.entities);
		if (entities.length === 0) continue;
		const id =
			typeof data.id === "string" && data.id ? data.id : file.replace(/\.md$/, "");
		cards.push({
			id,
			text: raw.slice(bodyStart).trim(),
			entities,
			sources: [id, ...flattenList(data.sources ?? data.contentHash)].filter(
				(v, i, a) => v !== "" && a.indexOf(v) === i,
			),
		});
	}
	return cards;
}

/**
 * Build the full aggregation hierarchy over `opts.cards` into `opts.kbDir`.
 * Resume-safe (per-layer checkpoints), budget-gated end-to-end (D6 — llmCalls
 * stays 0 while every cluster is under `tokenBudget`), and returns the union
 * of all layers' nodes. Empty cards / no entities anywhere → `skipped:
 * "no-entities"` (nothing to aggregate).
 */
export async function buildHierarchy(opts: HierarchyBuildOptions): Promise<HierarchyBuildResult> {
	const cards = opts.cards ?? (await loadKbCards(opts.kbDir));
	if (cards.length === 0 || cards.every((c) => c.entities.length === 0)) {
		return { layers: 0, nodes: [], llmCalls: 0, resumed: false, skipped: "no-entities" };
	}
	const tokenBudget = opts.tokenBudget ?? 10_000;
	const maxDepth = opts.maxDepth ?? 3;
	const all: AggregationNode[] = [];
	let llmCalls = 0;
	let resumed = false;
	let current: HierarchyCard[] = cards;
	for (let depth = 0; depth <= maxDepth; depth++) {
		const ckpt = (await readCheckpoint(opts.kbDir, depth)) as LayerCheckpoint | null;
		if (ckpt && Array.isArray(ckpt.nodes)) {
			// D2 resume: this layer already completed on disk — skip the build
			// (no embed / summarize cost) and climb from its checkpointed nodes.
			resumed = true;
			all.push(...ckpt.nodes);
			if (ckpt.done) break;
			current = ckpt.nodes.map(nodeToCard);
			continue;
		}
		const r = await buildLayer({
			cards: current,
			embedFn: opts.embedFn,
			summarizeFn: opts.summarizeFn,
			tokenBudget,
			threshold: opts.threshold,
			maxDepth,
			currentDepth: depth,
		});
		// Materialize with the full accumulated set so parent links (and the
		// stale-prune) see the complete tree; the final pass after the last
		// layer leaves every agg card byte-correct.
		writeAggregationMocs({ kbDir: opts.kbDir, nodes: [...all, ...r.nodes] });
		await writeCheckpoint(opts.kbDir, depth, { nodes: r.nodes, llmCalls: r.llmCalls, done: r.done });
		all.push(...r.nodes);
		llmCalls += r.llmCalls;
		if (r.done) break;
		current = r.nodes.map(nodeToCard);
	}
	const layers = new Set(all.map((n) => n.layer)).size;
	return { layers, nodes: all, llmCalls, resumed };
}
