/**
 * deck-pack — the byte-stable JSONL interchange envelope for a deck (t03 of
 * the 2026-09-08-archify-deck-html effort; design in
 * .planning/plans/2026-09-07-archify-eval-track2-format.md §4).
 *
 * Format: line 1 is a header
 *   {"format":"archify-deck","version":1,"slideCount":N,…manifest fields…}
 * then ONE line per slide: {"kind":"slide",…}. LF, UTF-8, no BOM, no
 * timestamps — two packs of the same manifest are byte-identical, and
 * pack → unpack → pack round-trips byte-stable.
 *
 * Canonical serialization: object keys are sorted DEEPLY (arrays keep their
 * order). That is the entire determinism story — no field-order table to
 * maintain, and equal manifests always serialize identically. Unknown fields
 * survive the round trip (pack is format-level, not schema-level).
 *
 * Scope (POC): diagram IRs stay EXTERNAL — `ir` paths are recorded as authored
 * (relative to the manifest) and are NOT inlined, so an unpacked folder needs
 * the IR files present at those paths. Single-file transport of IR bodies
 * (`--inline-ir`) is a follow-up ticket.
 */
import { DeckError } from "./deck-build.ts";

const FORMAT = "archify-deck";
const VERSION = 1;

/** Deterministic JSON: object keys sorted deeply; arrays keep order. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const body = keys
		.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
		.join(",");
	return `{${body}}`;
}

/** The manifest minus `slides`, as the header's manifest fields. */
function headerFields(manifest: Record<string, unknown>): Record<string, unknown> {
	const { slides, ...rest } = manifest;
	return {
		format: FORMAT,
		version: VERSION,
		slideCount: Array.isArray(slides) ? slides.length : 0,
		...rest,
	};
}

/** Pack a manifest into the canonical JSONL envelope. Pure + deterministic. */
export function packDeck(manifest: Record<string, unknown>): string {
	const slides = Array.isArray(manifest.slides) ? manifest.slides : [];
	const header = stableStringify(headerFields(manifest));
	const lines = slides.map((s) => stableStringify({ kind: "slide", ...(s as object) }));
	return [header, ...lines].join("\n") + "\n";
}

export interface UnpackResult {
	/** The recovered manifest (slides stripped of the `kind` marker). */
	manifest: Record<string, unknown>;
	/** The header fields (format/version/slideCount + manifest fields). */
	header: Record<string, unknown>;
}

/**
 * Unpack a JSONL envelope back into a manifest object. Throws DeckError when
 * the envelope is structurally wrong or written by a NEWER format version —
 * the error names both versions so the caller knows what to upgrade.
 */
export function unpackDeck(text: string): UnpackResult {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	if (lines.length === 0) throw new DeckError("deck pack: empty envelope");
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(lines[0]!) as Record<string, unknown>;
	} catch (err) {
		throw new DeckError(`deck pack: header line is not JSON: ${errMsg(err)}`);
	}
	if (header["format"] !== FORMAT) {
		throw new DeckError(
			`deck pack: unknown format ${JSON.stringify(header["format"])} — expected "${FORMAT}"`,
		);
	}
	const version = header["version"];
	if (version !== VERSION) {
		throw new DeckError(
			`deck pack: file version ${JSON.stringify(version)} is newer than the supported version ${VERSION} — upgrade archify to read this envelope`,
		);
	}
	const manifest: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(header)) {
		if (k === "format" || k === "version" || k === "slideCount" || k === "kind") continue;
		manifest[k] = v;
	}
	const slides: Record<string, unknown>[] = [];
	for (const line of lines.slice(1)) {
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(line) as Record<string, unknown>;
		} catch (err) {
			throw new DeckError(`deck pack: slide line is not JSON: ${errMsg(err)}`);
		}
		if (rec["kind"] !== "slide") {
			throw new DeckError(`deck pack: unexpected record kind ${JSON.stringify(rec["kind"] ?? null)}`);
		}
		const { kind, ...slide } = rec;
		slides.push(slide);
	}
	const declared = header["slideCount"];
	if (typeof declared === "number" && declared !== slides.length) {
		throw new DeckError(
			`deck pack: header declares slideCount ${declared} but the envelope carries ${slides.length} slides`,
		);
	}
	manifest.slides = slides;
	return { manifest, header };
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
