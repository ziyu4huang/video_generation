/**
 * deck-pack round-trip — t03 of the 2026-09-08-archify-deck-html effort.
 *
 * The interchange-envelope contract (track2 §4):
 *   1. pack → unpack → pack is byte-identical across the example manifests.
 *   2. An unpacked manifest BUILDS (buildDeck against the original manifest
 *      dir, so relative IR paths resolve).
 *   3. A newer format version is REFUSED, naming both versions.
 *   4. CJK titles/takeaways survive exactly (deep-equal, not approximate).
 *   5. pack is deterministic: two packs of the same manifest are identical.
 *
 * Hermetic: examples committed in-tree, IRs resolved from the same dirs, no
 * operator files.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeck, DeckError } from "../src/deck-build.ts";
import { packDeck, unpackDeck } from "../src/deck-pack.ts";

const PKG_ROOT = join(import.meta.dir, "..");
const EXAMPLES = join(PKG_ROOT, "examples");

const MANIFESTS = [
	join(EXAMPLES, "deck", "deck.config.json"),
	join(EXAMPLES, "deck-composed", "deck.config.json"),
	join(EXAMPLES, "deck-general", "deck.config.json"),
	join(EXAMPLES, "ir-library", "decks", "library.config.json"),
];

describe("deck pack/unpack — the interchange envelope", () => {
	test("round-trip is byte-stable on every example manifest (incl. CJK)", () => {
		for (const path of MANIFESTS) {
			const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			const envelope = packDeck(original);
			const unpacked = unpackDeck(envelope);
			const repacked = packDeck(unpacked.manifest);

			expect(repacked).toBe(envelope);
			// CJK survival is implicit in the deep-equality the repack asserts —
			// but pin a visible one so a regression reads clearly.
			if (path.includes("deck-composed")) {
				const slides = unpacked.manifest.slides as Array<{ title: string }>;
				expect(slides[0]?.title).toBe("散文寫的規格改不動、查不出、驗不了");
			}
		}
	});

	test("pack is deterministic across calls (no hidden timestamps or ordering)", () => {
		const manifest = JSON.parse(readFileSync(MANIFESTS[1]!, "utf8")) as Record<string, unknown>;
		expect(packDeck(manifest)).toBe(packDeck(manifest));
	});

	test("a newer format version is refused, naming both versions", () => {
		const tampered = packDeck({ slides: [{ title: "x" }] }).replace(
			'"version":1',
			'"version":2',
		);
		expect(() => unpackDeck(tampered)).toThrow(
			/file version 2 is newer than the supported version 1/,
		);
	});

	test("slideCount mismatch is refused (a truncated envelope is not a deck)", () => {
		const envelope = packDeck({
			output: "x.pptx",
			slides: [{ title: "a" }, { title: "b" }, { title: "c" }],
		});
		const tampered = envelope.replace('"slideCount":3', '"slideCount":9');
		expect(() => unpackDeck(tampered)).toThrow(/declares slideCount 9 but the envelope carries 3/);
	});

	test("unknown format is refused", () => {
		const forged = `{"format":"other-deck","version":1,"slideCount":0}\n`;
		expect(() => unpackDeck(forged)).toThrow(/unknown format "other-deck"/);
	});
});

describe("deck pack/unpack — the unpacked manifest builds", () => {
	test("buildDeck succeeds from an unpacked manifest (IRs resolve via the original dir)", async () => {
		const composedDir = join(EXAMPLES, "deck-composed");
		const manifest = JSON.parse(readFileSync(join(composedDir, "deck.config.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const unpacked = unpackDeck(packDeck(manifest)).manifest;
		const work = mkdtempSync(join(tmpdir(), "deck-pack-build-"));
		try {
			const result = await buildDeck({
			manifest: unpacked as unknown as Parameters<typeof buildDeck>[0]["manifest"],
			manifestDir: composedDir, // the IRs resolve exactly as the original build did
			outputPath: join(work, "unpacked.pptx"),
			cwd: PKG_ROOT,
			slidesDir: null,
		});
			expect(result.slides.length).toBe((manifest.slides as unknown[]).length);
			expect(result.bytes).toBeGreaterThan(0);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});
