/**
 * Tests for src/extractor.ts — pluggable `Extractor` interface + the default
 * `DictionaryExtractor` (LeanRAG ⑤). Phase-1 contract: the dictionary impl
 * wraps the existing deterministic `extractEntities` and emits entities ONLY
 * (no relations, zero LLM). Phase-2 will add an LLM impl behind the `kg.llm`
 * gate that also emits relations behind this same interface.
 */
import { test, expect, describe } from "bun:test";
import { extractEntities } from "../src/entities.ts";
import {
	DictionaryExtractor,
	type Extractor,
	type ExtractionResult,
} from "../src/extractor.ts";

// Representative knowledge-card-style text: exercises backtick tool/config +
// title-case surfaces → multi-type extraction, all deterministic.
const FIXTURE =
	"`run.py` generates images with Z-Image at `--cfg-scale 3.5`; " +
	"set MLX_MODELS_DIR for the model path.";

describe("DictionaryExtractor", () => {
	test("implements the Extractor interface (type-level + structural)", () => {
		// Type-level assertion: the class satisfies `Extractor`.
		const extractor: Extractor = new DictionaryExtractor();
		// ExtractionResult must be the { entities, relations } shape.
		const result: ExtractionResult = extractor.extract(FIXTURE);
		expect(result).toBeDefined();
		expect(Array.isArray(result.entities)).toBe(true);
		expect(result.relations).toEqual([]);
	});

	test("extract() returns entities identical to extractEntities() (behavior preserved)", () => {
		const expected = extractEntities(FIXTURE);
		// Sanity: the fixture actually yields entities (≥1, multi-type).
		expect(expected.length).toBeGreaterThan(0);
		const { entities } = new DictionaryExtractor().extract(FIXTURE);
		expect(entities).toEqual(expected); // deep-equal — wrapper is a pure passthrough
	});

	test("emits at least one entity of a known type (non-trivial fixture)", () => {
		const { entities } = new DictionaryExtractor().extract(FIXTURE);
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

	test("relations is always [] (dictionary path emits no relations — Phase-1 contract)", () => {
		const { relations } = new DictionaryExtractor().extract(FIXTURE);
		expect(relations).toEqual([]);
	});

	test("empty/blank text yields empty entities + [] relations", () => {
		const { entities, relations } = new DictionaryExtractor().extract("");
		expect(entities).toEqual([]);
		expect(relations).toEqual([]);
	});
});
