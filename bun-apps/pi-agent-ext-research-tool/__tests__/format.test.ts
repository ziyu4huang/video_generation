import { test, expect } from "bun:test";
import { fmtNum, fmtDuration, getWeekEndDate, generateMarkdown, weeklyFilename } from "../lib/format.ts";
import type { CollectionResult } from "../lib/types.ts";

test("fmtNum thresholds", () => {
	expect(fmtNum(0)).toBe("0");
	expect(fmtNum(999)).toBe("999");
	expect(fmtNum(1000)).toBe("1.0k");
	expect(fmtNum(1500)).toBe("1.5k");
	expect(fmtNum(9999)).toBe("10.0k"); // 9999/1000 = 9.999 → toFixed(1) = "10.0"
});

test("fmtNum 万 threshold (>=10000)", () => {
	expect(fmtNum(10000)).toBe("1.0萬");
	expect(fmtNum(100000)).toBe("10.0萬");
	expect(fmtNum(123456)).toBe("12.3萬");
});

test("fmtDuration pads seconds", () => {
	expect(fmtDuration("28:7")).toBe("28:07");
	expect(fmtDuration("3:5")).toBe("3:05");
	expect(fmtDuration("1:30:00")).toBe("1:30:00"); // H:MM:SS unchanged
});

test("getWeekEndDate anchors to Saturday", () => {
	// 2026-07-09 is a Thursday → Saturday is 2026-07-11
	expect(getWeekEndDate(new Date("2026-07-09T12:00:00Z"))).toBe("2026-07-11");
	// 2026-07-11 is already Saturday → same day
	expect(getWeekEndDate(new Date("2026-07-11T12:00:00Z"))).toBe("2026-07-11");
	// 2026-07-12 is Sunday → rolls to *next* Saturday 2026-07-18
	expect(getWeekEndDate(new Date("2026-07-12T12:00:00Z"))).toBe("2026-07-18");
});

test("weeklyFilename format", () => {
	expect(weeklyFilename("bilibili", "llm")).toMatch(/^bilibili-llm-\d{4}-\d{2}-\d{2}\.md$/);
	expect(weeklyFilename("youtube", "media")).toMatch(/^youtube-media-\d{4}-\d{2}-\d{2}\.md$/);
});

test("generateMarkdown produces frontmatter + sections for bilibili", () => {
	const result: CollectionResult = {
		platform: "bilibili",
		preset: "llm",
		dateStr: "2026-07-09",
		hot: [
			{ id: "BV1", url: "https://www.bilibili.com/video/BV1", title: "LLM 入門", author: "UP", play: 12000, danmaku: 100, favorites: 500, replies: 50, date: "2026-07-08", duration: "10:30", thumbnail: "", tag: "", description: "" },
		],
		groups: [
			{ keyword: "大模型", videos: [
				{ id: "BV2", url: "https://www.bilibili.com/video/BV2", title: "GPT 解析", author: "AI頻道", play: 1500, danmaku: 30, favorites: 200, replies: 10, date: "2026-07-07", duration: "5:0", thumbnail: "", tag: "", description: "" },
			] },
		],
	};
	const md = generateMarkdown(result);
	expect(md).toContain("created: 2026-07-09");
	expect(md).toContain("domain/llm");
	expect(md).toContain("source/bilibili");
	expect(md).toContain("type/collection");
	expect(md).toContain("## 🔥 全站熱門");
	expect(md).toContain("## 🔍 搜尋：`大模型`");
	expect(md).toContain("[LLM 入門](https://www.bilibili.com/video/BV1)");
	expect(md).toContain("1.2萬"); // fmtNum(12000)
});

test("generateMarkdown uses media + youtube tags correctly", () => {
	const md = generateMarkdown({
		platform: "youtube", preset: "media", dateStr: "2026-07-09",
		groups: [{ keyword: "Sora", videos: [] }],
	});
	expect(md).toContain("domain/media");
	expect(md).toContain("source/youtube");
	expect(md).toContain("無結果"); // empty group message
});
