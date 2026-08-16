/**
 * Tests for `LlmRelationExtractor` (Phase-2 Task 2, LeanRAG ⑤ LLM half).
 *
 * The extractor implements the async `Extractor` seam behind the `kg.llm`
 * gate. All chat traffic is injected via `_fetchImpl` (deterministic, no live
 * LM Studio). Contract under test:
 *
 * - Success: canned entities+relations round-trip (descriptions preserved,
 *   malformed entries dropped, unknown entity types coerced to "concept").
 * - NEVER-THROWS degradation: chat null (HTTP 500) OR unparseable content ⇒
 *   the result is dictionary-equivalent (entities === extractEntities(text),
 *   relations []).
 * - Sanity caps: entities ≤ 32, relations ≤ 64.
 * - Type-level: the class satisfies `Extractor`.
 * - `resolveExtractor(kgLlm=true)` returns it (Phase-2 shipped — no longer a
 *   dictionary no-op).
 */
import { test, expect, describe } from "bun:test";
import { extractEntities } from "@repo/pi-agent-core-interface";
import {
	DictionaryExtractor,
	LlmRelationExtractor,
	resolveExtractor,
	type Extractor,
	type ExtractionResult,
} from "../src/extractor.ts";

const FIXTURE =
	"`run.py` generates images with Z-Image at `--cfg-scale 3.5`; " +
	"set MLX_MODELS_DIR for the model path.";

/** Build a canned chat-completions Response whose assistant content is the
 *  given raw string (pre-JSON — callers pass JSON.stringify(payload) or
 *  garbage text). */
function chatContent(content: string, status = 200): Response {
	return new Response(
		JSON.stringify({ choices: [{ message: { content } }] }),
		{ status, headers: { "content-type": "application/json" } },
	);
}

/** Canned fetch returning a fixed content string every call. */
function cannedFetch(content: string, status = 200): typeof fetch {
	return (async () => chatContent(content, status)) as unknown as typeof fetch;
}

const SUCCESS_PAYLOAD = {
	entities: [
		{ type: "tool", name: "run.py", description: "MLX pipeline CLI entry" },
		{ type: "model", name: "Z-Image" },
		{ type: "quantum", name: "Weird Thing", description: "unknown type → concept" },
		{ name: 42, type: "tool" }, // malformed: name not a string → dropped
		null, // malformed → dropped
	],
	relations: [
		{ s: "run.py", rel: "uses", o: "Z-Image" },
		{ s: "run.py", rel: 7, o: "Z-Image" }, // malformed: rel not a string → dropped
		{ s: "", rel: "uses", o: "Z-Image" }, // malformed: empty s → dropped
	],
};

describe("LlmRelationExtractor", () => {
	test("satisfies the Extractor interface (type-level + structural)", () => {
		const extractor: Extractor = new LlmRelationExtractor({ _fetchImpl: cannedFetch("") });
		expect(typeof extractor.extract).toBe("function");
	});

	test("success: canned entities + relations round-trip (descriptions kept, malformed dropped)", async () => {
		const extractor = new LlmRelationExtractor({
			_fetchImpl: cannedFetch(JSON.stringify(SUCCESS_PAYLOAD)),
		});
		const result: ExtractionResult = await extractor.extract(FIXTURE);
		// 5 raw entity entries → 3 survive (malformed name/null dropped);
		// unknown type "quantum" coerced to "concept".
		expect(result.entities).toEqual([
			{ type: "tool", name: "run.py", description: "MLX pipeline CLI entry" },
			{ type: "model", name: "Z-Image" },
			{ type: "concept", name: "Weird Thing", description: "unknown type → concept" },
		]);
		// 3 raw relations → 1 survives (malformed rel / empty s dropped).
		expect(result.relations).toEqual([{ s: "run.py", rel: "uses", o: "Z-Image" }]);
	});

	test("success: dictionary-style payload without descriptions still parses", async () => {
		const payload = {
			entities: [{ type: "lib", name: "mlx" }],
			relations: [{ s: "mlx", rel: "runs-on", o: "Apple Silicon" }],
		};
		const result = await new LlmRelationExtractor({
			_fetchImpl: cannedFetch(JSON.stringify(payload)),
		}).extract(FIXTURE);
		expect(result.entities).toEqual([{ type: "lib", name: "mlx" }]);
		expect(result.relations).toEqual([{ s: "mlx", rel: "runs-on", o: "Apple Silicon" }]);
	});

	test("tolerates markdown-fenced JSON content", async () => {
		const fenced = "```json\n" + JSON.stringify(SUCCESS_PAYLOAD) + "\n```";
		const result = await new LlmRelationExtractor({
			_fetchImpl: cannedFetch(fenced),
		}).extract(FIXTURE);
		expect(result.relations).toEqual([{ s: "run.py", rel: "uses", o: "Z-Image" }]);
	});

	test("chat null (HTTP 500) → dictionary-equivalent, never throws", async () => {
		const extractor = new LlmRelationExtractor({ _fetchImpl: cannedFetch("boom", 500) });
		const result = await extractor.extract(FIXTURE);
		const dictionary = await new DictionaryExtractor().extract(FIXTURE);
		expect(result).toEqual(dictionary);
		expect(result.entities).toEqual(extractEntities(FIXTURE));
		expect(result.relations).toEqual([]);
	});

	test("garbage (non-JSON) content → dictionary-equivalent", async () => {
		const extractor = new LlmRelationExtractor({
			_fetchImpl: cannedFetch("I am sorry, I cannot answer that."),
		});
		const result = await extractor.extract(FIXTURE);
		expect(result).toEqual(await new DictionaryExtractor().extract(FIXTURE));
		expect(result.relations).toEqual([]);
	});

	test("null-ish/JSON-but-wrong-shape content (entities/relations not arrays) → dictionary-equivalent", async () => {
		const extractor = new LlmRelationExtractor({
			_fetchImpl: cannedFetch(JSON.stringify({ entities: "nope", relations: 3 })),
		});
		const result = await extractor.extract(FIXTURE);
		expect(result).toEqual(await new DictionaryExtractor().extract(FIXTURE));
	});

	test("caps: 100 canned relations → 64 returned; 50 entities → 32", async () => {
		const payload = {
			entities: Array.from({ length: 50 }, (_, i) => ({
				type: "concept",
				name: `entity-${i}`,
			})),
			relations: Array.from({ length: 100 }, (_, i) => ({
				s: `entity-${i}`,
				rel: "relates-to",
				o: `entity-${(i + 1) % 100}`,
			})),
		};
		const result = await new LlmRelationExtractor({
			_fetchImpl: cannedFetch(JSON.stringify(payload)),
		}).extract(FIXTURE);
		expect(result.entities.length).toBe(32);
		expect(result.relations.length).toBe(64);
	});
});

describe("resolveExtractor — kg.llm gate (Phase-2 shipped)", () => {
	test("flag ON (kgLlm=true) → LlmRelationExtractor", () => {
		expect(resolveExtractor(true)).toBeInstanceOf(LlmRelationExtractor);
	});

	test("flag ON threads kgLlmModel as the chat model option", () => {
		// Structural: resolves without error when a model override is given.
		// (Deep threading is covered by kgLlmModel → IngestOptions tests.)
		expect(resolveExtractor(true, { kgLlmModel: "test/model" })).toBeInstanceOf(
			LlmRelationExtractor,
		);
	});

	test("flag OFF (kgLlm=false) → default DictionaryExtractor singleton", () => {
		expect(resolveExtractor(false)).toBeInstanceOf(DictionaryExtractor);
		expect(resolveExtractor()).toBeInstanceOf(DictionaryExtractor);
	});
});
