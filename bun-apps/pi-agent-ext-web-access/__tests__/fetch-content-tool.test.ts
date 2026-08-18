/**
 * fetch-content-tool.test.ts — first tests for `get_search_content`.
 *
 * This tool's `execute` lived inside index.ts's `export default function (pi)`
 * closure, so no test file could reach it. Every assertion below is new
 * coverage, not a port: nothing had ever run this retrieval path under test.
 *
 * The focus is the selector matrix, because that is what the tool IS — a
 * responseId plus one of four selectors (query / queryIndex / url / urlIndex),
 * each with a not-found and an out-of-range branch, over two stored shapes.
 * Nine of its ten returns are refusals; only two are content. That ratio is the
 * argument for testing it.
 *
 * `fetch_content` is registered here too but is not exercised: its execute calls
 * fetchAllContent, i.e. the network. Its registration IS asserted, since a
 * silent failure to register is the regression this extraction could plausibly
 * introduce.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { registerFetchContentTool, registerGetSearchContentTool } from "../fetch-content-tool.ts";
import { clearResults, storeResult, type StoredSearchData } from "../storage.ts";
import type { ExtractedContent } from "../extract.ts";

type ToolDef = {
	name: string;
	gating?: { core?: boolean; gate?: string };
	execute: (id: string, params: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text?: string }>;
		details: Record<string, unknown>;
	}>;
};

/** Minimal `pi` that only captures registrations — no agent runtime involved. */
function capturePi() {
	const tools = new Map<string, ToolDef>();
	const entries: Array<{ kind: string; data: unknown }> = [];
	const pi = {
		registerTool(def: ToolDef) {
			tools.set(def.name, def);
		},
		appendEntry(kind: string, data: unknown) {
			entries.push({ kind, data });
		},
	};
	return { pi, tools, entries };
}

function getTool(): ToolDef {
	const { pi, tools } = capturePi();
	registerGetSearchContentTool(pi as never);
	const def = tools.get("get_search_content");
	if (!def) throw new Error("get_search_content did not register");
	return def;
}

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
	return r.content.find((c) => c.type === "text")?.text ?? "";
}

function url(u: string, extra: Partial<ExtractedContent> = {}): ExtractedContent {
	return { url: u, title: `title ${u}`, content: `content of ${u}`, error: null, ...extra } as ExtractedContent;
}

const SEARCH: StoredSearchData = {
	id: "s1",
	type: "search",
	timestamp: 0,
	queries: [
		{ query: "alpha", answer: "answer alpha", results: [{ title: "A", url: "https://a", snippet: "" }], error: null },
		{ query: "beta", answer: "", results: [], error: "provider exploded" },
	],
};

const FETCH: StoredSearchData = {
	id: "f1",
	type: "fetch",
	timestamp: 0,
	urls: [url("https://one"), url("https://two"), url("https://bad", { error: "404" })],
};

beforeEach(() => {
	clearResults();
	storeResult(SEARCH.id, SEARCH);
	storeResult(FETCH.id, FETCH);
});

describe("registration", () => {
	test("both tools register, with the gating each is meant to have", () => {
		const { pi, tools } = capturePi();
		registerFetchContentTool(pi as never);
		registerGetSearchContentTool(pi as never);

		expect([...tools.keys()].sort()).toEqual(["fetch_content", "get_search_content"]);
		// fetch_content is core; get_search_content was demoted to a gate
		// (wayfinder ticket 02). Extraction must not silently restore it.
		expect(tools.get("fetch_content")?.gating).toEqual({ core: true });
		expect(tools.get("get_search_content")?.gating).toEqual({ gate: "get_search_content" });
	});
});

describe("get_search_content — unknown responseId", () => {
	test("refuses and echoes the id back", async () => {
		const r = await getTool().execute("c", { responseId: "nope" });
		expect(textOf(r)).toContain('No stored results for "nope"');
		expect(r.details).toMatchObject({ error: "Not found", responseId: "nope" });
	});
});

describe("get_search_content — stored search results", () => {
	test("by query name returns the formatted results", async () => {
		const r = await getTool().execute("c", { responseId: "s1", query: "alpha" });
		expect(textOf(r)).toContain('## Results for: "alpha"');
		expect(textOf(r)).toContain("answer alpha");
		expect(textOf(r)).toContain("https://a");
		expect(r.details).toMatchObject({ query: "alpha", resultCount: 1 });
	});

	test("by index returns the same as by name", async () => {
		const byIndex = await getTool().execute("c", { responseId: "s1", queryIndex: 0 });
		const byName = await getTool().execute("c", { responseId: "s1", query: "alpha" });
		expect(textOf(byIndex)).toBe(textOf(byName));
	});

	test("an unknown query name lists what IS available", async () => {
		const r = await getTool().execute("c", { responseId: "s1", query: "gamma" });
		expect(r.details.error).toBe("Query not found");
		// The list is the point — a bare "not found" leaves the agent guessing.
		expect(textOf(r)).toContain('"alpha"');
		expect(textOf(r)).toContain('"beta"');
	});

	test("an out-of-range index reports the real range", async () => {
		const r = await getTool().execute("c", { responseId: "s1", queryIndex: 7 });
		expect(r.details.error).toBe("Index out of range");
		expect(textOf(r)).toContain("(0-1)");
	});

	test("no selector at all lists the queries with their indices", async () => {
		const r = await getTool().execute("c", { responseId: "s1" });
		expect(r.details.error).toBe("No query specified");
		expect(textOf(r)).toContain('0: "alpha"');
		expect(textOf(r)).toContain('1: "beta"');
	});

	test("a query that failed at search time surfaces ITS error, not a generic one", async () => {
		const r = await getTool().execute("c", { responseId: "s1", query: "beta" });
		expect(r.details).toMatchObject({ error: "provider exploded", query: "beta" });
		expect(textOf(r)).toContain("provider exploded");
	});
});

describe("get_search_content — stored fetch results", () => {
	test("by url returns title and full content", async () => {
		const r = await getTool().execute("c", { responseId: "f1", url: "https://one" });
		expect(textOf(r)).toBe("# title https://one\n\ncontent of https://one");
		expect(r.details).toMatchObject({
			url: "https://one",
			title: "title https://one",
			contentLength: "content of https://one".length,
		});
	});

	test("by index returns the same as by url", async () => {
		const byIndex = await getTool().execute("c", { responseId: "f1", urlIndex: 1 });
		expect(textOf(byIndex)).toBe("# title https://two\n\ncontent of https://two");
	});

	test("an unknown url lists the stored ones", async () => {
		const r = await getTool().execute("c", { responseId: "f1", url: "https://absent" });
		expect(r.details.error).toBe("URL not found");
		expect(textOf(r)).toContain("https://one");
		expect(textOf(r)).toContain("https://two");
	});

	test("an out-of-range index reports the real range", async () => {
		const r = await getTool().execute("c", { responseId: "f1", urlIndex: 99 });
		expect(r.details.error).toBe("Index out of range");
		expect(textOf(r)).toContain("(0-2)");
	});

	test("no selector lists urls with their indices", async () => {
		const r = await getTool().execute("c", { responseId: "f1" });
		expect(r.details.error).toBe("No URL specified");
		expect(textOf(r)).toContain("0: https://one");
		expect(textOf(r)).toContain("2: https://bad");
	});

	test("a url that failed at fetch time surfaces ITS error", async () => {
		const r = await getTool().execute("c", { responseId: "f1", url: "https://bad" });
		expect(r.details).toMatchObject({ error: "404", url: "https://bad" });
	});

	test("index 0 is a real selector, not a falsy no-selector", async () => {
		// `params.urlIndex !== undefined` rather than a truthiness check — 0 is
		// the most likely index an agent passes, and a truthy guard would send it
		// down the "no selector" path.
		const r = await getTool().execute("c", { responseId: "f1", urlIndex: 0 });
		expect(r.details.error).toBeUndefined();
		expect(r.details.url).toBe("https://one");
	});
});

describe("get_search_content — malformed store entry", () => {
	test("a typed entry with no payload is refused, not thrown on", async () => {
		storeResult("empty", { id: "empty", type: "fetch", timestamp: 0 });
		const r = await getTool().execute("c", { responseId: "empty" });
		expect(r.details.error).toBe("Invalid data");
		expect(textOf(r)).toBe("Invalid stored data format");
	});
});
