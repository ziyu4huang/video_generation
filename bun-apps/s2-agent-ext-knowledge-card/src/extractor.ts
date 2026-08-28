/**
 * src/extractor.ts — pluggable `Extractor` interface (LeanRAG ⑤) + the default
 * deterministic `DictionaryExtractor`.
 *
 * Deterministic-by-design (tier rule): the default ingest path is LLM-free. The
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
} from "@repo/s2-agent-core-interface";
import { chatJson, type LmChatOptions } from "./llm-chat.ts";
import { clampSummary, SUMMARY_MAX_CHARS } from "./card-format.ts";

export type { Relation } from "@repo/s2-agent-core-interface";

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

// ---------------------------------------------------------------------------
// Summary L0 (schema v2 / D4) — deterministic first sentence + gated LLM condense
// ---------------------------------------------------------------------------

/** Bodies at or under this length skip the LLM condense entirely — their first
 *  sentence is a faithful abstract AND the semantic layer already embeds this
 *  window verbatim (semantic.ts embeds the first 800 chars of body prose), so
 *  an LLM pass would buy nothing. Mirrors the leanrag-D6 budget-gating rule. */
export const SUMMARY_BODY_BUDGET = 800;

/** Boilerplate markers for the leading-block strip (#2056 symptom 3): a page
 *  whose head is a copyright/license/legal notice block (file2md page output
 *  begins with the spec's title-page legalese) must not have that as its L0
 *  abstract. TWO tiers (review finding 1 — the strip runs inside
 *  firstSentenceSummary for EVERY source, so weak words must not fire on
 *  ordinary prose like "How to license your product…"):
 *  - ANYWHERE in the line: only unambiguous legal markers (`copyright`, `©`,
 *    `all rights reserved`) — prose never legitimately contains these.
 *  - LINE-START only AND immediately followed by a notice separator (`:`,
 *    `—`, `-`) or end-of-line: `license`/`licence`/`disclaimer`/
 *    `legal notice`/`trademark`/`(c)`. Real title-page notices have the shape
 *    `License: MIT` / `DISCLAIMER` alone on a line; prose that merely BEGINS
 *    a line with the word ("Disclaimer applies to beta builds only.")
 *    survives. */
const BOILERPLATE_ANYWHERE_RE = /(copyright|©|all rights reserved)/i;
const BOILERPLATE_LINE_START_RE =
	/^\s*(?:[-*>#]+\s*)?(license|licence|disclaimer|legal notice|trademark|\(c\))(?:\s*[:：—-]|\s*$)/i;
/** Tier 3 (#2056 residual, license-NOTE prose): a `NOTE:`/`NOTICE:` line that
 *  itself carries legal language starts a legal-note RUN, and the run keeps
 *  swallowing soft-wrapped continuation lines while they stay legal-dense —
 *  the USB4 title page's notice block (`NOTE: Adopters may only use …` /
 *  `…all other uses are prohibited.`) has no other marker on its continuation
 *  lines, so tiers 1–2 stop mid-block and the legal text re-pollutes the
 *  abstract head (measured: generic-page-003). `NOTE:` alone is common
 *  ordinary prose — the legal keyword gate is what keeps this tier from
 *  firing on "NOTE: this is a draft".
 *
 *  Two strengths (same discipline as tiers 1–2's anywhere/line-start split):
 *  the START gate may use bare legal words (patent/license/trademark — the
 *  `NOTE:` prefix is already a strong signal), but a CONTINUATION line must
 *  carry an unambiguous legal PHRASE — "The chapter covers patent history
 *  broadly." must not extend the run just for mentioning patents. Bare
 *  copyright/©/all-rights-reserved remain covered on every line by tier 1. */
const LEGAL_NOTE_START_RE = /^\s*(?:[-*>#]+\s*)?(?:note|notice)\s*[:：]/i;
const LEGAL_NOTE_CONTENT_RE =
	/\b(adopters?|may only|expressly|prohibited|sole purpose|solely|not authorized|no other rights|no other uses|without limitation|written permission|intellectual property|hereby|licen[cs]e|licen[cs]ed|licen[cs]ing|patent|trademark)\b|copyright|©|all rights reserved/i;
const LEGAL_RUN_PHRASE_RE =
	/\b(adopters?|may only|expressly|prohibited|sole purpose|solely to the extent|not authorized|no other rights|no other uses|without limitation|written permission|intellectual property|hereby)\b|copyright|©|all rights reserved/i;

/** How many leading lines the boilerplate strip may scan past — the strip is
 *  for TITLE-PAGE blocks, not for scrubbing a legal notice deep in the body
 *  (those stay: the abstract head just has to clear the leading block). */
const BOILERPLATE_SCAN_LINES = 12;

/** Extra lines a tier-3 legal run may extend past the base window — real
 *  title-page notice blocks run 25+ soft-wrapped lines (measured:
 *  usb4 page-003's NOTE + LIMITED COPYRIGHT LICENSE + all-caps IP
 *  disclaimer). Only applies once a legal run has STARTED inside the base
 *  window, so the strip still cannot reach into a clean body. The cap is
 *  ABSOLUTE (base 12 + 48 = line index 60): a run starting late in the base
 *  window gets fewer than 48 extra lines, and a >60-line notice leaks its
 *  tail into the summary (bounded by design). */
const LEGAL_RUN_EXTRA_LINES = 48;

/** Does this line read as a title-page legal notice? (tiers 1–2, see the
 *  BOILERPLATE_*_RE docblock). */
function isBoilerplateLine(ln: string): boolean {
	return BOILERPLATE_ANYWHERE_RE.test(ln) || BOILERPLATE_LINE_START_RE.test(ln);
}

/** Does this line BEGIN a legal-note run? (tier 3 — a `NOTE:` line that
 *  carries legal language; see the LEGAL_NOTE_START_RE docblock). */
function isLegalNoteLine(ln: string): boolean {
	return LEGAL_NOTE_START_RE.test(ln) && LEGAL_NOTE_CONTENT_RE.test(ln);
}

/** Strip the leading copyright/license boilerplate block from a body: drop
 *  leading lines that match isBoilerplateLine (scanning at most the first
 *  BOILERPLATE_SCAN_LINES lines, stopping at the first clean line — a
 *  boilerplate line deep in the body is content, not a header). Lines before
 *  the first boilerplate line are kept (a real title/heading precedes the
 *  notice on some pages). Exported for the generic adapter's explicit summary
 *  (#2056 D-c) and tested directly. */
/** Does a line read as title-page all-caps legalese? (≥80% uppercase letters,
 *  ≥20 letters — the IP-disclaimer PARAGRAPHS of a title page run 40+ letters,
 *  while common all-caps section headings ("CHAPTER 1" = 8, "INTRODUCTION" =
 *  12, "NORMATIVE REFERENCES" = 19) are shorter; the floor keeps those out of
 *  the strip. Known gap (accepted): a 20–39-letter all-caps heading inside a
 *  live legal run is still swallowed — one line, no cascade, and only when no
 *  clean line separates it from the notice. Review blocker 1 against #2098:
 *  at ≥4 the rule ate "CHAPTER 1"-style headings and the swallowed heading
 *  then armed the wrap cascade onto real prose. Only consulted INSIDE an
 *  active legal run, never to start one). */
function isMostlyUppercase(ln: string): boolean {
	const letters = ln.replace(/[^A-Za-z]/g, "");
	if (letters.length < 20) return false;
	const upper = letters.replace(/[^A-Z]/g, "").length;
	return upper / letters.length >= 0.8;
}

/** Does a line END with sentence-final punctuation? A notice block's
 *  soft-wrapped lines end mid-sentence ("…under the"), so a non-final line
 *  inside a legal run extends it; a line that CLOSES a sentence does not
 *  (the next line must justify itself). */
function endsSentence(ln: string): boolean {
	return /[.!?;:。．！？；：]["'”’)]*\s*$/.test(ln.trimEnd());
}

export function stripLeadingBoilerplate(text: string): string {
	const lines = text.split(/\r?\n/);
	// Find the FIRST boilerplate line in the base window; if none, return as-is.
	let first = -1;
	for (let i = 0; i < Math.min(lines.length, BOILERPLATE_SCAN_LINES); i++) {
		if (isBoilerplateLine(lines[i]!) || isLegalNoteLine(lines[i]!)) {
			first = i;
			break;
		}
	}
	if (first === -1) return text;
	// Drop the boilerplate block from `first` onward. Tier-3 legal runs are
	// the long soft-wrapped title-page notices: once started, a run extends
	// across blanks and any line that is legal-dense, all-caps legalese, OR
	// a soft-wrapped continuation (the previous text line did not close a
	// sentence, or this line starts lowercase). A line that closes its
	// sentence and none of the signals fire is real content — the run ends.
	// Everything before `first` is kept.
	let last = first;
	let inLegalRun = isLegalNoteLine(lines[first]!);
	let lastTextLine: string | null = inLegalRun ? lines[first]! : null;
	for (let i = first + 1; i < lines.length; i++) {
		// The window bound is re-evaluated per line: a legal run that starts
		// mid-block (© line first, NOTE line after) lifts the cap from the
		// moment it flips on — the base window only bounds finding `first`.
		if (i >= (inLegalRun ? BOILERPLATE_SCAN_LINES + LEGAL_RUN_EXTRA_LINES : BOILERPLATE_SCAN_LINES)) break;
		const ln = lines[i]!;
		if (ln.trim() === "") {
			last = i;
			continue;
		}
		if (isLegalNoteLine(ln)) {
			last = i;
			inLegalRun = true;
			lastTextLine = ln;
			continue;
		}
		const legalHere = isBoilerplateLine(ln) || (inLegalRun && LEGAL_RUN_PHRASE_RE.test(ln));
		const wrappedHere =
			inLegalRun &&
			(lastTextLine === null || !endsSentence(lastTextLine) || /^[a-z]/.test(ln.trim()));
		if (legalHere || (inLegalRun && isMostlyUppercase(ln)) || wrappedHere) {
			last = i;
			// An all-caps line swallowed ONLY by the caps rule does NOT become
			// the wrap reference: an all-caps heading has no sentence-final
			// punctuation, so feeding it to lastTextLine would arm wrappedHere
			// against the NEXT real sentence (the review-blocker-1 cascade).
			const capsOnly = !legalHere && !wrappedHere;
			if (!capsOnly) lastTextLine = ln;
			continue;
		}
		break;
	}
	// Trailing blanks swallowed by the block are dropped with it.
	const kept = [...lines.slice(0, first), ...lines.slice(last + 1)];
	return kept.join("\n");
}

/** Deterministic first-sentence summary (schema v2 L0): strips markdown
 *  decorations, takes prose up to the first sentence boundary (。．.!?？！；
 *  or newline), clamped to the 256-char budget. Leading copyright/license
 *  boilerplate is stripped first (#2056 symptom 3) so the abstract head is
 *  real content. Returns "" for empty input. */
export function firstSentenceSummary(text: string): string {
	const prose = stripLeadingBoilerplate(text.replace(/^---\n[\s\S]*?\n---/, "")) // frontmatter first — it must not eat the boilerplate strip's scan window
		.replace(/```[\s\S]*?```/g, " ") // code fences are not abstract material
		.replace(/^#{1,6}\s+/gm, "") // headings → prose
		.replace(/^[-*]\s+/gm, "") // list markers → prose
		.replace(/^>\s?\[!\w+\]\s*/gm, "") // callout markers → prose
		.replace(/\s+/g, " ")
		.trim();
	if (!prose) return "";
	const sentenceEnd = new RegExp(`^(.{1,${SUMMARY_MAX_CHARS}}?[。．.!?？！;；])(\\s|$)`);
	const m = prose.match(sentenceEnd);
	return clampSummary(m ? m[1]! : prose);
}

/** LLM condense for over-budget bodies (schema v2 L0, D4). Best-effort in the
 *  extreme: chatJson never throws, and the caller falls back to the clamped
 *  deterministic sentence when this returns null. */
export async function condenseSummary(
	text: string,
	opts: LmChatOptions = {},
): Promise<string | null> {
	const parsed = await chatJson(
		[
			"Condense the following knowledge-card body into ONE Traditional-Chinese summary sentence (≤80 chars).",
			'Reply with ONLY one JSON object: {"summary": string}. No prose.',
			"Body:",
			text.slice(0, 2000),
		].join("\n"),
		(raw: string) => {
			let t = raw.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
			const start = t.indexOf("{");
			const end = t.lastIndexOf("}");
			const obj = JSON.parse(
				start >= 0 && end > start ? t.slice(start, end + 1) : t,
			) as { summary?: unknown };
			if (typeof obj.summary !== "string" || !obj.summary.trim())
				throw new Error("no summary string");
			return obj.summary;
		},
		opts,
	);
	return parsed === null ? null : clampSummary(parsed);
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
