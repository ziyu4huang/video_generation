/**
 * Weekly LLM community news digest — scaffold generation.
 *
 * The digest content itself is agent-researched (web search) and written in
 * the established study-news format (繁體中文, headline quote, per-story
 * sections with tables + source links). The code owns the repetitive parts:
 * the Saturday-anchored filename, frontmatter tags, zh title/date formatting,
 * and the skeleton, so every issue starts from the same shape. Pure module —
 * no I/O; the tool layer (extensions/research-tool.ts#collectNewsTool) owns
 * vault resolution, the overwrite guard, and writing.
 */
import { getWeekEndDate } from "./format.ts";

/** The digest week: Monday (inclusive) → Saturday (inclusive), ISO dates. */
export interface NewsWeek {
	/** Monday of the digest week, ISO yyyy-mm-dd. */
	start: string;
	/** Saturday of the digest week — also the filename anchor, ISO. */
	end: string;
}

function toIso(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${dd}`;
}

/** "2026-07-13" → "2026 年 7 月 13 日" (zh, unpadded — the digest title style). */
export function zhDate(iso: string): string {
	const [y, m, d] = iso.split("-").map(Number);
	return `${y} 年 ${m} 月 ${d} 日`;
}

/**
 * Strict "yyyy-mm-dd" → a local-noon Date, or null unless the string is a real
 * calendar date. Noon is the timezone-hard anchor: `new Date("2026-09-06")`
 * parses as UTC midnight, so in negative-UTC-offset locales the local day —
 * and with it the Saturday week anchor — slips back one day (a Sunday anchor
 * lands in the previous week). Noon sits ≥10h from local midnight even at the
 * extreme ±14h offsets, so the local calendar date always equals the ISO date.
 * The round-trip check rejects impossible dates (2026-02-30, 2026-13-01 …).
 */
export function parseIsoDate(iso: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const date = new Date(y, mo - 1, d, 12);
	if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
		return null;
	}
	return date;
}

/**
 * The digest week containing `date`: the week's Monday → Saturday (the same
 * Saturday anchor as every weekly-news file). A Sunday belongs to the week
 * ending the FOLLOWING Saturday (mirrors getWeekEndDate).
 */
export function getNewsWeek(date = new Date()): NewsWeek {
	const end = getWeekEndDate(date);
	const endDate = new Date(`${end}T12:00:00`);
	endDate.setDate(endDate.getDate() - 5);
	return { start: toIso(endDate), end };
}

/** e.g. llm-weekly-news-2026-07-18.md (Saturday-anchored, study-news convention). */
export function newsFilename(date = new Date()): string {
	return `llm-weekly-news-${getWeekEndDate(date)}.md`;
}

/**
 * Render the issue skeleton: frontmatter (tags: type/weekly, domain/llm,
 * domain/news), the zh title spanning the week, a headline-quote placeholder,
 * commented fill-in guidance, and the closing quick-hits + summary tables.
 * Title/preview formatting matches the existing corpus: the end date drops
 * the year (and month when shared with the start), and 下期預告 uses the zh
 * date form.
 */
export function generateNewsScaffold(week: NewsWeek, created = week.end): string {
	const startFull = zhDate(week.start);
	const [y, m] = week.start.split("-").map(Number);
	const endFull = zhDate(week.end);
	const endShort = endFull.startsWith(`${y} 年 `) ? endFull.slice(`${y} 年 `.length) : endFull;
	const nextPreview = new Date(`${week.end}T12:00:00`);
	nextPreview.setDate(nextPreview.getDate() + 7);
	const nextIso = toIso(nextPreview);
	const lines = [
		"---",
		`created: ${created}`,
		"tags:",
		"  - type/weekly",
		"  - domain/llm",
		"  - domain/news",
		"---",
		"",
		`# 📰 LLM 社群每週新聞 — ${startFull} ～ ${endShort}`,
		"",
		"> *本週重量級動態：<!-- 3–5 條一句話頭條，頓號分隔 -->。*",
		"",
		"<!--",
		"填寫指南（collect-news-llm skill）：",
		"1. 每則新聞一節：`## <emoji> <標題>`，標 `**日期：**`，內文含重點、表格與 `[來源](url)` 連結。",
		"2. 首節為 `## 🔥 本週頭條：<story>`（本週最重要的一則，展開寫）。",
		"3. 只寫有來源連結的新聞 — 不杜測。保留 frontmatter 與標題格式。",
		"4. 結尾附摘要表格（最受關注公司 / 上升最快 / 主導主題）與下期預告。",
		"-->",
		"",
		"## 🔥 本週頭條：<!-- 本週最重要的一則 -->",
		"",
		"**日期：** <!-- yyyy 年 m 月 d 日 -->",
		"",
		"<!-- 內文：重點、表格、引述；結尾一行來源：[來源](url) | [Outlet](url) -->",
		"",
		"---",
		"",
		"## ⚖️ 政策與產業動態",
		"",
		"<!-- 1–3 則，格式同頭條 -->",
		"",
		"---",
		"",
		"## 🤔 值得關注的其他動態",
		"",
		"| 主題 | 日期 | 一句話 |",
		"|------|------|--------|",
		"| <!-- ... --> | | |",
		"",
		"---",
		"",
		"| 指標 | 本週觀察 |",
		"|------|----------|",
		"| **最受關注公司** | |",
		"| **上升最快公司** | |",
		"| **主導主題** | |",
		"",
		`*下期預告：${zhDate(nextIso)}（六）*`,
		"",
	];
	return lines.join("\n");
}

export type ScaffoldAction = "write" | "overwrite" | "skip";

/**
 * Whether collect_news may write the scaffold. `write` on a fresh/empty file,
 * `overwrite` only when explicitly asked, `skip` when the issue already has
 * content — a filled digest must never be clobbered by a re-run.
 */
export function planScaffoldWrite(existing: string | null, overwrite: boolean): ScaffoldAction {
	if (existing === null || existing.trim() === "") return "write";
	return overwrite ? "overwrite" : "skip";
}
