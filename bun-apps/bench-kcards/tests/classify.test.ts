/**
 * classify.test.ts — census pin for the per-class question classifier
 * (kcard-hit3-residual T1). The census {anchored: 8, bare: 4, page: 5,
 * topical: 61} over golden-v2's 78 answerable questions IS the spec
 * (planner pre-adjudication): these pins survive regex refactors; a
 * census change means the classifier (or the golden set) moved and must
 * be re-adjudicated, never silently accepted.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyQuestion, distinctiveTokens, isRelationIntent } from "../src/lanes/classify.ts";

const GOLDEN_V2 = join(import.meta.dir, "..", "fixtures", "golden-v2");

function loadQuestions(): string[] {
	const out: string[] = [];
	for (const f of readdirSync(GOLDEN_V2).filter((f) => f.endsWith(".json")).sort()) {
		const g = JSON.parse(readFileSync(join(GOLDEN_V2, f), "utf8"));
		for (const q of g.questions) if (q.answerable) out.push(q.question);
	}
	return out;
}

describe("classifyQuestion — golden-v2 census pin (T1)", () => {
	const census = { "relation-anchored": 8, "relation-bare": 4, page: 5, topical: 61 };

	test("census over the 78 answerable questions is exactly the planner spec", () => {
		const qs = loadQuestions();
		expect(qs.length).toBe(78);
		const counted: Record<string, number> = {};
		for (const q of qs) counted[classifyQuestion(q)] = (counted[classifyQuestion(q)] ?? 0) + 1;
		expect(counted).toEqual(census);
	});

	test("the bare class is exactly the unservable template set (3 byte-equal + 1)", () => {
		const qs = loadQuestions().filter((q) => classifyQuestion(q) === "relation-bare");
		const unique = [...new Set(qs)];
		// 4 bare questions, 2 unique strings: the triple 「這張卡與哪兩張卡片
		// 有「相關」連結？」targets three DIFFERENT cards (no query-only
		// ranker can separate them) + the single-card 指向哪張卡片 variant.
		expect(qs.length).toBe(4);
		expect(unique.length).toBe(2);
		for (const q of qs) {
			expect(isRelationIntent(q)).toBe(true);
			expect(distinctiveTokens(q)).toEqual([]);
		}
	});

	test("anchored queries carry real anchor content in their distinctive tokens", () => {
		const anchored = loadQuestions().filter((q) => classifyQuestion(q) === "relation-anchored");
		expect(anchored.length).toBe(8);
		for (const q of anchored) expect(distinctiveTokens(q).length).toBeGreaterThan(0);
	});

	test("topical/page queries never classify as relation intent", () => {
		for (const q of loadQuestions()) {
			const c = classifyQuestion(q);
			if (c === "topical" || c === "page") expect(isRelationIntent(q)).toBe(false);
		}
	});
});
