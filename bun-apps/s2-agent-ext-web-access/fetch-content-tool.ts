/**
 * `fetch_content` and `get_search_content`, lifted out of index.ts's
 * `export default function (pi)` closure.
 *
 * WHY THESE TWO, AND WHY TOGETHER: index.ts carries the package's last
 * `@ts-nocheck`. Its 49 errors are not spread through the file — they cluster in
 * the anonymous handler bodies passed to `pi.registerTool`, and because those
 * bodies are closures inside the default export, the directive cannot be scoped
 * narrower than the whole file. Giving each tool its own module is the fix.
 *
 * These two go first because they were measured to close over NOTHING from the
 * enclosing scope except `pi` itself, which becomes a parameter — so they move
 * without threading any state. They also belong together: `fetch_content`'s
 * output is a `responseId`, and `get_search_content` is the only thing that
 * redeems one. Splitting them would put the writer and the sole reader of
 * StoredSearchData in different files.
 *
 * `web_search` (12 errors, 5 closure names) and the `/websearch` command
 * (5 errors, 4 names) are the harder half and stay in index.ts for now.
 *
 * The 22 errors these carried are FIXED here, not re-suppressed. They were three
 * problems, not twenty-two: `fetchResults[0]` unchecked under
 * noUncheckedIndexedAccess (14 sites), `urlList[0]` the same inside a
 * `.length === 1` branch the checker cannot narrow through (3), and a `content`
 * array widened to `type: string` where a discriminated union was required (2,
 * one per tool). The last three were the `theme` parameter of the shared error
 * renderer, fixed by typing it as pi's real `Theme` — see render-error-plan.ts.
 * A fourth surfaced only once the file was checked: `get_search_content`'s
 * TDetails was inferred from its FIRST return, which rejected the six after it.
 *
 * ONE RUNTIME BEHAVIOR CHANGE, deliberate. The single-URL branch used to read
 * `fetchResults[0]` inside `if (urlList.length === 1)` and dereference it
 * immediately; had fetchAllContent ever returned an empty array for a one-URL
 * request, that threw a TypeError. It now guards on the ELEMENT instead of the
 * length, so such a case falls through to the multi-URL summary and the caller
 * gets a coherent (empty) result. Whether it is reachable is unproven —
 * extract.ts is expected to return one entry per URL — but the checker cannot
 * know that, and a defined response beats an unproven crash. Nothing else
 * changed: every other line is the original, moved.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import { fetchAllContent, type ExtractedContent } from "./extract.ts";
import { normalizeFetchContentParams } from "./fetch-params.ts";
import { formatSeconds } from "./utils.ts";
import {
	generateId,
	getResult,
	storeResult,
	stripThumbnails,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.ts";
import { buildSearchErrorPlan } from "./render-search-error.ts";
import { renderSearchErrorPlan } from "./render-error-plan.ts";

/** Content returned directly to the agent; the rest is redeemed via responseId. */
const MAX_INLINE_CONTENT = 30000;

/**
 * The union a tool result's `content` must be. Writing this out is what fixes
 * the two TS2322s: an inline `Array<{ type: string; ... }>` annotation widens
 * `type` to `string`, which is not assignable to the discriminated union the
 * agent runtime expects. Declaring the union means the literals stay literal.
 */
type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/**
 * Every shape `get_search_content` can put in `details`, as one type.
 *
 * Without this, TypeScript infers the tool's `TDetails` generic from the FIRST
 * `return` in execute — the not-found branch, which carries `responseId` — and
 * then rejects all six later returns for omitting it. Annotating the return type
 * makes the union the contract instead of the first branch. (Same inference trap
 * hermes-memory hit; see s2-agent/src/static-extensions.ts.)
 */
interface GetSearchContentDetails {
	error?: string;
	responseId?: string;
	query?: string;
	resultCount?: number;
	url?: string;
	title?: string;
	contentLength?: number;
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}\n\n`;
	}
	return output;
}

// ─── Gate family (wayfinder ticket 02 — demoted from core) ──────────────────
// get_search_content is a companion retrieval surface for stored web_search /
// fetch_content results — on-demand, not needed every turn (web_search +
// fetch_content themselves stay core). Keywords are the stored-content
// retrieval vocabulary. Declared here, beside the tool it gates, rather than in
// index.ts; ESM evaluates this module before index.ts's body, so the registry is
// populated no later than it was before.
GATE_DEFS["get_search_content"] = {
	id: "get_search_content",
	keywords: ["get search content", "full content", "stored content", "previous search", "responseId", "取回內容", "完整內容"],
	requires: {
		nouns: ["content", "search", "response", "url", "query", "內容"],
		verbs: ["retrieve", "get", "fetch", "取回", "取得"],
	},
	description: "Retrieve full content from a previous web_search/fetch_content",
};

export function registerFetchContentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		gating: { core: true },
		description: "Fetch URL(s) and extract readable content as markdown. Supports YouTube video transcripts (with thumbnail), GitHub repository contents, and local video files (with frame thumbnail). Video frames can be extracted via timestamp/range or sampled across the entire video with frames alone. Falls back to Gemini for pages that block bots or fail Readability extraction. For YouTube and video files: ALWAYS pass the user's specific question via the prompt parameter — this directs the AI to focus on that aspect of the video, producing much better results than a generic extraction. Content is always stored and can be retrieved with get_search_content.",
		promptSnippet:
			"Use to extract readable content from URL(s), YouTube, GitHub repos, or local videos. For video questions, pass the user's exact question in prompt.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({
				description: "Force cloning large GitHub repositories that exceed the size threshold",
			})),
			prompt: Type.Optional(Type.String({
				description: "Question or instruction for video analysis (YouTube and video files). Pass the user's specific question here — e.g. 'describe the book shown at the advice for beginners section'. Without this, a generic transcript extraction is used which may miss what the user is asking about.",
			})),
			timestamp: Type.Optional(Type.String({
				description: "Extract video frame(s) at a timestamp or time range. Single: '1:23:45', '23:45', or '85' (seconds). Range: '23:41-25:00' extracts evenly-spaced frames across that span (default 6). Use frames with ranges to control density; single+frames uses a fixed 5s interval. YouTube requires yt-dlp + ffmpeg; local videos require ffmpeg. Use a range when you know the approximate area but not the exact moment — you'll get a contact sheet to visually identify the right frame.",
			})),
			frames: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: 12,
				description: "Number of frames to extract. Use with timestamp range for custom density, with single timestamp to get N frames at 5s intervals, or alone to sample across the entire video. Requires yt-dlp + ffmpeg for YouTube, ffmpeg for local video.",
			})),
			model: Type.Optional(Type.String({
				description: "Override the Gemini model for video/YouTube analysis (e.g. 'gemini-2.5-flash', 'gemini-3-flash-preview'). Defaults to config or gemini-3-flash-preview.",
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const { urlList, options } = normalizeFetchContentParams(params);
			if (urlList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No URL provided." }],
					details: { error: "No URL provided" },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});

			const fetchResults = await fetchAllContent(urlList, signal, options);
			const successful = fetchResults.filter((r) => !r.error).length;
			const totalChars = fetchResults.reduce((sum, r) => sum + r.content.length, 0);

			// ALWAYS store results (even for single URL)
			const responseId = generateId();
			const data: StoredSearchData = {
				id: responseId,
				type: "fetch",
				timestamp: Date.now(),
				urls: stripThumbnails(fetchResults),
			};
			storeResult(responseId, data);
			pi.appendEntry("web-search-results", data);

			// Single URL: return content directly (possibly truncated) with responseId.
			// `result` is read out before the branch so the guard below narrows it
			// once — `urlList.length === 1` says nothing about fetchAllContent's
			// return length, which is why the 14 unchecked reads errored.
			const result = urlList.length === 1 ? fetchResults[0] : undefined;
			if (result) {
				if (result.error) {
					return {
						content: [{ type: "text", text: `Error: ${result.error}` }],
						details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, responseId, prompt: params.prompt, timestamp: params.timestamp, frames: params.frames },
					};
				}

				const fullLength = result.content.length;
				const truncated = fullLength > MAX_INLINE_CONTENT;
				let output = truncated
					? result.content.slice(0, MAX_INLINE_CONTENT) + "\n\n[Content truncated...]"
					: result.content;

				if (truncated) {
					output += `\n\n---\nShowing ${MAX_INLINE_CONTENT} of ${fullLength} chars. ` +
						`Use get_search_content({ responseId: "${responseId}", urlIndex: 0 }) for full content.`;
				}

				const content: ToolContent[] = [];
				if (result.frames?.length) {
					for (const frame of result.frames) {
						content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
						content.push({ type: "text", text: `Frame at ${frame.timestamp}` });
					}
				} else if (result.thumbnail) {
					content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
				}
				content.push({ type: "text", text: output });

				const imageCount = (result.frames?.length ?? 0) + (result.thumbnail ? 1 : 0);
				return {
					content,
					details: {
						urls: urlList,
						urlCount: 1,
						successful: 1,
						totalChars: fullLength,
						title: result.title,
						responseId,
						truncated,
						hasImage: imageCount > 0,
						imageCount,
						prompt: params.prompt,
						timestamp: params.timestamp,
						frames: params.frames,
						duration: result.duration,
					},
				};
			}

			// Multi-URL: existing behavior (summary + responseId)
			let output = "## Fetched URLs\n\n";
			for (const { url, title, content, error } of fetchResults) {
				if (error) {
					output += `- ${url}: Error - ${error}\n`;
				} else {
					output += `- ${title || url} (${content.length} chars)\n`;
				}
			}
			output += `\n---\nUse get_search_content({ responseId: "${responseId}", urlIndex: 0 }) to retrieve full content.`;

			return {
				content: [{ type: "text", text: output }],
				details: { urls: urlList, urlCount: urlList.length, successful, totalChars, responseId },
			};
		},

		renderCall(args, theme) {
			const { url, urls, prompt, timestamp, frames, model } = args as { url?: string; urls?: string[]; prompt?: string; timestamp?: string; frames?: number; model?: string };
			const urlList = urls ?? (url ? [url] : []);
			const only = urlList.length === 1 ? urlList[0] : undefined;
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (only !== undefined) {
				const display = only.length > 60 ? only.slice(0, 57) + "..." : only;
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("muted", "  " + display));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			if (timestamp) {
				lines.push(theme.fg("dim", "  timestamp: ") + theme.fg("warning", timestamp));
			}
			if (typeof frames === "number") {
				lines.push(theme.fg("dim", "  frames: ") + theme.fg("warning", String(frames)));
			}
			if (prompt) {
				const display = prompt.length > 250 ? prompt.slice(0, 247) + "..." : prompt;
				lines.push(theme.fg("dim", "  prompt: ") + theme.fg("muted", `"${display}"`));
			}
			if (model) {
				lines.push(theme.fg("dim", "  model: ") + theme.fg("warning", model));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				responseId?: string;
				phase?: string;
				progress?: number;
				hasImage?: boolean;
				imageCount?: number;
				prompt?: string;
				timestamp?: string;
				frames?: number;
				duration?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "█".repeat(Math.floor(progress * 10)) + "░".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
			}

			if (details?.error) {
				const fd = details as typeof details & { urls?: string[] };
				const extras: string[] = [];
				if (typeof fd.urlCount === "number" || typeof fd.successful === "number") {
					extras.push(`urls: ${fd.successful ?? 0}/${fd.urlCount ?? 0} succeeded`);
				}
				if (fd.responseId) extras.push(`response id: ${fd.responseId}`);
				if (fd.urls && fd.urls.length > 0) {
					for (const u of fd.urls.slice(0, 8)) extras.push(`  ▸ ${u}`);
					if (fd.urls.length > 8) extras.push(`  ... and ${fd.urls.length - 8} more`);
				}
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				const imgCount = details?.imageCount ?? (details?.hasImage ? 1 : 0);
				const imageBadge = imgCount > 1
					? theme.fg("accent", ` [${imgCount} images]`)
					: imgCount === 1
						? theme.fg("accent", " [image]")
						: "";
				let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`) + imageBadge;
				if (details?.truncated) {
					statusLine += theme.fg("warning", " [truncated]");
				}
				if (typeof details?.duration === "number") {
					statusLine += theme.fg("muted", ` | ${formatSeconds(Math.floor(details.duration))} total`);
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
					return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
				}
				const lines = [statusLine];
				if (details?.prompt) {
					const display = details.prompt.length > 250 ? details.prompt.slice(0, 247) + "..." : details.prompt;
					lines.push(theme.fg("dim", `  prompt: "${display}"`));
				}
				if (details?.timestamp) {
					lines.push(theme.fg("dim", `  timestamp: ${details.timestamp}`));
				}
				if (typeof details?.frames === "number") {
					lines.push(theme.fg("dim", `  frames: ${details.frames}`));
				}
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				lines.push(theme.fg("dim", preview));
				return new Text(lines.join("\n"), 0, 0);
			}

			const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
			const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", " (content stored)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});
}

export function registerGetSearchContentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		gating: { gate: "get_search_content" }, // demoted from core (ticket 02)
		description: "Retrieve full content from a previous web_search or fetch_content call.",
		promptSnippet:
			"Use after web_search/fetch_content when full stored content is needed via responseId plus query/url selectors.",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
			query: Type.Optional(Type.String({ description: "Get content for this query (web_search)" })),
			queryIndex: Type.Optional(Type.Number({ description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Number({ description: "Get content for URL at index" })),
		}),

		async execute(_toolCallId, params): Promise<{ content: ToolContent[]; details: GetSearchContentDetails }> {
			const data = getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for "${params.responseId}"` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			if (data.type === "search" && data.queries) {
				const queries = data.queries;
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query "${params.query}" not found. Available: ${available}` }],
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = queries[params.queryIndex];
					if (!queryData) {
						return {
							content: [{ type: "text", text: `Index ${params.queryIndex} out of range (0-${queries.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex. Available: ${available}` }],
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error for "${queryData.query}": ${queryData.error}` }],
						details: { error: queryData.error, query: queryData.query },
					};
				}

				return {
					content: [{ type: "text", text: formatFullResults(queryData) }],
					details: { query: queryData.query, resultCount: queryData.results.length },
				};
			}

			if (data.type === "fetch" && data.urls) {
				const urls = data.urls;
				let urlData: ExtractedContent | undefined;

				if (params.url !== undefined) {
					urlData = urls.find((u) => u.url === params.url);
					if (!urlData) {
						const available = urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL not found. Available:\n  ${available}` }],
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					urlData = urls[params.urlIndex];
					if (!urlData) {
						return {
							content: [{ type: "text", text: `Index ${params.urlIndex} out of range (0-${urls.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex. Available:\n  ${available}` }],
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error for ${urlData.url}: ${urlData.error}` }],
						details: { error: urlData.error, url: urlData.url },
					};
				}

				return {
					content: [{ type: "text", text: `# ${urlData.title}\n\n${urlData.content}` }],
					details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length },
				};
			}

			return {
				content: [{ type: "text", text: "Invalid stored data format" }],
				details: { error: "Invalid data" },
			};
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || responseId.slice(0, 8)), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				error?: string;
				query?: string;
				url?: string;
				title?: string;
				resultCount?: number;
				contentLength?: number;
			};

			if (details?.error) {
				const extras: string[] = [];
				if (details.query) extras.push(`query: ${details.query}`);
				if (details.url) extras.push(`url: ${details.url}`);
				else if (details.title) extras.push(`resource: ${details.title}`);
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			if (details?.query) {
				statusLine = theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount} results)`);
			} else {
				statusLine = theme.fg("success", details?.title || "Content") + theme.fg("muted", ` (${details?.contentLength ?? 0} chars)`);
			}

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});
}
