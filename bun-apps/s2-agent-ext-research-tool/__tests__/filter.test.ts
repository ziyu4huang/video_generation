import { test, expect } from "bun:test";
import { resolveKeywords, filterRelevant, parseKeywords, DEFAULT_KEYWORDS } from "../lib/filter.ts";
import type { VideoResult } from "../lib/types.ts";

const v = (title: string): VideoResult => ({
	id: "", url: "", title, author: "", play: 0, danmaku: 0, favorites: 0,
	replies: 0, date: "", duration: "", thumbnail: "", tag: "", description: "",
});

test("resolveKeywords: preset defaults per platform", () => {
	expect(resolveKeywords("llm", undefined, "bilibili")).toBe(DEFAULT_KEYWORDS.llm);
	expect(resolveKeywords("media", undefined, "bilibili")).toBe(DEFAULT_KEYWORDS.media);
	expect(resolveKeywords("llm", undefined, "youtube")).toEqual(["LLM", "Large Language Model", "AI 2026"]);
});

test("resolveKeywords: explicit custom wins over preset", () => {
	expect(resolveKeywords("llm", ["my kw"], "bilibili")).toEqual(["my kw"]);
});

test("resolveKeywords: custom preset with no keywords falls back to llm", () => {
	expect(resolveKeywords("custom", undefined, "bilibili")).toBe(DEFAULT_KEYWORDS.llm);
	expect(resolveKeywords("custom", ["x", "y"], "bilibili")).toEqual(["x", "y"]);
});

test("filterRelevant: llm preset matches AI terms", () => {
	const videos = [v("Cooking pasta"), v("GPT-5 解析"), v("LLM 訓練實錄"), v("旅遊 Vlog")];
	const filtered = filterRelevant(videos, "llm");
	expect(filtered.map((x) => x.title)).toEqual(["GPT-5 解析", "LLM 訓練實錄"]);
});

test("filterRelevant: media preset matches AIGC terms", () => {
	const videos = [v("Midjourney 教學"), v("LLM 訓練"), v("AI 繪畫入門"), v("做菜")];
	const filtered = filterRelevant(videos, "media");
	expect(filtered.map((x) => x.title)).toEqual(["Midjourney 教學", "AI 繪畫入門"]);
});

test("filterRelevant: custom preset returns everything unfiltered", () => {
	const videos = [v("Cooking"), v("GPT"), v("random")];
	expect(filterRelevant(videos, "custom")).toHaveLength(3);
});

test("parseKeywords: comma split + trim + drop empties", () => {
	expect(parseKeywords("a, b ,c")).toEqual(["a", "b", "c"]);
	expect(parseKeywords("")).toBeUndefined();
	expect(parseKeywords(undefined)).toBeUndefined();
	expect(parseKeywords("  ,  ")).toBeUndefined();
});
