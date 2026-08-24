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
	/** Plain md body text (frontmatter-stripped), truncated — the lexical
	 *  lane's recall depth (ticket 09 D23 tuning: title+summary alone left
	 *  hier's FTS blind to body-level token matches that flat's bodyMatch
	 *  scores, a measured 2-query gap on the 20-question battery). */
	body: string;
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

/** Index row-shape version — salted into the rebuild fingerprint so a schema
 *  change forces exactly one rebuild of unchanged contents. v2 adds the
 *  `body` column (ticket 09 D23 body lane). */
const INDEX_SCHEMA_VERSION = "v2-body";

/** Truncation cap for the indexed body text: keeps a body row ≤ ~3 KB so the
 *  24-row /sql batch (~8–10 KB/vector row) stays well inside the 1 MiB cap. */
const INDEX_BODY_CHARS = 3000;

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

/** Stems of an agg card's children: the `[[target]]` wikilinks in its
 *  `## 子節點` section ONLY (that section is the downward edge list —
 *  aggregation-write; reviewer F5: scanning the whole body would invert a
 *  wikilink that merely appears in the `## 摘要` prose into a spurious
 *  parent edge). */
function aggChildStems(content: string, bodyStart: number): string[] {
	const body = content.slice(bodyStart);
	const section = body.indexOf("## 子節點");
	if (section === -1) return [];
	const rest = body.slice(section);
	const nextSection = rest.slice(1).search(/^## /m);
	const scope = nextSection === -1 ? rest : rest.slice(0, nextSection + 1);
	const stems: string[] = [];
	for (const m of scope.matchAll(/\[\[([^\]]+)\]\]/g)) {
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
					body: content.slice(bodyStart).trim().slice(0, INDEX_BODY_CHARS),
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
	// checkout, D13), salted with the index SCHEMA version so a row-shape
	// change (e.g. the body column) forces exactly one rebuild of otherwise
	// unchanged contents.
	const fingerprint = sha256(
		`schema:${INDEX_SCHEMA_VERSION}\n` + raws.map((r) => `${r.row.stem}:${r.contentHash}`).sort().join("\n"),
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
	return `CREATE ${key.replace("card:", `${table}:`)} SET stem = ${v(row.stem)}, path = ${v(row.path)}, title = ${v(row.title)}, summary = ${v(row.summary)}, body = ${v(row.body)}, is_leaf = ${row.is_leaf}, layer = ${row.layer ?? null}, parent = ${v(row.parent)}, entities = ${JSON.stringify(row.entities)}, kind = ${v(row.kind)}, vec = ${JSON.stringify(row.vec ? vec : null)}, embed_model = ${v(row.embed_model)};`;
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
	// ticket 10 reconciliation (from the parallel t08 branch): the usage
	// ledger's GROUP BY reader (`usageAggregates`: WHERE stem IN … GROUP BY
	// stem) scans `usage` per query — a plain stem index keeps the replay
	// cheap once real retrieve events accumulate.
	"DEFINE INDEX IF NOT EXISTS usage_stem ON TABLE usage COLUMNS stem;",
];

/** Table + plain indexes — everything EXCEPT the analyzer/FTS/HNSW search
 *  defs. The swap creates `card` with THESE ONLY, bulk-inserts the shadow
 *  copy (no search-index maintenance per row), then applies
 *  `cardSearchDefs` so each search index is built server-side in one pass —
 *  with the body FTS lane (ticket 09 D23) the pre-indexed swap's
 *  `INSERT INTO card SELECT * FROM card_shadow` grew past the client's 10s
 *  per-request bound (measured timeout on the 2351-card vault). */
function cardTableDefs(): string[] {
	return [
		"DEFINE TABLE IF NOT EXISTS card SCHEMALESS;",
		"DEFINE INDEX IF NOT EXISTS card_stem ON TABLE card COLUMNS stem;",
		"DEFINE INDEX IF NOT EXISTS card_parent ON TABLE card COLUMNS parent;",
		"DEFINE INDEX IF NOT EXISTS card_is_leaf ON TABLE card COLUMNS is_leaf;",
		// ticket 05 D36: virtual type dirs (type/<kind>) list by kind — plain
		// index applies on the next natural rebuild; correctness never depends
		// on it (a kind filter is a valid full-scan predicate regardless).
		"DEFINE INDEX IF NOT EXISTS card_kind ON TABLE card COLUMNS kind;",
	];
}

/** Analyzer + FTS + HNSW defs — applied AFTER the bulk insert lands. */
function cardSearchDefs(dim: number): string[] {
	const defs = [
		"DEFINE ANALYZER IF NOT EXISTS kcard_en TOKENIZERS class FILTERS snowball(english);",
		// v3.2.3 FULLTEXT indexes are single-column (ticket 02 specced
		// `FIELDS title, summary` — parse error, amended here): one per lane.
		"DEFINE INDEX IF NOT EXISTS card_fts_title ON TABLE card COLUMNS title FULLTEXT ANALYZER kcard_en;",
		"DEFINE INDEX IF NOT EXISTS card_fts_summary ON TABLE card COLUMNS summary FULLTEXT ANALYZER kcard_en;",
		"DEFINE INDEX IF NOT EXISTS card_fts_body ON TABLE card COLUMNS body FULLTEXT ANALYZER kcard_en;",
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

// ---------------------------------------------------------------------------
// Post-write rebuild trigger (ticket 08 fold-back, landed via the ticket 10
// reconciliation): the production path for rebuildCardIndex.
// ---------------------------------------------------------------------------

/** Default convergence folder (identical to retrieve/ingest defaults). */
const GRAPH_FOLDER = "Zettelkasten/knowledge-graph";

/**
 * Coalesced fire-and-forget rebuild after card writes — the production path
 * for `rebuildCardIndex` (until this, only the eval script rebuilt, so the
 * D36 freshness gate flipped back to flat after every ingest).
 *
 * Fingerprint-gated: an unchanged vault skips in ~ms (rebuildCardIndex), and
 * concurrent triggers coalesce onto one in-flight rebuild (single un-keyed
 * slot — production is single-vault/single-folder by construction; a
 * custom-folder ingest racing a default-folder one drops the loser's
 * rebuild, and the NEXT trigger on that folder picks it up). Failure is
 * NON-fatal by design — the index stays stale and the freshness gate serves
 * the flat path (the graceful-degrade contract, never a raised error in a
 * write path). Callers opt in with `indexRebuild: true` so unit tests stay
 * hermetic (ingest tests would otherwise hit the live Surreal service).
 *
 * LANE LIMITATION (reviewer F2, deliberate): the s2-agent CLI entry is
 * `process.exit(await runCli(...))`, so an un-awaited rebuild dies at exit —
 * the zk-ingest CLI therefore re-awaits the coalesced promise before
 * returning. The session_shutdown trigger stays fire-and-forget (shutdown
 * must never block on the embedder): in headless `-p` runs that lane is
 * best-effort and may not complete — the next explicit ingest/rebuild
 * closes the gap, and the fingerprint gate makes that retry cheap.
 *
 * Env kill-switch `KCARD_INDEX_REBUILD=0` (the KCARD_* knob family): test
 * suites that exercise the write path through the production boundary (tool
 * handler, spawned CLI) set it so a temp-vault run never touches the real
 * index — scheduleCardRebuild fingerprints the TEMP vault and would swap the
 * LIVE index to it.
 */
let pendingRebuild: Promise<RebuildResult | null> | null = null;
export function scheduleCardRebuild(args: {
	vaultPath: string;
	folder?: string;
	model?: string;
	/** INTERNAL test seam: client opts passthrough (fake fetch) so the
	 *  coalescing / kill-switch / non-fatal contract is unit-testable without
	 *  a live SurrealDB. Never set in production. */
	_clientOpts?: Partial<SurrealClientOptions>;
}): Promise<RebuildResult | null> {
	if (process.env.KCARD_INDEX_REBUILD === "0") return Promise.resolve(null);
	if (!pendingRebuild) {
		pendingRebuild = (async () => {
			try {
				// Long timeout: a real rebuild embeds + bulk-inserts the whole
				// vault (~minutes on a cold embed cache); the client default
				// 10s would abort mid-swap and leave a partial index (the
				// freshness gate still degrades to flat — recorded fog).
				const client = makeContextClient({ requestTimeoutMs: 180_000, ...args._clientOpts });
				return await rebuildCardIndex({
					client,
					vaultPath: args.vaultPath,
					folder: args.folder ?? GRAPH_FOLDER,
					model: args.model ?? resolveCardEmbedModel(),
				});
			} catch (e) {
				console.warn(
					`[kcard] post-write index rebuild failed: ${e instanceof Error ? e.message : String(e)} — index stays stale, the freshness gate serves flat`,
				);
				return null;
			} finally {
				pendingRebuild = null;
			}
		})();
	}
	return pendingRebuild;
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
	// Skip conditions (reviewer F2/F3 fixes): the fingerprint is content-only,
	// so an EMBED-MODEL change must independently force a rebuild (D10
	// model-swap A/B — otherwise a model flip silently keeps the old model's
	// vectors, exactly the silent-single-model trap D22 closed); and a zero
	// row count with a stamped fingerprint (crash inside the swap, after the
	// re-DEFINE but before the INSERT completed) must NOT skip — the live
	// table is empty and would stay pinned empty until content changes.
	if (
		status.present
		&& status.fingerprint === built.fingerprint
		&& status.embedModel === built.embedModel
		&& status.cardCount > 0
	) {
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
	await args.client.query(cardTableDefs().join("\n"));
	await args.client.query("INSERT INTO card SELECT * FROM card_shadow;");
	// Search indexes AFTER the bulk copy (see cardTableDefs docblock) — each
	// DEFINE builds server-side in one pass instead of per-row maintenance.
	for (const stmt of cardSearchDefs(built.dim)) {
		await args.client.query(stmt);
	}
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
