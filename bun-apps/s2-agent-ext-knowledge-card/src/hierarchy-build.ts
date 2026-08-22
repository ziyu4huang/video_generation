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
 * Stops on buildLayer's `done` flag (≤4 nodes / depth cap). The loop is
 * PURE: imports only hierarchy.ts + aggregation-write.ts + llm-chat.ts — the
 * embedder stays an injected callable (D4) and the summarizer is injectable
 * too, with a chatJson-backed default (ticket 06) that degrades to a
 * deterministic truncation on ANY LLM failure (chatJson never throws). The
 * per-layer budget schedule (layerBudgetOf — halving, floor 1200) replaces
 * the old flat tokenBudget.
 *
 * Library only — no ExtensionAPI, no network, no console.
 */
import {
	buildLayer,
	readCheckpoint,
	writeCheckpoint,
	HIERARCHY_CHECKPOINT_VERSION,
	type AggregationNode,
	type HierarchyCard,
} from "./hierarchy.ts";
import { writeAggregationMocs } from "./aggregation-write.ts";
import { chatJson, type LmChatOptions } from "./llm-chat.ts";
import { HIERARCHY_DEFAULTS } from "./zk-task-config.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@repo/s2-agent-ext-obsidian";

export interface HierarchyBuildOptions {
	kbDir: string;
	cards?: { id: string; text: string; entities: string[]; sources?: string[]; file?: string }[];
	embedFn(texts: string[]): Promise<number[][]>;
	summarizeFn?: (clusterText: string, budget: number) => Promise<string>;
	/** Test-only injection threaded into the default summarizer's chatJson
	 *  call (deterministic `_fetchImpl`) — production callers omit it. */
	_chatOpts?: LmChatOptions;
	tokenBudget?: number;
	threshold?: number;
	maxDepth?: number;
	/** Hang-mode circuit-breaker K (ticket 02): consecutive empty/null
	 *  summarizeFn results tolerated per layer before further LLM summary
	 *  calls are skipped (default HIERARCHY_DEFAULTS.summaryBreaker = 3).
	 *  Threaded straight into buildLayer's input. */
	summaryBreaker?: number;
}

export interface HierarchyBuildResult {
	layers: number;
	nodes: { id: string; parentOf: string[]; entities: string[]; sources: string[]; summary: string; layer: number; clusterSize: number }[];
	llmCalls: number;
	resumed: boolean;
	skipped?: string;
	/** Checkpoints found on disk whose format version predates
	 * HIERARCHY_CHECKPOINT_VERSION — ignored (rebuilt, not resumed) so a
	 * version change never half-matches. 0 when every hit resumed. */
	staleCheckpoints: number;
}

/** One layer's checkpoint payload (D2 shape — mirrors hierarchy.test.ts).
 *  `v` stamps HIERARCHY_CHECKPOINT_VERSION; a mismatch on read = rebuild. */
interface LayerCheckpoint {
	v?: number;
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

/** Per-layer budget schedule (ticket 06; LeanRAG (max_depth−layer)×80 analog,
 *  chars-scaled): halve the base each level, floor 1200. Deterministic. */
export function layerBudgetOf(depth: number, base: number): number {
	return Math.max(1200, base >> depth);
}

/** chatJson-backed default cluster summary (ticket 06): one LM Studio call
 *  returning JSON {"summary"} (fenced json tolerated). Null / invalid /
 *  empty — any LLM failure — degrades to the deterministic truncation
 *  fallback. Exported for direct tests. */
export async function defaultSummary(
	clusterText: string,
	budget: number,
	chatOpts?: LmChatOptions,
): Promise<string> {
	const norm = clusterText.replace(/\s+/g, " ").trim();
	const parsed = await chatJson<{ summary: string }>(
		[
			"Summarize the following cluster of notes into one dense, information-rich paragraph.",
			'Respond with ONLY a JSON object: {"summary": "<your paragraph>"}',
			"---",
			clusterText,
		].join("\n"),
		(text) => {
			const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
			const j = JSON.parse((fence ? fence[1] : text).trim()) as { summary?: unknown };
			if (typeof j.summary !== "string" || !j.summary.trim()) throw new Error("missing summary");
			return { summary: j.summary.trim() };
		},
		chatOpts,
	);
	const summary = parsed?.summary?.trim();
	if (summary) return summary;
	return norm.length > budget ? `${norm.slice(0, Math.max(0, budget - 1))}…` : norm;
}

async function loadKbCards(kbDir: string): Promise<HierarchyCard[]> {
	const files = (await readdir(kbDir)).filter(
		(f) => f.endsWith(".md") && !/^agg-L\d+-\d+\.md$/.test(f),
	);
	const cards: HierarchyCard[] = [];
	for (const file of files) {
		const raw = await readFile(join(kbDir, file), "utf8");
		const { data, bodyStart } = parseFrontmatter(raw);
		// Entities: the typed frontmatter when the writer emitted it, else a
		// TAGS fallback (ticket 06 real-vault enabler): the vault's pre-P8
		// cards carry only `tags:`, and the structural `zettel` marker sits on
		// every card — dropped so a cluster head never starts with it.
		const entities = flattenList(data.entities).length
			? flattenList(data.entities)
			: flattenList(data.tags).filter((t) => t !== "zettel");
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
			file: file.replace(/\.md$/, ""),
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
		return { layers: 0, nodes: [], llmCalls: 0, resumed: false, skipped: "no-entities", staleCheckpoints: 0 };
	}
	// card id → file stem: agg child wikilinks must target the FILENAME (the
	// real vault title-slugs files while ids stay numeric — a bare-id link
	// resolves to nothing). Explicit opts.cards without `file` keep the
	// slugify(id) fallback in childLinkTarget.
	const childTargets = new Map(
		cards.filter((c) => c.file).map((c) => [c.id, c.file as string]),
	);
	const baseBudget = opts.tokenBudget ?? HIERARCHY_DEFAULTS.baseBudget;
	const maxDepth = opts.maxDepth ?? HIERARCHY_DEFAULTS.maxDepth;
	const threshold = opts.threshold ?? HIERARCHY_DEFAULTS.threshold;
	const summaryBreaker = opts.summaryBreaker ?? HIERARCHY_DEFAULTS.summaryBreaker;
	const all: AggregationNode[] = [];
	let llmCalls = 0;
	let resumed = false;
	let staleCheckpoints = 0;
	let current: HierarchyCard[] = cards;
	for (let depth = 0; depth <= maxDepth; depth++) {
		const raw = (await readCheckpoint(opts.kbDir, depth)) as LayerCheckpoint | null;
		// Version gate (ticket 06): a checkpoint written by an older format
		// version does NOT resume — its summaries/rendering predate the current
		// node shape, and resuming would half-match the tree. Rebuild instead.
		const ckpt = raw && raw.v === HIERARCHY_CHECKPOINT_VERSION && Array.isArray(raw.nodes) ? raw : null;
		if (raw && !ckpt) staleCheckpoints++;
		if (ckpt) {
			// D2 resume: this layer already completed on disk — skip the build
			// (no embed / summarize cost) and climb from its checkpointed nodes.
			resumed = true;
			all.push(...ckpt.nodes);
			if (ckpt.done) break;
			current = ckpt.nodes.map(nodeToCard);
			continue;
		}
		const budget = layerBudgetOf(depth, baseBudget);
		const r = await buildLayer({
			cards: current,
			embedFn: opts.embedFn,
			summarizeFn:
				opts.summarizeFn ??
				((text: string, b: number) => defaultSummary(text, b, opts._chatOpts)),
			tokenBudget: budget,
			threshold,
			maxDepth,
			currentDepth: depth,
			summaryBreaker,
		});
		// Materialize with the full accumulated set so parent links (and the
		// stale-prune) see the complete tree; the final pass after the last
		// layer leaves every agg card byte-correct.
		writeAggregationMocs({ kbDir: opts.kbDir, nodes: [...all, ...r.nodes], childTargets });
		await writeCheckpoint(opts.kbDir, depth, {
			v: HIERARCHY_CHECKPOINT_VERSION,
			nodes: r.nodes,
			llmCalls: r.llmCalls,
			done: r.done,
		});
		all.push(...r.nodes);
		llmCalls += r.llmCalls;
		if (r.done) break;
		current = r.nodes.map(nodeToCard);
	}
	const layers = new Set(all.map((n) => n.layer)).size;
	// FINAL materialization pass over the complete node set — also on a fully
	// resumed run (where the loop above never built a layer). Idempotent when
	// nothing changed (byte-identical files are skipped), but it re-renders
	// agg cards when the WRITER changed (e.g. the childTargets link fix) or a
	// resumed checkpoint's renderer drifted — the tree on disk always matches
	// the current renderer.
	writeAggregationMocs({ kbDir: opts.kbDir, nodes: all, childTargets });
	return { layers, nodes: all, llmCalls, resumed, staleCheckpoints };
}
