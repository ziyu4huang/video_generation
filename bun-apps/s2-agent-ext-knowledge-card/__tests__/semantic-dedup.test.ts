/**
 * Ticket 13 (context-lifecycle P3): vector pre-filter + gray-zone LLM dedup
 * on the ingest path. Hermetic — the embedder is injected (`_testEmbedder`,
 * the retrieve.ts contract) and the gray-zone chat rides `_dedupFetch`, so no
 * live LM Studio is ever contacted.
 *
 * Coverage per the ticket's acceptance:
 *  - seeded near-dups merge via the VECTOR lane (≥0.90, no LLM call);
 *  - distinct corpus: ZERO false merges (every record creates);
 *  - gray-zone-only LLM invocations (a fetch call counter);
 *  - guardrails: merge must name a candidate id — malformed / unknown target /
 *    HTTP failure all fail OPEN to create; "skip" drops the record;
 *  - offline degrade: a failing embedder → today's Jaccard-only behavior;
 *  - re-ingest idempotency: same input → same vault state.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRecords } from "../src/ingest.ts";
import { planDedup } from "../src/semantic-dedup.ts";
import type { Embedder } from "@repo/s2-agent-core-interface";
import type { KnowledgeRecord } from "../src/types.ts";

const FOLDER = "Zettelkasten/knowledge-graph";

let vault: string;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-dedup-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

function rec(over: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
	return {
		id: "test:base",
		type: "gotcha",
		title: "Base gotcha",
		detail: "Some detail about the gotcha.",
		tags: ["probe"],
		dimension: null,
		confidence: 0.8,
		status: "active",
		superseded_by: null,
		...over,
	};
}

// --- injectable embedder ----------------------------------------------------
// Marker-keyed vectors: a text containing "topic-a" embeds to [1,0,0] etc, on
// BOTH sides (card cache texts via cardEmbedText, record texts via
// recordEmbedText) — so cosine is exactly the marker agreement. gray1/gray2
// are a fixed 0.8-cosine pair (4·5 / (5·√25) = 0.8) inside the gray band.
const VECS: [string, number[]][] = [
	["topic-a", [1, 0, 0]],
	["topic-b", [0, 1, 0]],
	["topic-c", [0, 0, 1]],
	["gray1", [4, 3]],
	["gray2", [5, 0]],
];
const markerEmbedder: Embedder = (texts) =>
	Promise.resolve(
		texts.map((t) => {
			for (const [k, v] of VECS) if (t.includes(k)) return v;
			return [0.001, 0.002, 0.003]; // near-zero — no accidental pairing
		}),
	);

// --- chat mock --------------------------------------------------------------
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
function asFetch(f: FetchLike): typeof fetch {
	return f as unknown as typeof fetch;
}
function chatFetch(reply: (prompt: string) => string): { fetch: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const impl: FetchLike = async (_input, init) => {
		calls.push(String(init?.body));
		const prompt = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[0]!.content;
		return new Response(
			JSON.stringify({ choices: [{ message: { role: "assistant", content: reply(prompt) } }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { fetch: asFetch(impl), calls };
}

const baseOpts = () => ({ vaultPath: vault, source: "generic" as const, sourceLabel: "test:dedup" });

function folderFiles(): string[] {
	return readdirSync(join(vault, FOLDER)).filter((n) => n.endsWith(".md")).sort();
}

async function seedCorpus(records: KnowledgeRecord[]) {
	// First batch on an EMPTY folder: existing.size === 0 → no pre-filter,
	// straight create (this is also the degrade contract for fresh folders).
	return ingestRecords(records, { ...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder });
}

describe("planDedup (pure pre-filter)", () => {
	const byName = new Map([["card-a", "src:a"], ["card-b", "src:b"]]);
	test("null query vector → create", () => {
		expect(planDedup(null, ["f/card-a"], [[1, 0]], byName)).toEqual({ kind: "create" });
	});
	test("top-1 ≥ merge threshold → deterministic merge", () => {
		const plan = planDedup([1, 0], ["f/card-a", "f/card-b"], [[1, 0], [0, 1]], byName);
		expect(plan.kind).toBe("merge");
		if (plan.kind === "merge") {
			expect(plan.candidate.basename).toBe("card-a");
			expect(plan.candidate.sim).toBeCloseTo(1);
		}
	});
	test("in-band → gray with candidates sorted by sim desc, capped at 3", () => {
		// query [4,3]: cos 0.8 with [5,0] (four in band), 0.6 with [0,1].
		const plan = planDedup(
			[4, 3],
			["f/a", "f/b", "f/c", "f/d", "f/e"],
			[[0, 1], [5, 0], [5, 0], [5, 0], [5, 0]],
			byName,
		);
		expect(plan.kind).toBe("gray");
		if (plan.kind === "gray") {
			expect(plan.candidates.length).toBe(3); // 4 in band, capped
			expect(plan.candidates.every((c) => c.sim > 0.75 && c.sim < 0.9)).toBe(true);
		}
	});
	test("below gray → create", () => {
		expect(planDedup([0, 1], ["f/a"], [[1, 0]], byName)).toEqual({ kind: "create" });
	});
});

describe("ingest semantic dedup — vector lane", () => {
	test("seeded near-dup merges into the existing card, no LLM call", async () => {
		const seed = await seedCorpus([
			rec({ id: "src:a", title: "topic-a lever", detail: "Use topic-a for stability." }),
			rec({ id: "src:b", title: "topic-b lever", detail: "Use topic-b for speed." }),
		]);
		expect(seed.created).toBe(2);

		const chat = chatFetch(() => {
			throw new Error("LLM must not be called in the vector lane");
		});
		const dup = rec({
			id: "src:a-restated",
			title: "topic-a revisited", // same marker → cosine 1.0, no shared Jaccard tokens
			detail: "A differently worded restatement of the topic-a lesson.",
		});
		const s = await ingestRecords([dup], {
			...baseOpts(), semanticDedup: true,
			_testEmbedder: markerEmbedder, _dedupFetch: chat.fetch,
		});
		expect(chat.calls.length).toBe(0); // gray-zone-only LLM (counter)
		expect(s.semanticMerged).toBe(1);
		expect(s.created).toBe(0);
		expect(folderFiles()).toEqual(seed.cards.map((c) => c.path.split("/").pop() ?? "").sort());
		const merged = readFileSync(join(vault, FOLDER, folderFiles()[0]!), "utf8");
		expect(merged).toContain("semantic-merged: test:dedup");
		expect(s.dedupDecisions).toEqual([
			{ id: "src:a-restated", sim: 1, via: "vector", target: expect.any(String) },
		]);
	});

	test("distinct corpus: zero false merges", async () => {
		await seedCorpus([
			rec({ id: "src:a", title: "topic-a lever", detail: "Use topic-a." }),
			rec({ id: "src:b", title: "topic-b lever", detail: "Use topic-b." }),
		]);
		const chat = chatFetch(() => '{"decision":"merge","target":"src:a"}');
		const s = await ingestRecords(
			[
				rec({ id: "src:c1", title: "topic-c one", detail: "Distinct topic-c fact." }),
				rec({ id: "src:c2", title: "topic-c two", detail: "Another distinct topic-c fact." }),
			],
			{ ...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder, _dedupFetch: chat.fetch },
		);
		expect(chat.calls.length).toBe(0); // everything below gray — no LLM
		expect(s.semanticMerged).toBe(0);
		expect(s.created).toBe(2);
		expect(folderFiles().length).toBe(4);
	});

	test("re-ingest idempotency: same input → same vault state", async () => {
		await seedCorpus([rec({ id: "src:a", title: "topic-a lever", detail: "Use topic-a." })]);
		const dup = rec({ id: "src:a-restated", title: "topic-a again", detail: "Restated topic-a lesson." });
		const first = await ingestRecords([dup], {
			...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder,
		});
		expect(first.semanticMerged).toBe(1);
		const afterFirst = folderFiles().map((f) => readFileSync(join(vault, FOLDER, f), "utf8")).join("\n--\n");

		const second = await ingestRecords([dup], {
			...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder,
		});
		expect(second.semanticMerged).toBe(1);
		expect(second.updated).toBe(0); // unchanged — the merge line is already there
		const afterSecond = folderFiles().map((f) => readFileSync(join(vault, FOLDER, f), "utf8")).join("\n--\n");
		expect(afterSecond).toBe(afterFirst);
	});
});

describe("ingest semantic dedup — gray-zone LLM lane", () => {
	async function seedGray() {
		// gray2 card; a gray1-marked record sits at cosine 0.8 against it.
		await seedCorpus([rec({ id: "src:g", title: "gray2 lever", detail: "Use gray2." })]);
		return rec({ id: "src:g-near", title: "gray1 near-dup", detail: "Wording that lands near gray2." });
	}

	test("LLM merge naming a candidate merges via the llm lane", async () => {
		const near = await seedGray();
		const chat = chatFetch(() => '{"decision":"merge","target":"src:g"}');
		const s = await ingestRecords([near], {
			...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder, _dedupFetch: chat.fetch,
		});
		expect(chat.calls.length).toBe(1);
		expect(s.semanticMerged).toBe(1);
		expect(s.dedupDecisions[0]?.via).toBe("llm");
		expect(readFileSync(join(vault, FOLDER, folderFiles()[0]!), "utf8")).toContain("semantic-merged");
	});

	test("LLM merge naming an UNKNOWN target fails open to create", async () => {
		const near = await seedGray();
		const chat = chatFetch(() => '{"decision":"merge","target":"no-such-card"}');
		const s = await ingestRecords([near], {
			...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder, _dedupFetch: chat.fetch,
		});
		expect(s.created).toBe(1);
		expect(s.semanticMerged).toBe(0);
		expect(s.dedupDecisions[0]?.via).toBe("llm-malformed");
	});

	test("LLM skip drops the record (not minted, not merged)", async () => {
		const near = await seedGray();
		const chat = chatFetch(() => '{"decision":"skip"}');
		const s = await ingestRecords([near], {
			...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder, _dedupFetch: chat.fetch,
		});
		expect(s.semanticSkipped).toBe(1);
		expect(s.created).toBe(0);
		expect(folderFiles().length).toBe(1);
	});

	test("unparseable LLM output fails open to create (after the retry envelope)", async () => {
		const near = await seedGray();
		const chat = chatFetch(() => "not json at all");
		const s = await ingestRecords([near], {
			...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder, _dedupFetch: chat.fetch,
		});
		expect(chat.calls.length).toBe(2); // first attempt + the one parse-failure retry
		expect(s.created).toBe(1);
		expect(s.dedupDecisions[0]?.via).toBe("llm-failed");
	});

	test("gray-zone-only invocations: vector merge and below-gray records never call the LLM", async () => {
		await seedCorpus([
			rec({ id: "src:a", title: "topic-a lever", detail: "Use topic-a." }),
			rec({ id: "src:g", title: "gray2 lever", detail: "Use gray2." }),
		]);
		const chat = chatFetch(() => '{"decision":"create"}');
		const s = await ingestRecords(
			[
				rec({ id: "src:a-dup", title: "topic-a restated", detail: "Restated topic-a." }), // vector lane
				rec({ id: "src:g-near", title: "gray1 near-dup", detail: "Near gray2." }), // gray lane
				rec({ id: "src:c-new", title: "topic-c fresh", detail: "Fresh topic-c." }), // below gray
			],
			{ ...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder, _dedupFetch: chat.fetch },
		);
		expect(chat.calls.length).toBe(1); // ONLY the gray record reached the LLM
		expect(s.semanticMerged).toBe(1); // topic-a via vector
		expect(s.created).toBe(2); // gray "create" + below-gray
	});
});

describe("ingest semantic dedup — offline degrade", () => {
	test("failing embedder degrades to today's Jaccard-only path", async () => {
		await seedCorpus([rec({ id: "src:a", title: "topic-a lever", detail: "Use topic-a." })]);
		const failing: Embedder = () => Promise.reject(new Error("LM Studio down"));
		const s = await ingestRecords(
			[
				rec({ id: "src:a-restated", title: "topic-a again", detail: "Restated topic-a." }),
				rec({ id: "src:new", title: "topic-c fresh", detail: "Fresh topic-c." }),
			],
			{ ...baseOpts(), semanticDedup: true, _testEmbedder: failing },
		);
		expect(s.semanticMerged).toBe(0);
		expect(s.dedupDecisions).toEqual([]); // cache miss → pre-filter never ran
		expect(s.created).toBe(2); // both take the plain create path
	});

	test("flag OFF (default): byte-identical today behavior, no embedder call", async () => {
		await seedCorpus([rec({ id: "src:a", title: "topic-a lever", detail: "Use topic-a." })]);
		let embedderCalls = 0;
		const counting: Embedder = (texts) => {
			embedderCalls += texts.length;
			return markerEmbedder(texts, "test");
		};
		const s = await ingestRecords(
			[rec({ id: "src:a-restated", title: "topic-a again", detail: "Restated topic-a." })],
			{ ...baseOpts(), _testEmbedder: counting }, // semanticDedup unset
		);
		expect(embedderCalls).toBe(0);
		expect(s.created).toBe(1);
		expect(s.semanticMerged).toBe(0);
	});

	test("exact-id record takes the normal upsert path even when semantically near", async () => {
		await seedCorpus([rec({ id: "src:a", title: "topic-a lever", detail: "Use topic-a." })]);
		const chat = chatFetch(() => {
			throw new Error("LLM must not be called for an exact-id upsert");
		});
		const s = await ingestRecords(
			[rec({ id: "src:a", title: "topic-a lever v2", detail: "Use topic-a, updated wording." })],
			{ ...baseOpts(), semanticDedup: true, _testEmbedder: markerEmbedder, _dedupFetch: chat.fetch },
		);
		expect(s.updated).toBe(1); // upsert onto its own canonical card
		expect(s.semanticMerged).toBe(0);
		expect(folderFiles().length).toBe(1);
	});
});
