import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markSuperseded } from "../src/supersede.ts";

describe("markSuperseded", () => {
	let vault: string;
	const graphDir = () => join(vault, "Zettelkasten", "knowledge-graph");
	beforeAll(() => {
		vault = mkdtempSync(join(tmpdir(), "supersede-"));
		mkdirSync(graphDir(), { recursive: true });
	});
	afterAll(() => rmSync(vault, { recursive: true, force: true }));

	function seedCard(file: string, id: string, status = "active", supersededBy = "") {
		writeFileSync(
			join(graphDir(), file),
			`---\nid: ${id}\nstatus: ${status}\nsuperseded_by: ${supersededBy ? `"${supersededBy}"` : '""'}\ntags: [zettel]\n---\nbody text for ${id}\n`,
		);
	}

	test("flips an active card to superseded with the curated id", () => {
		seedCard("a.md", "pi-memory:failure:abc");
		const r = markSuperseded("pi-memory:failure:abc", "distill:curated-1", vault);
		expect(r.found).toBe(true);
		expect(r.updated).toBe(true);
		const raw = readFileSync(join(graphDir(), "a.md"), "utf-8");
		expect(raw).toContain("status: superseded");
		// colon-containing ids are double-quoted (matches ingest.ts yamlScalar)
		expect(raw).toContain('superseded_by: "distill:curated-1"');
		// body untouched
		expect(raw).toContain("body text for pi-memory:failure:abc");
	});

	test("idempotent — re-marking with the same id is a no-op", () => {
		seedCard("b.md", "pi-memory:failure:def", "superseded", "distill:x");
		const r = markSuperseded("pi-memory:failure:def", "distill:x", vault);
		expect(r.found).toBe(true);
		expect(r.updated).toBe(false); // already superseded by same id
	});

	test("re-marking with a DIFFERENT curated id updates superseded_by", () => {
		seedCard("c.md", "pi-memory:failure:ghi", "superseded", "distill:old");
		const r = markSuperseded("pi-memory:failure:ghi", "distill:new", vault);
		expect(r.updated).toBe(true);
		const raw = readFileSync(join(graphDir(), "c.md"), "utf-8");
		expect(raw).toContain('superseded_by: "distill:new"');
	});

	test("missing card → found:false, updated:false", () => {
		const r = markSuperseded("pi-memory:failure:nope", "distill:z", vault);
		expect(r.found).toBe(false);
		expect(r.updated).toBe(false);
	});

	test("missing graph folder → found:false (no throw)", () => {
		const r = markSuperseded("any", "any", join(vault, "does-not-exist"));
		expect(r.found).toBe(false);
	});
});
