/**
 * s2-agent-ext-research-tool — research collection extension.
 *
 * Six tools:
 *   • collect_videos         — unified Bilibili/YouTube collector (platform + preset)
 *   • organize_vault_notes   — auto-tag missing frontmatter, list orphans
 *   • import_memory_to_vault — pi-hermes-memory → vault-mind jsonl
 *   • arxiv_search           — search arXiv by query/category (ported from @wienerberliner/pi-arxiv)
 *   • arxiv_paper            — exact metadata lookup by arXiv ID/URL
 *   • arxiv_fetch2md         — fetch paper body as Markdown (arxiv2md) → <vault>/papers/
 *
 * Three slash commands mapping to the collection presets.
 *
 * Output lands in the active vault's weekly-news/ (collect_videos) or papers/
 * (arxiv_fetch2md), mirroring obsidian vault resolution, unless an explicit
 * outputPath is given.
 */
import {
	defineTool,
	type ExtensionFactory,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { CollectionResult, KeywordGroup, Platform, Preset, VideoResult } from "../lib/types.ts";
import { resolveKeywords, filterRelevant, parseKeywords } from "../lib/filter.ts";
import { fetchBuvid3, searchVideos, fetchHotVideos, sleep } from "../lib/bilibili.ts";
import { searchYtKeyword, publishedAfterDays } from "../lib/youtube.ts";
import { generateMarkdown, weeklyFilename } from "../lib/format.ts";
import { resolveWritePath, resolveVaultRoot } from "../lib/vault.ts";
import { organizeVault } from "../lib/organize.ts";
import { importMemory, resolveHermesDir } from "../lib/import-memory.ts";
import { join } from "node:path";
import {
	parseArxivId,
	searchPapers,
	lookupPaper,
	fetchMarkdown,
	formatPaper,
	renderPaperSummary,
	saveMarkdown,
	type SearchDetails,
	type PaperDetails,
	type FetchMarkdownDetails,
} from "../lib/arxiv.ts";

// ─── Gate families (wayfinder ticket 01 — reference form) ───────────────────
// Declared ONCE by id; the three collection tools share "collect_videos" and
// the three arxiv tools share "arxiv", each referenced via gating:{gate}.
// buildEffectiveGates groups each family into ONE co-firing gate (names[0] ===
// "collect_videos" / "arxiv_search") — the former per-tool verbatim
// duplication is gone; edit a family here, all its tools follow.
GATE_DEFS["collect_videos"] = {
	id: "collect_videos",
	keywords: [
		"bilibili", "youtube", "collect videos", "video trending",
		"vault notes", "organize vault", "import memory",
		"收集影片", "整理筆記",
	],
	requires: {
		nouns: ["clip", "clips", "footage", "videos", "platform", "vault", "影片", "短片", "平台", "筆記"],
		verbs: ["gather", "collect", "pull", "organize", "scrape", "收集", "整理", "抓"],
	},
	description: "Bilibili/YouTube collection + vault notes organization",
};
GATE_DEFS["arxiv"] = {
	id: "arxiv",
	keywords: ["arxiv", "論文", "找論文", "抓論文", "讀論文", "search paper", "search papers", "find paper", "find papers"],
	requires: {
		nouns: ["paper", "papers", "論文"],
		verbs: ["search", "find", "fetch", "read", "look up", "找", "查", "搜尋", "讀"],
	},
	description: "arXiv search / paper lookup / fetch-to-markdown",
};

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
	// Owner-declared gating — migrated from tool-gate's hardcoded GATES (was the
	// {names:["collect_videos","organize_vault_notes","import_memory_to_vault"]}
	// gate). Per ticket 09's semantics-preserving rule, the SAME gating is
	// mirrored on organize_vault_notes + import_memory_to_vault so all three
	// activate together and reconstructOwnerDeclaredGates collapses them back
	// into one multi-name gate (names[0] === "collect_videos"). Keywords cover
	// the unambiguous bilibili/youtube/collect videos/vault phrases + CJK; the
	// noun∧verb `requires` path mirrors flux2 so keyword-free paraphrases (gather
	// clips / pull footage / 整理 vault 筆記) also reach the gate (gate-recall
	// adversarial floor 0.9).
	gating: { gate: "collect_videos" }, // reference form (ticket 01) — family in GATE_DEFS["collect_videos"]
	parameters: Type.Object({
		platform: StringEnum(["bilibili", "youtube"] as const, {
			description: "Source platform.",
		}),
		preset: StringEnum(["llm", "media", "custom"] as const, {
			description: "Keyword preset + relevance filter. `custom` uses `keywords` verbatim, no filtering.",
			default: "llm",
		}),
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
	// Owner-declared gating — mirrored IDENTICALLY from collect_videos (same
	// signature) so reconstructOwnerDeclaredGates collapses the three vault
	// tools into one multi-name gate
	// {names:["collect_videos","organize_vault_notes","import_memory_to_vault"]}
	// (ticket 09). Co-fire preserved: when the gate fires, all three names
	// activate together. See collect_videos's gating comment.
	gating: { gate: "collect_videos" }, // reference form (ticket 01) — family in GATE_DEFS["collect_videos"]
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
	// Owner-declared gating — mirrored IDENTICALLY from collect_videos (same
	// signature) so reconstructOwnerDeclaredGates collapses the three vault
	// tools into one multi-name gate
	// {names:["collect_videos","organize_vault_notes","import_memory_to_vault"]}
	// (ticket 09). Co-fire preserved: when the gate fires, all three names
	// activate together. See collect_videos's gating comment.
	gating: { gate: "collect_videos" }, // reference form (ticket 01) — family in GATE_DEFS["collect_videos"]
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
 * arXiv tools — ported from @wienerberliner/pi-arxiv.
 * Logic lives in lib/arxiv.ts (pure); this layer owns truncation,
 * vault writes, and TUI rendering. Library-folder discovery /
 * /arxiv-library command were dropped: arxiv_fetch2md writes into
 * the active vault's papers/ via the shared vault resolver.
 * ================================================================ */

function truncateForTool(text: string): { text: string; truncated: boolean } {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let output = truncation.content;
	if (truncation.truncated) {
		output += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`;
	}
	return { text: output, truncated: truncation.truncated };
}

const arxivSearchTool = defineTool({
	name: "arxiv_search",
	label: "arXiv Search",
	description:
		"Search arXiv papers by query, optional category, sorting, and pagination. Returns titles, authors, abstracts, dates, categories, and links. Use arxiv_search when the user asks to find papers, recent papers, related work, or papers in an arXiv category; follow with arxiv_fetch2md when the full body of a specific paper is needed.",
	gating: { gate: "arxiv" }, // reference form (ticket 01) — family in GATE_DEFS["arxiv"]
	// Owner-declared gating — migrated from tool-gate's hardcoded GATES (was the
	// {names:["arxiv_search","arxiv_fetch2md","arxiv_paper"]} gate). Per ticket
	// 09's semantics-preserving rule, the SAME gating is mirrored on arxiv_paper
	// + arxiv_fetch2md so all three activate together and
	// reconstructOwnerDeclaredGates collapses them back into one multi-name gate
	// (names[0] === "arxiv_search"). Mirrors the original GATES entry verbatim:
	// narrow "arxiv" word-boundary keyword + CJK 論文 + a noun∧verb `requires`
	// (paper∧find/read) so "find papers" fires but bare "paper cut" doesn't.
	parameters: Type.Object({
		query: Type.String({ description: "Search query, e.g. 'diffusion policies robotics'" }),
		category: Type.Optional(Type.String({ description: "Optional arXiv category filter, e.g. cs.RO, cs.LG, cs.CV, stat.ML" })),
		max_results: Type.Optional(Type.Number({ description: "Max papers to return (default 10, max 50)", default: 10 })),
		sort_by: Type.Optional(
			StringEnum(["relevance", "lastUpdatedDate", "submittedDate"] as const, { description: "Sort order (default relevance)" }),
		),
		sort_order: Type.Optional(
			StringEnum(["ascending", "descending"] as const, { description: "Sort direction (default descending)" }),
		),
		start: Type.Optional(Type.Number({ description: "Start index for pagination (default 0)", default: 0 })),
	}),
	async execute(_toolCallId, params, signal) {
		const { papers, totalResults, start } = await searchPapers(
			{
				query: params.query,
				category: params.category,
				maxResults: params.max_results,
				sortBy: params.sort_by,
				sortOrder: params.sort_order,
				start: params.start,
			},
			signal,
		);

		if (papers.length === 0) {
			return {
				content: [{ type: "text" as const, text: `No papers found for query: ${params.query}` }],
				details: { query: params.query, category: params.category, totalResults: 0, returned: 0, start, papers: [] } satisfies SearchDetails,
			};
		}

		const body = papers.map((paper, index) => formatPaper(paper, index)).join("\n\n");
		const { text } = truncateForTool(`Found ${totalResults} papers (showing ${start + 1}-${start + papers.length}):\n\n${body}`);
		return {
			content: [{ type: "text" as const, text }],
			details: { query: params.query, category: params.category, totalResults, returned: papers.length, start, papers } satisfies SearchDetails,
		};
	},
	renderCall(args, theme) {
		let text = `${theme.bold("arxiv_search")} ${theme.fg("accent", `"${String(args.query ?? "")}"`)}`;
		if (args.category) text += theme.fg("muted", ` cat:${String(args.category)}`);
		return new Text(text, 0, 0);
	},
	renderResult(result, { expanded }, theme) {
		const details = result.details as SearchDetails | undefined;
		if (!details || details.returned === 0) return new Text(theme.fg("dim", "No papers found"), 0, 0);
		let text = theme.fg("success", `${details.totalResults} results`) + theme.fg("dim", ` (showing ${details.returned})`);
		if (expanded) {
			for (const paper of details.papers) {
				text += "\n\n" + theme.fg("accent", theme.bold(paper.title));
				text += "\n" + theme.fg("dim", `${paper.id} · ${paper.published.slice(0, 10)} · ${paper.authors.slice(0, 3).join(", ")}${paper.authors.length > 3 ? " et al." : ""}`);
			}
		}
		return new Text(text, 0, 0);
	},
});

const arxivPaperTool = defineTool({
	name: "arxiv_paper",
	label: "arXiv Paper",
	description: "Fetch exact metadata for one arXiv paper by ID or URL. Returns title, authors, abstract, dates, categories, and links. Use arxiv_paper when the user gives a specific arXiv ID/URL and wants metadata or abstract.",
	gating: { gate: "arxiv" }, // reference form (ticket 01) — family in GATE_DEFS["arxiv"]
	// Owner-declared gating — mirrored IDENTICALLY from arxiv_search (same
	// signature) so reconstructOwnerDeclaredGates collapses the three arxiv
	// tools into one multi-name gate
	// {names:["arxiv_search","arxiv_paper","arxiv_fetch2md"]} (ticket 09).
	// Co-fire preserved: when the gate fires, all three names activate
	// together. See arxiv_search's gating comment.
	parameters: Type.Object({
		id: Type.String({ description: "arXiv ID or URL, e.g. 2401.12345v2 or https://arxiv.org/abs/2401.12345" }),
	}),
	async execute(_toolCallId, params, signal) {
		const paper = await lookupPaper(params.id, signal);
		const details: PaperDetails = { paper };
		return {
			content: [{ type: "text" as const, text: paper ? formatPaper(paper) : `Paper not found: ${params.id}` }],
			details,
		};
	},
	renderCall(args, theme) {
		return new Text(`${theme.bold("arxiv_paper")} ${theme.fg("accent", String(args.id ?? ""))}`, 0, 0);
	},
	renderResult(result, { expanded }, theme) {
		const details = result.details as PaperDetails | undefined;
		if (!details?.paper) return new Text(theme.fg("error", "Paper not found"), 0, 0);
		let text = theme.fg("accent", theme.bold(details.paper.title));
		text += "\n" + theme.fg("dim", `${details.paper.id} · ${details.paper.published.slice(0, 10)}`);
		if (expanded) text += "\n\n" + details.paper.abstract;
		return new Text(text, 0, 0);
	},
});

const arxivFetchTool = defineTool({
	name: "arxiv_fetch2md",
	label: "arXiv Fetch Markdown",
	description:
		"Fetch the full body of an arXiv paper as Markdown using arxiv2md; prefer it over scraping PDFs (it preserves sections + math via the HTML pipeline). Saves the Markdown to <vault>/papers/ unless save=false or output_path is given. Use arxiv_fetch2md when the user asks to read, analyze, summarize, or quote the full body of a specific arXiv paper.",
	gating: { gate: "arxiv" }, // reference form (ticket 01) — family in GATE_DEFS["arxiv"]
	// Owner-declared gating — mirrored IDENTICALLY from arxiv_search (same
	// signature) so reconstructOwnerDeclaredGates collapses the three arxiv
	// tools into one multi-name gate
	// {names:["arxiv_search","arxiv_paper","arxiv_fetch2md"]} (ticket 09).
	// Co-fire preserved: when the gate fires, all three names activate
	// together. See arxiv_search's gating comment.
	parameters: Type.Object({
		id: Type.String({ description: "arXiv ID or URL, e.g. 2501.11120v1 or https://arxiv.org/abs/2501.11120v1" }),
		save: Type.Optional(Type.Boolean({ description: "Whether to save the Markdown file (default true)", default: true })),
		output_path: Type.Optional(
			Type.String({ description: "Explicit output file (absolute or cwd-relative). Default: <vault>/papers/<id> - <title>.md" }),
		),
		remove_refs: Type.Optional(Type.Boolean({ description: "Ask arxiv2md to remove references (default true)", default: true })),
		remove_toc: Type.Optional(Type.Boolean({ description: "Ask arxiv2md to remove table of contents (default true)", default: true })),
		remove_citations: Type.Optional(Type.Boolean({ description: "Ask arxiv2md to remove inline citations/internal links (default true)", default: true })),
		frontmatter: Type.Optional(Type.Boolean({ description: "Ask arxiv2md to include YAML frontmatter (default true)", default: true })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const id = parseArxivId(params.id);
		const paper = await lookupPaper(id, signal).catch(() => null);
		const { markdown, sourceUrl } = await fetchMarkdown(
			id,
			{
				removeRefs: params.remove_refs,
				removeToc: params.remove_toc,
				removeCitations: params.remove_citations,
				frontmatter: params.frontmatter,
			},
			signal,
		);

		const save = params.save ?? true;
		let outputPath: string | undefined;
		let saveDirectory: string | undefined;
		if (save) {
			if (params.output_path) {
				outputPath = params.output_path.startsWith("/") ? params.output_path : join(ctx.cwd, params.output_path);
				saveDirectory = dirname(outputPath);
				await mkdir(saveDirectory, { recursive: true });
				await writeFile(outputPath, markdown, "utf8");
			} else {
				saveDirectory = join(await resolveVaultRoot(ctx.cwd), "papers");
				outputPath = await saveMarkdown(id, paper?.title, markdown, saveDirectory);
			}
		}

		const lineCount = markdown.split("\n").length;
		const bytes = Buffer.byteLength(markdown);
		const { text, truncated } = truncateForTool(
			`${paper ? `# ${renderPaperSummary(paper)}\n\n` : ""}${outputPath ? `Saved Markdown to: ${outputPath}\nSource: ${sourceUrl}\n\n` : `Source: ${sourceUrl}\n\n`}${markdown}`,
		);

		return {
			content: [{ type: "text" as const, text }],
			details: {
				id,
				sourceUrl,
				path: outputPath,
				saved: Boolean(outputPath),
				saveDirectory,
				bytes,
				lines: lineCount,
				truncated,
			} satisfies FetchMarkdownDetails,
		};
	},
	renderCall(args, theme) {
		return new Text(`${theme.bold("arxiv_fetch2md")} ${theme.fg("accent", String(args.id ?? ""))}`, 0, 0);
	},
	renderResult(result, { expanded }, theme, context) {
		const details = result.details as FetchMarkdownDetails | undefined;
		if (context.isError) {
			const message = result.content.find((block) => block.type === "text")?.text ?? "Fetch failed";
			return new Text(theme.fg("error", message), 0, 0);
		}
		if (!details) return new Text("", 0, 0);
		let text = theme.fg("success", `Fetched ${details.id} as Markdown`);
		text += theme.fg("dim", ` (${details.lines} lines, ${formatSize(details.bytes)})`);
		if (details.path) text += "\n" + theme.fg("muted", `Saved: ${details.path}`);
		if (expanded) {
			const markdown = result.content.find((block) => block.type === "text")?.text;
			if (markdown) text += "\n\n" + theme.fg("toolOutput", markdown);
		}
		return new Text(text, 0, 0);
	},
});

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
	pi.registerTool(arxivSearchTool);
	pi.registerTool(arxivPaperTool);
	pi.registerTool(arxivFetchTool);

	registerCollectCommand(pi, "collect-bilibili-llm", "bilibili", "llm",
		"Collect Bilibili LLM/大模型 videos → vault weekly-news/. Optional: comma keywords.");
	registerCollectCommand(pi, "collect-bilibili-media", "bilibili", "media",
		"Collect Bilibili AI media/AIGC videos → vault weekly-news/. Optional: comma keywords.");
	registerCollectCommand(pi, "collect-youtube-llm", "youtube", "llm",
		"Collect YouTube LLM/AI videos → vault weekly-news/. Needs YOUTUBE_API_KEY. Optional: comma keywords.");
};

// ---------------------------------------------------------------------------
// Gate-Recall Guard probe sets (QA-DATA only — NOT part of the runtime
// `gating` object). Consumed by s2-agent-ext-tool-gate/qa/collect-probes.ts.
// This package registers TWO keyword-gated tool groups (collect_videos +
// arxiv_search), so it exports TWO named probe consts. Plain objects: no
// `satisfies` / type import, so this extension never depends on tool-gate
// (avoids a circular dep); shape is enforced by tool-gate's drift-guard test.
//   - controls[]  carry a current keyword → MUST fire.
//   - adversarial[] are keyword-free "I need this tool" phrasings that fire via
//     the noun∧verb `requires` path on the runtime gating.
// collect_videos now carries a requires path (mirrors flux2/ltx), so its
// adversarial recall is calibrated to the 0.9 target (was 0 when keywords-
// only). arxiv_search ALSO has a requires path, but its only zh noun
// (論文) collides with a keyword — so a clean keyword-free zh adversarial is
// impossible (any zh probe firing via requires contains 論文). The arxiv
// adversarial set is therefore EN-only; this zh-noun/keyword collision is a
// separate finding worth a future keyword/requires split.
// ---------------------------------------------------------------------------
export const COLLECT_VIDEOS_PROBES = {
	gate: "collect_videos",
	recallFloor: 0.9,
	adversarial: ["gather clips from video platforms", "pull trending footage for research", "把 vault 的筆記整理一下"],
	controls: ["collect videos from bilibili", "organize vault notes", "收集影片"],
};
export const ARXIV_SEARCH_PROBES = {
	gate: "arxiv_search",
	recallFloor: 0.9,
	adversarial: [
		"look up papers on diffusion models",
		"fetch the paper cited in that thread",
		"read papers about reinforcement learning",
	],
	controls: ["search arxiv for transformers", "find papers on rlhf", "找論文"],
};

export default extension;
