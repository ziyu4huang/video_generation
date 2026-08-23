/**
 * src/fs-surface.ts — OpenViking-style virtual-FS read surface (kcard-parity
 * ticket 05, D32–D35): deterministic browse ops (`ls` / `tree` / `find` /
 * `grep` / `stat`) over the knowledge-graph folder, rendered through the
 * tier ladder (L0 abstract by default, `tier` promotes — renderTier is the
 * sole renderer, demote-not-truncate holds).
 *
 * D33 addressing: vault-relative paths ARE the URIs (obsidian-ext precedent).
 * The virtual type namespace `type/<kind>` is RENDERED by ls/tree only — never
 * on disk (D15: types are frontmatter values, not folders).
 *
 * Index-first, md-fallback (D2: the Surreal `card` index is derived): listing
 * queries hit the index when it is up; when Surreal is down or the table is
 * empty the ops fall back to scanning the folder's frontmatter directly —
 * deterministic either way, ZERO LLM tokens (D5/D6).
 *
 * Library only — no ExtensionAPI, no LLM, no network beyond the local
 * SurrealDB/LM-Studio services.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDerivedAggregation } from "./aggregation-write.ts";
import { cardAnatomy } from "./card-format.ts";
import { extractTitle } from "./graph-health.ts";
import { buildLeafTiers, renderTier, type Tier } from "./tier-ladder.ts";
import { makeContextClient, type CardIndexRow } from "./surreal-index.ts";
import { CARD_TYPES } from "./kcard-types.ts";
import type { SurrealClient } from "@repo/s2-agent-core-interface";

export type FsOp = "ls" | "tree" | "find" | "grep" | "stat";

export interface FsSurfaceOptions {
	/** Absolute vault path. */
	vaultPath: string;
	/** Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). */
	folder?: string;
	/** Render tier (D35): "abstract" L0 default | "overview" L1 | "full" L2. */
	tier?: Tier;
	/** Injectable Surreal client (tests) — default: makeContextClient(). */
	client?: SurrealClient;
}

/** One browse entry: a card (leaf), a virtual type dir, or an agg node. */
export interface FsEntry {
	/** Vault-relative path without .md (`folder/stem`, or `type/<kind>` virtual). */
	path: string;
	/** Display title. */
	title: string;
	/** D15 kind (frontmatter `type` / index `kind`; "derived-aggregation" for aggs). */
	kind: string;
	/** Tier-rendered text at the requested tier (D35). */
	text: string;
	/** Effective tier after demotion. */
	tier: Tier;
}

export interface FsResult {
	op: FsOp;
	ok: boolean;
	/** Present when ok:false. */
	reason?: string;
	entries: FsEntry[];
	/** Which lane answered: "index" (Surreal) or "md" (frontmatter fallback). */
	lane: "index" | "md";
	/** Total cards the op considered (ls root: leaf total; type dir: kind total). */
	scanned: number;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Frontmatter-derived row over one md file (the md-fallback lane's shape —
 *  a subset of CardIndexRow: no vec/embed_model). */
interface MdRow {
	stem: string;
	path: string;
	title: string;
	summary: string;
	is_leaf: boolean;
	layer: number | null;
	parent: string | null;
	kind: string;
}

function parseMdRow(folderAbs: string, folder: string, name: string): MdRow | null {
	const abs = join(folderAbs, name);
	let raw: string;
	try {
		raw = readFileSync(abs, "utf8");
	} catch {
		return null;
	}
	// Frontmatter extraction without the obsidian dep: reuse cardAnatomy +
	// a light yaml-lite read of the few keys we need (kcard cards carry flat
	// scalar frontmatter only).
	const { body } = cardAnatomy(raw);
	const fm = readFmScalars(raw);
	if (fm.status === "retired" || fm.status === "superseded") return null;
	const isAgg = isDerivedAggregation(raw);
	const stem = name.slice(0, -3);
	return {
		stem,
		path: `${folder}/${stem}`,
		title: extractTitle(raw),
		summary: typeof fm.summary === "string" ? fm.summary : "",
		is_leaf: !isAgg,
		layer: typeof fm.layer === "number" ? fm.layer : null,
		parent: typeof fm.parent === "string" ? fm.parent : null,
		kind: isAgg
			? "derived-aggregation"
			: typeof fm.type === "string" ? fm.type : (typeof fm.record_type === "string" ? fm.record_type : "pattern"),
	};
}

/** Minimal flat-scalar frontmatter reader (status/type/record_type/summary/
 * layer/parent) — the keys fs ops need; block values (entities/relations)
 * are not read here. */
function readFmScalars(raw: string): Record<string, string | number | undefined> {
	const out: Record<string, string | number | undefined> = {};
	const lines = raw.split("\n");
	if (lines[0]?.trim() !== "---") return out;
	for (let k = 1; k < lines.length; k++) {
		const ln = lines[k]!;
		if (ln.trim() === "---") break;
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(ln);
		if (!m) continue;
		const key = m[1]!;
		let val: string | number | undefined = m[2]!.trim().replace(/^["']|["']$/g, "");
		if (val === "" || val === "true" || val === "false" || val.startsWith("[") || val === "null") continue;
		if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
		out[key] = val;
	}
	return out;
}

/** All rows for the folder, index-first with md fallback. */
async function allRows(opts: FsSurfaceOptions, folder: string): Promise<{ rows: Array<Partial<CardIndexRow> & MdRow>; lane: "index" | "md" }> {
	const folderAbs = join(opts.vaultPath, folder);
	if (!existsSync(folderAbs)) return { rows: [], lane: "md" };
	// Index lane.
	const client = opts.client ?? makeContextClient();
	try {
		const rows = await client.query<Array<{ stem: string; path: string; title: string; summary: string; is_leaf: boolean; layer: number | null; parent: string | null; kind: string }>>(
			"SELECT stem, path, title, summary, is_leaf, layer, parent, kind FROM card;",
		);
		if (Array.isArray(rows) && rows.length > 0) {
			return { rows: rows as unknown as Array<Partial<CardIndexRow> & MdRow>, lane: "index" };
		}
	} catch {
		// Surreal down / table absent — md fallback below.
	}
	// Md fallback lane.
	const rows: MdRow[] = [];
	for (const name of readdirSync(folderAbs)) {
		if (!name.endsWith(".md")) continue;
		const r = parseMdRow(folderAbs, folder, name);
		if (r) rows.push(r);
	}
	return { rows, lane: "md" };
}

/** Render one row's L0/L1 text via the tier ladder (D35: renderTier is the
 *  sole renderer). `body` is read from disk only at L1+ (L0 needs the
 *  summary; leaves without `summary:` fall back to firstSentenceSummary
 *  inside buildLeafTiers — which wants the body, so read it anyway; the
 *  folder is local and ls is interactive). */
function toEntry(row: MdRow, opts: FsSurfaceOptions, tier: Tier): FsEntry {
	let text = "";
	let effective: Tier = tier;
	try {
		const abs = join(opts.vaultPath, `${row.path}.md`);
		const raw = readFileSync(abs, "utf8");
		const { body } = cardAnatomy(raw);
		const fm = readFmScalars(raw);
		const summary = typeof fm.summary === "string" ? fm.summary : undefined;
		const tiers = buildLeafTiers({ title: row.title, tags: [], summary, body: body.trim() });
		const rendered = renderTier(tiers, tier);
		text = rendered.text;
		effective = rendered.tier;
	} catch {
		text = row.summary || row.title;
	}
	return { path: row.path, title: row.title, kind: row.kind, text, tier: effective };
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

/**
 * `ls <path>` — list a directory. `""` / `"."` = folder root: leaf/agg card
 * stems + the virtual `type/` dir. `type/<kind>` = the D18 virtual type
 * directory: leaf cards of that kind, stem-sorted. Any other path lists the
 * matching card (single-entry stat-like listing) or fails.
 */
export async function fsLs(args: FsSurfaceOptions & { path?: string; limit?: number }): Promise<FsResult> {
	const folder = args.folder ?? "Zettelkasten/knowledge-graph";
	const tier = args.tier ?? "abstract";
	const limit = args.limit ?? 50;
	const path = (args.path ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
	const { rows, lane } = await allRows(args, folder);

	if (path === "" || path === ".") {
		// Root: the virtual type dir + a stem window of leaf cards.
		const leaves = rows.filter((r) => r.is_leaf);
		const entries: FsEntry[] = [
			{ path: "type/", title: `virtual type dirs (${CARD_KINDS.length} kinds)`, kind: "virtual", text: `type/<kind> — D18 virtual type directories over frontmatter type`, tier },
			...leaves.slice(0, limit).map((r) => toEntry(r, args, tier)),
		];
		return { op: "ls", ok: true, entries, lane, scanned: leaves.length };
	}

	const typeMatch = /^type\/([a-z_]+)\/?$/.exec(path);
	if (typeMatch) {
		const kind = typeMatch[1]!;
		if (!CARD_KINDS.includes(kind)) {
			return { op: "ls", ok: false, reason: `unknown kind '${kind}' — known: ${CARD_KINDS.join(", ")}`, entries: [], lane, scanned: 0 };
		}
		const of = rows.filter((r) => r.is_leaf && r.kind === kind).sort((a, b) => (a.stem < b.stem ? -1 : 1));
		return { op: "ls", ok: true, entries: of.slice(0, limit).map((r) => toEntry(r, args, tier)), lane, scanned: of.length };
	}

	// A concrete card path.
	const hit = rows.find((r) => r.path === path || r.path === `${folder}/${path}`);
	if (!hit) return { op: "ls", ok: false, reason: `no such path: ${path}`, entries: [], lane, scanned: rows.length };
	return { op: "ls", ok: true, entries: [toEntry(hit, args, tier)], lane, scanned: rows.length };
}

/** The D15/D16 kind vocabulary (CARD_TYPES keys + derived-aggregation). */
const CARD_KINDS: string[] = [...Object.keys(CARD_TYPES), "derived-aggregation"];

/**
 * `tree` — the agg hierarchy (parent links), depth-capped, optional D18
 * `type` filter over the leaf rows shown beneath their parents. Prototype
 * shape: roots = aggs with no parent; children via the inverted leaf parent
 * column / agg parent field, stem-sorted per node.
 */
export async function fsTree(args: FsSurfaceOptions & { type?: string; depth?: number }): Promise<FsResult> {
	const folder = args.folder ?? "Zettelkasten/knowledge-graph";
	const tier = args.tier ?? "abstract";
	const depth = Math.max(1, Math.min(args.depth ?? 2, 4));
	const { rows, lane } = await allRows(args, folder);
	const childrenOf = new Map<string, MdRow[]>();
	for (const r of rows) {
		if (!r.parent) continue;
		const list = childrenOf.get(r.parent) ?? [];
		list.push(r);
		childrenOf.set(r.parent, list);
	}
	const roots = rows.filter((r) => !r.is_leaf && !r.parent);
	const entries: FsEntry[] = [];
	const walk = (node: MdRow, d: number): void => {
		if (d > depth) return;
		for (const child of (childrenOf.get(node.stem) ?? []).sort((a, b) => (a.stem < b.stem ? -1 : 1))) {
			if (child.is_leaf && args.type && child.kind !== args.type) continue;
			const e = toEntry(child, args, tier);
			e.title = `${"  ".repeat(d - 1)}${e.title}`;
			entries.push(e);
			if (!child.is_leaf) walk(child, d + 1);
		}
	};
	for (const root of roots.sort((a, b) => (a.stem < b.stem ? -1 : 1))) {
		entries.push({ ...toEntry(root, args, tier), title: `${root.stem} (L${root.layer ?? 0} root)` });
		walk(root, 1);
	}
	return { op: "tree", ok: true, entries, lane, scanned: rows.length };
}

/**
 * `find <pattern>` — glob-ish match over stems/paths (`*` wildcard, case
 * insensitive; a bare token is a substring match), optional D18 type filter.
 */
export async function fsFind(args: FsSurfaceOptions & { pattern: string; type?: string; limit?: number }): Promise<FsResult> {
	const folder = args.folder ?? "Zettelkasten/knowledge-graph";
	const tier = args.tier ?? "abstract";
	const limit = args.limit ?? 30;
	const { rows, lane } = await allRows(args, folder);
	const pattern = args.pattern.toLowerCase();
	const hasWildcard = pattern.includes("*");
	const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	const hits = rows
		.filter((r) => r.is_leaf)
		.filter((r) => (args.type ? r.kind === args.type : true))
		.filter((r) => (hasWildcard ? re.test(r.stem.toLowerCase()) : r.stem.toLowerCase().includes(pattern)))
		.sort((a, b) => (a.stem < b.stem ? -1 : 1))
		.slice(0, limit);
	return { op: "find", ok: true, entries: hits.map((r) => toEntry(r, args, tier)), lane, scanned: rows.length };
}

/**
 * `grep <query>` — token match over titles/summaries/bodies. Index lane: FTS
 * (`@@`, AND-only per ticket 03 P6 — a multi-token query is the caller asking
 * for the conjunction; single tokens are the common browse case). Md lane:
 * substring scan over title+summary+body.
 */
export async function fsGrep(args: FsSurfaceOptions & { query: string; type?: string; limit?: number }): Promise<FsResult> {
	const folder = args.folder ?? "Zettelkasten/knowledge-graph";
	const tier = args.tier ?? "abstract";
	const limit = args.limit ?? 20;
	const q = args.query.trim().toLowerCase();
	if (!q) return { op: "grep", ok: false, reason: "empty query", entries: [], lane: "md", scanned: 0 };

	const client = args.client ?? makeContextClient();
	try {
		const rows = await client.query<Array<{ stem: string; path: string; title: string; summary: string; kind: string; is_leaf: boolean }>>(
			"SELECT stem, path, title, summary, kind, is_leaf FROM card WHERE (title @@ $q OR summary @@ $q OR body @@ $q) AND is_leaf = true;",
			{ q: args.query.trim() },
		);
		if (Array.isArray(rows)) {
			const hits = rows
				.filter((r) => (args.type ? r.kind === args.type : true))
				.sort((a, b) => (a.stem < b.stem ? -1 : 1))
				.slice(0, limit);
			return { op: "grep", ok: true, entries: hits.map((r) => toEntry(r as unknown as MdRow, args, tier)), lane: "index", scanned: rows.length };
		}
	} catch {
		// md fallback below
	}
	const folderAbs = join(args.vaultPath, folder);
	const hits: MdRow[] = [];
	let scanned = 0;
	for (const name of readdirSync(folderAbs)) {
		if (!name.endsWith(".md")) continue;
		const r = parseMdRow(folderAbs, folder, name);
		if (!r || !r.is_leaf) continue;
		if (args.type && r.kind !== args.type) continue;
		scanned++;
		const raw = readFileSync(join(folderAbs, name), "utf8");
		if (`${r.title}\n${r.summary}\n${raw}`.toLowerCase().includes(q)) hits.push(r);
	}
	return { op: "grep", ok: true, entries: hits.sort((a, b) => (a.stem < b.stem ? -1 : 1)).slice(0, limit).map((r) => toEntry(r, args, tier)), lane: "md", scanned };
}

/** `stat <path>` — one card's metadata + tier text. */
export async function fsStat(args: FsSurfaceOptions & { path: string }): Promise<FsResult> {
	const folder = args.folder ?? "Zettelkasten/knowledge-graph";
	const tier = args.tier ?? "abstract";
	const { rows, lane } = await allRows(args, folder);
	const hit = rows.find((r) => r.path === args.path || r.path === `${folder}/${args.path}` || r.stem === args.path);
	if (!hit) return { op: "stat", ok: false, reason: `no such path: ${args.path}`, entries: [], lane, scanned: rows.length };
	return { op: "stat", ok: true, entries: [toEntry(hit, args, tier)], lane, scanned: rows.length };
}
