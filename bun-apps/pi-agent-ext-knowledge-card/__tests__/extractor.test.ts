/**
 * Tests for src/extractor.ts — pluggable `Extractor` interface + the default
 * `DictionaryExtractor` (LeanRAG ⑤). Phase-1 contract: the dictionary impl
 * wraps the existing deterministic `extractEntities` and emits entities ONLY
 * (no relations, zero LLM). Phase-2 will add an LLM impl behind the `kg.llm`
 * gate that also emits relations behind this same interface.
 *
 * The interface was widened to ASYNC (Task 3a) so Phase-2's LLM impl drops in
 * without a signature-change ripple — every `.extract()` here is `await`ed.
 */
import { test, expect, describe } from "bun:test";
import { extractEntities } from "../src/entities.ts";
import {
	DictionaryExtractor,
	LlmRelationExtractor,
	resolveExtractor,
	type Extractor,
	type ExtractionResult,
} from "../src/extractor.ts";

// Representative knowledge-card-style text: exercises backtick tool/config +
// title-case surfaces → multi-type extraction, all deterministic.
const FIXTURE =
	"`run.py` generates images with Z-Image at `--cfg-scale 3.5`; " +
	"set MLX_MODELS_DIR for the model path.";

describe("DictionaryExtractor", () => {
	test("implements the Extractor interface (type-level + structural)", async () => {
		// Type-level assertion: the class satisfies `Extractor`.
		const extractor: Extractor = new DictionaryExtractor();
		// ExtractionResult must be the { entities, relations } shape. Async since
		// Task 3a widened the interface to Promise<ExtractionResult>.
		const result: ExtractionResult = await extractor.extract(FIXTURE);
		expect(result).toBeDefined();
		expect(Array.isArray(result.entities)).toBe(true);
		expect(result.relations).toEqual([]);
	});

	test("extract() returns entities identical to extractEntities() (behavior preserved)", async () => {
		const expected = extractEntities(FIXTURE);
		// Sanity: the fixture actually yields entities (≥1, multi-type).
		expect(expected.length).toBeGreaterThan(0);
		const { entities } = await new DictionaryExtractor().extract(FIXTURE);
		expect(entities).toEqual(expected); // deep-equal — wrapper is a pure passthrough
	});

	test("emits at least one entity of a known type (non-trivial fixture)", async () => {
		const { entities } = await new DictionaryExtractor().extract(FIXTURE);
		const types = new Set(entities.map((e) => e.type));
		// run.py → file; --cfg-scale / MLX_MODELS_DIR → config. At least one
		// of our 8 typed categories must surface.
		expect(types.size).toBeGreaterThan(0);
		expect(
			types.has("tool") ||
				types.has("model") ||
				types.has("config") ||
				types.has("file"),
		).toBe(true);
	});

	test("relations is always [] (dictionary path emits no relations — Phase-1 contract)", async () => {
		const { relations } = await new DictionaryExtractor().extract(FIXTURE);
		expect(relations).toEqual([]);
	});

	test("empty/blank text yields empty entities + [] relations", async () => {
		const { entities, relations } = await new DictionaryExtractor().extract("");
		expect(entities).toEqual([]);
		expect(relations).toEqual([]);
	});
});

describe("resolveExtractor — kg.llm gate (D4, default OFF)", () => {
	// The kg.llm flag is real + wired (Task 3 / D4). Phase-2 SHIPPED (Task 2):
	// with the flag ON, resolveExtractor returns the LlmRelationExtractor (which
	// itself degrades to dictionary-equivalent output on any LLM failure — see
	// llm-extractor.test.ts). This test only pins the SELECTION — it must not
	// call extract() without an injected `_fetchImpl` (that would hit a real
	// LM Studio endpoint from the suite).
	test("flag ON (kgLlm=true) → LlmRelationExtractor (Phase-2 shipped)", () => {
		expect(resolveExtractor(true)).toBeInstanceOf(LlmRelationExtractor);
	});

	test("flag OFF (kgLlm=false) → default DictionaryExtractor (dictionary path)", async () => {
		const extractor = resolveExtractor(false);
		expect(extractor).toBeInstanceOf(DictionaryExtractor);
		const { entities } = await extractor.extract(FIXTURE);
		expect(entities).toEqual(extractEntities(FIXTURE));
	});
});
