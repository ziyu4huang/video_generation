/**
 * lib/graphExport.ts — pure functions converting a VaultIndex into
 * portable graph formats for external rendering (Obsidian Graph / D3 /
 * Graphviz / Mermaid live). No I/O.
 *
 * Usage:
 *   import { getIndex } from "../extensions/obsidian.ts";
 *   import { toGraphJSON, toDOT, toMermaid } from "../lib/graphExport.ts";
 *   const idx = await getIndex("./vault");
 *   console.log(toMermaid(idx));
 */
import type { VaultIndex } from "../extensions/obsidian.ts";
import { resolveWikiLink } from "../extensions/obsidian.ts";

export interface GraphNode {
	id: string;       // vault-relative path without .md
	title: string;    // human title (original case if recoverable)
	tags: string[];
	created?: string;
	path: string;     // vault-relative path with .md
}

export interface GraphEdge {
	source: string;   // node id (path without .md)
	target: string;   // node id (resolved path without .md)
}

export interface GraphJSON {
	nodes: GraphNode[];
	edges: GraphEdge[];
	stats: { nodeCount: number; edgeCount: number; orphans: number };
}

/** Strip a trailing .md and lowercase (matches index key convention). */
function nodeId(path: string): string {
	return path.replace(/\.md$/i, "");
}

/** Convert a VaultIndex into a plain { nodes, edges } structure. */
export function toGraphJSON(idx: VaultIndex): GraphJSON {
	const nodes: GraphNode[] = [];
	for (const [path, meta] of idx.notes) {
		nodes.push({
			id: nodeId(path),
			// meta.title is lowercased in the index; recover a readable title
			// from the basename when possible.
			title: meta.title || basename(path),
			tags: meta.tags,
			created: meta.created,
			path,
		});
	}

	const edges: GraphEdge[] = [];
	const seen = new Set<string>();
	for (const [srcPath, meta] of idx.notes) {
		const src = nodeId(srcPath);
		for (const link of meta.links) {
			const resolved = resolveWikiLink(idx, link);
			const target = resolved ? nodeId(resolved) : nodeId(link);
			const key = `${src}\u0001${target}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ source: src, target });
		}
	}

	// orphans = nodes with no incoming or outgoing edges (resolved)
	const touched = new Set<string>();
	for (const e of edges) { touched.add(e.source); touched.add(e.target); }
	const orphans = nodes.filter((n) => !touched.has(n.id)).length;

	return { nodes, edges, stats: { nodeCount: nodes.length, edgeCount: edges.length, orphans } };
}

/** Escape a string for DOT label safety. */
function dotEscape(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Convert a VaultIndex into a Graphviz DOT digraph string. */
export function toDOT(idx: VaultIndex): string {
	const g = toGraphJSON(idx);
	const lines: string[] = ["digraph vault {", '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
	for (const n of g.nodes) {
		const label = n.tags.length ? `${dotEscape(n.title)}\\n#${n.tags.join(" #")}` : dotEscape(n.title);
		lines.push(`  "${dotEscape(n.id)}" [label="${label}"];`);
	}
	for (const e of g.edges) {
		lines.push(`  "${dotEscape(e.source)}" -> "${dotEscape(e.target)}";`);
	}
	lines.push("}");
	return lines.join("\n");
}

/** Mermaid node ids must be alphanumeric/safe; map each id to a stable token. */
function mermaidSafeKey(id: string): string {
	// Mermaid allows letters, digits, underscore, hyphen, parens-free.
	return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Escape node display text for Mermaid (avoid `]` breaking the label). */
function mermaidLabel(s: string): string {
	return s.replace(/]/g, "&#93;");
}

/** Convert a VaultIndex into a Mermaid `graph TD` string. */
export function toMermaid(idx: VaultIndex): string {
	const g = toGraphJSON(idx);
	const lines: string[] = ["graph TD"];
	// Stable ordering for diff-friendliness: sort by id.
	const keyOf = new Map<string, string>();
	const sortedNodes = [...g.nodes].sort((a, b) => a.id.localeCompare(b.id));
	for (const n of sortedNodes) {
		const key = mermaidSafeKey(n.id);
		keyOf.set(n.id, key);
		lines.push(`  ${key}["${mermaidLabel(n.title)}"]`);
	}
	const sortedEdges = [...g.edges].sort((a, b) =>
		a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
	for (const e of sortedEdges) {
		const s = keyOf.get(e.source) ?? mermaidSafeKey(e.source);
		const t = keyOf.get(e.target) ?? mermaidSafeKey(e.target);
		lines.push(`  ${s} --> ${t}`);
	}
	return lines.join("\n");
}

function basename(path: string): string {
	return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
}
