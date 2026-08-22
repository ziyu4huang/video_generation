/** Wiki-aware duplicate matching + surgical in-place card merge (split from ingest.ts — hermes-arch-13). */
import { readFileSync, writeFileSync } from "node:fs";
import { parseFrontmatter } from "@repo/s2-agent-ext-obsidian";
import { tokeniseText } from "./similarity.ts";
import { cardAnatomy, clampSummary, mergeField, yamlScalar } from "./card-format.ts";
import { cardTags } from "./card-render.ts";
import type { CardOutcome, KnowledgeRecord } from "./types.ts";
// ---------------------------------------------------------------------------
// Wiki-aware merge helpers
// ---------------------------------------------------------------------------

/** Tokenise a card FILE's title + 核心想法 body for wiki-aware matching.
 *  Mirrors merge.ts's tokeniseCard so the duplicate scanner and the ingest
 *  matcher agree on token sets. */
export function tokeniseCardFile(content: string): Set<string> {
	const { title, body } = cardAnatomy(content);
	return tokeniseText(`${title} ${body}`);
}

/** Surgical in-place merge of a wiki-matched record into an EXISTING canonical
 *  card. Appends the new source's evidence + bumps last_seen WITHOUT replacing
 *  the canonical card's title/body/links (first-wins policy). Returns the card
 *  outcome: "updated" if content changed, "unchanged" if already merged. */
export function wikiMergeIntoCard(
	abs: string,
	rec: KnowledgeRecord,
	sourceLabel: string,
	similarity: number,
	today: string,
	dryRun: boolean,
): CardOutcome {
	const original = readFileSync(abs, "utf8");
	let next = original;
	let changed = false;

	// Parsed frontmatter (schema v2): the wiki merge consults the D4 merge-op
	// table (MERGE_OPS in card-format.ts) for the fields it touches — sources
	// union + summary replace + tags union here; id/created stay immutable by
	// the first-wins policy that never rewrites them.
	const fmData = parseFrontmatter(original).data ?? {};

	// 1. `sources` patch-union (merge-op table): add sourceLabel if not present.
	const currentSources = Array.isArray(fmData.sources)
		? (fmData.sources as unknown[]).map((s) => String(s))
		: [];
	const mergedSources = mergeField("sources", currentSources, [sourceLabel]) as string[];
	if (mergedSources.length !== currentSources.length) {
		const sourcesRe = /^(sources:\s*\[)([^\]]*)(\])/m;
		if (sourcesRe.test(next)) {
			next = next.replace(sourcesRe, `$1${mergedSources.map((s) => yamlScalar(s)).join(", ")}$3`);
			changed = true;
		}
	}

	// 1b. `summary` replace (merge-op table): the incoming record's L0 abstract
	//     is fresher than the canonical card's — replace when non-empty.
	const recSummary = rec.summary?.trim();
	if (recSummary && recSummary !== (typeof fmData.summary === "string" ? fmData.summary : "")) {
		const summaryLine = `summary: ${yamlScalar(clampSummary(recSummary))}`;
		if (/^summary:.*$/m.test(next)) {
			next = next.replace(/^summary:.*$/m, summaryLine);
		} else {
			next = next.replace(/^(record_type:.*)$/m, `$1\n${summaryLine}`);
		}
		changed = true;
	}

	// 1c. `tags` union (merge-op table): union the incoming record's card tags
	//     onto the canonical card's tags. Append-only order (existing tags
	//     first) keeps tags[1] — the MOC grouping slot — stable.
	const currentTags = Array.isArray(fmData.tags)
		? (fmData.tags as unknown[]).map((t) => String(t))
		: [];
	const mergedTags = mergeField(
		"tags",
		currentTags,
		cardTags(rec).filter((t) => t !== "zettel"),
	) as string[];
	if (mergedTags.length !== currentTags.length) {
		const tagsRe = /^(tags:\s*\[)([^\]]*)(\])/m;
		if (tagsRe.test(next)) {
			next = next.replace(tagsRe, `$1${mergedTags.join(", ")}$3`);
			changed = true;
		}
	}

	// 2. Append a wiki-merge provenance line to the 證據 / 脈絡 section.
	const mergeLine = `- wiki-merged: ${sourceLabel} (sim=${similarity.toFixed(3)}, ${today})`;
	if (!next.includes(mergeLine)) {
		const secHdr = "## 證據 / 脈絡";
		const secStart = next.indexOf(secHdr);
		if (secStart >= 0) {
			const bodyStart = secStart + secHdr.length;
			const nextSec = next.indexOf("\n## ", bodyStart);
			const secEnd = nextSec < 0 ? next.length : nextSec;
			const before = next.slice(0, secEnd).replace(/\n+$/, "");
			const tail = next.slice(secEnd);
			next = `${before}\n${mergeLine}\n${tail}`;
			changed = true;
		}
	}

	// 3. Bump last_seen to today (if a last_seen evidence line exists).
	const lsRe = /^(- last_seen:\s*).*$/m;
	if (lsRe.test(next)) {
		const bumped = next.replace(lsRe, `$1${today}`);
		if (bumped !== next) {
			next = bumped;
			changed = true;
		}
	}

	if (!changed) return "unchanged";
	if (!dryRun) writeFileSync(abs, next, "utf8");
	return "updated";
}
