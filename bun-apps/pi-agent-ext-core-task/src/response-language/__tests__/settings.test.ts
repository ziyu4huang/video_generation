/**
 * settings.ts — unit tests for the pure decision functions
 * (getResponseLanguage / withResponseLanguage / isValidTag).
 * The IO wrappers (readSettingsFile / writeResponseLanguage) are thin and not
 * asserted here.
 */
import { describe, expect, test } from "bun:test";
import { getResponseLanguage, isValidTag, withResponseLanguage } from "../settings.js";

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
