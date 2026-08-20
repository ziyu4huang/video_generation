/** Wiki-aware duplicate matching + surgical in-place card merge (split from ingest.ts — hermes-arch-13). */
import { readFileSync, writeFileSync } from "node:fs";
import { tokeniseText } from "./similarity.ts";
import { cardAnatomy } from "./card-format.ts";
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

	// 1. Add sourceLabel to the `sources` frontmatter array if not present.
	const sourcesRe = /^(sources:\s*\[)([^\]]*)(\])/m;
	const sm = next.match(sourcesRe);
	if (sm) {
		const items = sm[2]!.split(",").map((s) => s.trim()).filter(Boolean);
		if (!items.includes(sourceLabel)) {
			items.push(sourceLabel);
			next = next.replace(sourcesRe, `${sm[1]}${items.join(", ")}${sm[3]}`);
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
