/**
 * Unit tests for the weekly news digest scaffold (lib/news.ts) — pure fns,
 * no network, no vault. Date anchors use the established Saturday chain
 * (2026-07-04 / 11 / 18 are Saturdays in the existing weekly-news corpus),
 * so a change to the week-anchoring logic fails loudly against real filenames.
 */
import { describe, test, expect } from "bun:test";
import {
	zhDate,
	getNewsWeek,
	newsFilename,
	generateNewsScaffold,
	planScaffoldWrite,
} from "../lib/news.ts";

describe("getNewsWeek", () => {
	test("mid-week date → that week's Monday–Saturday", () => {
		// 2026-07-15 is a Wednesday; the real corpus has llm-weekly-news-2026-07-18.md
		const week = getNewsWeek(new Date("2026-07-15T12:00:00"));
		expect(week.start).toBe("2026-07-13");
		expect(week.end).toBe("2026-07-18");
	});

	test("Saturday itself anchors its own week", () => {
		const week = getNewsWeek(new Date("2026-07-18T12:00:00"));
		expect(week.start).toBe("2026-07-13");
		expect(week.end).toBe("2026-07-18");
	});

	test("Sunday belongs to the week ending the FOLLOWING Saturday", () => {
		const week = getNewsWeek(new Date("2026-07-19T12:00:00"));
		expect(week.start).toBe("2026-07-20");
		expect(week.end).toBe("2026-07-25");
	});

	test("spans exactly 5 days (Mon → Sat)", () => {
		const week = getNewsWeek(new Date("2026-07-15T12:00:00"));
		const days =
			(new Date(`${week.end}T12:00:00`).getTime() -
				new Date(`${week.start}T12:00:00`).getTime()) /
			86_400_000;
		expect(days).toBe(5);
	});
});

describe("zhDate", () => {
	test("ISO → zh with unpadded month/day", () => {
		expect(zhDate("2026-07-13")).toBe("2026 年 7 月 13 日");
		expect(zhDate("2026-12-31")).toBe("2026 年 12 月 31 日");
	});
});

describe("newsFilename", () => {
	test("Saturday-anchored llm-weekly-news filename", () => {
		expect(newsFilename(new Date("2026-07-15T12:00:00"))).toBe(
			"llm-weekly-news-2026-07-18.md",
		);
	});
});

describe("generateNewsScaffold", () => {
	test("frontmatter carries the weekly digest tags", () => {
		const md = generateNewsScaffold({ start: "2026-07-13", end: "2026-07-18" });
		expect(md).toStartWith("---\ncreated: 2026-07-18\ntags:\n");
		expect(md).toContain("  - type/weekly");
		expect(md).toContain("  - domain/llm");
		expect(md).toContain("  - domain/news");
	});

	test("title spans the zh Monday–Saturday range, corpus short end form", () => {
		const md = generateNewsScaffold({ start: "2026-07-13", end: "2026-07-18" });
		expect(md).toContain(
			"# 📰 LLM 社群每週新聞 — 2026 年 7 月 13 日 ～ 7 月 18 日",
		);
	});

	test("title end date keeps the month when it differs from the start", () => {
		const md = generateNewsScaffold({ start: "2026-08-31", end: "2026-09-05" });
		expect(md).toContain(
			"# 📰 LLM 社群每週新聞 — 2026 年 8 月 31 日 ～ 9 月 5 日",
		);
	});

	test("next-issue preview is the following Saturday in the corpus zh form", () => {
		const md = generateNewsScaffold({ start: "2026-07-13", end: "2026-07-18" });
		expect(md).toContain("*下期預告：2026 年 7 月 25 日（六）*");
	});

	test("created defaults to the issue's Saturday; fill-in guide present", () => {
		const md = generateNewsScaffold({ start: "2026-07-13", end: "2026-07-18" });
		expect(md).toContain("created: 2026-07-18");
		expect(md).toContain("## 🔥 本週頭條：");
		expect(md).toContain("collect-news-llm skill");
	});
});

describe("planScaffoldWrite", () => {
	test("missing or empty file → write", () => {
		expect(planScaffoldWrite(null, false)).toBe("write");
		expect(planScaffoldWrite("", false)).toBe("write");
		expect(planScaffoldWrite("  \n\t", false)).toBe("write");
	});

	test("filled file without overwrite → skip (never clobber a digest)", () => {
		expect(planScaffoldWrite("---\ncreated: 2026-07-18\n---\n# 📰 …", false)).toBe("skip");
	});

	test("filled file with overwrite → overwrite", () => {
		expect(planScaffoldWrite("---\ncreated: 2026-07-18\n---", true)).toBe("overwrite");
	});
});
