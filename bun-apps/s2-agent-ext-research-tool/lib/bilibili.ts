/**
 * Unified Bilibili collection engine.
 *
 * Replaces the two near-identical scripts (collect-bilibili-llm.ts +
 * collect-bilibili-media.ts) — the ONLY difference was the keyword preset,
 * now externalized to lib/filter.ts. This module is the shared engine:
 * WBI signing, buvid3 acquisition, type=search + popular endpoints.
 *
 * Fixes vs. the originals:
 *  - Proxy actually works (Bun native `fetch(url, { proxy })`). The old
 *    `{ dispatcher: proxy }` was an undici-only option that native fetch
 *    silently ignored → the 412 bypass never engaged.
 *  - Results normalize to platform-agnostic VideoResult[].
 */
import { createHash } from "node:crypto";
import type { VideoResult } from "./types.ts";

const API_BASE = "https://api.bilibili.com";
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ================================================================
 * WBI signing
 * ================================================================ */

const MIXIN_KEY_ENC_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
	27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
	37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
	22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** Derive the 32-char mixin key from the raw img+sub key via the enc tab. */
export function getMixinKey(raw: string): string {
	return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

/** md5 helper for WBI signing. */
function md5(str: string): string {
	return createHash("md5").update(str).digest("hex");
}

/* ================================================================
 * Outcomes (self-arc-13 T2)
 * ================================================================ */

/**
 * Every engine call answers with an OUTCOME, never a bare value: a 412
 * risk-control block, a WBI-key outage, a network failure, and a genuinely
 * empty result are four different facts, and the pre-T2 engine collapsed
 * them all into `[]` — the tool then wrote a "successful" empty digest.
 */
export type EngineStatus = "ok" | "blocked-412" | "wbi-unavailable" | "network-error" | "api-error";

export interface EngineOutcome<T> {
	data: T;
	status: EngineStatus;
	/** Human-readable cause; present iff status !== "ok". */
	reason?: string;
}

export type SearchOutcome = EngineOutcome<VideoResult[]>;
/** buvid3 acquisition: data null ⇒ NO cookie (a fabricated random buvid3
 *  fools risk-control checks into hard-blocking the session — never invent one). */
export type Buvid3Outcome = EngineOutcome<string | null>;

const BLOCKED_412_HINT = "risk-control blocked (HTTP 412): off-China IPs need proxy (e.g. proxy=http://127.0.0.1:7890)";

async function fetchJson(url: string, init: RequestInit, proxy?: string): Promise<Response> {
	return fetch(url, { ...init, ...(proxy ? { proxy } : {}) });
}

/* ================================================================
 * WBI key cache (self-arc-13 T2)
 * ================================================================ */

// Keys rotate daily; the pre-T2 engine refetched /nav per keyword × per page,
// multiplying the exact risk-control exposure the buvid3+proxy machinery
// exists to avoid. Process-scoped cache; invalidated on signature rejection
// (-403) so the next call refetches once.
const WBI_KEY_TTL_MS = 12 * 3600_000;
let wbiKeyCache: { imgKey: string; subKey: string; fetchedAt: number } | null = null;

/** Cached WBI-key acquisition (fetch once per process/12h). */
export async function getWbiKeys(cookieStr: string, proxy?: string): Promise<{ imgKey: string; subKey: string }> {
	if (wbiKeyCache && Date.now() - wbiKeyCache.fetchedAt < WBI_KEY_TTL_MS) return wbiKeyCache;
	const keys = await fetchWbiKeys(cookieStr, proxy);
	wbiKeyCache = { ...keys, fetchedAt: Date.now() };
	return keys;
}

/** Drop the cached WBI keys (signature rejection / tests). */
export function resetWbiKeyCache(): void {
	wbiKeyCache = null;
}

/**
 * WBI-sign a param map. Returns the original params plus `wts` + `w_rid`.
 * Reference: SocialSisterYi/bilibili-API-collect (misc/sign/wbi.md).
 */
export function signWbi(
	params: Record<string, string>,
	imgKey: string,
	subKey: string,
): Record<string, string> {
	const mixinKey = getMixinKey(imgKey + subKey);
	const wts = Math.floor(Date.now() / 1000).toString();
	const merged: Record<string, string> = { ...params, wts };
	const keys = Object.keys(merged).sort();
	const query = keys.map((k) => `${k}=${encodeURIComponent(merged[k] ?? "")}`).join("&");
	const wRid = md5(query + mixinKey);
	return { ...params, wts, w_rid: wRid };
}

/* ================================================================
 * Cookie + key acquisition
 * ================================================================ */

/** Fetch a buvid3 cookie (Bilibili basic risk-control requirement). Never fabricates. */
export async function fetchBuvid3(proxy?: string): Promise<Buvid3Outcome> {
	try {
		const resp = await fetchJson(
			`${API_BASE}/x/frontend/finger/spi`,
			{ headers: { "User-Agent": USER_AGENT } },
			proxy,
		);
		if (resp.status === 412) {
			return { data: null, status: "blocked-412", reason: BLOCKED_412_HINT };
		}
		const json = (await resp.json()) as { code: number; message?: string; data?: { b_3?: string } };
		if (json.code === 0 && json.data?.b_3) return { data: json.data.b_3, status: "ok" };
		return { data: null, status: "api-error", reason: `spi code ${json.code}${json.message ? `: ${json.message}` : ""}` };
	} catch (err) {
		return { data: null, status: "network-error", reason: (err as Error).message };
	}
}

/** Fetch the daily-rotating WBI keys (img_key, sub_key) from /x/web-interface/nav. */
export async function fetchWbiKeys(
	cookieStr: string,
	proxy?: string,
): Promise<{ imgKey: string; subKey: string }> {
	const resp = await fetch(`${API_BASE}/x/web-interface/nav`, {
		headers: {
			"User-Agent": USER_AGENT,
			Cookie: cookieStr,
			Referer: "https://www.bilibili.com/",
		},
		...(proxy ? { proxy } : {}),
	});
	const json = (await resp.json()) as {
		data?: { wbi_img?: { img_url: string; sub_url: string } };
	};
	if (!json.data?.wbi_img) throw new Error("WBI keys unavailable from /nav");
	const imgKey = json.data.wbi_img.img_url.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
	const subKey = json.data.wbi_img.sub_url.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
	if (!imgKey || !subKey) throw new Error(`could not parse WBI keys from urls`);
	return { imgKey, subKey };
}

/* ================================================================
 * API calls
 * ================================================================ */

export interface SearchOptions {
	order?: string;
	duration?: number;
	page?: number;
	cookieStr?: string;
	proxy?: string;
}

/** Type=search video search. Endpoint: /x/web-interface/wbi/search/type */
export async function searchVideos(keyword: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
	const { order = "click", duration = 0, page = 1, cookieStr = "", proxy } = opts;
	let wbiKeys: { imgKey: string; subKey: string };
	try {
		wbiKeys = await getWbiKeys(cookieStr, proxy);
	} catch (err) {
		return { data: [], status: "wbi-unavailable", reason: (err as Error).message };
	}

	const signed = signWbi(
		{
			search_type: "video",
			keyword,
			order,
			duration: duration.toString(),
			tids: "0",
			page: page.toString(),
		},
		wbiKeys.imgKey,
		wbiKeys.subKey,
	);
	const url = `${API_BASE}/x/web-interface/wbi/search/type?${new URLSearchParams(signed)}`;
	const headers: Record<string, string> = {
		"User-Agent": USER_AGENT,
		Referer: "https://www.bilibili.com/",
	};
	if (cookieStr) headers["Cookie"] = cookieStr;

	let resp: Response;
	try {
		resp = await fetchJson(url, { headers }, proxy);
	} catch (err) {
		return { data: [], status: "network-error", reason: (err as Error).message };
	}
	if (resp.status === 412) return { data: [], status: "blocked-412", reason: BLOCKED_412_HINT };
	const json = (await resp.json()) as {
		code: number;
		message?: string;
		data?: { result?: RawBiliSearchItem[] };
	};
	if (json.code === -403) {
		// Signature rejected — the cached keys went stale; drop them so the
		// next call refetches once.
		resetWbiKeyCache();
		return { data: [], status: "wbi-unavailable", reason: "signature rejected (-403); WBI keys invalidated — retry" };
	}
	if (json.code !== 0 || !json.data?.result) {
		return { data: [], status: "api-error", reason: `search code ${json.code}${json.message ? `: ${json.message}` : ""}` };
	}
	return { data: json.data.result.map(normalizeSearchItem), status: "ok" };
}

/** Popular/all-site feed. Endpoint: /x/web-interface/popular (no WBI needed). */
export async function fetchHotVideos(
	page = 1,
	pageSize = 20,
	cookieStr = "",
	proxy?: string,
): Promise<SearchOutcome> {
	const url = `${API_BASE}/x/web-interface/popular?pn=${page}&ps=${pageSize}`;
	const headers: Record<string, string> = {
		"User-Agent": USER_AGENT,
		Referer: "https://www.bilibili.com/",
	};
	if (cookieStr) headers["Cookie"] = cookieStr;
	let resp: Response;
	try {
		resp = await fetchJson(url, { headers }, proxy);
	} catch (err) {
		return { data: [], status: "network-error", reason: (err as Error).message };
	}
	if (resp.status === 412) return { data: [], status: "blocked-412", reason: BLOCKED_412_HINT };
	const json = (await resp.json()) as {
		code: number;
		message?: string;
		data?: { list?: RawBiliPopularItem[] };
	};
	if (json.code !== 0 || !json.data?.list) {
		return { data: [], status: "api-error", reason: `popular code ${json.code}${json.message ? `: ${json.message}` : ""}` };
	}
	return { data: json.data.list.map(normalizePopularItem), status: "ok" };
}

/* ================================================================
 * Raw → normalized
 * ================================================================ */

interface RawBiliSearchItem {
	aid: number;
	bvid?: string;
	title: string;
	author: string;
	play: number;
	video_review: number;
	favorites: number;
	review: number;
	pubdate: number;
	duration: string;
	pic: string;
	tag: string;
	description: string;
	arcurl: string;
}

interface RawBiliPopularItem {
	aid: number;
	bvid?: string;
	title: string;
	owner?: { name?: string };
	stat?: { view?: number; danmaku?: number; favorite?: number; reply?: number };
	pubdate: number;
	duration: number;
	pic?: string;
	desc?: string;
	bvid_legacy?: string;
}

function stripHtml(s: string): string {
	return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&");
}

function formatDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

function timestampToDate(ts: number): string {
	return new Date(ts * 1000).toISOString().split("T")[0] ?? "";
}

function extractBvid(url: string, fallbackBvid?: string): string {
	const m = url.match(/\/(BV[a-zA-Z0-9]+)/);
	return m ? (m[1] ?? "") : (fallbackBvid ?? "");
}

function normalizeSearchItem(item: RawBiliSearchItem): VideoResult {
	const bvid = extractBvid(item.arcurl, item.bvid);
	return {
		id: item.bvid ?? bvid,
		url: bvid ? `https://www.bilibili.com/video/${bvid}` : item.arcurl,
		title: stripHtml(item.title),
		author: item.author,
		play: item.play,
		danmaku: item.video_review,
		favorites: item.favorites,
		replies: item.review,
		date: timestampToDate(item.pubdate),
		duration: item.duration,
		thumbnail: item.pic,
		tag: item.tag,
		description: item.description,
	};
}

function normalizePopularItem(item: RawBiliPopularItem): VideoResult {
	const bvid = item.bvid ?? "";
	return {
		id: bvid,
		url: bvid ? `https://www.bilibili.com/video/${bvid}` : "",
		title: stripHtml(item.title),
		author: item.owner?.name ?? "",
		play: item.stat?.view ?? 0,
		danmaku: item.stat?.danmaku ?? 0,
		favorites: item.stat?.favorite ?? 0,
		replies: item.stat?.reply ?? 0,
		date: timestampToDate(item.pubdate),
		duration: formatDuration(item.duration),
		thumbnail: item.pic ?? "",
		tag: "",
		description: item.desc ?? "",
	};
}

/** Sleep helper (request spacing to dodge risk-control). */
export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
