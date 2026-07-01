/**
 * Phase 2 — AI-workflow safety (WS-B1 validate-before-trust, B2 explicit model,
 * B5 promise-antipattern removal) + D5 subagent mock tests.
 *
 *   bun test extensions/__tests__/subagentSafety.test.mjs
 *
 * These exercise the Phase 2 boundaries as PURE functions (no real LLM/pi):
 *   - resolveSubagentModel: explicit/floor/inherited/default + weak refusal
 *   - validateZettelNote / validateZettelNotes: schema enforcement
 *   - runSubagent spawn-error: resolves cleanly (B5 — no unhandled rejection)
 *   - parseStructuredResult: malformed output rejected
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	resolveSubagentModel,
	isWeakModel,
	validateZettelNote,
	validateZettelNotes,
	runSubagent,
	parseStructuredResult,
	toolAllowlist,
	assertExtensionApi,
	getIndex,
	dropIndex,
} from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

// ---- B6: env-driven tool allowlists ---------------------------------------

describe("WS-B6 — toolAllowlist", () => {
	const defs = ["a", "b", "c"];
	afterEach(() => {
		delete process.env.OB_TEST_ALLOWLIST;
	});

	it("returns defaults when the env var is unset", () => {
		expect(toolAllowlist("OB_TEST_ALLOWLIST", defs)).toEqual(defs);
	});
	it("parses a comma-separated override", () => {
		process.env.OB_TEST_ALLOWLIST = "x,y,z";
		expect(toolAllowlist("OB_TEST_ALLOWLIST", defs)).toEqual(["x", "y", "z"]);
	});
	it("trims whitespace and drops empty entries", () => {
		process.env.OB_TEST_ALLOWLIST = " x , , y ,  ";
		expect(toolAllowlist("OB_TEST_ALLOWLIST", defs)).toEqual(["x", "y"]);
	});
	it("falls back to defaults when the value is all-empty", () => {
		process.env.OB_TEST_ALLOWLIST = " , , ";
		expect(toolAllowlist("OB_TEST_ALLOWLIST", defs)).toEqual(defs);
	});
	it("falls back when set but blank", () => {
		process.env.OB_TEST_ALLOWLIST = "   ";
		expect(toolAllowlist("OB_TEST_ALLOWLIST", defs)).toEqual(defs);
	});
});

// ---- C8: ExtensionAPI contract guard --------------------------------------

describe("WS-C8 — assertExtensionApi", () => {
	const good = () => ({ registerTool: () => {}, registerCommand: () => {}, on: () => {} });

	it("passes silently when all methods are present", () => {
		expect(() => assertExtensionApi(good())).not.toThrow();
	});
	it("throws when a CORE method (registerTool) is missing", () => {
		const pi = good();
		delete pi.registerTool;
		expect(() => assertExtensionApi(pi)).toThrow(/core method/i);
	});
	it("warns (does not throw) when only a secondary method is missing", () => {
		const pi = good();
		delete pi.on;
		const errs = [];
		const orig = console.error;
		console.error = (m) => errs.push(m);
		try {
			expect(() => assertExtensionApi(pi)).not.toThrow();
		} finally {
			console.error = orig;
		}
		expect(errs.join(" ")).toMatch(/secondary method/i);
	});
	it("throws on a non-object host", () => {
		expect(() => assertExtensionApi(null)).toThrow(/core method/i);
		expect(() => assertExtensionApi(undefined)).toThrow(/core method/i);
	});
});

// ---- B2: model resolution -------------------------------------------------

describe("WS-B2 — isWeakModel", () => {
	it("flags known small/fast tiers", () => {
		expect(isWeakModel("claude-haiku-4-5")).toBe(true);
		expect(isWeakModel("gpt-4o-mini")).toBe(true);
		expect(isWeakModel("gemini-2.0-flash")).toBe(true);
		expect(isWeakModel("some-nano-model")).toBe(true);
	});
	it("does not flag capable tiers", () => {
		expect(isWeakModel("claude-opus-4-8")).toBe(false);
		expect(isWeakModel("claude-sonnet-5")).toBe(false);
		expect(isWeakModel("glm-4.6")).toBe(false);
	});
	it("treats undefined as not-weak", () => {
		expect(isWeakModel(undefined)).toBe(false);
	});
});

describe("WS-B2 — resolveSubagentModel", () => {
	let savedSub, savedParent;
	beforeEach(() => {
		savedSub = process.env.OB_SUBAGENT_MODEL;
		savedParent = process.env.OB_PARENT_MODEL;
		delete process.env.OB_SUBAGENT_MODEL;
		delete process.env.OB_PARENT_MODEL;
	});
	afterEach(() => {
		if (savedSub === undefined) delete process.env.OB_SUBAGENT_MODEL;
		else process.env.OB_SUBAGENT_MODEL = savedSub;
		if (savedParent === undefined) delete process.env.OB_PARENT_MODEL;
		else process.env.OB_PARENT_MODEL = savedParent;
	});

	it("honors an explicit per-call model", () => {
		const r = resolveSubagentModel({ model: "claude-opus-4-8" });
		expect(r.model).toBe("claude-opus-4-8");
		expect(r.source).toBe("explicit");
		expect(r.warned).toBe(false);
	});

	it("warns when an explicit model is a known-weak tier (but still honors it)", () => {
		const r = resolveSubagentModel({ model: "claude-haiku-4-5" });
		expect(r.model).toBe("claude-haiku-4-5");
		expect(r.source).toBe("explicit");
		expect(r.warned).toBe(true);
	});

	it("uses OB_SUBAGENT_MODEL as a trusted floor when no explicit model", () => {
		process.env.OB_SUBAGENT_MODEL = "claude-sonnet-5";
		const r = resolveSubagentModel({});
		expect(r.model).toBe("claude-sonnet-5");
		expect(r.source).toBe("floor");
		// a weak-looking floor is still trusted (operator set it deliberately)
		process.env.OB_SUBAGENT_MODEL = "claude-haiku-4-5";
		const r2 = resolveSubagentModel({});
		expect(r2.source).toBe("floor");
		expect(r2.warned).toBe(false);
	});

	it("REFUSES to inherit a known-weak OB_PARENT_MODEL", () => {
		process.env.OB_PARENT_MODEL = "gpt-4o-mini";
		const r = resolveSubagentModel({});
		expect(r.model).toBeUndefined();
		expect(r.source).toBe("default");
		expect(r.warned).toBe(true);
	});

	it("inherits a capable OB_PARENT_MODEL", () => {
		process.env.OB_PARENT_MODEL = "claude-opus-4-8";
		const r = resolveSubagentModel({});
		expect(r.model).toBe("claude-opus-4-8");
		expect(r.source).toBe("inherited");
		expect(r.warned).toBe(false);
	});

	it("explicit model wins over a weak parent", () => {
		process.env.OB_PARENT_MODEL = "gpt-4o-mini";
		const r = resolveSubagentModel({ model: "claude-sonnet-5" });
		expect(r.model).toBe("claude-sonnet-5");
		expect(r.source).toBe("explicit");
	});

	it("warns when nothing is configured", () => {
		const r = resolveSubagentModel({});
		expect(r.model).toBeUndefined();
		expect(r.source).toBe("default");
		expect(r.warned).toBe(true);
	});
});

// ---- B1: Zettelkasten note validation -------------------------------------

const VALID_CARD = `---
id: 202607010900
created: 2026-07-01
tags: [zettel, testing]
sources: ["input.md"]
---

# Atomic Idea

## 核心想法
- one claim.

## 連結
- [[Existing Note]]
`;

describe("WS-B1 — validateZettelNote", () => {
	it("accepts a well-formed card", () => {
		const { ok, errors } = validateZettelNote(VALID_CARD);
		expect(ok).toBe(true);
		expect(errors).toEqual([]);
	});

	it("rejects a card with no frontmatter", () => {
		const { ok, errors } = validateZettelNote("# Just a title\n\nno fm here\n");
		expect(ok).toBe(false);
		expect(errors.join("|")).toMatch(/frontmatter/i);
	});

	it("rejects a card missing a required key", () => {
		const noId = VALID_CARD.replace(/^id:.*\n/m, "");
		const { ok, errors } = validateZettelNote(noId);
		expect(ok).toBe(false);
		expect(errors.join("|")).toMatch(/missing required key: id/);
	});

	it("rejects when tags[0] is not 'zettel'", () => {
		const badTag = VALID_CARD.replace("tags: [zettel, testing]", "tags: [random, testing]");
		const { ok, errors } = validateZettelNote(badTag);
		expect(ok).toBe(false);
		expect(errors.join("|")).toMatch(/tags\[0\] should be "zettel"/);
	});

	it("rejects an empty / whitespace-only note", () => {
		const { ok } = validateZettelNote("   \n\n  ");
		expect(ok).toBe(false);
	});

	it("flags an oversized blob as garbage", () => {
		const huge = "---\nid: 1\ncreated: 2026-07-01\ntags: [zettel]\n---\n\n# x\n\n" + "a".repeat(70_000);
		const { ok, errors } = validateZettelNote(huge);
		expect(ok).toBe(false);
		expect(errors.join("|")).toMatch(/exceeds/i);
	});
});

describe("WS-B1 — validateZettelNote with index (dead-link detection)", () => {
	let vault;
	beforeEach(async () => {
		vault = await makeFixture({ "Existing Note.md": "# Existing Note\n" });
		process.env.OB_INDEX_POLL_MS = "0";
	});
	afterEach(async () => {
		dropIndex(vault);
		await rmFixture(vault);
	});

	it("flags wiki-link targets that do not resolve in the vault", async () => {
		const idx = await getIndex(vault);
		const card = VALID_CARD.replace("[[Existing Note]]", "[[Ghost Note]]");
		const { ok, errors } = validateZettelNote(card, idx);
		expect(ok).toBe(false);
		expect(errors.join("|")).toMatch(/unresolved wiki-link/i);
	});

	it("passes when all wiki-link targets resolve", async () => {
		const idx = await getIndex(vault);
		const { ok } = validateZettelNote(VALID_CARD, idx);
		expect(ok).toBe(true);
	});
});

describe("WS-B1 — validateZettelNotes (batch over a vault)", () => {
	let vault;
	beforeEach(async () => {
		vault = await makeFixture({});
		process.env.OB_INDEX_POLL_MS = "0";
	});
	afterEach(async () => {
		dropIndex(vault);
		await rmFixture(vault);
	});

	it("reports valid vs invalid notes and flags missing-on-disk", async () => {
		await writeFile(
			join(vault, "good.md"),
			"---\nid: 1\ncreated: 2026-07-01\ntags: [zettel]\n---\n\n# Good\n",
			"utf8",
		);
		await writeFile(join(vault, "bad.md"), "# Bad\n\nno frontmatter\n", "utf8");
		const report = await validateZettelNotes(vault, ["good.md", "bad.md", "ghost.md"]);
		expect(report.valid).toBe(1);
		expect(report.invalid).toBe(2);
		const byPath = Object.fromEntries(report.notes.map((n) => [n.path, n]));
		expect(byPath["good.md"].ok).toBe(true);
		expect(byPath["bad.md"].ok).toBe(false);
		expect(byPath["ghost.md"].errors.join("")).toMatch(/not found on disk/);
	});

	it("returns an empty report for no paths", async () => {
		const report = await validateZettelNotes(vault, []);
		expect(report.notes).toEqual([]);
		expect(report.valid).toBe(0);
	});
});

// ---- B5: runSubagent spawn-error does not leak a rejection ----------------

describe("WS-B5 — runSubagent resolves cleanly on spawn error (no antipattern leak)", () => {
	it("returns exitCode 1 (does not throw / reject) when the child can't spawn", async () => {
		const savedPath = process.env.PATH;
		const savedTimeout = process.env.OB_SUBAGENT_TIMEOUT_MS;
		process.env.PATH = ""; // ensure `pi` cannot be resolved → ENOENT spawn error
		process.env.OB_SUBAGENT_TIMEOUT_MS = "2000";
		let unhandled = null;
		const onUR = (err) => {
			unhandled = err;
		};
		process.on("unhandledRejection", onUR);
		try {
			const res = await runSubagent(
				process.cwd(),
				"sys",
				"task",
				"read",
				undefined,
				"pi-spawnerr-",
			);
			expect(res.exitCode).toBe(1);
			expect(res).toHaveProperty("output");
			expect(res).toHaveProperty("stderr");
			expect(res.result).toBeNull();
			// allow any deferred microtask to surface an unhandled rejection
			await new Promise((r) => setTimeout(r, 50));
			expect(unhandled).toBeNull();
		} finally {
			process.removeListener("unhandledRejection", onUR);
			process.env.PATH = savedPath;
			if (savedTimeout === undefined) delete process.env.OB_SUBAGENT_TIMEOUT_MS;
			else process.env.OB_SUBAGENT_TIMEOUT_MS = savedTimeout;
		}
	}, 10_000);
});

// ---- parseStructuredResult: malformed output rejected ---------------------

describe("WS-B1 — parseStructuredResult rejects malformed subagent output", () => {
	it("returns null for non-JSON trailing text", () => {
		expect(parseStructuredResult("some prose\nnot json")).toBeNull();
	});
	it("returns null for JSON without the pi_obsidian_result type", () => {
		expect(parseStructuredResult('{"type":"other","x":1}')).toBeNull();
	});
	it("parses a valid trailing result line", () => {
		const text = 'summary line\n{"type":"pi_obsidian_result","notesCreated":2,"notes":["a.md"]}';
		const r = parseStructuredResult(text);
		expect(r).not.toBeNull();
		expect(r.type).toBe("pi_obsidian_result");
		expect(r.notesCreated).toBe(2);
	});
	it("picks the LAST result line when multiple are present", () => {
		const text =
			'{"type":"pi_obsidian_result","notesCreated":1}\nmore\n{"type":"pi_obsidian_result","notesCreated":3}';
		expect(parseStructuredResult(text).notesCreated).toBe(3);
	});
	it("returns null for empty input", () => {
		expect(parseStructuredResult("")).toBeNull();
		expect(parseStructuredResult(undefined)).toBeNull();
	});
});
