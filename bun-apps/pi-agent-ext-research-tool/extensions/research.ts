/**
 * pi-agent-ext-research-tool — research collection extension.
 *
 * Three tools:
 *   • collect_videos         — unified Bilibili/YouTube collector (platform + preset)
 *   • organize_vault_notes   — auto-tag missing frontmatter, list orphans
 *   • import_memory_to_vault — pi-hermes-memory → vault-mind jsonl
 *
 * Three slash commands mapping to the collection presets.
 *
 * Output lands in the active vault's weekly-news/ (mirrors obsidian vault
 * resolution) unless an explicit outputPath is given.
 */
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { CollectionResult, KeywordGroup, Platform, Preset, VideoResult } from "../lib/types.ts";
import { resolveKeywords, filterRelevant, parseKeywords } from "../lib/filter.ts";
import { fetchBuvid3, searchVideos, fetchHotVideos, sleep } from "../lib/bilibili.ts";
import { searchYtKeyword, publishedAfterDays } from "../lib/youtube.ts";
import { generateMarkdown, weeklyFilename } from "../lib/format.ts";
import { resolveWritePath } from "../lib/vault.ts";
import { organizeVault } from "../lib/organize.ts";
import { importMemory, resolveHermesDir } from "../lib/import-memory.ts";
import { join } from "node:path";

/* ================================================================
 * collect_videos
 * ================================================================ */

const collectVideosTool = defineTool({
	name: "collect_videos",
	label: "Collect Videos",
	description:
		"Collect LLM/AI videos from Bilibili or YouTube and write a Markdown summary to the vault. " +
		"Unified collector: `platform` (bilibili|youtube) + `preset` (llm|media) select defaults; " +
		"pass `keywords` to override. Bilibili needs no key (optional `proxy` for 412 risk-control); " +
		"YouTube needs YOUTUBE_API_KEY. Output → <vault>/weekly-news/<platform>-<preset>-<saturday>.md " +
		"unless `outputPath` is given.",
	parameters: Type.Object({
		platform: Type.Union([Type.Literal("bilibili"), Type.Literal("youtube")], {
			description: "Source platform.",
		}),
		preset: Type.Union(
			[Type.Literal("llm"), Type.Literal("media"), Type.Literal("custom")],
			{ description: "Keyword preset + relevance filter. `custom` uses `keywords` verbatim, no filtering.", default: "llm" },
		),
		keywords: Type.Optional(
			Type.Array(Type.String(), {
				description: "Override keywords (comma-string also accepted via the command). Empty → preset defaults.",
			}),
		),
		pages: Type.Optional(Type.Number({ description: "Pages per keyword (each ≈20 bilibili / 50 youtube).", default: 1 })),
		order: Type.Optional(Type.String({ description: "Sort: click|pubdate|dm|stow (bilibili) / relevance|date|viewCount (youtube).", default: "click" })),
		popular: Type.Optional(Type.Boolean({ description: "Bilibili only: also pull the all-site popular feed and filter by preset.", default: false })),
		proxy: Type.Optional(Type.String({ description: "Bilibili proxy URL (e.g. http://127.0.0.1:7890) to bypass HTTP 412 risk-control." })),
		recency: Type.Optional(Type.Number({ description: "YouTube only: only videos from last N days (0 = all history).", default: 30 })),
		outputPath: Type.Optional(Type.String({ description: "Explicit output file (absolute or cwd-relative). Default: vault weekly-news/." })),
		dryRun: Type.Optional(Type.Boolean({ description: "Collect + report without writing the Markdown file.", default: false })),
	}),
	async execute(_id, params, _signal, _onUpdate, ctx) {
		const platform: Platform = params.platform;
		const preset: Preset = params.preset ?? "llm";
		const keywords = resolveKeywords(preset, params.keywords, platform);
		const pages = params.pages ?? 1;
		const order = params.order ?? (platform === "youtube" ? "relevance" : "click");
		const today = new Date().toISOString().split("T")[0] ?? "";

		const groups: KeywordGroup[] = [];
		let hot: VideoResult[] | undefined;
		const notes: string[] = [];

		if (platform === "bilibili") {
			const proxy = params.proxy;
			const buvid3 = await fetchBuvid3(proxy);
			const cookieStr = `buvid3=${buvid3};`;
			if (params.popular) {
				const hotAll = await fetchHotVideos(1, 50, cookieStr, proxy);
				hot = filterRelevant(hotAll, preset);
				notes.push(`popular: ${hot.length} relevant of ${hotAll.length}`);
			}
			for (const keyword of keywords) {
				const all: VideoResult[] = [];
				for (let p = 1; p <= pages; p++) {
					const videos = await searchVideos(keyword, { order, page: p, cookieStr, proxy });
					if (videos.length === 0) break;
					all.push(...videos);
					if (p < pages) await sleep(1500);
				}
				groups.push({ keyword, videos: all });
				notes.push(`"${keyword}": ${all.length}`);
			}
		} else {
			// youtube
			const apiKey = process.env.YOUTUBE_API_KEY;
			if (!apiKey) {
				return toolError(
					"YouTube collection requires YOUTUBE_API_KEY (YouTube Data API v3). " +
						"Set it: export YOUTUBE_API_KEY=\"...\" (Google Cloud Console).",
				);
			}
			const publishedAfter = publishedAfterDays(params.recency ?? 30);
			for (const keyword of keywords) {
				try {
					const videos = await searchYtKeyword(keyword, apiKey, { order, pages, publishedAfter });
					groups.push({ keyword, videos });
					notes.push(`"${keyword}": ${videos.length}`);
				} catch (err) {
					groups.push({ keyword, videos: [] });
					notes.push(`"${keyword}": ERROR ${(err as Error).message}`);
				}
			}
		}

		const result: CollectionResult = { platform, preset, groups, hot, dateStr: today };
		const markdown = generateMarkdown(result);

		const filename = weeklyFilename(platform, preset);
		const writePath = await resolveWritePath(ctx.cwd, filename, params.outputPath);
		if (!params.dryRun) {
			await mkdir(dirname(writePath), { recursive: true });
			await writeFile(writePath, markdown, "utf-8");
		}

		const total = groups.reduce((s, g) => s + g.videos.length, 0);
		return {
			content: [
				{
					type: "text" as const,
					text:
						`${params.dryRun ? "[dry-run] " : ""}Collected ${total} videos from ${platform} (${preset}).\n` +
						`Per-keyword: ${notes.join("; ")}.\n` +
						`${params.dryRun ? "Would write to" : "Written to"}: ${writePath}`,
				},
			],
			details: { platform, preset, total, groups: groups.length, hotCount: hot?.length ?? 0, writePath, dryRun: params.dryRun ?? false },
		};
	},
});

/* ================================================================
 * organize_vault_notes
 * ================================================================ */

const organizeTool = defineTool({
	name: "organize_vault_notes",
	label: "Organize Vault Notes",
	description:
		"Auto-tag frontmatter (tags/aliases/created) on vault notes that lack it, based on " +
		"filename + path patterns, and list unclassified orphan notes. Operates on the active " +
		"vault root. Use dryRun to preview without writing.",
	parameters: Type.Object({
		vaultRoot: Type.Optional(Type.String({ description: "Vault root (absolute or cwd-relative). Default: active vault." })),
		dryRun: Type.Optional(Type.Boolean({ description: "Report changes without writing.", default: false })),
	}),
	async execute(_id, params, _signal, _onUpdate, ctx) {
		const { resolveVaultRoot } = await import("../lib/vault.ts");
		const root = params.vaultRoot
			? (params.vaultRoot.startsWith("/") ? params.vaultRoot : join(ctx.cwd, params.vaultRoot))
			: await resolveVaultRoot(ctx.cwd);
		const res = organizeVault(root, params.dryRun ?? false);
		const lines: string[] = [];
		lines.push(`${params.dryRun ? "[dry-run] " : ""}Updated ${res.updated.length}, skipped ${res.skipped}, orphans ${res.orphans.length}.`);
		if (res.updated.length > 0) lines.push("Tagged:\n" + res.updated.map((u) => `  - ${u}`).join("\n"));
		if (res.orphans.length > 0) lines.push("Orphans (no tag rule):\n" + res.orphans.map((o) => `  - ${o}`).join("\n"));
		return {
			content: [{ type: "text" as const, text: lines.join("\n") }],
			details: { updated: res.updated.length, skipped: res.skipped, orphans: res.orphans.length, vaultRoot: root, dryRun: params.dryRun ?? false },
		};
	},
});

/* ================================================================
 * import_memory_to_vault
 * ================================================================ */

const importMemoryTool = defineTool({
	name: "import_memory_to_vault",
	label: "Import Memory to Vault",
	description:
		"Parse pi-hermes-memory entries (MEMORY.md / USER.md / failures.md) and append them to a " +
		"vault-mind JSONL collection (dedup by id). Output defaults to <vault>/collections/study_news.jsonl.",
	parameters: Type.Object({
		outputPath: Type.Optional(Type.String({ description: "JSONL output (absolute or cwd-relative). Default: <vault>/collections/study_news.jsonl." })),
		hermesDir: Type.Optional(Type.String({ description: "Override hermes-memory dir. Default: $HOME/.pi/agent/pi-hermes-memory or PI_HERMES_MEMORY_DIR." })),
		dryRun: Type.Optional(Type.Boolean({ description: "Parse + report without writing the JSONL file.", default: false })),
	}),
	async execute(_id, params, _signal, _onUpdate, ctx) {
		const { resolveVaultRoot } = await import("../lib/vault.ts");
		const hermesDir = params.hermesDir
			? (params.hermesDir.startsWith("/") ? params.hermesDir : join(ctx.cwd, params.hermesDir))
			: resolveHermesDir();
		const outputPath = params.outputPath
			? (params.outputPath.startsWith("/") ? params.outputPath : join(ctx.cwd, params.outputPath))
			: join(await resolveVaultRoot(ctx.cwd), "collections", "study_news.jsonl");
		if (!params.dryRun) {
			await mkdir(dirname(outputPath), { recursive: true });
		}
		const res = importMemory(outputPath, hermesDir, params.dryRun ?? false);
		return {
			content: [
				{
					type: "text" as const,
					text:
						`${params.dryRun ? "[dry-run] " : ""}Imported ${res.added} new entries (${res.existing} already present, ${res.total} parsed).\n` +
						`Source: ${hermesDir}\n${params.dryRun ? "Would write to" : "Output"}: ${res.outputPath}`,
				},
			],
			details: { ...res, dryRun: params.dryRun ?? false },
		};
	},
});

/* ================================================================
 * helpers
 * ================================================================ */

function toolError(message: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { error: message },
		isError: true,
	};
}

/* ================================================================
 * Slash commands → collect_videos presets
 * Each injects a user message that the agent fulfils via collect_videos.
 * ================================================================ */

function registerCollectCommand(
	pi: Parameters<ExtensionFactory>[0],
	name: string,
	platform: Platform,
	preset: Preset,
	description: string,
) {
	pi.registerCommand(name, {
		description,
		handler: async (args: string) => {
			const keywords = parseKeywords(args?.trim());
			const parts = [`collect_videos platform=${platform} preset=${preset}`];
			if (keywords) parts.push(`keywords=${JSON.stringify(keywords)}`);
			// Inject as a user message — the agent then invokes the tool.
			pi.sendUserMessage(parts.join(" "));
		},
	});
}

/* ================================================================
 * Extension factory
 * ================================================================ */

const extension: ExtensionFactory = (pi) => {
	pi.registerTool(collectVideosTool);
	pi.registerTool(organizeTool);
	pi.registerTool(importMemoryTool);

	registerCollectCommand(pi, "collect-bilibili-llm", "bilibili", "llm",
		"Collect Bilibili LLM/大模型 videos → vault weekly-news/. Optional: comma keywords.");
	registerCollectCommand(pi, "collect-bilibili-media", "bilibili", "media",
		"Collect Bilibili AI media/AIGC videos → vault weekly-news/. Optional: comma keywords.");
	registerCollectCommand(pi, "collect-youtube-llm", "youtube", "llm",
		"Collect YouTube LLM/AI videos → vault weekly-news/. Needs YOUTUBE_API_KEY. Optional: comma keywords.");
};

export default extension;
