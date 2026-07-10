/**
 * YouTube Data API v3 collection engine.
 *
 * Requires YOUTUBE_API_KEY (Google Cloud Console → YouTube Data API v3).
 * Quota-aware: each search ≈ 100 units, stats batch ≈ 1 unit per 50 ids.
 * Daily quota: 10,000 units.
 *
 * Results normalize to platform-agnostic VideoResult[].
 */
import type { VideoResult } from "./types.ts";

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

const YT_ORDER_MAP: Record<string, string> = {
	relevance: "relevance",
	date: "date",
	viewCount: "viewCount",
	rating: "rating",
};

interface YtSearchItem {
	id: { kind: string; videoId: string };
	snippet: {
		publishedAt: string;
		title: string;
		description: string;
		channelTitle: string;
		thumbnails: { high?: { url: string }; default?: { url: string } };
	};
}

export interface YtSearchOptions {
	order?: string;
	pages?: number;
	/** RFC 3339 — only videos published after this. */
	publishedAfter?: string;
}

/* ================================================================
 * API calls
 * ================================================================ */

async function searchYtVideos(
	keyword: string,
	apiKey: string,
	opts: {
		order?: string;
		pageToken?: string;
		maxResults?: number;
		publishedAfter?: string;
	} = {},
): Promise<{ items: YtSearchItem[]; nextPageToken?: string }> {
	const { order = "relevance", pageToken, maxResults = 50, publishedAfter } = opts;
	const params: Record<string, string> = {
		part: "snippet",
		type: "video",
		q: keyword,
		order: YT_ORDER_MAP[order] ?? "relevance",
		maxResults: Math.min(maxResults, 50).toString(),
		key: apiKey,
	};
	if (pageToken) params.pageToken = pageToken;
	if (publishedAfter) params.publishedAfter = publishedAfter;

	const resp = await fetch(`${YT_API_BASE}/search?${new URLSearchParams(params)}`);
	const json = (await resp.json()) as {
		error?: { code: number; message: string };
		items?: YtSearchItem[];
		nextPageToken?: string;
	};
	if (json.error) {
		throw new Error(`YouTube API error ${json.error.code}: ${json.error.message}`);
	}
	return { items: json.items ?? [], nextPageToken: json.nextPageToken };
}

async function fetchYtStats(
	videoIds: string[],
	apiKey: string,
): Promise<
	Map<string, { viewCount: number; likeCount: number; commentCount: number; duration: string }>
> {
	if (videoIds.length === 0) return new Map();
	const url = `${YT_API_BASE}/videos?${new URLSearchParams({
		part: "statistics,contentDetails",
		id: videoIds.join(","),
		key: apiKey,
	})}`;
	const resp = await fetch(url);
	const json = (await resp.json()) as {
		error?: { message: string };
		items?: { id: string; statistics?: Record<string, string>; contentDetails?: { duration?: string } }[];
	};
	if (json.error) return new Map();
	const map = new Map<string, { viewCount: number; likeCount: number; commentCount: number; duration: string }>();
	for (const item of json.items ?? []) {
		map.set(item.id, {
			viewCount: parseInt(item.statistics?.viewCount ?? "0", 10),
			likeCount: parseInt(item.statistics?.likeCount ?? "0", 10),
			commentCount: parseInt(item.statistics?.commentCount ?? "0", 10),
			duration: item.contentDetails?.duration ?? "PT0S",
		});
	}
	return map;
}

/* ================================================================
 * Helpers
 * ================================================================ */

/** ISO 8601 duration (PT#H#M#S) → "MM:SS" or "H:MM:SS". */
export function parseIsoDuration(iso: string): string {
	const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
	if (!m) return iso;
	const h = parseInt(m[1] ?? "0", 10);
	const min = parseInt(m[2] ?? "0", 10);
	const sec = parseInt(m[3] ?? "0", 10);
	if (h > 0) return `${h}:${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

function stripHtml(s: string): string {
	return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/* ================================================================
 * Core search
 * ================================================================ */

/** Search one keyword across N pages, batch-fetch stats, normalize. */
export async function searchYtKeyword(
	keyword: string,
	apiKey: string,
	opts: YtSearchOptions = {},
): Promise<VideoResult[]> {
	const { order = "relevance", pages = 1, publishedAfter } = opts;
	const allItems: YtSearchItem[] = [];
	let pageToken: string | undefined;

	for (let p = 0; p < pages; p++) {
		const result = await searchYtVideos(keyword, apiKey, { order, pageToken, publishedAfter });
		allItems.push(...result.items);
		if (!result.nextPageToken) break;
		pageToken = result.nextPageToken;
		if (p < pages - 1) await sleep(800);
	}
	if (allItems.length === 0) return [];

	const videoIds = allItems.map((i) => i.id.videoId);
	const stats = await fetchYtStats(videoIds, apiKey);

	return allItems.map((item) => {
		const s = stats.get(item.id.videoId);
		const { snippet } = item;
		return {
			id: item.id.videoId,
			url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
			title: stripHtml(snippet.title),
			author: snippet.channelTitle,
			play: s?.viewCount ?? 0,
			danmaku: 0,
			favorites: s?.likeCount ?? 0,
			replies: s?.commentCount ?? 0,
			date: snippet.publishedAt.split("T")[0] ?? "",
			duration: parseIsoDuration(s?.duration ?? "PT0S"),
			thumbnail: snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url ?? "",
			tag: "",
			description: stripHtml(snippet.description),
		};
	});
}

/** Build an RFC 3339 publishedAfter for "last N days" (0 = no filter). */
export function publishedAfterDays(days: number): string | undefined {
	if (!days || days <= 0) return undefined;
	const d = new Date(Date.now() - days * 86_400_000);
	return d.toISOString();
}
