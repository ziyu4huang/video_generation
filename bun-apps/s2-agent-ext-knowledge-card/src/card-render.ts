/** Pure markdown → zettel-card rendering (split from ingest.ts — hermes-arch-13). */
import { yamlScalar, normTag } from "./card-format.ts";
import type { ExtractedEntity, Relation } from "@repo/s2-agent-core-interface";
import type { CardOutcome, IngestOptions, KnowledgeRecord } from "./types.ts";
export interface MarkdownFeatures {
	/** True iff at least one `> [!type]` callout block is present. */
	hasCallouts: boolean;
	/** Lowercased callout types, in source order (e.g. ["warning", "tip"]). */
	calloutTypes: string[];
	/** Headline text per callout (`[!type] headline`), lifted into the digest. */
	calloutTexts: string[];
	/** True iff any `- [ ]` or `- [x]` task line is present. */
	hasTasks: boolean;
	/** Count of open tasks (`- [ ]`). */
	openTaskCount: number;
	/** Count of closed tasks (`- [x]`). */
	closedTaskCount: number;
	/** Count of `![[...]]` embeds (image/note), NOT plain `[[...]]` links. */
	embedCount: number;
	/** Number of fenced code blocks (``` / ~~~). */
	codeBlockCount: number;
	/** Total lines inside fenced code blocks (density proxy). */
	codeBlockLines: number;
}

function emptyFeatures(): MarkdownFeatures {
	return {
		hasCallouts: false,
		calloutTypes: [],
		calloutTexts: [],
		hasTasks: false,
		openTaskCount: 0,
		closedTaskCount: 0,
		embedCount: 0,
		codeBlockCount: 0,
		codeBlockLines: 0,
	};
}

/** Detect Obsidian structured features in a markdown body. Callouts (`>
 *  [!type]`), tasks (`- [ ]` / `- [x]`), embeds (`![[...]]`), and fenced-code
 *  density are counted. Tasks/embeds inside code fences are NOT counted
 *  (they are code, not prose). Returns an empty result for empty input. */
export function extractFeatures(body: string): MarkdownFeatures {
	if (!body || !body.trim()) return emptyFeatures();
	const lines = body.split(/\r?\n/);
	const f = emptyFeatures();

	// 1. Callouts — a `> [!type]` line starts a block; the headline is the text
	//    after `]` on that line, falling back to the first `>` continuation.
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const m = line.match(/^>\s*\[!(\w+)\]\s*(.*)$/);
		if (!m) continue;
		const type = m[1]!.toLowerCase();
		f.calloutTypes.push(type);
		let headline = (m[2] ?? "").trim();
		if (!headline) {
			const next = lines[i + 1];
			if (next) {
				const nm = next.match(/^>\s?(.*)$/);
				if (nm) headline = nm[1]!.trim();
			}
		}
		f.calloutTexts.push(headline ? `[!${type}] ${headline}` : `[!${type}]`);
	}
	f.hasCallouts = f.calloutTypes.length > 0;

	// 2. Tasks / embeds / code density — single pass, code-fence aware.
	let inCode = false;
	for (const line of lines) {
		if (/^(\s*)```|^\s*~~~/.test(line)) {
			if (inCode) {
				f.codeBlockLines++;
				inCode = false;
			} else {
				inCode = true;
				f.codeBlockCount++;
			}
			continue;
		}
		if (inCode) {
			f.codeBlockLines++;
			continue;
		}
		if (/^[-*]\s+\[\s\]/.test(line)) f.openTaskCount++;
		else if (/^[-*]\s+\[[xX]\]/.test(line)) f.closedTaskCount++;
		// Embeds: `![[...]]` only (plain `[[...]]` wiki-links are NOT embeds).
		for (const _ of line.matchAll(/!\[\[([^\]]+)\]\]/g)) f.embedCount++;
	}
	f.hasTasks = f.openTaskCount + f.closedTaskCount > 0;
	return f;
}

export function cardTags(rec: KnowledgeRecord): string[] {
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
/** Shared detail truncation — the rendered card body AND the kgLlm extract
 *  prompt both pass through here (P2 FIX C: card-truncation parity, so a
 *  pathological record can never ship a multi-MB prompt to the chat
 *  endpoint). The default cap (when `maxDetailChars` is undefined) is the
 *  caller's: ingestRecords resolves it to 32_000 before either consumer. */
export function truncateDetail(detail: string, maxDetailChars: number): string {
	return detail.length > maxDetailChars
		? detail.slice(0, maxDetailChars) + "\n\n…(truncated)"
		: detail;
}

export function renderCard(
	rec: KnowledgeRecord,
	created: string,
	tags: string[],
	links: string[],
	sourceLabel: string,
	maxDetailChars: number,
	entities?: ExtractedEntity[],
	relations?: Relation[],
): string {
	const detail = truncateDetail(rec.detail, maxDetailChars);
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

	// Feature metadata (kg-improvement-plan P1): detect Obsidian callouts /
	// tasks / embeds / code density in the body that becomes 核心想法, and
	// carry them as ADDITIVE frontmatter keys. Written ONLY where the source
	// body has the feature, so feature-less records stay byte-identical to
	// pre-feature ingest (old cards validate + retrieve unchanged). Only the
	// callout fields carry a retrieval lever (ranking boost + context
	// surfacing); tasks/embeds/code are filter flags, not ranked.
	const feats = extractFeatures(detail);
	if (feats.hasCallouts) {
		fm.has_callouts = true;
		fm.callout_types = feats.calloutTypes;
	}
	if (feats.hasTasks) {
		fm.has_tasks = true;
		fm.open_task_count = feats.openTaskCount;
	}
	if (feats.embedCount > 0) fm.embed_count = feats.embedCount;
	if (feats.codeBlockLines > 0) fm.code_block_lines = feats.codeBlockLines;

	// Typed entities (SAG-inspired, kg-improvement-plan P8): when present
	// (linkWeighting:"idf" extracts them deterministically, or the source
	// JSONL supplied them pre-typed), carry them as ADDITIVE frontmatter so
	// retrieve.ts can use them as a cross-link / retrieval signal. Rendered as
	// quoted "type:name" strings (flat-YAML safe; yamlScalar quotes the colon).
	if (entities && entities.length > 0) {
		fm.entities = entities.map((e) => `${e.type}:${e.name}`);
	}

	// Relations (Phase-2 T3): emitted ONLY when the kg.llm LLM extractor
	// returned edges (write authority — the dictionary path passes undefined /,
	// from the fallback, []). The nested block is spliced into the frontmatter
	// AFTER `entities:` when present (sibling emission order), else at the end
	// of the fence. The block format is the shared cross-package contract:
	// zk `parseRelationsBlock` (retrieve.ts) and hermes
	// `KnowledgeSerializer.deserialize` both parse this exact shape.
	let fmText = renderFrontmatter(fm);
	if (relations && relations.length > 0) {
		fmText = spliceRelations(fmText, renderRelationsBlock(relations));
	}

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

/** Render the nested `relations:` frontmatter block (Phase-2 T3 — the LLM
 *  write-authority path). Focused emitter: a YAML block sequence of `{s, rel,
 *  o}` mappings whose exact byte shape is the shared cross-package contract:
 *
 *   relations:
 *     - s: a
 *       rel: references
 *       o: b
 *
 * Both readers parse this: zk's `parseRelationsBlock` (retrieve.ts — walks the
 * indented `- ` entries + their kv continuation lines, stripping a defensive
 * surrounding quote pair) and hermes's `KnowledgeSerializer.deserialize`
 * (`splitFencedYaml` → real YAML parse, canonicalizing `rel` on read). Values
 * reuse `yamlScalar` quoting so `:`-bearing / bracket-bearing ids stay
 * YAML-safe for both readers. NOT routed through `renderFrontmatter` — that
 * layer emits flat scalars/flow-lists only; relations need nesting. */
function renderRelationsBlock(relations: Relation[]): string {
	const lines: string[] = ["relations:"];
	for (const r of relations) {
		// Belt-and-braces: skip malformed entries whose s/rel/o are empty after
		// trim (normalizers upstream usually prevent this, but a blank scalar
		// here would corrupt the YAML block shape).
		if (!r.s.trim() || !r.rel.trim() || !r.o.trim()) continue;
		lines.push(`  - s: ${yamlScalar(r.s)}`);
		lines.push(`    rel: ${yamlScalar(r.rel)}`);
		lines.push(`    o: ${yamlScalar(r.o)}`);
	}
	return lines.join("\n");
}

/** Splice a rendered `relations:` block into an already-rendered frontmatter
 *  fence (the `---\n…\n---\n` string `renderFrontmatter` returns), after the
 *  top-level `entities:` line when present, else just before the closing
 *  fence. Returns the input unchanged when no insertion point exists. */
function spliceRelations(fmText: string, block: string): string {
	const lines = fmText.split("\n");
	// Last top-level `entities:` line inside the fence (entities is emitted
	// last by renderCard's key order, so end-of-fence == after entities in
	// practice; the explicit scan keeps the contract if key order ever shifts).
	let insertAt = -1;
	for (let k = lines.length - 1; k >= 0; k--) {
		if (/^entities:/.test(lines[k]!)) { insertAt = k + 1; break; }
	}
	if (insertAt === -1) {
		for (let k = lines.length - 1; k >= 0; k--) {
			if (lines[k]!.trim() === "---") { insertAt = k; break; }
		}
	}
	if (insertAt === -1) return fmText;
	lines.splice(insertAt, 0, block);
	return lines.join("\n");
} 
