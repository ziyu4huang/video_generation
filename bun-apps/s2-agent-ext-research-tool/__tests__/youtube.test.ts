/**
 * youtube.test.ts — self-arc-13 T3: the quota-aware engine's FIRST test file.
 *
 * Pins the latent stats-chunking defect: videos.list caps at 50 ids per call,
 * and the pre-T3 engine sent ALL ids in one request — pages ≥ 2 failed the
 * batch, the error was swallowed, and every video reported 0 views/likes/
 * duration silently. Also pins pagination stop, duration parsing, publishedAfter,
 * normalization/HTML-strip, the quota-error throw, and the missing-key guard
 * (via the real extension factory). Zero network, zero LLM.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { parseIsoDuration, publishedAfterDays, searchYtKeyword } from "../lib/youtube.ts";
import extensionFactory from "../extensions/research-tool.ts";

function mockFetch(routes: { needle: string; make: (url: string) => Response | Promise<Response> }[]) {
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request) => {
		const u = String(url);
		calls.push(u);
		for (const r of routes) {
			if (u.includes(r.needle)) return r.make(u);
		}
		throw new Error(`unexpected fetch: ${u}`);
	}) as typeof fetch;
	return { calls, restore: () => (globalThis.fetch = realFetch) };
}

const ytItem = (n: number) => ({
	id: { kind: "youtube#video", videoId: `vid${n}` },
	snippet: {
		publishedAt: "2026-09-01T12:00:00Z",
		title: `<b>Title ${n}</b> &amp; more`,
		description: "desc &quot;quoted&quot;",
		channelTitle: "chan",
		thumbnails: { high: { url: `https://i.ytimg.com/${n}.jpg` }, default: { url: `https://i.ytimg.com/${n}-d.jpg` } },
	},
});

const searchPage = (items: ReturnType<typeof ytItem>[], nextPageToken?: string) =>
	new Response(JSON.stringify({ items, nextPageToken }));

const statsFor = (ids: string[]) =>
	new Response(
		JSON.stringify({
			items: ids.map((id, i) => ({
				id,
				statistics: { viewCount: String(100 + i), likeCount: "5", commentCount: "2" },
				contentDetails: { duration: i % 2 ? "PT1H2M3S" : "PT4M5S" },
			})),
		}),
	);

/** The endpoint's real constraint, enforced by the mock: >50 ids ⇒ 400. */
const idsFromUrl = (url: string) =>
	decodeURIComponent(url.match(/id=([^&]+)/)?.[1] ?? "").split(",").filter(Boolean);
const statsEndpoint = (url: string) => {
	const ids = idsFromUrl(url);
	if (ids.length > 50) {
		return new Response(JSON.stringify({ error: { code: 400, message: "Too many ids" } }), { status: 400 });
	}
	return statsFor(ids);
};

describe("parseIsoDuration", () => {
	test("table", () => {
		expect(parseIsoDuration("PT1H2M3S")).toBe("1:02:03");
		expect(parseIsoDuration("PT5M30S")).toBe("5:30");
		expect(parseIsoDuration("PT45S")).toBe("0:45");
		expect(parseIsoDuration("PT0S")).toBe("0:00");
		expect(parseIsoDuration("live")).toBe("live"); // passthrough
	});
});

describe("publishedAfterDays", () => {
	test("0 / negative ⇒ undefined (no filter)", () => {
		expect(publishedAfterDays(0)).toBeUndefined();
		expect(publishedAfterDays(-3)).toBeUndefined();
	});
	test("7 ⇒ RFC3339 ≈ 7 days ago", () => {
		const got = publishedAfterDays(7)!;
		const deltaDays = (Date.now() - Date.parse(got)) / 86_400_000;
		expect(deltaDays).toBeGreaterThan(6.9);
		expect(deltaDays).toBeLessThan(7.1);
		expect(got).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("searchYtKeyword", () => {
	test("pagination stops when nextPageToken is absent", async () => {
		const m = mockFetch([
			{ needle: "/search?", make: () => searchPage([ytItem(1), ytItem(2)]) }, // no nextPageToken
			{ needle: "/videos?", make: statsEndpoint },
		]);
		try {
			const out = await searchYtKeyword("kw", "KEY", { pages: 3 });
			expect(out.length).toBe(2);
			expect(m.calls.filter((u) => u.includes("/search?")).length).toBe(1); // asked for 3 pages, stopped at 1
		} finally {
			m.restore();
		}
	});

	test("chunks stats batches at 50 ids (regression: pre-T3 sent all 100 in one call → silent zeros)", async () => {
		const page1 = Array.from({ length: 50 }, (_, i) => ytItem(i));
		const page2 = Array.from({ length: 50 }, (_, i) => ytItem(i + 50));
		const m = mockFetch([
			{
				needle: "/search?",
				make: (url) => (url.includes("pageToken=PAGE2") ? searchPage(page2) : searchPage(page1, "PAGE2")),
			},
			{ needle: "/videos?", make: statsEndpoint },
		]);
		try {
			const out = await searchYtKeyword("kw", "KEY", { pages: 2 });
			expect(out.length).toBe(100);
			const statsCalls = m.calls.filter((u) => u.includes("/videos?"));
			expect(statsCalls.length).toBe(2); // FAILS pre-fix: one call with 100 ids
			for (const c of statsCalls) {
				expect(idsFromUrl(c).length).toBeLessThanOrEqual(50);
			}
			// stats actually merged across BOTH chunks — no silent zeros
			expect(out.every((v) => v.play > 0)).toBe(true);
			expect(out.filter((v) => v.duration === "1:02:03").length).toBe(50);
			expect(out.filter((v) => v.duration === "4:05").length).toBe(50);
		} finally {
			m.restore();
		}
	});

	test("stats batch failure surfaces via onNotice, results stay usable", async () => {
		const m = mockFetch([
			{ needle: "/search?", make: () => searchPage([ytItem(1)]) },
			{ needle: "/videos?", make: () => new Response(JSON.stringify({ error: { code: 403, message: "quotaExceeded" } })) },
		]);
		const notices: string[] = [];
		try {
			const out = await searchYtKeyword("kw", "KEY", { onNotice: (msg) => notices.push(msg) });
			expect(out.length).toBe(1); // results still returned
			expect(notices.length).toBe(1); // pre-fix: silent empty Map, zero notices
			expect(notices[0]).toContain("stats unavailable");
			expect(notices[0]).toContain("403");
		} finally {
			m.restore();
		}
	});

	test("search quota error throws with the code", async () => {
		const m = mockFetch([
			{ needle: "/search?", make: () => new Response(JSON.stringify({ error: { code: 403, message: "quotaExceeded" } })) },
		]);
		try {
			expect(searchYtKeyword("kw", "KEY")).rejects.toThrow("YouTube API error 403");
		} finally {
			m.restore();
		}
	});

	test("normalization: HTML stripped, date split, duration + fallbacks", async () => {
		const m = mockFetch([
			{ needle: "/search?", make: () => searchPage([ytItem(1)]) },
			{
				needle: "/videos?",
				make: () =>
					new Response(JSON.stringify({ items: [{ id: "vid1", statistics: { viewCount: "42" }, contentDetails: { duration: "PT4M5S" } }] })),
			},
		]);
		try {
			const [v] = await searchYtKeyword("kw", "KEY");
			expect(v).toBeDefined();
			if (!v) throw new Error("unreachable");
			expect(v.title).toBe("Title 1 & more");
			expect(v.description).toBe('desc "quoted"');
			expect(v.date).toBe("2026-09-01");
			expect(v.url).toBe("https://www.youtube.com/watch?v=vid1");
			expect(v.play).toBe(42);
			expect(v.duration).toBe("4:05");
			expect(v.thumbnail).toBe("https://i.ytimg.com/1.jpg");
		} finally {
			m.restore();
		}
	});
});

describe("collect_videos youtube guard (extension factory)", () => {
	const captured: Record<string, unknown>[] = [];
	beforeEach(() => {
		captured.length = 0;
	});
	test("missing-key path errors cleanly", async () => {
		const pi = {
			registerTool: (t: Record<string, unknown>) => {
				captured.push(t);
				return t;
			},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			registerShortcut: () => {},
			registerFlag: () => {},
			sendMessage: () => {},
			appendEntry: () => {},
			setSessionName: () => {},
			getSessionName: () => undefined,
			setActiveTools: () => {},
			getActiveTools: () => [] as string[],
			getFlag: () => undefined,
			setModel: async () => true,
			on: () => {},
			events: { on: () => () => {}, emit: () => {} },
			exec: async () => "",
			sendUserMessage: () => {},
		};
		extensionFactory(pi as never);
		const tool = captured.find((t) => t.name === "collect_videos") as {
			execute: (id: string, params: Record<string, unknown>, sig: unknown, upd: unknown, ctx: { cwd: string }) => Promise<{ isError?: boolean; content?: Array<{ text: string }> }>;
		};
		expect(tool).toBeDefined();
		const prev = process.env.YOUTUBE_API_KEY;
		delete process.env.YOUTUBE_API_KEY;
		try {
			const out = await tool.execute("t", { platform: "youtube", preset: "llm" }, undefined, undefined, { cwd: import.meta.dir });
			expect(out.isError).toBe(true);
			expect(out.content?.[0]?.text).toContain("YOUTUBE_API_KEY");
		} finally {
			if (prev !== undefined) process.env.YOUTUBE_API_KEY = prev;
		}
	});
});
