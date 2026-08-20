/**
 * Contract tests for obsidian_semantic_search — the vault-mind (ChromaDB)
 * vector-search bridge tool. Uses the fake-pi pattern (collect registered
 * tools, drive .execute directly) and stubs globalThis.fetch so no real
 * HTTP/vault-mind service is required.
 *
 *   bun test extensions/__tests__/semanticSearch.test.ts
 *
 * Covered:
 *   - tool is registered with the documented name + Typebox param schema
 *   - happy path: vault-mind 200 → ranked result text + structured details
 *   - query-string construction (vault_name/query/limit/threshold/tags)
 *   - server unreachable (fetch rejects) → isError + actionable fallback hint
 *   - non-OK HTTP (500/404) → isError
 *   - empty result set → friendly "no hits" text, not an error
 *
 * The tool is optional infrastructure: every failure path returns a structured
 * isError result so the agent can fall back to obsidian_search (lexical) rather
 * than crashing the turn.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const mod = await import("../obsidian.ts");

function makeFakePi() {
	const tools: Record<string, any> = {};
	const pi = {
		registerTool: (t: any) => {
			tools[t.name] = t;
			if (t._capturedTools) Object.assign(tools, t._capturedTools);
		},
		registerCommand: () => {},
		on: () => {},
	};
	return { pi, tools };
}
const { pi, tools } = makeFakePi();
// `pi` is an intentionally-partial mock (only the methods this tool touches);
// cast through `unknown` to satisfy the full ExtensionAPI contract.
mod.default(pi as unknown as ExtensionAPI);

const TOOL = "obsidian_semantic_search";

// ---- fetch stub ----------------------------------------------------------
// The tool reads globalThis.fetch at call time, so per-test overrides work.
const origFetch = globalThis.fetch;
let lastUrl: string | undefined;
let mockResponse: { ok: boolean; status: number; statusText: string; body: any } =
	{ ok: true, status: 200, statusText: "OK", body: { status: "success", data: {} } };
let fetchThrows: string | null = null;

function setMock(opts: Partial<typeof mockResponse>) {
	mockResponse = { ...mockResponse, ...opts };
}
function setFetchError(msg: string) {
	fetchThrows = msg;
}

beforeEach(() => {
	lastUrl = undefined;
	fetchThrows = null;
	setMock({
		ok: true,
		status: 200,
		statusText: "OK",
		body: {
			status: "success",
			data: {
				total_found: 1,
				search_time_ms: 9.4,
				results: [
					{
						id: "vault_card_0",
						content: "weight symlinks silently vanish at commit time",
						similarity_score: 0.618,
						metadata: {
							file_name: "model-symlink-silent-skip-on-commit",
							file_path: "/v/Zettelkasten/model-symlink-silent-skip-on-commit.md",
							searchable_tags: "auto-memory, model-weights, pattern",
						},
					},
				],
			},
		},
	});
	(globalThis as any).fetch = async (url: string) => {
		lastUrl = url;
		if (fetchThrows) throw new Error(fetchThrows);
		return {
			ok: mockResponse.ok,
			status: mockResponse.status,
			statusText: mockResponse.statusText,
			json: async () => mockResponse.body,
		} as Response;
	};
});
afterEach(() => {
	(globalThis as any).fetch = origFetch;
});

async function call(params: any) {
	return await tools[TOOL].execute("id", params, undefined, undefined, {
		cwd: "/tmp",
	});
}

// --------------------------------------------------------------------------

describe("obsidian_semantic_search — registration + schema", () => {
	it("registers the tool with the documented name", () => {
		expect(tools[TOOL]).toBeDefined();
		expect(tools[TOOL].name).toBe(TOOL);
		expect(tools[TOOL].label).toMatch(/semantic/i);
	});

	it("declares query (required) plus the optional knobs", () => {
		const p = tools[TOOL].parameters.properties;
		expect(p.query).toBeDefined();
		expect(tools[TOOL].parameters.required).toEqual(["query"]);
		expect(p.vault_name).toBeDefined();
		expect(p.limit).toBeDefined();
		expect(p.similarity_threshold).toBeDefined();
		expect(p.include_tags).toBeDefined();
		expect(p.exclude_tags).toBeDefined();
	});
});

describe("obsidian_semantic_search — happy path", () => {
	it("returns ranked result text + structured details on 200", async () => {
		const r = await call({
			query: "git branches broke my model weights",
			vault_name: "s2-agent-vault",
		});
		expect(r.isError).toBeFalsy();
		const text: string = r.content[0].text;
		expect(text).toContain("1 semantic result");
		expect(text).toContain("model-symlink-silent-skip-on-commit");
		expect(text).toContain("0.618"); // score surfaced
		expect(r.details.vault).toBe("s2-agent-vault");
		expect(r.details.total_found).toBe(1);
		expect(r.details.results[0].file).toBe("model-symlink-silent-skip-on-commit");
		expect(r.details.results[0].score).toBe(0.618);
	});

	it("builds the vault-mind GET /api/search URL with all params", async () => {
		await call({
			query: "gpu exploding",
			vault_name: "my-vault",
			limit: 5,
			similarity_threshold: 0.25,
			include_tags: ["pattern"],
			exclude_tags: ["draft"],
		});
		expect(lastUrl).toBeDefined();
		const u = new URL(lastUrl!);
		expect(u.pathname).toBe("/api/search");
		expect(u.searchParams.get("vault_name")).toBe("my-vault");
		expect(u.searchParams.get("query")).toBe("gpu exploding");
		expect(u.searchParams.get("limit")).toBe("5");
		expect(u.searchParams.get("similarity_threshold")).toBe("0.25");
		expect(u.searchParams.get("include_tags")).toBe("pattern");
		expect(u.searchParams.get("exclude_tags")).toBe("draft");
	});

	it("honours env VAULT_MIND_BASE_URL when set", async () => {
		process.env.VAULT_MIND_BASE_URL = "http://example.test:9999/vm/";
		try {
			await call({ query: "x", vault_name: "v" });
			expect(lastUrl!.startsWith("http://example.test:9999/vm/api/search")).toBe(
				true,
			);
		} finally {
			delete process.env.VAULT_MIND_BASE_URL;
		}
	});
});

describe("obsidian_semantic_search — graceful failure (fall back to lexical)", () => {
	it("returns isError when the service is unreachable (fetch rejects)", async () => {
		setFetchError("ECONNREFUSED");
		const r = await call({ query: "x", vault_name: "v" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/unreachable|ECONNREFUSED/i);
		// actionable: points the agent at the lexical fallback
		expect(r.content[0].text).toMatch(/obsidian_search/);
	});

	it("returns isError on non-OK HTTP (500)", async () => {
		setMock({ ok: false, status: 500, statusText: "Internal Server Error" });
		const r = await call({ query: "x", vault_name: "v" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("500");
	});

	it("returns isError on 404 (vault not indexed)", async () => {
		setMock({ ok: false, status: 404, statusText: "Not Found" });
		const r = await call({ query: "x", vault_name: "missing-vault" });
		expect(r.isError).toBe(true);
		expect(r.details.vault).toBe("missing-vault");
	});
});

describe("obsidian_semantic_search — empty result handling", () => {
	it("returns a friendly 'no hits' message (NOT an error) when 0 cards match", async () => {
		setMock({
			body: {
				status: "success",
				data: { total_found: 0, search_time_ms: 5, results: [] },
			},
		});
		const r = await call({ query: "zzz", vault_name: "v" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/no semantic hits/i);
		expect(r.details.total_found).toBe(0);
	});
});
