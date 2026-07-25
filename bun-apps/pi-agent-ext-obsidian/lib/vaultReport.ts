/**
 * lib/vaultReport.ts — pure functions that summarize a VaultIndex into a
 * structured report and render it as Traditional-Chinese Markdown.
 *
 * Reuses existing health functions (graphOrphans, graphDeadLinks,
 * detectTitleStyleOutliers) so logic stays single-sourced.
 *
 * No I/O. The CLI layer reads content snippets if richer summaries are wanted.
 */
import type { VaultIndex } from "../extensions/obsidian.ts";
import {
	graphOrphans,
	graphDeadLinks,
	detectTitleStyleOutliers,
	tagPaths,
	resolveWikiLink,
} from "../extensions/obsidian.ts";
import { toGraphJSON } from "./graphExport.ts";

export interface VaultStats {
	noteCount: number;
	edgeCount: number;
	tagCount: number;
	orphans: number;
	deadLinks: number;
	folders: { folder: string; count: number }[];
}

export interface TagCluster {
	tag: string;
	count: number;
	notes: string[];
}

export interface TopicCluster {
	folder: string;
	notes: { path: string; title: string; tags: string[]; created?: string }[];
}

export interface VaultReport {
	generatedAt: string;
	stats: VaultStats;
	topTags: TagCluster[];
	topics: TopicCluster[];
	orphans: { path: string; title: string }[];
	deadLinks: { source: string; target: string }[];
	titleOutliers: { path: string; title: string; style: string }[];
}

/** Compute basic stats + tag/folder aggregates. */
export function summarizeVault(idx: VaultIndex, topTags = 10): VaultReport {
	const g = toGraphJSON(idx);

	// tag clusters sorted by count desc
	const tagClusters: TagCluster[] = [...idx.byTag.entries()]
		.map(([tag, paths]) => ({ tag, count: paths.size, notes: [...paths].sort() }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

	// folder clusters
	const folderMap = new Map<string, TopicCluster>();
	for (const [path, meta] of idx.notes) {
		const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "(root)";
		let t = folderMap.get(folder);
		if (!t) { t = { folder, notes: [] }; folderMap.set(folder, t); }
		t.notes.push({ path, title: meta.title || basename(path), tags: meta.tags, created: meta.created });
	}
	for (const t of folderMap.values()) t.notes.sort((a, b) => a.path.localeCompare(b.path));

	// orphans / dead links / title style. GraphResult carries the note title in
	// `text` (title or path fallback); map it onto the report's `title` field.
	const orphans = graphOrphans(idx).map((r) => ({ path: r.path, title: r.text }));
	const deadLinks = graphDeadLinks(idx).map((r) => ({ source: r.path, target: r.text }));
	const titleOutliers = detectTitleStyleOutliers(idx);

	const folderCounts = [...folderMap.values()]
		.map((t) => ({ folder: t.folder, count: t.notes.length }))
		.sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));

	const stats: VaultStats = {
		noteCount: g.nodes.length,
		edgeCount: g.edges.length,
		tagCount: idx.byTag.size,
		orphans: orphans.length, // = graphOrphans list (B2.2: no-inbound), NOT toGraphJSON's fully-isolated count
		deadLinks: deadLinks.length,
		folders: folderCounts,
	};

	return {
		generatedAt: new Date().toISOString(),
		stats,
		topTags: tagClusters.slice(0, topTags),
		topics: [...folderMap.values()].sort((a, b) => a.folder.localeCompare(b.folder)),
		orphans,
		deadLinks,
		titleOutliers,
	};
}

/** Render a VaultReport as Traditional-Chinese Markdown. */
export function renderReportMD(report: VaultReport): string {
	const s = report.stats;
	const lines: string[] = [];
	lines.push("# 📊 Vault 知識庫報告", "");
	lines.push(`> 產生時間：${report.generatedAt}`, "");
	lines.push("## 概覽", "");
	lines.push(`- 筆記數：**${s.noteCount}**`);
	lines.push(`- 連結數：**${s.edgeCount}**`);
	lines.push(`- 標籤數：**${s.tagCount}**`);
	lines.push(`- 資料夾數：**${s.folders.length}**`);
	lines.push(`- 孤立筆記（無入連結）：**${s.orphans}**`);
	lines.push(`- 失效連結：**${s.deadLinks}**`);
	lines.push("");

	// tag clusters
	lines.push("## 標籤聚類", "");
	if (report.topTags.length === 0) {
		lines.push("- （尚無標籤）");
	} else {
		for (const t of report.topTags) {
			lines.push(`- **#${t.tag}**（${t.count}）：${t.notes.map((p) => `\`${p}\``).join("、")}`);
		}
	}
	lines.push("");

	// folders
	lines.push("## 資料夾分佈", "");
	for (const f of s.folders) {
		lines.push(`- \`${f.folder}\`：${f.count} 篇`);
	}
	lines.push("");

	// topic clusters (per-folder note listing)
	lines.push("## 主題聚類", "");
	for (const topic of report.topics) {
		lines.push(`### \`${topic.folder}\``, "");
		for (const n of topic.notes) {
			const tagStr = n.tags.length ? ` ${n.tags.map((t) => `#${t}`).join(" ")}` : "";
			const dateStr = n.created ? ` _(${n.created})_` : "";
			lines.push(`- **${n.title}** (\`${n.path}\`)${tagStr}${dateStr}`);
		}
		lines.push("");
	}

	// health
	lines.push("## 健康度", "");
	lines.push(`### 孤立筆記（${report.orphans.length}）`, "");
	if (report.orphans.length === 0) {
		lines.push("- ✅ 無孤立筆記");
	} else {
		for (const o of report.orphans) lines.push(`- \`${o.path}\` — ${o.title}`);
	}
	lines.push("");
	lines.push(`### 失效連結（${report.deadLinks.length}）`, "");
	if (report.deadLinks.length === 0) {
		lines.push("- ✅ 無失效連結");
	} else {
		for (const d of report.deadLinks) lines.push(`- \`${d.source}\` → \`${d.target}\``);
	}
	lines.push("");
	lines.push(`### 標題風格離群（${report.titleOutliers.length}）`, "");
	if (report.titleOutliers.length === 0) {
		lines.push("- ✅ 標題風格一致");
	} else {
		for (const t of report.titleOutliers) lines.push(`- \`${t.path}\` [${t.style}] — ${t.title}`);
	}
	lines.push("");

	return lines.join("\n");
}

function basename(path: string): string {
	return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
}
