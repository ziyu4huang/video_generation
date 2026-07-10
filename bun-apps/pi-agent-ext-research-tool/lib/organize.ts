/**
 * Vault frontmatter organizer — port of study-news organize-vault.js.
 *
 * Fixes vs. original:
 *  - No hardcoded VAULT path (passed as param, resolves via lib/vault.ts).
 *  - Uses file mtime (not birthtime, which is unreliable cross-platform).
 *  - Pure, testable functions (guessTags, injectFrontmatter) + a thin walker.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";

export interface TagInfo {
	tags: string[];
	aliases: string[];
}

/** Guess frontmatter tags from a file's vault-relative path + basename. */
export function guessTags(vaultRelative: string): TagInfo | null {
	const rel = vaultRelative.replace(/\\/g, "/");
	const name = basename(rel);

	// Exact-match table
	const exact: Record<string, TagInfo> = {
		"MOC-LLM-Zettelkasten.md": { tags: ["type/moc", "meta/index", "domain/zettelkasten", "domain/llm"], aliases: ["Map of Content", "索引"] },
		"Zettelkasten 方法論.md": { tags: ["type/note", "meta/methodology", "domain/zettelkasten"], aliases: ["Zettelkasten Methodology"] },
		"MCP 協定.md": { tags: ["type/note", "domain/llm", "domain/tool"], aliases: ["Model Context Protocol"] },
	};
	if (exact[name]) return exact[name];

	if (rel.startsWith("content/")) {
		if (name.includes("knowledge-")) {
			if (name.includes("mineru")) return { tags: ["type/knowledge", "domain/tool", "domain/parsing"], aliases: [] };
			return { tags: ["type/knowledge", "domain/llm"], aliases: [] };
		}
		const projectMap: [string, TagInfo][] = [
			["claude-obsidian", { tags: ["type/project", "domain/zettelkasten"], aliases: ["Claude Obsidian AI Second Brain"] }],
			["ztlgr", { tags: ["type/project", "domain/zettelkasten", "domain/rust"], aliases: [] }],
			["llm-kasten", { tags: ["type/project", "domain/zettelkasten", "domain/cli"], aliases: [] }],
			["stellavault", { tags: ["type/project", "domain/zettelkasten", "domain/3d"], aliases: [] }],
			["open-zk-kb", { tags: ["type/project", "domain/zettelkasten", "domain/memory"], aliases: [] }],
			["slipbox-mcp", { tags: ["type/project", "domain/zettelkasten", "domain/mcp"], aliases: [] }],
			["obsidian-llm-wiki", { tags: ["type/project", "domain/zettelkasten", "domain/llm"], aliases: [] }],
			["zettelkasten-classic", { tags: ["type/project", "domain/zettelkasten"], aliases: [] }],
			["knowledge-graph", { tags: ["type/project", "domain/zettelkasten", "domain/graph"], aliases: [] }],
			["pi-", { tags: ["type/study", "domain/pi"], aliases: [] }],
		];
		for (const [needle, info] of projectMap) {
			if (name.includes(needle)) return info;
		}
	}

	if (rel.startsWith("weekly-news/")) {
		if (name.includes("llm-weekly")) return { tags: ["type/weekly", "domain/llm", "domain/news"], aliases: [] };
		if (name.includes("github-weekly")) return { tags: ["type/weekly", "domain/github", "domain/opensource"], aliases: [] };
		if (name.includes("arxiv-weekly")) return { tags: ["type/weekly", "domain/arxiv", "domain/research"], aliases: [] };
		if (name.includes("bilibili")) return { tags: ["type/weekly", "domain/llm", "source/bilibili"], aliases: [] };
		if (name.includes("youtube")) return { tags: ["type/weekly", "domain/llm", "source/youtube"], aliases: [] };
		if (name.includes("pi-packages")) return { tags: ["type/weekly", "domain/pi", "source/pi-dev"], aliases: [] };
		return { tags: ["type/weekly", "domain/news"], aliases: [] };
	}

	if (rel.startsWith("zettel/")) return { tags: ["type/zettel", "meta/atomic"], aliases: [] };

	return null;
}

/** Inject/merge tags + aliases + created into a note's frontmatter. */
export function injectFrontmatter(content: string, tags: string[], aliases: string[], createdDate: string): string {
	const hasFm = content.startsWith("---");
	if (hasFm) {
		const end = content.indexOf("---", 3);
		let fm = content.slice(0, end + 3);
		const body = content.slice(end + 3).trim();
		if (!fm.includes("tags:")) {
			fm = fm.replace("---\n", `---\ntags:\n  ${tags.map((t) => `- ${t}`).join("\n  ")}\n`);
		}
		if (aliases.length > 0 && !fm.includes("aliases:")) {
			fm = fm.replace("---\n", `---\naliases:\n  ${aliases.map((a) => `- ${a}`).join("\n  ")}\n`);
		}
		if (!fm.includes("created:")) {
			fm = fm.replace("---\n", `---\ncreated: ${createdDate}\n`);
		}
		return `${fm}\n${body}\n`;
	}
	const fm = [
		"---",
		`created: ${createdDate}`,
		"tags:",
		...tags.map((t) => `  - ${t}`),
		...(aliases.length > 0 ? ["aliases:", ...aliases.map((a) => `  - ${a}`)] : []),
		"---",
		"",
		content.trim(),
		"",
	].join("\n");
	return fm;
}

export interface OrganizeResult {
	updated: string[];
	skipped: number;
	orphans: string[];
}

/** Walk a vault, tagging notes missing frontmatter. `dryRun` reports without writing. */
export function organizeVault(vaultRoot: string, dryRun = false): OrganizeResult {
	const updated: string[] = [];
	const orphans: string[] = [];
	let skipped = 0;

	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (extname(entry.name) === ".md") {
				const rel = relative(vaultRoot, full);
				const info = guessTags(rel);
				if (!info) {
					orphans.push(rel);
					continue;
				}
				const content = readFileSync(full, "utf-8");
				if (content.includes("tags:") && content.includes("type/")) {
					skipped++;
					continue;
				}
				const created = statSync(full).mtime.toISOString().slice(0, 10);
				const next = injectFrontmatter(content, info.tags, info.aliases, created);
				if (!dryRun) writeFileSync(full, next);
				updated.push(rel);
			}
		}
	};
	walk(vaultRoot);
	return { updated, skipped, orphans };
}
