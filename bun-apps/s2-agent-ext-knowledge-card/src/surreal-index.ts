/**
 * src/surreal-index.ts — the kcard SurrealDB derived index (kcard-parity
 * ticket 07, D9–D13/D21). D2: EVERYTHING here regenerates from the vault md —
 * the index is a derived, rebuildable cache; the md files stay sole canonical.
 *
 * Layout (db `context_db` inside the per-user namespace, D6):
 *
 *   card       — leaves + agg nodes, ONE table (D9): stem/path/title/summary/
 *                is_leaf/layer/parent/entities/kind + vec/embed_model (D10).
 *                Record key = sha256(stem) — NOT the raw stem (amended D9,
 *                ticket 07: real-vault stems carry backticks and CJK, which
 *                make SurrealQL identifier escaping a parser minefield; the
 *                stem rides as a plain indexed STRING column, so equality
 *                lookups never touch identifier syntax).
 *   relation   — defined but EMPTY (D11; writer is ticket 06).
 *   usage      — defined but EMPTY (D12; writer is ticket 08's RecallLedger).
 *   index_meta — fingerprint row gating no-op rebuilds.
 *
 * Rebuild (D13/D21): fingerprint = sha256 over sorted per-card content
 * hashes. Build goes into `card_shadow` first — only after every batch lands
 * does the swap run (server-side `INSERT INTO card SELECT * FROM card_shadow`
 * single statement), so a failed build leaves the live table intact. Vectors
 * come from getCardEmbeddings' model-keyed JSON cache — unchanged cards embed
 * zero times (a warm cache makes the rebuild pure I/O).
 *
 * Library only — no ExtensionAPI. The SurrealClient is injectable (tests run
 * against the local service or skip when it is down, hermes _helpers pattern).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@repo/s2-agent-ext-obsidian";
import {
	SurrealClient,
	SURREAL_DEFAULTS,
	derivePerUserNamespace,
	type SurrealClientOptions,
} from "@repo/s2-agent-core-interface";
import { getCardEmbeddings, resolveCardEmbedModel, type Embedder } from "./semantic.ts";
import { isDerivedAggregation } from "./aggregation-write.ts";

/** kcard's database name inside the per-user namespace (D6). */
export const KCARD_CONTEXT_DB = "context_db";

/** Build a SurrealClient bound to the kcard context_db (per-user ns, D6). */
export function makeContextClient(opts: Partial<SurrealClientOptions> = {}): SurrealClient {
	return new SurrealClient({
		endpoint: opts.endpoint ?? SURREAL_DEFAULTS.endpoint,
		namespace: opts.namespace ?? derivePerUserNamespace(),
		database: opts.database ?? KCARD_CONTEXT_DB,
		username: opts.username ?? SURREAL_DEFAULTS.username,
		password: opts.password ?? SURREAL_DEFAULTS.password,
		fetch: opts.fetch,
		maxAttempts: opts.maxAttempts,
		backoffMs: opts.backoffMs,
		requestTimeoutMs: opts.requestTimeoutMs,
		onRoundTrip: opts.onRoundTrip,
	});
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

/** One indexed card (leaf or agg node) — the `card` table shape. */
export interface CardIndexRow {
	/** md filename stem (no .md) — the plain-string identity, indexed. */
	stem: string;
	/** Vault-relative path without .md (`folder/stem`). */
	path: string;
	title: string;
	summary: string;
	is_leaf: boolean;
	/** Agg layer (0 = first aggregation above leaves); null for leaves. */
	layer: number | null;
	/** Parent stem (the agg card one level UP); null at the tree top. */
	parent: string | null;
	entities: string[];
	/** D15: mirrors frontmatter `type` (fallback `record_type`) 1:1 for
	 *  leaves; "derived-aggregation" for agg nodes. */
	kind: string;
	vec: number[] | null;
	embed_model: string | null;
}

export interface BuildRowsResult {
	rows: CardIndexRow[];
	/** sha256 over sorted `stem:contentHash` pairs — gates no-op rebuilds. */
	fingerprint: string;
	/** Vector dimensionality observed (0 when no vectors were produced). */
	dim: number;
	embedModel: string;
	leafCount: number;
	aggCount: number;
	/** Cards skipped (unreadable/unparseable) — informational. */
	skipped: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter extraction (defensive — mirrors hierarchy-build/loadKbCards)
// ---------------------------------------------------------------------------

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256-based record key: stable per stem, always a legal bare identifier. */
export function cardRecordKey(stem: string): string {
	return `card:${sha256(stem).slice(0, 16)}`;
}

function readTitle(content: string): string {
	const m = content.match(/^#\s+(.+?)\s*$/m);
	return m ? m[1]!.trim() : "(untitled)";
}

function flattenList(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			const m = /(?:^|\n)\s*name:\s*(.+)$/m.exec(entry);
			const name = (m ? m[1] : entry).trim();
			if (name) out.push(name);
		} else if (entry && typeof entry === "object") {
			const name = (entry as Record<string, unknown>).name;
			if (typeof name === "string" && name.trim()) out.push(name.trim());
		}
	}
	return out;
}

/** Stems of an agg card's children: the `[[target]]` wikilinks in its body
 *  (the `## 子節點` section is the downward edge list — aggregation-write). */
function aggChildStems(content: string, bodyStart: number): string[] {
	const stems: string[] = [];
	for (const m of content.slice(bodyStart).matchAll(/\[\[([^\]]+)\]\]/g)) {
		const target = (m[1] ?? "").split("|").pop()?.trim();
		if (target) stems.push(target);
	}
	return stems;
}

// ---------------------------------------------------------------------------
// Row building (pure read side — no Surreal, injectable embedder)
// ---------------------------------------------------------------------------

/**
 * Build index rows for every top-level .md in `folder` (subfolders such as
 * `_archive` are not indexed — they are outside the convergence surface).
 * Parent edges: agg→agg from the agg card's own `parent:` frontmatter;
 * leaf→agg by INVERTING each agg card's child wikilinks (leaves carry no
 * parent frontmatter — the hierarchy encodes downward edges only).
 * Vectors are attached from getCardEmbeddings (model-keyed JSON cache first;
 * only uncached cards hit the embedder).
 */
export async function buildCardRows(args: {
	vaultPath: string;
	folder: string;
	model?: string;
	embedder?: Embedder;
}): Promise<BuildRowsResult> {
	const model = resolveCardEmbedModel(args.model);
	const folderAbs = join(args.vaultPath, args.folder);
	const skipped: string[] = [];
	if (!existsSync(folderAbs)) {
		throw new Error(`folder does not exist: ${folderAbs}`);
	}
	const names = readdirSync(folderAbs).filter((n) => n.endsWith(".md")).sort();

	// Vectors (null when the embedder is unavailable — the index still builds,
	// the KNN lane degrades; the lexical/FTS lane is unaffected).
	const emb = await getCardEmbeddings(args.vaultPath, args.folder, model, args.embedder);
	const vecByPath = new Map<string, number[]>();
	if (emb) for (let i = 0; i < emb.paths.length; i++) vecByPath.set(emb.paths[i]!, emb.vectors[i]!);

	interface Raw {
		row: CardIndexRow;
		children: string[];
		isAgg: boolean;
		contentHash: string;
	}
	const raws: Raw[] = [];
	for (const name of names) {
		const stem = name.slice(0, -3);
		let raw: Raw;
		try {
			const content = readFileSync(join(folderAbs, name), "utf8");
			const { data, bodyStart } = parseFrontmatter(content);
			const isAgg = isDerivedAggregation(content);
			const kind = isAgg
				? "derived-aggregation"
				: typeof data.type === "string" && data.type
					? data.type
					: typeof data.record_type === "string" && data.record_type
						? data.record_type
						: "pattern";
			const parent = isAgg && typeof data.parent === "string" && data.parent !== "null"
				? aggParentStem(data.parent)
				: null;
			const layerNum = Number(data.layer);
			raw = {
				row: {
					stem,
					path: `${args.folder}/${stem}`,
					title: readTitle(content),
					summary: typeof data.summary === "string" ? data.summary.trim() : "",
					is_leaf: !isAgg,
					layer: isAgg && data.layer !== undefined && data.layer !== null && Number.isFinite(layerNum) ? layerNum : null,
					parent,
					entities: flattenList(data.entities),
					kind,
					vec: vecByPath.get(`${args.folder}/${stem}`) ?? null,
					embed_model: null,
				},
				children: isAgg ? aggChildStems(content, bodyStart) : [],
				isAgg,
				contentHash: sha256(content),
			};
			if (raw.row.vec) raw.row.embed_model = model;
		} catch {
			skipped.push(name);
			continue;
		}
		raws.push(raw);
	}

	// Invert agg child links → leaf parents (a leaf's ONLY upward edge).
	const byStem = new Map(raws.map((r) => [r.row.stem, r]));
	for (const r of raws) {
		if (!r.isAgg) continue;
		for (const child of r.children) {
			const c = byStem.get(child);
			if (c && c.row.is_leaf && c.row.parent === null) c.row.parent = r.row.stem;
		}
	}

	// Fingerprint: sorted stem:contentHash (mtime-free — unreliable after git
	// checkout, D13).
	const fingerprint = sha256(
		raws.map((r) => `${r.row.stem}:${r.contentHash}`).sort().join("\n"),
	);
	const dim = raws.find((r) => r.row.vec)?.row.vec?.length ?? 0;
	return {
		rows: raws.map((r) => r.row),
		fingerprint,
		dim,
		embedModel: model,
		leafCount: raws.filter((r) => r.row.is_leaf).length,
		aggCount: raws.filter((r) => !r.row.is_leaf).length,
		skipped,
	};
}

/** `agg:<l>:<i>` frontmatter parent id → the parent FILE's stem. */
function aggParentStem(parentId: string): string | null {
	const m = /^agg:(\d+):(\d+)$/.exec(parentId);
	return m ? `agg-L${m[1]}-${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// SQL plumbing
// ---------------------------------------------------------------------------

/** CREATE statement for one row. Every value is JSON-encoded (a valid
 *  SurrealQL literal for string/number/bool/null/array); the record key is a
 *  hex hash, so no identifier escaping is ever needed. Vector components are
 *  rounded to 6 decimals — the HNSW index stores F32 (~7 significant digits)
 *  anyway, and full-precision JSON floats make a 1024-dim row ~20 KB+, which
 *  overflowed the /sql body cap (HTTP 413, measured on the real 2352-card
 *  vault; rounding halves the statement size for zero index-visible loss). */
function createStmt(table: string, row: CardIndexRow): string {
	const key = cardRecordKey(row.stem);
	const v = (x: unknown) => JSON.stringify(x ?? null);
	const vec = (row.vec ?? []).map((x) => Math.round(x * 1e6) / 1e6);
	return `CREATE ${key.replace("card:", `${table}:`)} SET stem = ${v(row.stem)}, path = ${v(row.path)}, title = ${v(row.title)}, summary = ${v(row.summary)}, is_leaf = ${row.is_leaf}, layer = ${row.layer ?? null}, parent = ${v(row.parent)}, entities = ${JSON.stringify(row.entities)}, kind = ${v(row.kind)}, vec = ${JSON.stringify(vec)}, embed_model = ${v(row.embed_model)};`;
}

/** /sql body cap (HTTP 413 above it, measured): rounded 1024-dim vectors run
 *  ~8–10 KB/row, so 24/body stays well inside the limit. */
const BATCH_ROWS = 24;

async function insertBatches(client: SurrealClient, table: string, rows: CardIndexRow[]): Promise<number> {
	let n = 0;
	for (let i = 0; i < rows.length; i += BATCH_ROWS) {
		const body = rows.slice(i, i + BATCH_ROWS).map((r) => createStmt(table, r)).join("\n");
		await client.query(body);
		n += Math.min(BATCH_ROWS, rows.length - i);
	}
	return n;
}

const TABLE_DEFS = [
	"DEFINE TABLE IF NOT EXISTS relation SCHEMALESS;",
	"DEFINE TABLE IF NOT EXISTS usage SCHEMALESS;",
];

function cardIndexDefs(dim: number): string[] {
	const defs = [
		"DEFINE TABLE IF NOT EXISTS card SCHEMALESS;",
		"DEFINE ANALYZER IF NOT EXISTS kcard_en TOKENIZERS class FILTERS snowball(english);",
		// v3.2.3 FULLTEXT indexes are single-column (ticket 02 specced
		// `FIELDS title, summary` — parse error, amended here): one per lane.
		"DEFINE INDEX IF NOT EXISTS card_fts_title ON TABLE card COLUMNS title FULLTEXT ANALYZER kcard_en;",
		"DEFINE INDEX IF NOT EXISTS card_fts_summary ON TABLE card COLUMNS summary FULLTEXT ANALYZER kcard_en;",
		"DEFINE INDEX IF NOT EXISTS card_stem ON TABLE card COLUMNS stem;",
		"DEFINE INDEX IF NOT EXISTS card_parent ON TABLE card COLUMNS parent;",
		"DEFINE INDEX IF NOT EXISTS card_is_leaf ON TABLE card COLUMNS is_leaf;",
	];
	if (dim > 0) {
		defs.push(
			`DEFINE INDEX IF NOT EXISTS card_vec ON TABLE card FIELDS vec HNSW DIMENSION ${dim} DIST COSINE TYPE F32;`,
		);
	}
	return defs;
}

// ---------------------------------------------------------------------------
// Rebuild orchestration (D13/D21: shadow-gated swap)
// ---------------------------------------------------------------------------

/** Idempotent ns/db bootstrap — v3 does NOT lazily create the header-named
 *  namespace/database (hermes schema.ts precedent). Safe on every call. */
export async function ensureContextDb(client: SurrealClient): Promise<void> {
	await client.query(
		`DEFINE NAMESPACE IF NOT EXISTS ${client.namespace};\nDEFINE DATABASE IF NOT EXISTS ${client.database};`,
	);
}

export interface RebuildResult {
	skipped: boolean;
	fingerprint: string;
	inserted: number;
	leafCount: number;
	aggCount: number;
	dim: number;
	embedModel: string;
	elapsedMs: number;
}

export interface IndexStatus {
	present: boolean;
	fingerprint: string | null;
	cardCount: number;
	embedModel: string | null;
}

export async function indexStatus(client: SurrealClient): Promise<IndexStatus> {
	try {
		const meta = await client.query<{ fingerprint: string; embed_model: string }[] | null>(
			"SELECT fingerprint, embed_model FROM index_meta:current;",
		);
		const count = await client.query<Array<{ count: number }>>("SELECT VALUE count() FROM card GROUP ALL;");
		const n = Array.isArray(count) && count[0] && typeof count[0].count === "number" ? count[0].count : 0;
		return {
			present: Boolean(meta && meta.length > 0 && meta[0]?.fingerprint),
			fingerprint: meta?.[0]?.fingerprint ?? null,
			cardCount: n,
			embedModel: meta?.[0]?.embed_model ?? null,
		};
	} catch {
		return { present: false, fingerprint: null, cardCount: 0, embedModel: null };
	}
}

/**
 * Full fingerprint-gated rebuild of the `card` index. Steps:
 *   1. build rows + fingerprint from the vault folder (md-canonical, D2);
 *   2. fingerprint match against index_meta → no-op skip;
 *   3. batch-insert EVERYTHING into `card_shadow` (a failed batch throws —
 *      the live `card` table is untouched);
 *   4. swap: drop `card`, recreate + indexes, single server-side
 *      `INSERT INTO card SELECT * FROM card_shadow`, stamp index_meta,
 *      drop the shadow.
 * The swap window (~seconds) is not reader-transparent (ticket 03 P7) —
 * acceptable because hierarchical retrieval is NOT the default path (the
 * default switch is ticket 09's gate).
 */
export async function rebuildCardIndex(args: {
	client: SurrealClient;
	vaultPath: string;
	folder: string;
	model?: string;
	embedder?: Embedder;
}): Promise<RebuildResult> {
	const started = Date.now();
	await ensureContextDb(args.client);
	const built = await buildCardRows(args);
	if (built.rows.length === 0) throw new Error("no indexable cards found");

	const status = await indexStatus(args.client);
	if (status.present && status.fingerprint === built.fingerprint) {
		return {
			skipped: true,
			fingerprint: built.fingerprint,
			inserted: status.cardCount,
			leafCount: built.leafCount,
			aggCount: built.aggCount,
			dim: built.dim,
			embedModel: built.embedModel,
			elapsedMs: Date.now() - started,
		};
	}

	await args.client.query("REMOVE TABLE IF EXISTS card_shadow;");
	await args.client.query([...TABLE_DEFS, `DEFINE TABLE IF NOT EXISTS card_shadow SCHEMALESS;`].join("\n"));
	const inserted = await insertBatches(args.client, "card_shadow", built.rows);

	// Swap (only after every shadow batch landed).
	await args.client.query("REMOVE TABLE IF EXISTS card;");
	await args.client.query(cardIndexDefs(built.dim).join("\n"));
	await args.client.query("INSERT INTO card SELECT * FROM card_shadow;");
	await args.client.query(
		[
			"REMOVE TABLE IF EXISTS index_meta;",
			"DEFINE TABLE IF NOT EXISTS index_meta SCHEMALESS;",
			`CREATE index_meta:current SET fingerprint = ${JSON.stringify(built.fingerprint)}, card_count = ${built.rows.length}, embed_model = ${JSON.stringify(built.embedModel)}, dim = ${built.dim};`,
			"REMOVE TABLE IF EXISTS card_shadow;",
		].join("\n"),
	);
	return {
		skipped: false,
		fingerprint: built.fingerprint,
		inserted,
		leafCount: built.leafCount,
		aggCount: built.aggCount,
		dim: built.dim,
		embedModel: built.embedModel,
		elapsedMs: Date.now() - started,
	};
}
