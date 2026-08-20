/**
 * C1.1 — parseFrontmatter tests.
 *   bun test extensions/__tests__/parseFrontmatter.test.mjs
 */
import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../obsidian.ts";
import { vaultAvailable, VAULT, SKIP_REASON } from "./_vault-fixture.ts";

describe("parseFrontmatter", () => {
	it("parses flow-style tags: [a, b]", () => {
		const r = parseFrontmatter("---\ntags: [alpha, beta]\nid: 1\n---\n# T\n");
		expect(r.data.tags).toEqual(["alpha", "beta"]);
		expect(r.data.id).toBe("1");
		expect(r.bodyStart).toBe(4);
	});

	it("parses block-style tags (YAML block list)", () => {
		const r = parseFrontmatter("---\ntags:\n  - alpha\n  - beta\n---\nbody\n");
		expect(r.data.tags).toEqual(["alpha", "beta"]);
	});

	it("parses quoted scalars (strips quotes)", () => {
		const r = parseFrontmatter('---\ntitle: "Hello World"\nnote: \'single\'\n---\n');
		expect(r.data.title).toBe("Hello World");
		expect(r.data.note).toBe("single");
	});

	it("parses booleans and null", () => {
		const r = parseFrontmatter("---\ndraft: true\npublished: false\nempty: null\n---\n");
		expect(r.data.draft).toBe(true);
		expect(r.data.published).toBe(false);
		expect(r.data.empty).toBe(null);
	});

	it("returns empty data when no frontmatter", () => {
		const r = parseFrontmatter("# Just a title\n\nbody\n");
		expect(r.data).toEqual({});
		expect(r.bodyStart).toBe(0);
	});

	it("returns empty data for unterminated frontmatter", () => {
		const r = parseFrontmatter("---\ntags: [a]\n\nno close\n");
		expect(r.data).toEqual({});
	});

	it.skipIf(!vaultAvailable())("all 21-ish vault notes parse without error (skipped: " + SKIP_REASON + ")", async () => {
		const { readdir, readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		let count = 0;
		async function walk(dir) {
			for (const e of await readdir(dir, { withFileTypes: true })) {
				if (e.name.startsWith(".")) continue;
				const full = join(dir, e.name);
				if (e.isDirectory()) await walk(full);
				else if (e.name.endsWith(".md")) {
					const c = await readFile(full, "utf8");
					expect(() => parseFrontmatter(c)).not.toThrow();
					count++;
				}
			}
		}
		await walk(VAULT);
		expect(count).toBeGreaterThan(10);
	});
});
