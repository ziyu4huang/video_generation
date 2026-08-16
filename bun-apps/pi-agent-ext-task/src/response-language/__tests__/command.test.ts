/**
 * command.ts — unit tests for the pure command decision logic
 * (parseLanguageArg / decideCommand).
 */
import { describe, expect, test } from "bun:test";
import { decideCommand, parseLanguageArg } from "../command.js";

describe("parseLanguageArg", () => {
	test("tag present → trimmed", () => {
		expect(parseLanguageArg("  zh-TW  ")).toEqual({ raw: "  zh-TW  ", tag: "zh-TW" });
	});
	test("empty string → tag undefined", () => {
		expect(parseLanguageArg("")).toEqual({ raw: "", tag: undefined });
	});
	test("whitespace-only → tag undefined", () => {
		expect(parseLanguageArg("   ")).toEqual({ raw: "   ", tag: undefined });
	});
});

describe("decideCommand", () => {
	test("no arg → show current", () => {
		expect(decideCommand(parseLanguageArg(""), "zh-TW")).toEqual({
			kind: "show",
			current: "zh-TW",
		});
	});
	test("no arg + no current → show undefined", () => {
		expect(decideCommand(parseLanguageArg(""), undefined)).toEqual({
			kind: "show",
			current: undefined,
		});
	});
	test("valid tag → set", () => {
		expect(decideCommand(parseLanguageArg("en"), "zh-TW")).toEqual({ kind: "set", tag: "en" });
	});
	test("invalid tag (spaces) → invalid", () => {
		expect(decideCommand(parseLanguageArg("zh TW"), undefined)).toEqual({
			kind: "invalid",
			tag: "zh TW",
		});
	});
	test("invalid tag (punctuation) → invalid", () => {
		expect(decideCommand(parseLanguageArg("en!"), undefined)).toEqual({
			kind: "invalid",
			tag: "en!",
		});
	});
});
