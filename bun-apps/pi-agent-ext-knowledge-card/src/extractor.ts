/**
 * src/extractor.ts — pluggable `Extractor` interface (LeanRAG ⑤) + the default
 * deterministic `DictionaryExtractor`.
 *
 * Deterministic-by-design (ADR-0001): the default ingest path is LLM-free. The
 * dictionary extractor wraps the existing 8-type `extractEntities` and emits
 * entities only — no relations. Phase-2's `LlmRelationExtractor` (behind the
 * `kg.llm` gate) implements this same interface and also emits typed
 * relations, degrading to this dictionary result on any LLM failure. This file is the seam both plug into.
 *
 * Library only — no ExtensionAPI, no LLM, no network.
 */
import {
	extractEntities,
	type EntityType,
	type ExtractedEntity,
	type Relation,
} from "@repo/pi-agent-ext-core-interface";
import { chatJson, type LmChatOptions } from "./llm-chat.ts";

export type { Relation } from "@repo/pi-agent-ext-core-interface";

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
 *  instance serves the whole ingest path (and doubles as the LLM path's
 *  never-throws fallback). */
const defaultExtractor: Extractor = new DictionaryExtractor();

// ---------------------------------------------------------------------------
// LlmRelationExtractor (Phase-2 Task 2, LeanRAG ⑤ LLM half)
// ---------------------------------------------------------------------------

/** Sanity caps: a pathological/misbehaving model must not flood a card. */
const MAX_LLM_ENTITIES = 32;
const MAX_LLM_RELATIONS = 64;

/** The 8-type taxonomy — unknown model-proposed types coerce to "concept". */
const ENTITY_TYPES: ReadonlySet<string> = new Set([
	"tool",
	"model",
	"config",
	"concept",
	"error",
	"lib",
	"file",
	"tag",
]);

/** Few-shot system-style instruction (compact — prompt budget is real). */
const EXTRACTION_INSTRUCTION = [
	"You extract typed entities and relations from knowledge-card text for a developer-knowledge graph.",
	'Reply with ONLY one JSON object, no prose: {"entities":[{"type":string,"name":string,"description":string?}],"relations":[{"s":string,"rel":string,"o":string}]}.',
	'Entity "type" must be one of: tool, model, config, concept, error, lib, file, tag — use "concept" when unclear.',
	'In "relations", "s" and "o" must be entity names from your entities list; "rel" is a short lowercase verb phrase (e.g. uses, configures, documents, depends-on).',
	"Example — text: `run.py` renders with Z-Image at `--cfg-scale 3.5`.",
	'{"entities":[{"type":"tool","name":"run.py","description":"MLX pipeline CLI entry"},{"type":"model","name":"Z-Image"},{"type":"config","name":"--cfg-scale"}],"relations":[{"s":"run.py","rel":"uses","o":"Z-Image"},{"s":"run.py","rel":"configures","o":"--cfg-scale"}]}',
	"Example — text: MLX_MODELS_DIR points at the model tree; a missing path crashes the loader.",
	'{"entities":[{"type":"config","name":"MLX_MODELS_DIR","description":"Env var for the MLX model tree"},{"type":"error","name":"loader crash"}],"relations":[{"s":"MLX_MODELS_DIR","rel":"configures","o":"model tree"},{"s":"missing path","rel":"causes","o":"loader crash"}]}',
	"Now extract from this text:",
].join("\n");

/** Raw shape the model is asked for (pre-validation). */
interface RawExtractionPayload {
	entities?: unknown;
	relations?: unknown;
}

/**
 * Tolerant parseFn handed to `chatJson`: strips markdown fences + surrounding
 * prose, JSON.parse's the outermost object, and validates that entities /
 * relations are arrays (entry-level coercion happens downstream). THROWS on
 * any invalid shape so `chatJson` maps it to null (never-throws boundary).
 */
function parseExtractionPayload(raw: string): RawExtractionPayload {
	let text = raw.trim();
	// Strip fenced blocks: ```json ... ``` (leading AND trailing, independently).
	text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
	// Tolerate leading/trailing prose around the JSON object.
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	const body = start >= 0 && end > start ? text.slice(start, end + 1) : text;
	const parsed = JSON.parse(body) as RawExtractionPayload;
	if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
	// Shape contract: at least one of entities/relations must be a real array —
	// anything else ("{\"entities\":\"nope\"}", "{}", bare strings) is an invalid
	// payload: throwing here maps to chatJson null ⇒ dictionary fallback.
	if (!Array.isArray(parsed.entities) && !Array.isArray(parsed.relations)) {
		throw new Error("payload has no entities/relations arrays");
	}
	return parsed;
}

/** Coerce/normalize raw entity entries: keep only {type,name}-string entries,
 *  coerce unknown types to "concept", trim, cap. Malformed entries are
 *  dropped silently — never throw. */
function normalizeEntities(raw: unknown): ExtractedEntity[] {
	if (!Array.isArray(raw)) return [];
	const out: ExtractedEntity[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const { type, name, description } = entry as Record<string, unknown>;
		if (typeof type !== "string" || typeof name !== "string") continue;
		const trimmed = name.trim();
		if (!trimmed) continue;
		const entity: ExtractedEntity = {
			type: (ENTITY_TYPES.has(type) ? type : "concept") as EntityType,
			name: trimmed,
		};
		if (typeof description === "string" && description.trim()) {
			entity.description = description.trim();
		}
		out.push(entity);
	}
	return out.slice(0, MAX_LLM_ENTITIES);
}

/** Coerce/normalize raw relation entries: keep only {s,rel,o}-string entries
 *  with non-empty fields, cap. Malformed entries are dropped silently. */
function normalizeRelations(raw: unknown): Relation[] {
	if (!Array.isArray(raw)) return [];
	const out: Relation[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const { s, rel, o } = entry as Record<string, unknown>;
		if (typeof s !== "string" || typeof rel !== "string" || typeof o !== "string") continue;
		if (!s.trim() || !rel.trim() || !o.trim()) continue;
		out.push({ s: s.trim(), rel: rel.trim(), o: o.trim() });
	}
	return out.slice(0, MAX_LLM_RELATIONS);
}

/**
 * LLM few-shot relation extractor (LeanRAG ⑤, behind the `kg.llm` gate).
 *
 * Builds a system-style instruction + 2 compact few-shot examples asking for
 * the 8-type taxonomy + `{s,rel,o}` relations, sends it through the thin
 * `chatJson` client (Task 1), and normalizes/coerces/caps the result.
 *
 * NEVER-THROWS degradation: `chatJson` null (HTTP/timeout/parse failure) or
 * ANY error in this method ⇒ the DictionaryExtractor's result for the same
 * text (entities only, relations []). The extractor degrades; it never
 * throws, and ingest never crashes on LLM errors. Write authority is intact:
 * only this path can yield relations — the fallback carries [].
 */
export class LlmRelationExtractor implements Extractor {
	constructor(private readonly chatOpts: LmChatOptions = {}) {}

	async extract(text: string): Promise<ExtractionResult> {
		try {
			const prompt = `${EXTRACTION_INSTRUCTION}\n${text}`;
			const parsed = await chatJson(prompt, parseExtractionPayload, this.chatOpts);
			if (parsed === null) return await fallbackExtract(text);
			return {
				entities: normalizeEntities(parsed.entities),
				relations: normalizeRelations(parsed.relations),
			};
		} catch {
			// Any unexpected failure ⇒ dictionary-equivalent result, never throw.
			return await fallbackExtract(text);
		}
	}
}

/** Dictionary-fallback wrapper: even the fallback must never throw — a
 * second failure degrades to the empty result instead of escaping. */
async function fallbackExtract(text: string): Promise<ExtractionResult> {
	try {
		return await defaultExtractor.extract(text);
	} catch {
		return { entities: [], relations: [] };
	}
}

/** Options for the extractor-selection seam. `kgLlmModel` overrides the chat
 *  model id (threaded from `IngestOptions.kgLlmModel`, env fallback
 *  `PI_KG_LLM_MODEL`); other chat-client fields stay defaulted. */
export interface ResolveExtractorOptions {
	kgLlmModel?: string;
}

/**
 * Resolve the active extractor for a text body. `kgLlm` OFF (default) → the
 * deterministic `DictionaryExtractor` singleton (zero LLM cost,
 * byte-identical Phase-1 path). `kgLlm` ON (D4) → `LlmRelationExtractor`
 * (Phase-2 SHIPPED — the plug-point is now real), which itself degrades to
 * dictionary-equivalent output on any LLM failure.
 */
export function resolveExtractor(
	kgLlm = false,
	opts: ResolveExtractorOptions = {},
): Extractor {
	if (kgLlm) {
		return new LlmRelationExtractor(opts.kgLlmModel ? { model: opts.kgLlmModel } : {});
	}
	return defaultExtractor;
}
