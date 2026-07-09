/**
 * A3.4 — structured subagent result parsing.
 *   bun test extensions/__tests__/structuredResult.test.mjs
 */
import { describe, it, expect } from "bun:test";
import { parseStructuredResult } from "../obsidian.ts";

describe("parseStructuredResult (A3.4)", () => {
	it("extracts a trailing pi_obsidian_result JSON line", () => {
		const text = "我建了 3 張卡...\n\n{\"type\":\"pi_obsidian_result\",\"notesCreated\":3,\"linksAdded\":5,\"notes\":[\"a.md\"],\"errors\":[]}";
		const r = parseStructuredResult(text);
		expect(r).not.toBeNull();
		expect(r.type).toBe("pi_obsidian_result");
		expect(r.notesCreated).toBe(3);
		expect(r.notes).toEqual(["a.md"]);
	});

	it("picks the LAST result line when multiple present", () => {
		const text = "{\"type\":\"pi_obsidian_result\",\"notesCreated\":1}\n中間文字\n{\"type\":\"pi_obsidian_result\",\"notesCreated\":7}";
		expect(parseStructuredResult(text).notesCreated).toBe(7);
	});

	it("returns null when no structured line present", () => {
		expect(parseStructuredResult("just a prose report, no JSON")).toBeNull();
	});

	it("returns null for empty input", () => {
		expect(parseStructuredResult("")).toBeNull();
		expect(parseStructuredResult(undefined)).toBeNull();
	});

	it("ignores malformed JSON lines", () => {
		const text = "report\n{\"type\":\"pi_obsidian_result\", broken}\nmore";
		expect(parseStructuredResult(text)).toBeNull();
	});

	it("ignores JSON without the pi_obsidian_result type", () => {
		const text = "report\n{\"type\":\"something_else\",\"x\":1}";
		expect(parseStructuredResult(text)).toBeNull();
	});

	it("handles garden-style result with issues array", () => {
		const text = `audit done
{"type":"pi_obsidian_result","notesCreated":0,"linksAdded":2,"issuesFound":3,"issues":[{"kind":"orphan","path":"x.md","detail":"no inbound"}],"errors":[]}`;
		const r = parseStructuredResult(text);
		expect(r.issuesFound).toBe(3);
		expect(r.issues[0].kind).toBe("orphan");
	});
});
