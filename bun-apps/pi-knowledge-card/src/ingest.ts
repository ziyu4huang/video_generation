/**
 * src/ingest.ts — deterministic knowledge-graph convergence primitive.
 *
 * The pi-knowledge-card tools (zk_extract / zk_card / zk_ask) are LLM-subagent
 * coordinators: they decompose free-form markdown into atomic zettels. That is
 * the right tool for UNSTRUCTURED text, but the self-improve loops already
 * produce STRUCTURED knowledge — `.claude/workflows/*.knowledge.jsonl` records
 * with a fixed 12-key schema (id/type/title/detail/tags/dimension/confidence/
 * status/superseded_by/evidence/...). Routing those through an LLM subagent
 * would be lossy, non-deterministic, and would re-introduce exactly the
 * "siloed per-workflow" fragmentation this module exists to dissolve.
 *
 * zk_ingest is the deterministic counterpart: it maps each structured record
 * 1:1 onto a canonical zettel card in ONE shared vault folder, dedup'd by the
 * record's stable id, cross-linked by shared tags, and indexed by a MOC. The
 * graph then spans every source (workflow-jsonl today; hermes + auto-memory
 * later) because every converged card lives in the same folder and shares the
 * same tag space — a flux2 gotcha and a krea2 gotcha with overlapping tags get
 * a `[[...]]` edge, and `zk_ask` (graph-enhanced RAG over the whole vault)
 * answers cross-source questions for free.
 *
 * Canonical card schema (frontmatter; validateZettelNote requires id/created/
 * tags with tags[0]=="zettel" and does NOT reject extra keys, so the lifecycle
 * + provenance fields ride along as extended frontmatter):
 *
 *   ---
 *   id: <record.id>                 # stable canonical key (namespaced, e.g. ltx:cfg-scale-7-lever)
 *   created: YYYY-MM-DD             # best-effort from evidence.first_seen / extracted_at
 *   tags: [zettel, <record.type>, ...record.tags, ...dimension parts]
 *   sources: [<provenance>]
 *   source: workflow-jsonl          # source family
 *   source_id: <record.id>          # dedup key (== id; kept explicit for scanners)
 *   record_type: lever              # lever|avoid|pattern|gotcha|metric|false_positive
 *   status: active                  # active|superseded|retired
 *   superseded_by: <id|null>
 *   confidence: 0.93
 *   dimension: <string|null>
 *   ---
 *
 * Library only — no ExtensionAPI, no LLM, no network. The extension tool
 * (zk_ingest) and the bun-pi-agent-cli subcommand (zk-ingest) are thin shells
 * over `ingestRecords`.
 *
 * Env (passed through from pi-obsidian): OB_VAULT_PATH / OB_VAULT_DIR.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
	parseFrontmatter,
	validateZettelNote,
	ZETTEL_MAX_BYTES,
	type VaultIndex,
} from "pi-obsidian/extensions/obsidian.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A structured knowledge record (the .knowledge.jsonl 12-key schema). Fields
 *  beyond the canonical 12 are tolerated and preserved in evidence only. */
export interface KnowledgeRecord {
	id: string;
	type: string; // lever | avoid | pattern | gotcha | metric | false_positive
	title: string;
	detail: string;
	tags: string[];
	dimension: string | null;
	confidence: number;
	status: string; // active | superseded | retired
	superseded_by: string | null;
	schema_version?: number;
	evidence?: {
		occurrences?: number;
		first_seen?: string;
		last_seen?: string;
		run_ids?: string[];
		extracted_at?: string;
	};
	extracted_at?: string;
}

export type SourceFamily = "workflow-jsonl" | "hermes" | "auto-memory";

export interface IngestOptions {
	/** Absolute vault path (the convergence sink — single shared vault). */
	vaultPath: string;
	/** Source family; becomes the `source` frontmatter key. */
	source: SourceFamily;
	/** Human-readable provenance, e.g. "workflow-jsonl:mlx-...-ltx". */
	sourceLabel: string;
	/** Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). */
	folder?: string;
	/** MOC note path, vault-relative (default: Tags/Knowledge Graph.md). */
	mocPath?: string;
	/** Don't write anything; just report what would happen. */
	dryRun?: boolean;
	/** Max cross-link neighbours per card (default 8). */
	maxLinks?: number;
	/** Max detail length in chars before truncation (keeps the note < 64KB). */
	maxDetailChars?: number;
}

export type CardOutcome = "created" | "updated" | "unchanged";

export interface IngestCardReport {
	id: string;
	path: string; // vault-relative
	status: CardOutcome;
	links: number;
}

export interface IngestSummary {
	source: SourceFamily;
	sourceLabel: string;
	total: number;
	created: number;
	updated: number;
	unchanged: number;
	skipped: number; // malformed records
	linked: number; // total cross-link edges written
	mocUpdated: boolean;
	vaultPath: string;
	folder: string;
	cards: IngestCardReport[];
	parseErrors: { line: number; reason: string }[];
}

// ---------------------------------------------------------------------------
// auto-memory parsing (the second convergence source)
// ---------------------------------------------------------------------------

/**
 * Adapt an auto-memory topic file (the `.claude-glm/.../memory/*.md` shape) into
 * a KnowledgeRecord, so it can converge into the SAME graph as workflow-jsonl.
 *
 * Memory file frontmatter:
 *   ---
 *   name: <slug>
 *   description: "<one-line summary>"
 *   metadata:
 *     type: user | feedback | project | reference
 *   ---
 *   <body — the fact; for feedback/project, Why/How-to-apply lines>
 *
 * Mapping:
 *   id          = `auto-memory:<name>`        (stable; namespaced like workflow ids)
 *   type        = `pattern` (default) — memory is human-curated, not a gotcha/lever
 *                 in the workflow sense; the metadata.type rides as a tag.
 *   title       = description (the one-line hook)
 *   detail      = body (Why/How stripped of frontmatter)
 *   tags        = [auto-memory, <metadata.type>, ...slugs extracted from [[links]]]
 *   dimension   = metadata.type
 *   confidence  = 1 (human-curated)
 *
 * Returns null if the file has no `name` + `description` (not a memory file).
 */
export function adaptAutoMemoryMarkdown(content: string): KnowledgeRecord | null {
	const { data, bodyStart } = parseFrontmatter(content);
	const name = typeof data.name === "string" ? data.name.trim() : "";
	const description =
		typeof data.description === "string" ? data.description.trim() : "";
	if (!name || !description) return null;

	const meta = (data.metadata ?? {}) as Record<string, unknown>;
	// parseFrontmatter is flat-YAML; nested `metadata.type` won't appear in
	// `meta` — scan the raw frontmatter for it as a fallback.
	let memType =
		typeof meta.type === "string" ? meta.type.trim().toLowerCase() : "";
	if (!memType) {
		const lines = content.split("\n");
		let inMeta = false;
		// Skip the opening "---" (line 0); scan until the closing "---".
		for (let i = 1; i < lines.length; i++) {
			const ln = lines[i]!;
			if (ln.trim() === "---") break;
			if (/^metadata\s*:/.test(ln)) {
				inMeta = true;
				continue;
			}
			if (inMeta) {
				if (/^\S/.test(ln)) break; // left the metadata block
				const m = ln.match(/^\s+type\s*:\s*(.+)$/);
				if (m) {
					memType = m[1]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
					break;
				}
			}
		}
	}
	if (!memType) memType = "reference";

	// Body = everything after the frontmatter block.
	const body = content.split("\n").slice(bodyStart).join("\n").trim();

	// Harvest [[wiki-link]] targets as cross-link tags so memory cards connect
	// to workflow cards that name the same concept (e.g. both link [[git-pr-workflow-...]]).
	const linkTags = new Set<string>();
	const linkRe = /\[\[([^\]]+)\]\]/g;
	for (const line of content.split("\n")) {
		let m: RegExpExecArray | null;
		while ((m = linkRe.exec(line)) !== null) {
			const t = normTag(m[1]!.split(/[#|]/)[0]!);
			if (t) linkTags.add(t);
		}
	}

	return {
		id: `auto-memory:${name}`,
		type: "pattern",
		title: description.replace(/^["']|["']$/g, ""),
		detail: body || description,
		tags: ["auto-memory", memType, ...[...linkTags].slice(0, 8)],
		dimension: memType,
		confidence: 1,
		status: "active",
		superseded_by: null,
	};
}

// ---------------------------------------------------------------------------
// .knowledge.jsonl parsing
// ---------------------------------------------------------------------------

/** Parse newline-delimited JSON records. Blank lines and comments (#) ignored.
 *  Returns well-formed records plus per-line parse errors (never throws). */
export function parseKnowledgeJsonl(content: string): {
	records: KnowledgeRecord[];
	parseErrors: { line: number; reason: string }[];
} {
	const records: KnowledgeRecord[] = [];
	const parseErrors: { line: number; reason: string }[] = [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!.trim();
		if (raw === "" || raw.startsWith("#")) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(raw);
		} catch (e) {
			parseErrors.push({ line: i + 1, reason: `JSON parse: ${(e as Error).message}` });
			continue;
		}
		const rec = obj as Partial<KnowledgeRecord>;
		if (typeof rec.id !== "string" || rec.id === "") {
			parseErrors.push({ line: i + 1, reason: "missing/empty `id`" });
			continue;
		}
		if (typeof rec.title !== "string" || rec.title === "") {
			parseErrors.push({ line: i + 1, reason: `missing/empty \`title\` (id=${rec.id})` });
			continue;
		}
		// Coerce + default optional fields so downstream never sees undefined.
		records.push({
			id: rec.id,
			type: typeof rec.type === "string" ? rec.type : "pattern",
			title: rec.title,
			detail: typeof rec.detail === "string" ? rec.detail : "",
			tags: Array.isArray(rec.tags) ? rec.tags.map(String) : [],
			dimension: rec.dimension ?? null,
			confidence: typeof rec.confidence === "number" ? rec.confidence : 0,
			status: typeof rec.status === "string" ? rec.status : "active",
			superseded_by: rec.superseded_by ?? null,
			schema_version: rec.schema_version,
			evidence: rec.evidence,
			extracted_at: rec.extracted_at,
		});
	}
	return { records, parseErrors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slugify a record id into a filename-safe basename (keeps the namespace
 *  prefix legible: "ltx:cfg-scale-7-lever" -> "ltx-cfg-scale-7-lever"). */
export function slugify(id: string): string {
	return id
		.trim()
		.replace(/[:/\\]+/g, "-") // namespace + path separators
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase()
		.slice(0, 80) || "untitled";
}

/** Best-effort extraction of a YYYY-MM-DD from the heterogeneous timestamp
 *  formats the workflows emit (`20260620_091118`, `2026-06-14T22-47-40`,
 *  ISO `2026-06-23T22:34:02Z`). Returns "" if nothing parses. */
export function extractDate(...candidates: (string | undefined | null)[]): string {
	for (const c of candidates) {
		if (!c) continue;
		const m = c.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
		if (m) {
			const [, y, mo, d] = m;
			return `${y}-${mo}-${d}`;
		}
	}
	return "";
}

/** Normalise a tag for cross-link matching (lowercase, trimmed, spaces->-). */
function normTag(t: string): string {
	return t.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Compute the tag set used for linking + indexing a record. tags[0] is always
 *  "zettel" (validateZettelNote contract); then record type, the record's own
 *  tags, and dimension parts — all normalised, dedup'd, preserving order. */
function cardTags(rec: KnowledgeRecord): string[] {
	const out: string[] = ["zettel", normTag(rec.type)];
	for (const t of rec.tags) {
		const n = normTag(t);
		if (n && !out.includes(n)) out.push(n);
	}
	if (rec.dimension) {
		for (const part of rec.dimension.split(/[./]+/)) {
			const n = normTag(part);
			if (n && !out.includes(n)) out.push(n);
		}
	}
	return out;
}

/** Render a zettel card body for a record, with `## 連結` placeholder lines
 *  filled from `links`. The links arg is a list of display targets (already
 *  resolved note basenames or `Tags/...#anchor`). */
function renderCard(
	rec: KnowledgeRecord,
	created: string,
	tags: string[],
	links: string[],
	sourceLabel: string,
	maxDetailChars: number,
): string {
	const detail = rec.detail.length > maxDetailChars
		? rec.detail.slice(0, maxDetailChars) + "\n\n…(truncated)"
		: rec.detail;
	const ev = rec.evidence ?? {};
	const fm: Record<string, unknown> = {
		id: rec.id,
		created,
		tags,
		sources: [sourceLabel],
		source: sourceLabel,
		source_id: rec.id,
		record_type: rec.type,
		status: rec.status,
		superseded_by: rec.superseded_by ?? "",
		confidence: rec.confidence,
	};
	if (rec.dimension !== null) fm.dimension = rec.dimension;
	const fmText = renderFrontmatter(fm);

	const evidenceLines = [
		`- type: ${rec.type}`,
		`- confidence: ${rec.confidence}`,
		`- status: ${rec.status}${rec.superseded_by ? ` → superseded_by ${rec.superseded_by}` : ""}`,
	];
	if (typeof ev.occurrences === "number") evidenceLines.push(`- occurrences: ${ev.occurrences}`);
	if (ev.first_seen) evidenceLines.push(`- first_seen: ${ev.first_seen}`);
	if (ev.last_seen) evidenceLines.push(`- last_seen: ${ev.last_seen}`);
	if (rec.extracted_at) evidenceLines.push(`- extracted_at: ${rec.extracted_at}`);
	evidenceLines.push(`- provenance: ${sourceLabel}`);

	const linkLines =
		links.length > 0
			? links.map((l) => `- 相關：[[${l}]]`)
			: ["- (no shared-tag neighbours yet)"];

	return `${fmText}# ${rec.title}

## 核心想法
${detail || "—"}

## 證據 / 脈絡
${evidenceLines.join("\n")}

## 連結
${linkLines.join("\n")}
`;
}

/** Minimal YAML frontmatter renderer for the flat scalar/list values we emit.
 *  We do not pull in a YAML dep: every value here is a string/number or a
 *  string[] (flow form `[a, b]`). */
function renderFrontmatter(data: Record<string, unknown>): string {
	const lines: string[] = ["---"];
	for (const [k, v] of Object.entries(data)) {
		if (v == null || v === "") {
			lines.push(`${k}: `);
		} else if (Array.isArray(v)) {
			const items = v.map((x) => yamlScalar(x));
			lines.push(`${k}: [${items.join(", ")}]`);
		} else if (typeof v === "number") {
			lines.push(`${k}: ${v}`);
		} else {
			lines.push(`${k}: ${yamlScalar(v)}`);
		}
	}
	lines.push("---", "");
	return lines.join("\n");
}

function yamlScalar(v: unknown): string {
	const s = String(v);
	// Quote if it contains chars that would confuse parseFrontmatter's scalar
	// stripper (colon, bracket, leading quote, etc).
	if (/[:\[\]#"']/.test(s) || s.includes(", ")) return JSON.stringify(s);
	return s;
}

/** Read a card file's frontmatter tags (normalised) + source_id, for link
 *  computation and collision detection. Returns null if not a valid card. */
function readCardMeta(absPath: string): { tags: Set<string>; source_id?: string } | null {
	try {
		const content = readFileSync(absPath, "utf8");
		const { data } = parseFrontmatter(content);
		if (!data || !Array.isArray(data.tags)) return null;
		const tags = new Set(
			(data.tags as unknown[]).map((t) => normTag(String(t))),
		);
		return { tags, source_id: typeof data.source_id === "string" ? data.source_id : undefined };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// MOC
// ---------------------------------------------------------------------------

/** Build (or rebuild) a MOC grouping every card in the folder by record_type
 *  then by tag. Fully deterministic — regenerated from the on-disk cards each
 *  run, so it never drifts. */
function writeMoc(
	vaultPath: string,
	mocRel: string,
	cardsAbs: string[],
	dryRun: boolean,
): boolean {
	const groups = new Map<string, string[]>(); // group-key -> list of card names
	for (const abs of cardsAbs) {
		const meta = readCardMeta(abs);
		if (!meta) continue;
		const base = abs.slice(abs.lastIndexOf("/") + 1, -3); // strip ".md"
		// Group by the type tag if present (tags[1]); else "other".
		let type = "other";
		const typeTag = [...meta.tags][1];
		if (typeTag && typeTag !== "zettel") type = typeTag;
		if (!groups.has(type)) groups.set(type, []);
		groups.get(type)!.push(base);
	}
	for (const list of groups.values()) list.sort();

	const order = ["gotcha", "avoid", "lever", "pattern", "metric", "false_positive", "other"];
	const present = order.filter((g) => groups.has(g)).concat(
		[...groups.keys()].filter((g) => !order.includes(g)).sort(),
	);
	const lines: string[] = [
		"---",
		"id: knowledge-graph-moc",
		'created: "auto"',
		"tags: [zettel, moc, knowledge-graph]",
		"---",
		"",
		"# Knowledge Graph — Converged Cards MOC",
		"",
		"> Auto-generated by `zk_ingest`. Do not edit by hand — regenerate with a re-ingest.",
		"> One card per structured knowledge record, dedup'd by canonical id, cross-linked by shared tags.",
		"",
	];
	for (const g of present) {
		lines.push(`## ${g}`);
		lines.push("");
		for (const name of groups.get(g)!) lines.push(`- [[${name}]]`);
		lines.push("");
	}
	const content = lines.join("\n");
	const mocAbs = join(vaultPath, mocRel);
	if (dryRun) return true;
	mkdirSync(dirname(mocAbs), { recursive: true });
	writeFileSync(mocAbs, content, "utf8");
	return true;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Ingest a batch of structured records into the shared vault as zettel cards.
 *
 * Dedup: canonical key is `record.id`. The card filename is `slug(id).md` under
 * the convergence folder, so a re-ingest of the same record upserts in place
 * (created vs updated vs unchanged decided by content hash). Cross-links are
 * computed across ALL cards in the folder — so a card from a prior source
 * (e.g. hermes) links to today's workflow-jsonl card when they share a tag.
 */
export async function ingestRecords(
	records: KnowledgeRecord[],
	opts: IngestOptions,
): Promise<IngestSummary> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const mocPath = opts.mocPath ?? "Tags/Knowledge Graph.md";
	const maxLinks = opts.maxLinks ?? 8;
	const maxDetailChars = opts.maxDetailChars ?? 32_000;
	const dryRun = opts.dryRun === true;
	const folderAbs = join(opts.vaultPath, folder);

	if (!existsSync(opts.vaultPath)) {
		throw new Error(`vault does not exist: ${opts.vaultPath}`);
	}
	if (!dryRun) mkdirSync(folderAbs, { recursive: true });

	// 1. Snapshot existing cards in the folder (for cross-link + collision).
	const existing = new Map<string, { abs: string; tags: Set<string> }>(); // basename -> meta
	if (existsSync(folderAbs)) {
		for (const name of readdirSync(folderAbs)) {
			if (!name.endsWith(".md")) continue;
			const abs = join(folderAbs, name);
			const meta = readCardMeta(abs);
			if (!meta) continue;
			existing.set(name.slice(0, -3), { abs, tags: meta.tags });
		}
	}

	const summary: IngestSummary = {
		source: opts.source,
		sourceLabel: opts.sourceLabel,
		total: records.length,
		created: 0,
		updated: 0,
		unchanged: 0,
		skipped: 0,
		linked: 0,
		mocUpdated: false,
		vaultPath: opts.vaultPath,
		folder,
		cards: [],
		parseErrors: [],
	};

	// 2. Resolve a target filename per record (handle slug collisions).
	const planned: {
		rec: KnowledgeRecord;
		rel: string;
		abs: string;
		basename: string;
	}[] = [];
	const usedBasenames = new Set(existing.keys());
	for (const rec of records) {
		let base = slugify(rec.id);
		// Disambiguate slug collisions where the existing file is a DIFFERENT id.
		let candidate = base;
		let n = 2;
		while (usedBasenames.has(candidate)) {
			const prevAbs = join(folderAbs, `${candidate}.md`);
			const prev = readCardMeta(prevAbs);
			if (prev && prev.source_id === rec.id) {
				base = candidate; // same record → upsert in place
				break;
			}
			candidate = `${base}-${n++}`;
		}
		base = candidate;
		usedBasenames.add(base);
		const rel = `${folder}/${base}.md`;
		planned.push({ rec, rel, abs: join(opts.vaultPath, rel), basename: base });
	}

	// 3. Compute cross-link neighbours for each planned card against the full
	//    folder tag graph (existing + this batch). Shared-tag count ranks.
	const plannedTags = new Map(planned.map((p) => [p.basename, new Set(cardTags(p.rec))]));
	const allNeighbours: Map<string, string[]> = new Map(); // basename -> targets
	for (const p of planned) {
		const myTags = plannedTags.get(p.basename)!;
		const scored: { name: string; shared: number }[] = [];
		for (const [name, meta] of [
			...[...existing.entries()].map(([n, m]) => [n, m] as const),
			...[...plannedTags.entries()].map(([n, t]) => [n, { abs: "", tags: t }] as const),
		]) {
			if (name === p.basename) continue;
			let shared = 0;
			for (const t of myTags) if (meta.tags.has(t)) shared++;
			// Only count the meaningful tag overlaps (exclude the ubiquitous
			// "zettel" tag, which every card has and would flatten ranking).
			if (myTags.has("zettel") && meta.tags.has("zettel")) shared -= 1;
			if (shared > 0) scored.push({ name, shared });
		}
		scored.sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name));
		allNeighbours.set(
			p.basename,
			scored.slice(0, maxLinks).map((s) => s.name),
		);
	}

	// 4. Render + write each card (or report only, in dryRun).
	for (const p of planned) {
		const rec = p.rec;
		const created =
			extractDate(rec.evidence?.first_seen, rec.evidence?.extracted_at, rec.extracted_at) ||
			"1970-01-01";
		const tags = cardTags(rec);
		const links = allNeighbours.get(p.basename) ?? [];
		const content = renderCard(rec, created, tags, links, opts.sourceLabel, maxDetailChars);

		// Validate frontmatter-only (no idx → no dead-link false-positives mid-batch).
		const v = validateZettelNote(content);
		if (!v.ok) {
			summary.skipped++;
			summary.parseErrors.push({
				line: 0,
				reason: `card for ${rec.id} failed zettel validation: ${v.errors.join("; ")}`,
			});
			continue;
		}
		if (Buffer.byteLength(content, "utf8") > ZETTEL_MAX_BYTES) {
			summary.skipped++;
			summary.parseErrors.push({
				line: 0,
				reason: `card for ${rec.id} exceeds ${ZETTEL_MAX_BYTES / 1024}KB`,
			});
			continue;
		}

		let outcome: CardOutcome;
		const existedBefore = existing.has(p.basename);
		if (dryRun) {
			outcome = existedBefore ? "updated" : "created";
		} else if (!existedBefore) {
			writeFileSync(p.abs, content, "utf8");
			outcome = "created";
		} else {
			const prev = readFileSync(p.abs, "utf8");
			if (prev === content) {
				outcome = "unchanged";
			} else {
				writeFileSync(p.abs, content, "utf8");
				outcome = "updated";
			}
		}
		summary[outcome === "created" ? "created" : outcome === "updated" ? "updated" : "unchanged"]++;
		summary.linked += links.length;
		summary.cards.push({ id: rec.id, path: p.rel, status: outcome, links: links.length });
	}

	// 5. Regenerate the MOC from every card now in the folder (post-write).
	if (!dryRun || existsSync(folderAbs)) {
		const allCards = existsSync(folderAbs)
			? readdirSync(folderAbs)
					.filter((n) => n.endsWith(".md"))
					.map((n) => join(folderAbs, n))
			: [];
		if (allCards.length > 0) {
			summary.mocUpdated = writeMoc(opts.vaultPath, mocPath, allCards, dryRun);
		}
	}

	return summary;
}

/** Human-readable summary for CLI / tool output. */
export function formatSummary(s: IngestSummary): string {
	const rel = (p: string) => relative(s.vaultPath, join(s.vaultPath, p));
	const head = [
		`vault:   ${s.vaultPath}`,
		`folder:  ${rel(s.folder)}/`,
		`source:  ${s.source} (${s.sourceLabel})`,
		`total:   ${s.total} record(s) → ${s.created} created, ${s.updated} updated, ${s.unchanged} unchanged, ${s.skipped} skipped`,
		`links:   ${s.linked} cross-source edge(s) written`,
		`moc:     ${s.mocUpdated ? "regenerated " + rel("Tags/Knowledge Graph.md") : "(no MOC change)"}`,
	];
	if (s.parseErrors.length > 0) {
		head.push("", `parse errors (${s.parseErrors.length}):`);
		for (const e of s.parseErrors.slice(0, 12))
			head.push(`  line ${e.line}: ${e.reason}`);
		if (s.parseErrors.length > 12) head.push(`  …(+${s.parseErrors.length - 12} more)`);
	}
	return head.join("\n");
}

// VaultIndex is re-exported for downstream tooling that wants to feed a fresh
// index to validateZettelNote; ingestRecords itself does not need one.
export type { VaultIndex };
