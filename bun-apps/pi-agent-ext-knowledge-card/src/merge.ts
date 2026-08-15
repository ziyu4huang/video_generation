/**
 * src/merge.ts — deterministic semantic-ish duplicate detection + merge.
 *
 * zk_ingest dedups by canonical record `id` (exact). This module catches a
 * different class of duplication: two cards that describe the SAME concept
 * but were ingested under different ids / from different sources (e.g. a flux2
 * gotcha and a krea2 gotcha that are really the same insight, or a re-worded
 * memory entry that already exists). That is a SEMANTIC duplicate, not an
 * id-collision, so id-dedup misses it.
 *
 * Approach (deterministic, no embedding model — embeddings are explicitly out
 * of scope per the smart-knowledge-pipeline goal to avoid re-opening the
 * semantic-retrieval question):
 *   - Tokenise each active card's title + core-idea body (lowercase, split on
 *     non-alphanumeric, drop <3-char tokens + a small stopword set).
 *   - Pairwise token-set Jaccard similarity.
 *   - Pairs at or above `threshold` (default 0.9 — deliberately HIGH so a bad
 *     merge never collapses two merely-related ideas) are duplicate candidates.
 *
 * Merge is conservative + reversible:
 *   - canonical = the card with more inbound graph weight (tie-break: higher
 *     confidence, then lexicographically smaller id for determinism).
 *   - loser is marked status:superseded + superseded_by:<canonical id> and
 *     MOVED to `<folder>/_archive/` (out of the active retrieval path, exactly
 *     like the Stage-0 purge of legacy retired cards).
 *   - the loser's `相關：[[...]]` links are unioned into the canonical card.
 *   - every inbound `[[loser-slug]]` in active cards is rewritten to
 *     `[[canonical-slug]]` so the graph keeps its edges.
 *   - both titles are recorded as aliases (merge provenance) on canonical.
 *
 * Library only — no ExtensionAPI, no LLM, no network. Exposed via zk-query
 * `--merge-duplicates [--fix]` and optionally as a healGraph stage.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardAnatomy, readCardFrontmatterFields, readCardMeta, slugify } from "./card-format.ts";
import { tokeniseText, jaccard } from "./similarity.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeOptions {
	vaultPath: string;
	folder?: string;
	/** Minimum Jaccard similarity to treat two cards as duplicates (default 0.9). */
	threshold?: number;
	/** Report pairs only; do not merge (default false). */
	dryRun?: boolean;
}

export interface DuplicatePair {
	canonical: string; // card basename (slug, no .md)
	loser: string; // card basename (slug, no .md)
	canonicalId: string; // source_id of canonical
	loserId: string; // source_id of loser
	similarity: number;
}

export interface MergeResult {
	scanned: number;
	threshold: number;
	pairs: DuplicatePair[]; // all detected pairs (pre-merge)
	merged: number; // pairs actually merged (0 in dryRun)
	archived: string[]; // loser card vault-relative paths moved to _archive/
	linksRewritten: number; // inbound [[loser]] -> [[canonical]] rewrites
	cardsTouched: string[]; // canonical cards whose links/aliases changed
	dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Tokenisation (delegates to the shared similarity module)
// ---------------------------------------------------------------------------

/** Tokenise a card's title + 核心想法 body into a Set of normalised tokens.
 *  Uses the shared {@link tokeniseText} so the duplicate scanner and the
 *  wiki-aware ingest matcher agree on what counts as the same concept. */
function tokeniseCard(content: string): Set<string> {
	const { title, body } = cardAnatomy(content);
	return tokeniseText(`${title} ${body}`);
}

// ---------------------------------------------------------------------------
// Card snapshot
// ---------------------------------------------------------------------------

interface CardSnap {
	basename: string;
	abs: string;
	rel: string;
	sourceId: string;
	status: string;
	confidence: number;
	tags: Set<string>;
	tokens: Set<string>;
	inbound: number;
}

function snapshotCards(vaultPath: string, folder: string): CardSnap[] {
	const folderAbs = join(vaultPath, folder);
	if (!existsSync(folderAbs)) return [];
	const names = readdirSync(folderAbs).filter((n) => n.endsWith(".md"));

	// Count inbound links per basename (canonical `- 相關：[[slug]]` lines).
	const inbound = new Map<string, number>();
	for (const name of names) {
		const content = readFileSync(join(folderAbs, name), "utf8");
		for (const m of content.matchAll(/-\s+相關：\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
			const target = slugify(m[1]!.trim());
			inbound.set(target, (inbound.get(target) ?? 0) + 1);
		}
	}

	const snaps: CardSnap[] = [];
	for (const name of names) {
		const abs = join(folderAbs, name);
		const content = readFileSync(abs, "utf8");
		const meta = readCardMeta(abs);
		if (!meta) continue;
		const { status, sourceId, confidence } = readCardFrontmatterFields(content);
		if (status !== "active") continue;
		const basename = name.slice(0, -3);
		snaps.push({
			basename,
			abs,
			rel: `${folder}/${name}`,
			sourceId: typeof sourceId === "string" ? sourceId : basename,
			status,
			confidence,
			tags: meta.tags,
			tokens: tokeniseCard(content),
			inbound: inbound.get(basename) ?? 0,
		});
	}
	return snaps;
}

function pickCanonical(a: CardSnap, b: CardSnap): { canonical: CardSnap; loser: CardSnap } {
	if (a.inbound !== b.inbound)
		return a.inbound > b.inbound ? { canonical: a, loser: b } : { canonical: b, loser: a };
	if (a.confidence !== b.confidence)
		return a.confidence > b.confidence ? { canonical: a, loser: b } : { canonical: b, loser: a };
	return a.sourceId <= b.sourceId ? { canonical: a, loser: b } : { canonical: b, loser: a };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export function findDuplicatePairs(snaps: CardSnap[], threshold: number): DuplicatePair[] {
	const pairs: (DuplicatePair & { _sim: number })[] = [];
	for (let i = 0; i < snaps.length; i++) {
		for (let j = i + 1; j < snaps.length; j++) {
			const a = snaps[i]!;
			const b = snaps[j]!;
			let any = false;
			for (const t of a.tokens) { if (b.tokens.has(t)) { any = true; break; } }
			if (!any) continue;
			const sim = jaccard(a.tokens, b.tokens);
			if (sim >= threshold) {
				const { canonical, loser } = pickCanonical(a, b);
				pairs.push({
					canonical: canonical.basename,
					loser: loser.basename,
					canonicalId: canonical.sourceId,
					loserId: loser.sourceId,
					similarity: sim,
					_sim: sim,
				});
			}
		}
	}
	pairs.sort((a, b) => b._sim - a._sim);
	return pairs.map(({ _sim, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Merge execution
// ---------------------------------------------------------------------------

function extractLinks(content: string): string[] {
	const out: string[] = [];
	for (const m of content.matchAll(/-\s+相關：\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
		out.push(slugify(m[1]!.trim()));
	}
	return out;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceLinksSection(content: string, linkLines: string[]): string {
	const start = content.indexOf("\n## 連結");
	if (start < 0) return content;
	const bodyStart = start + "\n## 連結".length;
	const nextIdx = content.indexOf("\n## ", bodyStart);
	const sectionEnd = nextIdx < 0 ? content.length : nextIdx;
	const before = content.slice(0, bodyStart);
	const tail = content.slice(sectionEnd);
	return `${before}\n${linkLines.join("\n")}\n${tail}`;
}

function mergeOne(
	vaultPath: string,
	folder: string,
	pair: DuplicatePair,
): { archived: string; linksRewritten: number; canonicalTouched: boolean } {
	const folderAbs = join(vaultPath, folder);
	const canonAbs = join(folderAbs, `${pair.canonical}.md`);
	const loserAbs = join(folderAbs, `${pair.loser}.md`);
	const archiveDir = join(folderAbs, "_archive");

	const canonContent = readFileSync(canonAbs, "utf8");
	const loserContent = existsSync(loserAbs) ? readFileSync(loserAbs, "utf8") : "";

	// 1. Union loser's links into canonical (dedup, exclude self).
	const canonLinks = new Set(extractLinks(canonContent));
	for (const l of extractLinks(loserContent)) {
		const n = slugify(l);
		if (n && n !== pair.canonical) canonLinks.add(n);
	}
	let canonNext = canonContent;
	const canonLinksNow = extractLinks(canonContent);
	if (canonLinksNow.length !== canonLinks.size) {
		const linkLines = [...canonLinks].sort().map((l) => `- 相關：[[${l}]]`);
		canonNext = replaceLinksSection(canonContent, linkLines);
	}

	// 2. Record merge provenance as an HTML comment alias (idempotent).
	const aliasNote = `<!-- merged: ${pair.loserId} (similarity ${pair.similarity.toFixed(3)}) → ${pair.canonicalId} -->`;
	if (!canonNext.includes(aliasNote)) {
		const fmEnd = canonNext.indexOf("\n---");
		if (fmEnd >= 0) {
			const insertAt = fmEnd + "\n---".length;
			canonNext = canonNext.slice(0, insertAt) + "\n" + aliasNote + canonNext.slice(insertAt);
		}
	}
	const canonicalTouched = canonNext !== canonContent;

	// 3. Mark loser superseded in place, then move to _archive/.
	if (loserContent) {
		let loserNext = loserContent.replace(/^status:\s*.*$/m, `status: superseded`);
		if (/^superseded_by:\s*/m.test(loserNext)) {
			loserNext = loserNext.replace(/^superseded_by:\s*.*$/m, `superseded_by: "${pair.canonicalId}"`);
		} else {
			const fmEnd = loserNext.indexOf("\n---");
			if (fmEnd >= 0) {
				loserNext = loserNext.slice(0, fmEnd) + `\nsuperseded_by: "${pair.canonicalId}"` + loserNext.slice(fmEnd);
			}
		}
		writeFileSync(loserAbs, loserNext, "utf8");
		mkdirSync(archiveDir, { recursive: true });
		renameSync(loserAbs, join(archiveDir, `${pair.loser}.md`));
	}
	writeFileSync(canonAbs, canonNext, "utf8");

	// 4. Rewrite inbound [[loser]] -> [[canonical]] in every active card.
	const names = readdirSync(folderAbs).filter((n) => n.endsWith(".md"));
	let linksRewritten = 0;
	const loserLinkRe = new RegExp(`\\[\\[${escapeRegex(pair.loser)}(\\|[^\\]]*)?\\]\\]`, "g");
	for (const name of names) {
		const abs = join(folderAbs, name);
		const content = readFileSync(abs, "utf8");
		const next = content.replace(loserLinkRe, `[[${pair.canonical}$1]]`);
		if (next !== content) {
			writeFileSync(abs, next, "utf8");
			linksRewritten++;
		}
	}

	return { archived: `${folder}/_archive/${pair.loser}.md`, linksRewritten, canonicalTouched };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function mergeDuplicates(opts: MergeOptions): Promise<MergeResult> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const threshold = opts.threshold ?? 0.9;
	const dryRun = opts.dryRun === true;

	const snaps = snapshotCards(opts.vaultPath, folder);
	const pairs = findDuplicatePairs(snaps, threshold);

	const result: MergeResult = {
		scanned: snaps.length,
		threshold,
		pairs,
		merged: 0,
		archived: [],
		linksRewritten: 0,
		cardsTouched: [],
		dryRun,
	};
	if (dryRun || pairs.length === 0) return result;

	const archivedLosers = new Set<string>();
	for (const pair of pairs) {
		if (archivedLosers.has(pair.loser) || archivedLosers.has(pair.canonical)) continue;
		if (!existsSync(join(opts.vaultPath, folder, `${pair.loser}.md`))) continue;
		const r = mergeOne(opts.vaultPath, folder, pair);
		archivedLosers.add(pair.loser);
		result.merged++;
		result.archived.push(r.archived);
		result.linksRewritten += r.linksRewritten;
		if (r.canonicalTouched && !result.cardsTouched.includes(pair.canonical)) {
			result.cardsTouched.push(pair.canonical);
		}
	}
	return result;
}

export function formatMerge(m: MergeResult): string {
	const lines = [
		`scanned:    ${m.scanned} active card(s)`,
		`threshold:  ${m.threshold}`,
		`candidates: ${m.pairs.length} duplicate pair(s)`,
	];
	if (m.dryRun) {
		lines.push("(dry-run — no merges applied)");
	} else {
		lines.push(`merged:     ${m.merged} pair(s)`);
		lines.push(`archived:   ${m.archived.length} loser card(s) → _archive/`);
		lines.push(`rewritten:  ${m.linksRewritten} inbound link(s)`);
		lines.push(`touched:    ${m.cardsTouched.length} canonical card(s)`);
	}
	if (m.pairs.length > 0) {
		lines.push("", "duplicate pairs:");
		for (const p of m.pairs.slice(0, 30)) {
			lines.push(`  ${p.canonical}  ⊳  ${p.loser}  (sim=${p.similarity.toFixed(3)})`);
		}
		if (m.pairs.length > 30) lines.push(`  …(+${m.pairs.length - 30} more)`);
	}
	return lines.join("\n");
}
