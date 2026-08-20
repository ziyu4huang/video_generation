/**
 * A1.3 — assertWritablePath blocklist tests.
 *   bun test extensions/__tests__/assertWritablePath.test.mjs
 *
 * Validates that writes into .obsidian/ and .git/ are refused (vault app
 * config + VCS internals must be off-limits to note-editing tools), while
 * normal note paths remain writable.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { safeNotePath, assertWritablePath } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => { vault = await makeFixture(); });
afterAll(async () => { await rmFixture(vault); });

describe("assertWritablePath — blocklisted segments", () => {
	it("refuses .obsidian/app.json", () => {
		const abs = safeNotePath(vault, ".obsidian/app.json");
		expect(() => assertWritablePath(vault, abs)).toThrow(/blocklisted/);
	});

	it("refuses a nested file under .git/", () => {
		const abs = safeNotePath(vault, ".git/config");
		expect(() => assertWritablePath(vault, abs)).toThrow(/blocklisted/);
	});

	it("refuses .obsidian even with .md extension", () => {
		const abs = safeNotePath(vault, ".obsidian/workspace.md");
		expect(() => assertWritablePath(vault, abs)).toThrow(/blocklisted/);
	});

	it("mentions the offending segment in the error", () => {
		const abs = safeNotePath(vault, ".git/hooks/pre-commit");
		try {
			assertWritablePath(vault, abs);
			throw new Error("should have thrown");
		} catch (e) {
			expect(String(e.message)).toContain(".git");
		}
	});
});

describe("assertWritablePath — allowed paths", () => {
	it("allows a normal Inbox note", () => {
		const abs = safeNotePath(vault, "Inbox/idea");
		expect(() => assertWritablePath(vault, abs)).not.toThrow();
	});

	it("allows a deeply nested note", () => {
		const abs = safeNotePath(vault, "Zettelkasten/deep/nested/card");
		expect(() => assertWritablePath(vault, abs)).not.toThrow();
	});

	it("allows a note whose name merely contains '.git' as a substring", () => {
		// 'github-notes.md' is fine — only a top-level .git/ segment is blocked
		const abs = safeNotePath(vault, "Inbox/github-notes");
		expect(() => assertWritablePath(vault, abs)).not.toThrow();
	});
});
