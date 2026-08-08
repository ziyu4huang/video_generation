/**
 * settings.ts — unit tests for the pure decision functions
 * (getResponseLanguage / withResponseLanguage / isValidTag) and the generic,
 * key-parameterized language-key IO (getLanguageKey / withLanguageKey /
 * writeLanguageKey) shared by /response-language and /ask-user-language.
 * The legacy IO wrapper writeResponseLanguage is thin and not asserted here;
 * the generic writeLanguageKey IS round-tripped (it gates ask-user-language).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	getLanguageKey,
	getResponseLanguage,
	isValidTag,
	readSettingsFile,
	withLanguageKey,
	withResponseLanguage,
	writeLanguageKey,
} from "../settings.js";

const S = (entries: Record<string, unknown>) => entries;

describe("getResponseLanguage", () => {
	test("set → returns trimmed tag", () => {
		expect(getResponseLanguage(S({ responseLanguage: "zh-TW" }))).toBe("zh-TW");
	});
	test("trims whitespace", () => {
		expect(getResponseLanguage(S({ responseLanguage: "  en  " }))).toBe("en");
	});
	test("missing → undefined", () => {
		expect(getResponseLanguage(S({ defaultModel: "x" }))).toBeUndefined();
	});
	test("non-string → undefined", () => {
		expect(getResponseLanguage(S({ responseLanguage: 123 }))).toBeUndefined();
	});
	test("blank → undefined", () => {
		expect(getResponseLanguage(S({ responseLanguage: "  " }))).toBeUndefined();
	});
	test("undefined settings → undefined", () => {
		expect(getResponseLanguage(undefined)).toBeUndefined();
	});
});

describe("withResponseLanguage", () => {
	test("sets the key on a clone", () => {
		expect(withResponseLanguage(S({ theme: "dark" }), "zh-TW")).toEqual(
			S({ theme: "dark", responseLanguage: "zh-TW" }),
		);
	});
	test("overwrites an existing value", () => {
		expect(withResponseLanguage(S({ responseLanguage: "en" }), "zh-TW")).toEqual(
			S({ responseLanguage: "zh-TW" }),
		);
	});
	test("tag undefined → removes the key", () => {
		expect(withResponseLanguage(S({ responseLanguage: "en", theme: "dark" }), undefined)).toEqual(
			S({ theme: "dark" }),
		);
	});
	test("does not mutate the input", () => {
		const input = S({ responseLanguage: "en" });
		withResponseLanguage(input, "zh-TW");
		expect(input).toEqual(S({ responseLanguage: "en" }));
	});
	test("empty settings + tag → object with only the key", () => {
		expect(withResponseLanguage(undefined, "ja")).toEqual(S({ responseLanguage: "ja" }));
	});
});

describe("isValidTag", () => {
	test("accepts BCP-47-ish tags", () => {
		for (const t of ["zh-TW", "en", "zh-Hant", "ja", "pt-BR", "a_b"]) {
			expect(isValidTag(t)).toBe(true);
		}
	});
	test("rejects empty / whitespace", () => {
		expect(isValidTag("")).toBe(false);
		expect(isValidTag("   ")).toBe(false);
	});
	test("rejects spaces inside the tag", () => {
		expect(isValidTag("zh TW")).toBe(false);
	});
	test("rejects punctuation / special chars", () => {
		expect(isValidTag("zh-TW!")).toBe(false);
		expect(isValidTag("en/US")).toBe(false);
	});
	test("rejects absurdly long tags", () => {
		expect(isValidTag("x".repeat(33))).toBe(false);
		expect(isValidTag("x".repeat(32))).toBe(true);
	});
});

// ── Generic, key-parameterized language-key IO (responseLanguage + askUserLanguage) ──

describe("getLanguageKey", () => {
	test("askUserLanguage set → returns trimmed tag", () => {
		expect(getLanguageKey(S({ askUserLanguage: "zh-TW" }), "askUserLanguage")).toBe("zh-TW");
	});
	test("trims whitespace", () => {
		expect(getLanguageKey(S({ askUserLanguage: "  en  " }), "askUserLanguage")).toBe("en");
	});
	test("missing → undefined", () => {
		expect(getLanguageKey(S({ defaultModel: "x" }), "askUserLanguage")).toBeUndefined();
	});
	test("non-string → undefined", () => {
		expect(getLanguageKey(S({ askUserLanguage: 123 }), "askUserLanguage")).toBeUndefined();
	});
	test("blank → undefined", () => {
		expect(getLanguageKey(S({ askUserLanguage: "  " }), "askUserLanguage")).toBeUndefined();
	});
	test("unknown settings object → undefined", () => {
		expect(getLanguageKey("not-an-object", "askUserLanguage")).toBeUndefined();
		expect(getLanguageKey(null, "askUserLanguage")).toBeUndefined();
		expect(getLanguageKey(undefined, "askUserLanguage")).toBeUndefined();
	});
	test("generic over both keys — reads responseLanguage too", () => {
		expect(getLanguageKey(S({ responseLanguage: "ja" }), "responseLanguage")).toBe("ja");
	});
});

describe("withLanguageKey", () => {
	test("sets the askUserLanguage key on a clone", () => {
		expect(withLanguageKey(S({ theme: "dark" }), "askUserLanguage", "zh-TW")).toEqual(
			S({ theme: "dark", askUserLanguage: "zh-TW" }),
		);
	});
	test("overwrites an existing value", () => {
		expect(withLanguageKey(S({ askUserLanguage: "en" }), "askUserLanguage", "zh-TW")).toEqual(
			S({ askUserLanguage: "zh-TW" }),
		);
	});
	test("invalid tag (spaces) → drops / leaves the key unset", () => {
		expect(
			withLanguageKey(S({ askUserLanguage: "en", theme: "dark" }), "askUserLanguage", "bad tag"),
		).toEqual(S({ theme: "dark" }));
	});
	test("invalid tag with no existing key → stays unset (no bogus value written)", () => {
		expect(withLanguageKey(S({ theme: "dark" }), "askUserLanguage", "")).toEqual(
			S({ theme: "dark" }),
		);
	});
	test("does not mutate the input", () => {
		const input = S({ askUserLanguage: "en" });
		withLanguageKey(input, "askUserLanguage", "zh-TW");
		expect(input).toEqual(S({ askUserLanguage: "en" }));
	});
	test("generic over both keys — sets responseLanguage too", () => {
		expect(withLanguageKey(S({ theme: "dark" }), "responseLanguage", "ja")).toEqual(
			S({ theme: "dark", responseLanguage: "ja" }),
		);
	});
});

describe("writeLanguageKey (IO round-trip via PI_CODING_AGENT_DIR)", () => {
	let tmp: string;
	let prevDir: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pi-lang-key-"));
		prevDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmp;
	});

	afterEach(() => {
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		rmSync(tmp, { recursive: true, force: true });
	});

	test("writes askUserLanguage and round-trips through readSettingsFile", () => {
		writeLanguageKey("askUserLanguage", "zh-TW");
		expect(getLanguageKey(readSettingsFile(), "askUserLanguage")).toBe("zh-TW");
	});

	test("preserves other keys when merging", () => {
		writeFileSync(join(tmp, "settings.json"), JSON.stringify({ theme: "dark" }) + "\n");
		writeLanguageKey("askUserLanguage", "en");
		expect(readSettingsFile()).toEqual(S({ theme: "dark", askUserLanguage: "en" }));
	});

	test("invalid tag does not create a bogus value", () => {
		writeFileSync(join(tmp, "settings.json"), JSON.stringify({ theme: "dark" }) + "\n");
		writeLanguageKey("askUserLanguage", "bad tag");
		expect(getLanguageKey(readSettingsFile(), "askUserLanguage")).toBeUndefined();
		expect(readSettingsFile()).toEqual(S({ theme: "dark" }));
	});
});
