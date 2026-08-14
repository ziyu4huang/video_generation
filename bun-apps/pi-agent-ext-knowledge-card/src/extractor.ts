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
 * an LLM impl behind the `kg.llm` gate that also emits relations. Widened to
 * ASYNC (Task 3a) so Phase-2's LLM impl drops in without a signature-change
 * ripple — the async signature is the natural shape for an LLM call.
 */
export interface Extractor {
	extract(text: string): Promise<ExtractionResult>;
}

/**
 * Deterministic dictionary-anchored extractor (default, always-on).
 *
 * Delegates to the existing `extractEntities` (8 typed passes, no LLM) and
 * wraps its result in `{ entities, relations: [] }`. Relations are always
 * empty here — the dictionary path emits entities only by design. Behavior is
 * byte-identical to calling `extractEntities` directly. `async` only to honor
 * the (Task 3a) async interface — the body is synchronous, so `async` wraps it
 * in an immediately-resolved Promise (no extra cost).
 */
export class DictionaryExtractor implements Extractor {
	async extract(text: string): Promise<ExtractionResult> {
		return { entities: extractEntities(text), relations: [] };
	}
}

/** Module-level singleton — the deterministic default is stateless, so one
 *  instance serves the whole ingest path. */
const defaultExtractor: Extractor = new DictionaryExtractor();

/**
 * Resolve the active extractor for a text body. Today this ALWAYS returns the
 * `DictionaryExtractor` — including when the `kg.llm` flag (D4) is ON. That is
 * intentional: Phase-1 is a GRACEFUL NO-OP (the LLM impl doesn't exist yet),
 * so the flag is real + wired but turning it on still yields dictionary
 * entities (no throw, no LLM cost). The `kgLlm` arg makes the gate observable
 * + testable and is the selection seam.
 *
 * Phase-2: plug `LlmRelationExtractor` here when `kgLlm` is true — it
 * implements this same Extractor interface and also emits typed relations.
 * Do NOT add an LLM call before Phase-2.
 */
export function resolveExtractor(kgLlm = false): Extractor {
	if (kgLlm) {
		// Phase-2: plug LlmRelationExtractor here when kg.llm is on.
		return defaultExtractor; // graceful dictionary fallback (Phase-1)
	}
	return defaultExtractor;
}
