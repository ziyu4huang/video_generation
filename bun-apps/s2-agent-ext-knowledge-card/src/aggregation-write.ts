/**
 * src/aggregation-write.ts — materialize hierarchy aggregation nodes as
 * derived MOC cards (effort 2026-08-16-leanrag-hierarchy-port, ticket 03;
 * spec D7 multi-level tree).
 *
 * Each `AggregationNode` from hierarchy.ts's `buildLayer` stack becomes one
 * markdown file `agg-L<layer>-<i>.md` in the convergence folder:
 *
 *   ---
 *   id: "agg:<layer>:<i>"
 *   created: "auto"
 *   tags: [zettel, derived-aggregation]
 *   kind: derived-aggregation
 *   parent: "agg:<l+1>:<i>" | null     # null at the tree root
 *   entities: [<first-seen union>]     # child entity union carried upward
 *   sources: [<contentHash union>]     # lineage union carried upward
 *   layer: N
 *   clusterSize: N
 *   generated: true
 *   ---
 *
 * Body: summary (`## 摘要`) + child wikilinks (`## 子節點`) — cards link to
 * their slugified id, lower agg nodes to their `agg-L*` basename, so the
 * multi-level structure is walkable from any node in either direction.
 *
 * T2 derived semantics — never supersede user cards: (a) an existing file
 * that is NOT `kind: derived-aggregation` (a user card squatting an agg
 * basename) is refused, never overwritten; (b) the stale-file prune only ever
 * deletes derived files. md stays the canonical store — the whole tree is
 * regen-able from a rebuild.
 *
 * Idempotent: each target is read first and skipped when the rendered content
 * is byte-identical (mtime untouched) — re-running an unchanged build is a
 * no-op.
 *
 * Library only — no ExtensionAPI, no LLM, no network.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@repo/s2-agent-ext-obsidian";
import { slugify, yamlScalar } from "./card-format.ts";
import type { AggregationNode } from "./hierarchy.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WriteAggregationOptions {
	/** Absolute convergence folder the agg cards live in. */
	kbDir: string;
	/** The full multi-level node set (all layers of one build). */
	nodes: AggregationNode[];
	/** Compute-only pass: report would-be changes, write nothing. */
	dryRun?: boolean;
}

export interface WriteAggregationResult {
	/** Basenames written (created or content-changed). */
	written: string[];
	/** Basenames left untouched — byte-identical content already on disk. */
	skipped: string[];
	/** Basenames NOT written — the existing file is user-authored (T2 guard). */
	refused: string[];
	/** Basenames deleted — stale derived nodes absent from the incoming set. */
	deleted: string[];
}

// ---------------------------------------------------------------------------
// Id / link mapping
// ---------------------------------------------------------------------------

/** `agg:<layer>:<i>` → `agg-L<layer>-<i>` (on-disk basename, no `.md`).
 *  Non-agg ids fall back to the shared slugifier. */
export function aggBasename(nodeId: string): string {
	const m = /^agg:(\d+):(\d+)$/.exec(nodeId);
	return m ? `agg-L${m[1]}-${m[2]}` : slugify(nodeId);
}

/** Wikilink target for a child id: lower agg node → its basename, card →
 *  slugified id (the card filename convention from ingest). */
export function childLinkTarget(childId: string): string {
	return childId.startsWith("agg:") ? aggBasename(childId) : slugify(childId);
}

/** Parent node id — the node whose `parentOf` contains `node.id`; null at the
 *  root (no node above it in the incoming set). */
export function parentNodeId(node: AggregationNode, nodes: AggregationNode[]): string | null {
	return nodes.find((n) => n.parentOf.includes(node.id))?.id ?? null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** True when a file's frontmatter marks it as a derived aggregation card
 *  (the T2 ownership marker — user-authored files never match). */
export function isDerivedAggregation(content: string): boolean {
	try {
		const { data } = parseFrontmatter(content);
		return data?.kind === "derived-aggregation";
	} catch {
		return false;
	}
}

/** Render one aggregation node as a complete markdown card (deterministic —
 *  no timestamps, so identical nodes always render byte-identically). */
export function renderAggCard(node: AggregationNode, nodes: AggregationNode[]): string {
	const base = aggBasename(node.id);
	const parent = parentNodeId(node, nodes);
	const lines: string[] = [
		"---",
		`id: ${yamlScalar(node.id)}`,
		'created: "auto"',
		"tags: [zettel, derived-aggregation]",
		"kind: derived-aggregation",
		`parent: ${parent ? yamlScalar(parent) : "null"}`,
		`entities: [${node.entities.map((e) => yamlScalar(e)).join(", ")}]`,
		`sources: [${node.sources.map((s) => yamlScalar(s)).join(", ")}]`,
		`layer: ${node.layer}`,
		`clusterSize: ${node.clusterSize}`,
		"generated: true",
		"---",
		"",
		`# ${base}`,
		"",
		`> Derived aggregation node (layer ${node.layer}, cluster ${node.clusterSize}) — regenerated by the hierarchy build. Do not edit by hand.`,
		"",
		"## 摘要",
		"",
		node.summary,
		"",
		"## 子節點",
		"",
	];
	for (const child of node.parentOf) lines.push(`- [[${childLinkTarget(child)}]]`);
	lines.push("");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Materialize the full multi-level node set as derived MOC cards in
 *  `kbDir`. Idempotent per file (identical content → skip), T2-guarded (user
 *  cards refused, never superseded), and self-pruning (derived files whose
 *  node vanished from the incoming set are deleted). */
export function writeAggregationMocs(opts: WriteAggregationOptions): WriteAggregationResult {
	const result: WriteAggregationResult = { written: [], skipped: [], refused: [], deleted: [] };

	// Deterministic write order (basename sort), independent of nodes order.
	const desired = new Map<string, string>();
	for (const node of opts.nodes) desired.set(`${aggBasename(node.id)}.md`, renderAggCard(node, opts.nodes));
	const sorted = [...desired.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

	if (!opts.dryRun && sorted.length > 0) mkdirSync(opts.kbDir, { recursive: true });

	for (const name of sorted) {
		const content = desired.get(name)!;
		const abs = join(opts.kbDir, name);
		if (existsSync(abs)) {
			const prev = readFileSync(abs, "utf8");
			if (prev === content) {
				result.skipped.push(name);
				continue;
			}
			if (!isDerivedAggregation(prev)) {
				// T2: user-authored card squatting an agg basename — it wins.
				result.refused.push(name);
				continue;
			}
		}
		if (!opts.dryRun) writeFileSync(abs, content, "utf8");
		result.written.push(name);
	}

	// Stale prune: derived files absent from the incoming set go away (the
	// tree is T2 regen-able). The kind gate means a user-authored agg-named
	// file is NEVER deleted here.
	if (existsSync(opts.kbDir)) {
		for (const name of readdirSync(opts.kbDir).filter((n) => n.endsWith(".md")).sort()) {
			if (desired.has(name)) continue;
			const abs = join(opts.kbDir, name);
			if (!isDerivedAggregation(readFileSync(abs, "utf8"))) continue;
			if (!opts.dryRun) rmSync(abs);
			result.deleted.push(name);
		}
	}

	return result;
}
