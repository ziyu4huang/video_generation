/**
 * deck-manifest-schema — t02 of the 2026-09-08-archify-deck-html effort: the
 * declarative PARITY CONTRACT for deck.config.json.
 *
 * The authority split (deliberate, mirrors templates/layout-template.schema.json):
 *   - RUNTIME authority stays in `parseManifest` (single gate, source/slide
 *     context in errors, registry-aware layout + slot checks).
 *   - The schema is the declarative twin: a contract test proves schema and
 *     parseManifest accept/reject the SAME fixture matrix, and pins the
 *     division (registry-aware checks happen ONLY in parseManifest).
 * ajv is a devDependency — `src/` imports ZERO ajv (no new runtime dep).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { join } from "node:path";
import { DeckError, parseManifest } from "../src/deck-build.ts";
import { loadRegistry } from "../src/layout-registry.js";

const PKG_ROOT = join(import.meta.dir, "..");
const schema = JSON.parse(
	readFileSync(join(PKG_ROOT, "schemas", "deck-manifest.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const EXAMPLE_MANIFESTS = [
	join(PKG_ROOT, "examples", "deck", "deck.config.json"),
	join(PKG_ROOT, "examples", "deck-composed", "deck.config.json"),
	join(PKG_ROOT, "examples", "deck-general", "deck.config.json"),
	join(PKG_ROOT, "examples", "ir-library", "decks", "library.config.json"),
	// The ASPICE 4.0 / ALM vertical exercises the aspice slot fields.
	join(PKG_ROOT, "examples", "aspice4-alm", "deck.config.json"),
];

/** A registry-less parseManifest wrapper: throws DeckError on any structural rejection. */
function tryParse(text: string): { ok: true } | { ok: false; message: string } {
	try {
		parseManifest(text, "test");
		return { ok: true };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}

/** Assert BOTH gates agree on a fixture (schema verdict === parseManifest verdict). */
function expectDualGate(raw: string, accept: boolean, messageFragment?: string) {
	const schemaOk = validate(JSON.parse(raw)) as boolean;
	const parse = tryParse(raw);
	expect(schemaOk, `schema should ${accept ? "accept" : "reject"}`).toBe(accept);
	expect(parse.ok, `parseManifest should ${accept ? "accept" : "reject"}`).toBe(accept);
	if (messageFragment !== undefined && !accept) {
		expect(parse.ok ? "" : parse.message).toContain(messageFragment);
	}
}

describe("deck-manifest schema — parity with the examples", () => {
	test("every committed example manifest validates", () => {
		for (const path of EXAMPLE_MANIFESTS) {
			const raw = readFileSync(path, "utf8");
			expect(validate(JSON.parse(raw)) as boolean, `${path} must validate`).toBe(true);
		}
	});
});

describe("deck-manifest schema — negative matrix, both gates agree", () => {
	const cases: Array<{ name: string; raw: string; fragment?: string }> = [
		{
			name: "unknown theme",
			raw: `{"output":"x.pptx","theme":"sepia","slides":[{"title":"t","layout":"bullets"}]}`,
		},
		{
			name: "slide missing title",
			raw: `{"output":"x.pptx","slides":[{"layout":"bullets"}]}`,
			fragment: "title",
		},
		{
			name: "empty slides",
			raw: `{"output":"x.pptx","slides":[]}`,
			fragment: "slides",
		},
		{
			name: "manifestVersion 2",
			raw: `{"output":"x.pptx","manifestVersion":2,"slides":[{"title":"t"}]}`,
			fragment: "manifestVersion 2",
		},
		{
			name: "non-string ir",
			raw: `{"output":"x.pptx","slides":[{"title":"t","layout":"diagram","ir":42}]}`,
			fragment: "ir",
		},
	];
	for (const c of cases) {
		test(`${c.name}: schema AND parseManifest both reject`, () => {
			const schemaOk = validate(JSON.parse(c.raw)) as boolean;
			expect(schemaOk, `schema must reject: ${c.name}`).toBe(false);
			const parse = tryParse(c.raw);
			expect(parse.ok, `parseManifest must reject: ${c.name}`).toBe(false);
			if (c.fragment !== undefined) {
				expect(parse.ok ? "" : parse.message).toContain(c.fragment);
			}
		});
	}
});

describe("deck-manifest schema — aspice-bp / pa-rating slot shapes (2026-09-10-aspice-alm t-C)", () => {
	// Template layouts need the registry (packaged tier) for parseManifest to
	// resolve their names — the schema, being name-agnostic, needs no registry.
	const withRegistry = (raw: string) => parseManifest(raw, "test", loadRegistry());

	test("bps item missing verdict → rejected; bps with evidence → accepted (dual gate)", () => {
		const noVerdict = `{"slides":[{"title":"t","layout":"aspice-bp","process":"SWE.1","bps":[{"id":"BP1","practice":"p"}]}]}`;
		expect(validate(JSON.parse(noVerdict)) as boolean).toBe(false);
		const parse = (() => {
			try {
				withRegistry(noVerdict);
				return { ok: true } as const;
			} catch (err) {
				return { ok: false, message: err instanceof Error ? err.message : String(err) } as const;
			}
		})();
		// parseManifest is schema-blind to slot ITEM shapes (slotProblems checks
		// presence/counts at build time) — the schema is the stricter twin HERE.
		expect(parse.ok).toBe(true);
		const withEvidence = `{"slides":[{"title":"t","layout":"aspice-bp","process":"SWE.1","bps":[{"id":"BP1","practice":"p","verdict":"SAT","evidence":"evidence.jsonl:L1"},{"id":"BP2","practice":"q","verdict":"PART"}]}]}`;
		expect(validate(JSON.parse(withEvidence)) as boolean).toBe(true);
	});

	test("ratings item missing rating → rejected; well-formed ratings → accepted", () => {
		const noRating = `{"slides":[{"title":"t","layout":"pa-rating","attribute":"PA 1.1","ratings":[{"gp":"GP 1.1.1"}]}]}`;
		expect(validate(JSON.parse(noRating)) as boolean).toBe(false);
		const ok = `{"slides":[{"title":"t","layout":"pa-rating","attribute":"PA 1.1","ratings":[{"gp":"GP 1.1.1","rating":"L"},{"gp":"GP 1.1.2","rating":"F"}]}]}`;
		expect(validate(JSON.parse(ok)) as boolean).toBe(true);
	});

	test("bps over the slot max (9 > 8) → schema rejects (mirrors slotProblems)", () => {
		const items = Array.from({ length: 9 }, (_, i) => ({ id: `BP${i}`, practice: "p", verdict: "SAT" }));
		expect(
			validate({ slides: [{ title: "t", layout: "aspice-bp", process: "SWE.1", bps: items }] }) as boolean,
		).toBe(false);
	});
});

describe("deck-manifest schema — the authority split, pinned as a canary", () => {
	test("unknown layout: schema ACCEPTS (layout is just a string), parseManifest REJECTS (registry check)", () => {
		const raw = `{"output":"x.pptx","slides":[{"title":"t","layout":"nope"}]}`;
		expect(validate(JSON.parse(raw)) as boolean).toBe(true);
		const parse = tryParse(raw);
		expect(parse.ok).toBe(false);
	});
});

describe("manifestVersion — the version story", () => {
	const BASE = `{"output":"x.pptx","slides":[{"title":"t","layout":"bullets","bullets":["a"]}]}`;
	test("absent manifestVersion ⇒ accepted (backward compat: every pre-version manifest)", () => {
		expect(tryParse(BASE).ok).toBe(true);
	});
	test("explicit 1 ⇒ accepted", () => {
		expect(
			tryParse(
				`{"manifestVersion":1,"output":"x.pptx","slides":[{"title":"t","layout":"bullets"}]}`,
			).ok,
		).toBe(true);
	});
	test("2 ⇒ refused, message names BOTH versions", () => {
		const parse = tryParse(
			`{"manifestVersion":2,"output":"x.pptx","slides":[{"title":"t","layout":"bullets"}]}`,
		);
		expect(parse.ok).toBe(false);
		if (!parse.ok) {
			expect(parse.message).toContain("manifestVersion 2");
			expect(parse.message).toContain("version 1");
		}
	});
});

describe("manifestVersion × deck pack — no header collision", () => {
	test("pack round-trip keeps manifestVersion and the envelope's own version", () => {
		// Delayed import avoids any cycle risk in the type surface; deck-pack is
		// format-level and imports nothing from deck-build.
		const { packDeck, unpackDeck } = require("../src/deck-pack.ts") as {
			packDeck: (m: Record<string, unknown>) => string;
			unpackDeck: (t: string) => { manifest: Record<string, unknown>; header: Record<string, unknown> };
		};
		const manifest = {
			manifestVersion: 1,
			output: "x.pptx",
			theme: "light",
			slides: [{ title: "t", layout: "bullets" }],
		};
		const envelope = packDeck(manifest);
		const header = JSON.parse(envelope.split("\n")[0]!) as Record<string, unknown>;
		// envelope version untouched:
		expect(header["version"]).toBe(1);
		// manifest field rides the header:
		expect(header["manifestVersion"]).toBe(1);
		const back = unpackDeck(envelope).manifest;
		expect(back["manifestVersion"]).toBe(1);
		// byte-stable round trip on the packed form
		expect(packDeck(back)).toBe(envelope);
	});
});

describe("deck-manifest schema — message texts do not regress", () => {
	test("existing parseManifest messages stay verbatim (union rule / unknown layout / theme)", () => {
		const missingSlides = tryParse(`{"output":"x.pptx"}`);
		expect(missingSlides.ok ? "" : missingSlides.message).toContain("missing non-empty `slides`");
		const badLayout = tryParse(`{"slides":[{"title":"t","layout":"nope"}]}`);
		expect(badLayout.ok ? "" : badLayout.message).toContain("nope");
		const badTheme = tryParse(
			`{"theme":"sepia","slides":[{"title":"t","layout":"bullets"}]}`,
		);
		expect(badTheme.ok ? "" : badTheme.message).toContain("sepia");
	});
});
