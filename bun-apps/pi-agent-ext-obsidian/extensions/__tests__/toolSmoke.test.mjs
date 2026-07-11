/**
 * Phase 5 / WS-D4 — happy-path smoke tests for the tools that had no
 * end-to-end round-trip coverage. Uses the fake-pi pattern (collect registered
 * tools, drive .execute directly) so no real pi/LLM is involved.
 *
 * Covered here: obsidian_list, obsidian_search, obsidian_move, obsidian_rename,
 * obsidian_query, obsidian_invalidate, obsidian_status.
 * (create/read/append/update_frontmatter/delete are covered by errorCodes,
 * expectedMtime, createGuard, deleteCleanup, structuredEditing; open launches a
 * URI; distill/garden spawn a subagent — all intentionally out of scope.)
 *
 * ONE beforeAll fixture: getVault caches the resolved vault in a closure, so a
 * per-test fixture would be invisible to the tools (same rule as
 * expectedMtime.test.mjs).
 *
 *   bun test extensions/__tests__/toolSmoke.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

const mod = await import("../obsidian.ts");

function makeFakePi() {
	const tools = {};
	const pi = {
		registerTool: (t) => { tools[t.name] = t; if (t._capturedTools) Object.assign(tools, t._capturedTools); },
		registerCommand: () => {},
		on: () => {},
	};
	return { pi, tools };
}
const { pi, tools } = makeFakePi();
mod.default(pi);

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"Inbox/source.md": "# Source\n\nRefs [[Target]] and [[Target|alias]].\n",
		"Notes/Target.md":
			"---\ntags: [alpha, beta]\ncreated: 2026-01-01\n---\n\n# Target\n\nbody with uniquewordxyz.\n",
	});
	// Force vault resolution onto this fixture; index refresh eagerly.
	process.env.OB_VAULT_PATH = vault;
	process.env.OB_INDEX_POLL_MS = "0";
});
afterAll(async () => {
	delete process.env.OB_VAULT_PATH;
	delete process.env.OB_INDEX_POLL_MS;
	await rmFixture(vault);
});

async function call(toolName, params) {
	const ctx = { cwd: vault };
	delete process.env.OB_USE_GLOBAL;
	process.env.OB_VAULT_PATH = vault;
	return await tools[toolName].execute("id", params, undefined, undefined, ctx);
}

// ---- obsidian_list --------------------------------------------------------

describe("WS-D4 — obsidian_list", () => {
	it("lists the whole vault when no folder given", async () => {
		const r = await call("obsidian_list", {});
		expect(r.isError).toBeFalsy();
		expect(r.details.notes).toEqual(
			expect.arrayContaining(["Inbox/source.md", "Notes/Target.md"]),
		);
	});

	it("restricts to a folder", async () => {
		const r = await call("obsidian_list", { folder: "Inbox" });
		expect(r.details.notes).toEqual(["Inbox/source.md"]);
	});

	it("reports an empty folder cleanly", async () => {
		const r = await call("obsidian_list", { folder: "DoesNotExist" });
		expect(r.details.notes).toEqual([]);
		expect(r.content[0].text).toMatch(/No notes/i);
	});
});

// ---- obsidian_search ------------------------------------------------------

describe("WS-D4 — obsidian_search", () => {
	it("substring search hits the matching note", async () => {
		const r = await call("obsidian_search", { query: "uniquewordxyz" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/Notes\/Target\.md/);
	});

	it("tag search (#prefix) returns the tagged note", async () => {
		const r = await call("obsidian_search", { query: "#alpha" });
		expect(r.details.matches.map((m) => m.file || m.path || m)).toEqual(
			expect.arrayContaining(["Notes/Target.md"]),
		);
	});

	it("a query with no hits returns an empty match list", async () => {
		const r = await call("obsidian_search", { query: "zzz_nope_zzz" });
		expect(r.content[0].text).toMatch(/no matches/i);
	});
});

// ---- obsidian_query -------------------------------------------------------

describe("WS-D4 — obsidian_query", () => {
	it("filters by tag (AND semantics)", async () => {
		const r = await call("obsidian_query", { tags: ["alpha", "beta"] });
		expect(r.details.rows.map((row) => row.path)).toEqual(
			expect.arrayContaining(["Notes/Target.md"]),
		);
	});

	it("a tag no note has yields zero rows", async () => {
		const r = await call("obsidian_query", { tags: ["nonexistent"] });
		expect(r.details.count).toBe(0);
	});
});

// ---- obsidian_move (file relocates + inbound links rewrite) --------------

describe("WS-D4 — obsidian_move", () => {
	it("moves the file AND rewrites inbound [[wiki-links]]", async () => {
		const r = await call("obsidian_move", {
			from: "Notes/Target.md",
			to: "Notes/Moved.md",
		});
		expect(r.isError).toBeFalsy();
		expect(r.details.from).toBe("Notes/Target.md");
		expect(r.details.to).toBe("Notes/Moved.md");
		expect(r.details.linksRewritten.length).toBeGreaterThan(0);
		// The source note's links now point at the new path.
		const src = await readFile(join(vault, "Inbox/source.md"), "utf8");
		expect(src).toMatch(/Notes\/Moved/);
		expect(src).not.toMatch(/\[\[Target/);
	});

	it("refuses to move a missing source", async () => {
		const r = await call("obsidian_move", { from: "Notes/Gone.md", to: "Notes/X.md" });
		expect(r.isError).toBe(true);
	});
});

// ---- obsidian_rename (in-place, same dir) ---------------------------------

describe("WS-D4 — obsidian_rename", () => {
	it("renames in place and reports the new path", async () => {
		// source.md → moved src.md (Target was already moved above)
		const r = await call("obsidian_rename", {
			note: "Inbox/source.md",
			newName: "src",
		});
		expect(r.isError).toBeFalsy();
		expect(r.details.to).toBe("Inbox/src.md");
		const after = await call("obsidian_list", { folder: "Inbox" });
		expect(after.details.notes).toContain("Inbox/src.md");
		expect(after.details.notes).not.toContain("Inbox/source.md");
	});
});

// ---- obsidian_invalidate (scoped reconcile) -------------------------------

describe("WS-D4 — obsidian_invalidate", () => {
	it("accepts a scoped path and returns a summary without error", async () => {
		// Build the index first via a search, then reconcile one note.
		await call("obsidian_search", { query: "uniquewordxyz" });
		const r = await call("obsidian_invalidate", { path: "Notes/Moved.md" });
		expect(r.isError).toBeFalsy();
		expect(typeof r.content[0].text).toBe("string");
	});

	it("no-arg reconcile also succeeds", async () => {
		const r = await call("obsidian_invalidate", {});
		expect(r.isError).toBeFalsy();
	});
});

// ---- obsidian_status ------------------------------------------------------

describe("WS-D4 — obsidian_status", () => {
	it("reports the active vault path + source for this fixture", async () => {
		const r = await call("obsidian_status", {});
		expect(r.isError).toBeFalsy();
		expect(r.details.active.path).toBe(vault);
		expect(typeof r.details.active.source).toBe("string");
		expect(typeof r.details.active.noteCount).toBe("number");
	});
});
