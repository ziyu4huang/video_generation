/**
 * classify.ts — per-class diagnostic classification for the production
 * query lane (kcard-hit3-residual T1). Deterministic, question-text-only,
 * DERIVED (goldens are never touched — the same derived-column precedent
 * as the zeroTag column).
 *
 * Classes (planner census, pinned by tests/classify.test.ts on golden-v2:
 * {relation-anchored: 8, relation-bare: 4, page: 5, topical: 61}):
 *  - relation-*  — the query asks about the CARD GRAPH (連結 intent); its
 *    signal lives in `## 連結` sections, which cardEmbedText strips, so
 *    the embed lane cannot see it. Split: after stripping the relation
 *    template phrases, a query with a ≥2-char content remnant is
 *    "anchored" (the anchor phrase can match the target's 連結 section);
 *    one with none is "bare" — 3 of the 4 bare questions are byte-equal
 *    strings targeting three different cards, unservable by any
 *    question-only ranker (planner probe,
 *    .planning/2026-09-15-kcard-hit3-residual/evidence/planner-rel-probe.mjs).
 *  - page        — page-anchor lookups (第幾頁/幾頁). 篇幅-format questions
 *    are topical (planner census boundary: 篇幅 row is a content question).
 *  - topical     — everything else (the content-ranker's home class).
 */

/** Relation template phrases — stripped BEFORE tokenizing so that only
 *  content remains (straddle bigrams like 片有 from 卡片+有 are artifacts,
 *  not content). Function singles (與/有/的) go last so longer phrases
 *  win at each position. */
const RELATION_TEMPLATE_RE = /這張卡|卡片|哪兩張|哪一張|哪張|相關|連結|指向|互為|同屬|形成|對照|與哪|張卡|與|有|的/g;

/** Relation/deixis vocabulary at the token level — shared contract: the
 *  T2 relation lever counts only tokens OUTSIDE this set (the same
 *  "distinctive token" notion), so classifier and lever cannot drift. */
export const RELATION_STOP = new Set(
	"這張 張卡 卡片 的卡 與哪 哪張 哪兩 兩張 互為 的相 相關 連結 指向 同屬 形成 對照 位於 論文 什麼 哪些 如何".split(" "),
);

/** Relation-intent gate: the query asks about the card graph's 連結. */
export function isRelationIntent(q: string): boolean {
	return /連結/.test(q) && /相關|互為|同屬|指向/.test(q);
}

/** Distinctive tokens of a relation query: the template phrases are
 *  stripped first, then ASCII words + CJK-run bigrams of the remainder,
 *  minus the token-level stoplist. Empty ⇒ the query cannot name a
 *  target (the bare class). */
export function distinctiveTokens(q: string): string[] {
	const stripped = q.replace(RELATION_TEMPLATE_RE, " ");
	const tokens = new Set(stripped.toLowerCase().match(/[a-z0-9-]{3,30}/g) ?? []);
	for (const run of stripped.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/g) ?? []) {
		for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
	}
	return [...tokens].filter((t) => !RELATION_STOP.has(t));
}

export type QuestionClass = "relation-anchored" | "relation-bare" | "page" | "topical";

export function classifyQuestion(q: string): QuestionClass {
	if (isRelationIntent(q)) {
		return distinctiveTokens(q).length > 0 ? "relation-anchored" : "relation-bare";
	}
	if (/第幾頁|幾頁/.test(q)) return "page";
	return "topical";
}
