/**
 * aspice4-alm evidence gates — the ALM workflow's mutation tests (queued by
 * the aspice-alm review pass 2, F7/OBS-1).
 *
 * The committed `assessment.deckl` is the authored form: an assessor mutates
 * evidence lines and repacks. These gates pin the mutation directions the
 * README documents:
 *   1. append a slide line WITHOUT bumping the header slideCount → REFUSAL
 *      (the assessor's real mistake shape, named both counts);
 *   2. append an evidence slide + repack → rebuild succeeds at 9 slides;
 *   3. edit a verdict line + repack → rebuild succeeds with the edit.
 *
 * The committed-bytes drift pin lives in tests/deck-pack.test.ts — do not
 * duplicate it here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeck } from "../src/deck-build.ts";
import { packDeck, unpackDeck } from "../src/deck-pack.ts";

const PKG_ROOT = join(import.meta.dir, "..");
const ASPICE_DIR = join(PKG_ROOT, "examples", "aspice4-alm");
const COMMITTED = readFileSync(join(ASPICE_DIR, "assessment.deckl"), "utf8");

/** The slide-3 fixture shape (aspice-bp), for the assessor's appended slide. */
function aspiceBpSlide(title: string): Record<string, unknown> {
	return {
		layout: "aspice-bp",
		title,
		process: "SWE.1 · Software Requirements Analysis · ASPICE 4.0",
		bps: [
			{ id: "BP1", practice: "appended evidence row A", verdict: "SAT", evidence: "evidence.jsonl:L99" },
			{ id: "BP2", practice: "appended evidence row B", verdict: "SAT", evidence: "evidence.jsonl:L100" },
		],
	};
}

describe("aspice4-alm evidence gates — the ALM workflow's mutation tests", () => {
	test("appending a slide line WITHOUT bumping slideCount → unpack refuses, naming both counts", () => {
		const lines = COMMITTED.split("\n").filter((l) => l.trim() !== "");
		const statementLine = lines.find((l) => l.includes('"statement"'))!;
		const extra = JSON.parse(statementLine) as Record<string, unknown>;
		extra["title"] = "extra assessor slide";
		extra["statement"] = "appended by the assessor";
		// NOT bumping the header slideCount — the assessor's real mistake shape.
		const mutated = [...lines, JSON.stringify({ kind: "slide", ...extra })].join("\n") + "\n";
		expect(() => unpackDeck(mutated)).toThrow(
			/declares slideCount 8 but the envelope carries 9/,
		);
	});

	test("assessor appends an evidence slide → repack → rebuild succeeds at 9 slides", async () => {
		const { manifest } = unpackDeck(COMMITTED);
		const slides = manifest.slides as Array<Record<string, unknown>>;
		slides.push(aspiceBpSlide("appended assessor evidence"));
		const envelope = packDeck(manifest);

		// The repacked envelope is self-consistent at the new count…
		const header = JSON.parse(envelope.split("\n")[0]!) as Record<string, unknown>;
		expect(header["slideCount"]).toBe(9);
		const back = unpackDeck(envelope);
		expect((back.manifest.slides as unknown[]).length).toBe(9);

		// …and the rebuilt deck carries all 9 slides.
		const work = mkdtempSync(join(tmpdir(), "aspice-alm-append-"));
		try {
			const result = await buildDeck({
				manifest: back.manifest as unknown as Parameters<typeof buildDeck>[0]["manifest"],
				manifestDir: ASPICE_DIR, // relative IR/template paths resolve as authored
				outputPath: join(work, "appended.pptx"),
				cwd: PKG_ROOT,
				slidesDir: null,
			});
			expect(result.slides.length).toBe(9);
			expect(result.bytes).toBeGreaterThan(0);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	test("editing a verdict line → repack → rebuild carries the edit", async () => {
		const { manifest } = unpackDeck(COMMITTED);
		const slides = manifest.slides as Array<{
			layout: string;
			process?: string;
			bps?: Array<{ id: string; verdict: string }>;
		}>;
		const swe1 = slides.find((s) => s.layout === "aspice-bp" && s.process?.startsWith("SWE.1"))!;
		const bp6 = swe1.bps!.find((b) => b.id === "BP6")!;
		expect(bp6.verdict).toBe("PART");
		bp6.verdict = "SAT";

		const envelope = packDeck(manifest);
		const reread = unpackDeck(envelope);
		const rereadSlides = reread.manifest.slides as Array<{
			layout: string;
			bps?: Array<{ id: string; verdict: string }>;
		}>;
		const rereadBp6 = rereadSlides
			.find((s) => s.layout === "aspice-bp")!
			.bps!.find((b) => b.id === "BP6")!;
		expect(rereadBp6.verdict).toBe("SAT");
	});
});
