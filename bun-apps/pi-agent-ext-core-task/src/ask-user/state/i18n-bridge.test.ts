/**
 * i18n-bridge — Stage 3a unit tests (i18n infrastructure + dictionaries).
 *
 * Scope: the bridge's locale resolution + dictionary lookup + positional
 * formatting, and that the zh-TW dictionary covers EVERY enumerated ask_user
 * chrome literal (so Stage 3b view wiring needs no dictionary edits).
 *
 * The dictionary is keyed by the English literal itself; `en` is identity via
 * fallback (empty dict). `zh-TW` maps every English literal → its translation.
 * Unknown locale / unset askUserLanguage → "en" → identity (the property that
 * makes reviving the bridge safe before Stage 3b wires any call site).
 *
 * Determinism: locale is pinned via `__setLocaleForTest` (mirrors config.ts's
 * `__setConfigPathForTest` seam). The production (unpinned) path is exercised
 * through `PI_CODING_AGENT_DIR` pointing readSettingsFile at a tmp settings.json.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Pull the exact dialog-builder literals (consts) so the dictionary keys are
// guaranteed to match the source strings — no transcription drift.
import { INCOMPLETE_WARNING_PREFIX, READY_PROMPT, REVIEW_HEADING } from "../view/dialog-builder.js";
import { buildHintText, HINT_TABLE } from "../view/hint-table.js";
import { DICTIONARIES, SUPPORTED_I18N_LOCALES } from "./i18n-dictionaries.js";
import {
	__setLocaleForTest,
	displayLabel,
	resolveActiveLocale,
	t,
} from "./i18n-bridge.js";

// ── Enumerated English chrome literals (grouped by source file) ─────────────
// multi-select-view.ts — nextLabel default + the free-text/Other row placeholder
const MULTI_SELECT = ["Next", "Type something."] as const;
// submit-picker.ts — Submit / Cancel row labels
const SUBMIT_PICKER = ["Submit", "Cancel"] as const;
// hint-table.ts — the footer vocabulary, DERIVED from the table rather than
// re-listed here. The old hand-written list was the same drift risk the table
// exists to remove: a hint could be added to the source and silently left out of
// the dictionary-coverage check below.
const HINT_LABELS = HINT_TABLE.map((e) => e.label);
// dialog-builder.ts — body chrome (headings/prompts), which is not keybindings.
const DIALOG_BUILDER = [
	...HINT_LABELS,
	REVIEW_HEADING, // "Review your answers"
	READY_PROMPT, // "Ready to submit your answers?"
	INCOMPLETE_WARNING_PREFIX, // "⚠ Answer remaining questions before submitting:"
] as const;

/** The collapsed one-line bar, built the same way production builds it. */
const collapsedHint = (collapseKey = "Ctrl+]") =>
	buildHintText({
		mode: "collapsed",
		isMulti: false,
		focusedIsMultiSelect: false,
		notesAvailable: false,
		collapseKey,
	});

const CHROME_LITERALS: readonly string[] = [...MULTI_SELECT, ...SUBMIT_PICKER, ...DIALOG_BUILDER];

// Positional-formatting demonstrator (no current chrome literal uses {n};
// exercises the formatter end-to-end in both en and zh-TW).
const FORMAT_KEY = "Page {0} of {1}";

afterEach(() => {
	// Never leak a test pin into sibling tests / the production path.
	__setLocaleForTest(null);
});

// ── Dictionary structure ────────────────────────────────────────────────────

describe("DICTIONARIES structure", () => {
	test("declares en + zh-TW as supported locales", () => {
		expect(SUPPORTED_I18N_LOCALES).toContain("en");
		expect(SUPPORTED_I18N_LOCALES).toContain("zh-TW");
		for (const loc of SUPPORTED_I18N_LOCALES) expect(DICTIONARIES[loc]).toBeDefined();
	});

	test("en dictionary is empty (identity via fallback — zero behavior change)", () => {
		const en = DICTIONARIES["en"];
		expect(en).toBeDefined();
		expect(Object.keys(en ?? {}).length).toBe(0);
	});

	test("zh-TW dictionary covers EVERY enumerated chrome literal", () => {
		const zh = DICTIONARIES["zh-TW"];
		expect(zh).toBeDefined();
		for (const lit of CHROME_LITERALS) {
			expect(zh?.[lit], `missing zh-TW entry for ${JSON.stringify(lit)}`).toBeTruthy();
		}
	});

	test("zh-TW dictionary maps the formatting demonstrator", () => {
		expect(DICTIONARIES["zh-TW"]?.[FORMAT_KEY]).toBeTruthy();
	});
});

// ── t(): identity (en) vs translated (zh-TW) for every chrome literal ────────

describe("t() — every chrome literal round-trips en-identity and zh-TW", () => {
	for (const lit of CHROME_LITERALS) {
		test(`${JSON.stringify(lit)} → en identity + zh-TW translation`, () => {
			__setLocaleForTest("en");
			expect(t(lit)).toBe(lit); // en = identity (literal falls back to itself)

			__setLocaleForTest("zh-TW");
			expect(t(lit)).toBe(DICTIONARIES["zh-TW"][lit]); // zh-TW = dictionary value
		});
	}
});

// ── Fallbacks ───────────────────────────────────────────────────────────────

describe("t() — fallbacks", () => {
	test("unknown key under en → returned unchanged (identity fallback)", () => {
		__setLocaleForTest("en");
		expect(t("not-a-real-key")).toBe("not-a-real-key");
	});

	test("unknown key under zh-TW → returned unchanged (key IS the English fallback)", () => {
		__setLocaleForTest("zh-TW");
		expect(t("not-a-real-key")).toBe("not-a-real-key");
	});

	test("unknown locale → dict miss → falls back to the key (en identity)", () => {
		__setLocaleForTest("klingon");
		expect(t("Submit")).toBe("Submit");
	});

	test("legacy (key, fallback) call shape still works — namespace keys never in dict", () => {
		// displayLabel / hint.expand_line use namespace keys with an English fallback.
		// These keys are NOT chrome literals, so the dict never holds them → fallback.
		__setLocaleForTest("en");
		expect(t("sentinel.choose", "Choose")).toBe("Choose");
		expect(t("hint.expand_line", collapsedHint())).toBe(collapsedHint());
		// Same in zh-TW — namespace keys still fall back (no behavior change).
		__setLocaleForTest("zh-TW");
		expect(t("sentinel.choose", "Choose")).toBe("Choose");
		expect(t("hint.expand_line", collapsedHint())).toBe(collapsedHint());
	});
});

// ── Positional formatting ({0}/{1}) ─────────────────────────────────────────

describe("t() — positional formatting", () => {
	test("en: substitutes {0}/{1} into the (fallback) template", () => {
		__setLocaleForTest("en");
		expect(t(FORMAT_KEY, 2, 5)).toBe("Page 2 of 5");
	});

	test("zh-TW: substitutes {0}/{1} into the translated template", () => {
		__setLocaleForTest("zh-TW");
		expect(t(FORMAT_KEY, 2, 5)).toBe(DICTIONARIES["zh-TW"][FORMAT_KEY].replace("{0}", "2").replace("{1}", "5"));
	});

	test("no format args → template returned verbatim (no stray {n})", () => {
		__setLocaleForTest("zh-TW");
		const v = DICTIONARIES["zh-TW"][FORMAT_KEY];
		expect(t(FORMAT_KEY)).toBe(v);
	});
});

// ── resolveActiveLocale + __setLocaleForTest seam ───────────────────────────

describe("resolveActiveLocale / __setLocaleForTest", () => {
	test("pin returns the pinned locale verbatim (even unsupported tags)", () => {
		__setLocaleForTest("zh-TW");
		expect(resolveActiveLocale()).toBe("zh-TW");
		__setLocaleForTest("klingon");
		expect(resolveActiveLocale()).toBe("klingon");
	});

	test("pin null clears the pin → re-reads settings on next call", () => {
		__setLocaleForTest("zh-TW");
		expect(resolveActiveLocale()).toBe("zh-TW");
		__setLocaleForTest(null);
		// No settings file in the real agent dir → defaults to "en".
		expect(resolveActiveLocale()).toBe("en"); // pin-clear busts cache → fresh read
	});

	test("production path reads askUserLanguage from settings.json", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-i18n-bridge-"));
		const prevDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmp;
		try {
			// The settings-derived locale is cached per process; __setLocaleForTest(null)
			// (re-clearing the pin) busts the cache so a re-read reflects a mutated
			// settings.json — mirroring config.ts's cache-invalidation discipline.

			__setLocaleForTest(null); // bust cache + production path
			writeFileSync(join(tmp, "settings.json"), JSON.stringify({ theme: "dark" }) + "\n");
			expect(resolveActiveLocale()).toBe("en"); // askUserLanguage unset → en

			__setLocaleForTest(null); // bust cache
			writeFileSync(join(tmp, "settings.json"), JSON.stringify({ askUserLanguage: "zh-TW" }) + "\n");
			expect(resolveActiveLocale()).toBe("zh-TW"); // supported tag → that tag

			__setLocaleForTest(null); // bust cache
			writeFileSync(join(tmp, "settings.json"), JSON.stringify({ askUserLanguage: "klingon" }) + "\n");
			expect(resolveActiveLocale()).toBe("en"); // unsupported tag → en
		} finally {
			if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevDir;
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ── en-identity safety (the property that makes landing before 3b safe) ──────

describe("en-identity safety — askUserLanguage unset ⇒ zero behavior change", () => {
	let tmp: string;
	let prevDir: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pi-i18n-bridge-id-"));
		prevDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmp;
		__setLocaleForTest(null); // production path, no settings → en
	});

	afterEach(() => {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		rmSync(tmp, { recursive: true, force: true });
	});

	test("resolveActiveLocale defaults to en when askUserLanguage is unset", () => {
		expect(resolveActiveLocale()).toBe("en");
	});

	test("every chrome literal returns itself unchanged", () => {
		for (const lit of CHROME_LITERALS) {
			expect(t(lit), `en-identity broken for ${JSON.stringify(lit)}`).toBe(lit);
		}
	});

	test("legacy (key, fallback) call shape returns the fallback unchanged", () => {
		expect(t("sentinel.choose", "Choose")).toBe("Choose");
		expect(t("hint.expand_line", collapsedHint())).toBe(collapsedHint());
	});
});

// ROW_INTENT_META labels (the English fallback displayLabel passes as arg):
//   next  → "Next", other → "Type something." (see row-intent.ts)
describe("displayLabel — preserved export (English fallback via namespace key)", () => {
	test("returns the ROW_INTENT_META English label regardless of locale", () => {
		__setLocaleForTest("en");
		expect(displayLabel("next")).toBe("Next");
		expect(displayLabel("other")).toBe("Type something.");
		__setLocaleForTest("zh-TW");
		// Namespace keys (sentinel.*) are NOT chrome literals → never in the dict
		// → fallback to the English label, unchanged.
		expect(displayLabel("next")).toBe("Next");
		expect(displayLabel("other")).toBe("Type something.");
	});
});
