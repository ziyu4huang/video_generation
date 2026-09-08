/**
 * bilibili-engine.test.ts — self-arc-13 T2: outcome surfacing + WBI cache.
 *
 * The pre-T2 engine collapsed every failure into `[]` (412 risk-control, WBI
 * outage, network error, genuinely empty) and fabricated a random buvid3 on
 * network failure. These tests pin the OUTCOME contract: statuses and reasons
 * survive to the caller, keys are fetched once per process, and nothing is
 * ever invented. Zero network — global fetch is routed to a counting mock.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	fetchBuvid3,
	fetchHotVideos,
	getMixinKey,
	resetWbiKeyCache,
	searchVideos,
} from "../lib/bilibili.ts";

/** Route URLs to canned responses; count hits per endpoint. */
function mockFetch(routes: Record<string, () => Response | Promise<Response>>) {
	const hits: Record<string, number> = {};
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request) => {
		const u = String(url);
		for (const [needle, make] of Object.entries(routes)) {
			if (u.includes(needle)) {
				hits[needle] = (hits[needle] ?? 0) + 1;
				return make();
			}
		}
		throw new Error(`unexpected fetch: ${u}`);
	}) as typeof fetch;
	return {
		hits,
		restore: () => {
			globalThis.fetch = realFetch;
		},
	};
}

const okNav = () =>
	new Response(
		JSON.stringify({
			code: 0,
			data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/abc123def456.png", sub_url: "https://i0.hdslb.com/bfs/wbi/789xyz012345.png" } },
		}),
	);
const okSpi = () => new Response(JSON.stringify({ code: 0, data: { b_3: "real-buvid3-value" } }));
const okSearch = () =>
	new Response(JSON.stringify({ code: 0, data: { result: [{ aid: 1, title: "t", author: "a", play: 1, video_review: 0, favorites: 0, review: 0, pubdate: 1700000000, duration: "1:00", pic: "", tag: "", description: "", arcurl: "https://www.bilibili.com/video/BV1xx" }] } }));

beforeEach(() => {
	resetWbiKeyCache();
});

describe("outcome surfacing (T2)", () => {
	test("412 surfaces blocked reason (not empty success)", async () => {
		const m = mockFetch({ "/nav": okNav, "search/type": () => new Response("{}", { status: 412 }) });
		try {
			const out = await searchVideos("llm");
			expect(out.status).toBe("blocked-412");
			expect(out.reason).toContain("412");
			expect(out.reason).toContain("proxy");
			expect(out.data).toEqual([]);
		} finally {
			m.restore();
		}
	});

	test("wbi failure surfaces reason", async () => {
		const m = mockFetch({ "/nav": () => new Response(JSON.stringify({ code: 0, data: {} })) });
		try {
			const out = await searchVideos("llm");
			expect(out.status).toBe("wbi-unavailable");
			expect(out.reason).toContain("WBI keys unavailable");
		} finally {
			m.restore();
		}
	});

	test("search network error surfaces reason", async () => {
		const m = mockFetch({
			"/nav": okNav,
			"search/type": () => {
				throw new Error("connection refused");
			},
		});
		try {
			const out = await searchVideos("llm");
			expect(out.status).toBe("network-error");
			expect(out.reason).toContain("connection refused");
		} finally {
			m.restore();
		}
	});

	test("non-zero api code surfaces api-error", async () => {
		const m = mockFetch({
			"/nav": okNav,
			"search/type": () => new Response(JSON.stringify({ code: -400, message: "请求错误" })),
		});
		try {
			const out = await searchVideos("llm");
			expect(out.status).toBe("api-error");
			expect(out.reason).toContain("-400");
		} finally {
			m.restore();
		}
	});

	test("signature rejection (-403) invalidates the WBI cache", async () => {
		let rejectNextSignedCall = true;
		const m = mockFetch({
			"/nav": okNav,
			"search/type": () =>
				rejectNextSignedCall
					? ((rejectNextSignedCall = false), new Response(JSON.stringify({ code: -403, message: "invalid sign" })))
					: okSearch(),
		});
		try {
			const rejected = await searchVideos("llm");
			expect(rejected.status).toBe("wbi-unavailable");
			expect(rejected.reason).toContain("-403");
			const retried = await searchVideos("llm"); // cache was dropped → /nav again → signed call ok
			expect(retried.status).toBe("ok");
			expect(retried.data.length).toBe(1);
			expect(m.hits["/nav"]).toBe(2);
		} finally {
			m.restore();
		}
	});

	test("hot videos 412 surfaces blocked reason", async () => {
		const m = mockFetch({ popular: () => new Response("{}", { status: 412 }) });
		try {
			const out = await fetchHotVideos(1, 50, "");
			expect(out.status).toBe("blocked-412");
		} finally {
			m.restore();
		}
	});

	test("ok path returns normalized data with status ok", async () => {
		const m = mockFetch({ "/nav": okNav, "search/type": okSearch });
		try {
			const out = await searchVideos("llm");
			expect(out.status).toBe("ok");
			expect(out.data[0]?.id).toBe("BV1xx");
		} finally {
			m.restore();
		}
	});
});

describe("buvid3 (T2)", () => {
	test("buvid3 failure surfaces, never fabricates", async () => {
		const m = mockFetch({
			"finger/spi": () => {
				throw new Error("offline");
			},
		});
		try {
			const out = await fetchBuvid3();
			expect(out.status).toBe("network-error");
			expect(out.reason).toContain("offline");
			expect(out.data).toBeNull(); // the old code returned a fabricated BUVID3_… random string here
		} finally {
			m.restore();
		}
	});

	test("buvid3 412 surfaces blocked status", async () => {
		const m = mockFetch({ "finger/spi": () => new Response("{}", { status: 412 }) });
		try {
			const out = await fetchBuvid3();
			expect(out.status).toBe("blocked-412");
			expect(out.data).toBeNull();
		} finally {
			m.restore();
		}
	});

	test("buvid3 ok returns the real cookie", async () => {
		const m = mockFetch({ "finger/spi": okSpi });
		try {
			const out = await fetchBuvid3();
			expect(out.status).toBe("ok");
			expect(out.data).toBe("real-buvid3-value");
		} finally {
			m.restore();
		}
	});
});

describe("WBI key cache (T2)", () => {
	test("wbi keys cached across keywords (nav called once)", async () => {
		const m = mockFetch({ "/nav": okNav, "search/type": okSearch });
		try {
			for (const kw of ["llm", "大模型", "agent"]) {
				const out = await searchVideos(kw);
				expect(out.status).toBe("ok");
			}
			expect(m.hits["/nav"]).toBe(1);
		} finally {
			m.restore();
		}
	});
});
