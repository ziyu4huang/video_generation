/**
 * Markdown generation — shared across Bilibili + YouTube.
 *
 * Output follows the study-news weekly-news convention: YAML frontmatter,
 * emoji title, summary quote, `---` section dividers, clean pipe tables,
 * footer source line. Filename = Saturday-anchored date.
 */
import type { CollectionResult, VideoResult, Platform, Preset } from "./types.ts";

/* ================================================================
 * Number / date formatting
 * ================================================================ */

/** >=1萬 → X.X萬, >=1k → X.Xk, else plain. */
export function fmtNum(n: number): string {
	if (n >= 10_000) return (n / 10_000).toFixed(1) + "萬";
	if (n >= 1000) return (n / 1000).toFixed(1) + "k";
	return n.toString();
}

/** Normalize a duration string ("M:SS"/"MM:SS"/"H:MM:SS") — pad seconds. */
export function fmtDuration(d: string): string {
	if (typeof d !== "string") return String(d);
	const parts = d.split(":");
	if (parts.length === 2) {
		return `${parts[0]}:${(parts[1] ?? "0").padStart(2, "0")}`;
	}
	return d;
}

/** The Saturday of the week containing `date` (weekly-news filename anchor). */
export function getWeekEndDate(date = new Date()): string {
	const d = new Date(date);
	const day = d.getDay(); // 0=Sun ... 6=Sat
	const diff = day === 0 ? 6 : 6 - day;
	d.setDate(d.getDate() + diff);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${dd}`;
}

function esc(s: string): string {
	return (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

/* ================================================================
 * Filename
 * ================================================================ */

/** e.g. bilibili-llm-2026-07-11.md, youtube-llm-2026-07-11.md */
export function weeklyFilename(platform: Platform, preset: Preset): string {
	return `${platform}-${preset === "custom" ? "custom" : preset}-${getWeekEndDate()}.md`;
}

/* ================================================================
 * Section renderers
 * ================================================================ */

function renderBilibiliTable(videos: VideoResult[], withFav: boolean): string[] {
	const header = withFav
		? "| # | 影片 | UP 主 | 播放 | 彈幕 | 收藏 | 時長 | 日期 |"
		: "| # | 影片 | UP 主 | 播放 | 彈幕 | 時長 |";
	const sep = withFav
		? "|---|------|-------|------|------|------|------|------|"
		: "|---|------|-------|------|------|------|";
	const lines = [header, sep];
	videos.forEach((v, i) => {
		const cells = [
			String(i + 1),
			`[${esc(v.title)}](${v.url})`,
			esc(v.author),
			fmtNum(v.play),
			fmtNum(v.danmaku),
		];
		if (withFav) {
			cells.push(fmtNum(v.favorites), fmtDuration(v.duration), v.date);
		} else {
			cells.push(fmtDuration(v.duration));
		}
		lines.push(`| ${cells.join(" | ")} |`);
	});
	return lines;
}

function renderYoutubeTable(videos: VideoResult[]): string[] {
	const lines = [
		"| # | 影片 | 頻道 | 觀看 | 按讚 | 留言 | 時長 | 日期 |",
		"|---|------|------|------|------|------|------|------|",
	];
	videos.forEach((v, i) => {
		lines.push(
			`| ${i + 1} | [${esc(v.title)}](${v.url}) | ${esc(v.author)} | ${fmtNum(v.play)} | ${fmtNum(v.favorites)} | ${fmtNum(v.replies)} | ${fmtDuration(v.duration)} | ${v.date} |`,
		);
	});
	return lines;
}

/* ================================================================
 * Full document
 * ================================================================ */

const PLATFORM_LABEL: Record<Platform, string> = {
	bilibili: "B 站",
	youtube: "YouTube",
};

const PRESET_LABEL: Record<Preset, string> = {
	llm: "LLM",
	media: "AI 多媒體",
	custom: "自訂",
};

/** Render a CollectionResult into a full Markdown document. */
export function generateMarkdown(result: CollectionResult): string {
	const { platform, preset, groups, hot, dateStr } = result;
	const isBili = platform === "bilibili";
	const now = new Date();
	const lines: string[] = [];

	const sourceTag = isBili ? "source/bilibili" : "source/youtube";
	const domainTag = preset === "media" ? "domain/media" : "domain/llm";

	// Frontmatter
	lines.push("---");
	lines.push(`created: ${dateStr}`);
	lines.push("tags:");
	lines.push(`  - ${domainTag}`);
	lines.push(`  - ${sourceTag}`);
	lines.push("  - type/collection");
	lines.push("---");
	lines.push("");

	const label = `${PLATFORM_LABEL[platform]} ${PRESET_LABEL[preset]}`;
	lines.push(`# 📺 ${label}熱門影片 — ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`);
	lines.push("");

	// Summary
	const total = groups.reduce((s, g) => s + g.videos.length, 0);
	const parts: string[] = [];
	if (hot && hot.length > 0) parts.push(`全站熱門過濾出 ${hot.length} 筆相關影片`);
	parts.push(`${groups.length} 組關鍵字共 ${total} 筆結果`);
	const sourceName = isBili ? "Bilibili 搜尋 API" : "YouTube Data API v3";
	lines.push(`> *${parts.join("；")}。來源：${sourceName}。*`);
	lines.push("");

	// Hot section
	if (hot && hot.length > 0) {
		lines.push("---", "");
		lines.push("## 🔥 全站熱門 · 相關");
		lines.push("");
		lines.push(...(isBili ? renderBilibiliTable(hot, false) : renderYoutubeTable(hot)));
		lines.push("");
	}

	// Keyword sections
	for (const { keyword, videos } of groups) {
		lines.push("---", "");
		lines.push(`## 🔍 搜尋：\`${keyword}\``, "");
		if (videos.length === 0) {
			lines.push("> 無結果（可能被風控攔截或無配額）", "");
			continue;
		}
		lines.push(...(isBili ? renderBilibiliTable(videos, true) : renderYoutubeTable(videos)));
		lines.push("");
	}

	// Footer
	lines.push("---", "");
	const apiUrl = isBili ? "https://api.bilibili.com/" : "https://developers.google.com/youtube/v3";
	lines.push(`> *資料來源：[${sourceName}](${apiUrl})。整理日期：${dateStr}。*`, "");

	return lines.join("\n");
}
