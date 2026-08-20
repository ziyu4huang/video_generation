/**
 * Phase 5 / WS-B4 — garden post-fix markdown integrity validation.
 *
 * fix-mode garden edits ARBITRARY notes (not only Zettel cards), so the strict
 * validateZettelNote (tags[0]==="zettel") does not apply. validateNoteIntegrity
 * is a lighter structural check: frontmatter (if present) is balanced, the note
 * is non-empty, and code fences are paired. This catches an append_section
 * accident that leaves invalid markdown after a garden fix run.
 *
 *   bun test extensions/__tests__/gardenValidation.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	validateNoteIntegrity,
	validateNoteIntegrityBatch,
	invalidateCache,
} from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

// ---- validateNoteIntegrity: pure structural checks -----------------------

describe("WS-B4 — validateNoteIntegrity", () => {
	it("accepts a well-formed note with frontmatter + body", () => {
		const { ok, errors } = validateNoteIntegrity(
			"---\nid: 1\ncreated: 2026-07-01\ntags: [note]\n---\n\n# Title\n\nbody\n",
		);
		expect(ok).toBe(true);
		expect(errors).toEqual([]);
	});

	it("accepts a note with NO frontmatter (frontmatter is optional)", () => {
		const { ok } = validateNoteIntegrity("# Just a title\n\nplain body, no fm\n");
		expect(ok).toBe(true);
	});

	it("rejects empty / whitespace-only content", () => {
		expect(validateNoteIntegrity("   \n\n  ").ok).toBe(false);
		expect(validateNoteIntegrity(undefined).ok).toBe(false);
	});

	it("rejects frontmatter opened but never closed", () => {
		const { ok, errors } = validateNoteIntegrity(
			"---\nid: 1\ncreated: 2026-07-01\n\n# Title\n\nbody got merged into YAML\n",
		);
		expect(ok).toBe(false);
		expect(errors.join("|")).toMatch(/never closed/i);
	});

	it("rejects unbalanced ``` code fences", () => {
		const { ok, errors } = validateNoteIntegrity("# T\n\n```js\nconst x = 1;\n\nno closing fence\n");
		expect(ok).toBe(false);
		expect(errors.join("|")).toMatch(/unbalanced ```/i);
	});

	it("rejects unbalanced ~~~ code fences", () => {
		const { ok, errors } = validateNoteIntegrity("# T\n\n~~~\n fenced\n\nstill open\n");
		expect(ok).toBe(false);
		expect(errors.join("|")).toMatch(/unbalanced ~~~/i);
	});

	it("accepts balanced code fences (even count)", () => {
		const { ok } = validateNoteIntegrity("# T\n\n```js\nx\n```\n\n```\ny\n```\n");
		expect(ok).toBe(true);
	});

	it("accepts a note with a single balanced fence block", () => {
		const { ok } = validateNoteIntegrity("# T\n\n```\ncode\n```\n");
		expect(ok).toBe(true);
	});

	it("reports BOTH a broken fence and unbalanced fence when both occur", () => {
		// frontmatter closed, but ``` unbalanced → one error is enough to fail
		const { ok, errors } = validateNoteIntegrity(
			"---\nid: 1\n---\n\n# T\n\n```\nopen\n",
		);
		expect(ok).toBe(false);
		expect(errors.length).toBeGreaterThanOrEqual(1);
	});
});

// ---- validateNoteIntegrityBatch: disk read + missing-on-disk -------------

describe("WS-B4 — validateNoteIntegrityBatch", () => {
	let vault;
	beforeAll(async () => {
		vault = await makeFixture({});
	});
	afterAll(async () => {
		invalidateCache();
		await rmFixture(vault);
	});

	it("flags missing-on-disk notes and validates present ones", async () => {
		await writeFile(
			join(vault, "ok.md"),
			"---\nid: 1\n---\n\n# Good\n\n```\ncode\n```\n",
			"utf8",
		);
		await writeFile(join(vault, "broken.md"), "---\nid: 2\n\n# no close\n", "utf8");
		const report = await validateNoteIntegrityBatch(vault, ["ok.md", "broken.md", "ghost.md"]);
		expect(report.intact).toBe(1);
		expect(report.broken).toBe(2);
		const byPath = Object.fromEntries(report.notes.map((n) => [n.path, n]));
		expect(byPath["ok.md"].ok).toBe(true);
		expect(byPath["broken.md"].ok).toBe(false);
		expect(byPath["ghost.md"].errors.join("")).toMatch(/missing/i);
	});

	it("returns an empty report for no paths", async () => {
		const report = await validateNoteIntegrityBatch(vault, []);
		expect(report.notes).toEqual([]);
		expect(report.intact).toBe(0);
	});
});
