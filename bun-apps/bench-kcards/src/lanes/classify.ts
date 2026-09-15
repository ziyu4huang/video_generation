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

// The relation vocabulary helpers (template strip, stoplist,
// isRelationIntent, distinctiveRelationTokens) live in the knowledge-card
// card-format LEAF — the T2 relation lever in retrieve.ts consumes the
// SAME definitions, so classifier and lever cannot drift.
import {
	isRelationIntent,
	distinctiveRelationTokens as distinctiveTokens,
} from "@repo/s2-agent-ext-knowledge-card/src/card-format.ts";

export { isRelationIntent, distinctiveRelationTokens, RELATION_STOP } from "@repo/s2-agent-ext-knowledge-card/src/card-format.ts";

export type QuestionClass = "relation-anchored" | "relation-bare" | "page" | "topical";

export function classifyQuestion(q: string): QuestionClass {
	if (isRelationIntent(q)) {
		return distinctiveTokens(q).length > 0 ? "relation-anchored" : "relation-bare";
	}
	if (/第幾頁|幾頁/.test(q)) return "page";
	return "topical";
}
