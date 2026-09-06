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
	parseIsoDate,
} from "../lib/news.ts";

describe("parseIsoDate", () => {
	test("valid ISO date → local noon on that calendar day", () => {
		const d = parseIsoDate("2026-09-06");
		expect(d).not.toBeNull();
		expect(d!.getHours()).toBe(12);
		expect(d!.getFullYear()).toBe(2026);
		expect(d!.getMonth()).toBe(8);
		expect(d!.getDate()).toBe(6);
	});

	test("rejects non-ISO shapes and impossible calendar dates", () => {
		expect(parseIsoDate("2026-9-5")).toBeNull(); // unpadded
		expect(parseIsoDate("2026/09/05")).toBeNull();
		expect(parseIsoDate("Sept 5, 2026")).toBeNull();
		expect(parseIsoDate("2026-02-30")).toBeNull(); // rolls over if naively constructed
		expect(parseIsoDate("2026-13-01")).toBeNull();
		expect(parseIsoDate("2026-00-10")).toBeNull();
		expect(parseIsoDate("2026-02-29")).toBeNull(); // 2026 is not a leap year
		expect(parseIsoDate("")).toBeNull();
	});

	test("accepts real leap day", () => {
		expect(parseIsoDate("2028-02-29")!.getDate()).toBe(29);
	});
});

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

	test("Sunday anchor via parseIsoDate keeps its week in ANY timezone", () => {
		// Regression: the tool used to build the anchor with new Date("2026-09-06"),
		// which parses as UTC midnight — under TZ=America/Los_Angeles the local
		// day is still 09-05 (Saturday), so a Sunday anchor slipped into the
		// PREVIOUS week (2026-08-31 → 2026-09-05). The local-noon anchor is
		// offset-proof, so this expectation holds in every timezone.
		const week = getNewsWeek(parseIsoDate("2026-09-06")!);
		expect(week.start).toBe("2026-09-07");
		expect(week.end).toBe("2026-09-12");
	});

	test("week spanning a year boundary stays anchored per segment", () => {
		// 2026-12-30 is a Wednesday → Mon 2026-12-28 → Sat 2027-01-02.
		const week = getNewsWeek(parseIsoDate("2026-12-30")!);
		expect(week.start).toBe("2026-12-28");
		expect(week.end).toBe("2027-01-02");
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

	test("title keeps the full zh form when the week crosses a year boundary", () => {
		const md = generateNewsScaffold({ start: "2026-12-28", end: "2027-01-02" });
		expect(md).toContain(
			"# 📰 LLM 社群每週新聞 — 2026 年 12 月 28 日 ～ 2027 年 1 月 2 日",
		);
		expect(md).toContain("*下期預告：2027 年 1 月 9 日（六）*");
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
