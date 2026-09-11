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
	// The ASPICE 4.0 / ALM vertical (2026-09-10-aspice-alm).
	join(EXAMPLES, "aspice4-alm", "deck.config.json"),
];

describe("deck pack/unpack — the interchange envelope", () => {
	test("the committed aspice assessment.deckl IS the canonical pack of its config (drift pin)", () => {
		// OBS-1 (aspice-alm review pass 2): a config edit without a repack would
		// silently drift the committed envelope. This pin makes that drift red.
		const config = JSON.parse(
			readFileSync(join(EXAMPLES, "aspice4-alm", "deck.config.json"), "utf8"),
		) as Record<string, unknown>;
		const committed = readFileSync(join(EXAMPLES, "aspice4-alm", "assessment.deckl"), "utf8");
		expect(packDeck(config)).toBe(committed);
	});

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

// ── inline IR transport (2026-09-10-archify-envelope T2) ────────────────────
describe("deck pack/unpack — inline IR transport", () => {
	const config = JSON.parse(
		readFileSync(join(EXAMPLES, "aspice4-alm", "deck.config.json"), "utf8"),
	) as Record<string, unknown>;
	const IR_A = { path: "../shared/ir/swe1.json", content: '{\n  "diagram_type": "architecture"\n}' };
	const IR_B = { path: "../shared/ir/hwe2.json", content: '{\n  "diagram_type": "workflow"\n}' };

	test("pack without opts.ir is byte-identical to the legacy envelope", () => {
		const committed = readFileSync(
			join(EXAMPLES, "aspice4-alm", "assessment.deckl"),
			"utf8",
		);
		// The committed envelope was packed WITHOUT inline IR (path-only form);
		// the manifest alone must reproduce it byte for byte.
		expect(packDeck(config)).toBe(committed);
		expect(packDeck(config, {})).toBe(committed);
	});

	test("pack embeds ir records after slides, sorted by path; header carries irCount", () => {
		const envelope = packDeck(config, { ir: [IR_B, IR_A] });
		const lines = envelope.split("\n").filter((l) => l.trim() !== "");
		expect(lines[0]).toContain('"irCount":2');
		const irLines = lines.filter((l) => l.includes('"kind":"ir"'));
		expect(irLines).toHaveLength(2);
		const paths = irLines.map((l) => (JSON.parse(l) as { path: string }).path);
		expect(paths).toEqual([IR_A.path, IR_B.path].sort());
		// IR records ride AFTER the slide lines.
		const lastSlideIdx = lines.reduce((acc, l, i) => (l.includes('"kind":"slide"') ? i : acc), -1);
		const firstIrIdx = lines.findIndex((l) => l.includes('"kind":"ir"'));
		expect(firstIrIdx).toBeGreaterThan(lastSlideIdx);
	});

	test("ir round-trip: manifest untouched, irFiles recovered, repack byte-identical", () => {
		const envelope = packDeck(config, { ir: [IR_A, IR_B] });
		const back = unpackDeck(envelope);
		expect(back.manifest).toEqual(config);
		expect(back.irFiles).toEqual([IR_A, IR_B].sort((a, b) => (a.path < b.path ? -1 : 1)));
		expect(packDeck(back.manifest, { ir: back.irFiles })).toBe(envelope);
	});

	test("duplicate path with different content is refused at pack (naming the path)", () => {
		expect(() =>
			packDeck(config, {
				ir: [
					{ path: "ir/swe1.json", content: "one" },
					{ path: "ir/swe1.json", content: "two" },
				],
			}),
		).toThrow(/IR path "ir\/swe1.json" appears twice with different content/);
	});

	test("duplicate path inside an envelope is refused at unpack", () => {
		// A hand-forged envelope carrying the same ir path twice: the first is
		// recoverable, the second must trip the unpack-side duplicate refusal.
		const good = packDeck(config, { ir: [IR_A] });
		const irLine = (content: string) =>
			JSON.stringify({ kind: "ir", path: IR_A.path, content });
		const forged = good + irLine("different") + "\n";
		expect(() => unpackDeck(forged)).toThrow(/duplicate IR path/);
	});

	test("irCount mismatch is refused (a truncated envelope is not a deck)", () => {
		const envelope = packDeck(config, { ir: [IR_A] });
		const tampered = envelope.replace('"irCount":1', '"irCount":9');
		expect(() => unpackDeck(tampered)).toThrow(
			/header declares irCount 9 but the envelope carries 1 IR records/,
		);
	});

	test("absolute record paths are refused at pack and at unpack", () => {
		expect(() => packDeck(config, { ir: [{ path: "/etc/passwd", content: "x" }] })).toThrow(
			/is absolute/,
		);
		const forgedLine = JSON.stringify({ kind: "ir", path: "/etc/passwd", content: "x" });
		const header = packDeck(config).split("\n")[0]!;
		const forged = header + "\n" + forgedLine + "\n";
		expect(() => unpackDeck(forged)).toThrow(/absolute/);
	});

	test("unknown record kinds are still refused (old-reader semantics locked)", () => {
		const forged = packDeck(config).split("\n")[0] + "\n" + '{"kind":"foo"}' + "\n";
		expect(() => unpackDeck(forged)).toThrow(/unexpected record kind/);
	});
});
