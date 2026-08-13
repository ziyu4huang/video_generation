/**
 * src/extractor.ts — pluggable `Extractor` interface (LeanRAG ⑤) + the default
 * deterministic `DictionaryExtractor`.
 *
 * Deterministic-by-design (ADR-0001): the default ingest path is LLM-free. The
 * dictionary extractor wraps the existing 8-type `extractEntities` and emits
 * entities only — no relations. Phase-2 adds an `LlmRelationExtractor` behind
 * the `kg.llm` config gate (Task 3) that implements this same interface and
 * also emits typed relations. This file is the seam both plug into.
 *
 * Library only — no ExtensionAPI, no LLM, no network.
 */
import { extractEntities, type ExtractedEntity, type Relation } from "./entities.ts";

export type { Relation } from "./entities.ts";

/** Result of extracting graph structure from text. */
export interface ExtractionResult {
	entities: ExtractedEntity[];
	relations: Relation[];
}

/**
 * Pluggable extractor (LeanRAG ⑤). The default `DictionaryExtractor` is
 * deterministic and emits entities only (no relations, zero LLM). Phase-2 adds
 * an LLM impl behind the `kg.llm` gate that also emits relations.
 */
export interface Extractor {
	extract(text: string): ExtractionResult;
}

/**
 * Deterministic dictionary-anchored extractor (default, always-on).
 *
 * Delegates to the existing `extractEntities` (8 typed passes, no LLM) and
 * wraps its result in `{ entities, relations: [] }`. Relations are always
 * empty here — the dictionary path emits entities only by design. Behavior is
 * byte-identical to calling `extractEntities` directly.
 */
export class DictionaryExtractor implements Extractor {
	extract(text: string): ExtractionResult {
		return { entities: extractEntities(text), relations: [] };
	}
}

/** Module-level singleton — the deterministic default is stateless, so one
 *  instance serves the whole ingest path. */
const defaultExtractor: Extractor = new DictionaryExtractor();

/**
 * Resolve the active extractor for a text body. Today this always returns the
 * `DictionaryExtractor`; Phase-2's `kg.llm` gate (Task 3) will select the LLM
 * impl here when the flag is on (falling back gracefully otherwise).
 *
 * Exposed so ingest has a single, swappable call-site.
 */
export function resolveExtractor(): Extractor {
	return defaultExtractor;
}
