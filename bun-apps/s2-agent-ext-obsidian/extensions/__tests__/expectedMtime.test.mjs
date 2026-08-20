/**
 * Phase 1 / WS-A4 + D3 — optimistic concurrency (expectedMtime) on every write.
 * obsidian_create already had it; Phase 1-C adds it to obsidian_append,
 * obsidian_append_section, and obsidian_update_frontmatter. A stale expectedMtime
 * (note changed since the caller last saw it) must be rejected with code CONFLICT;
 * a matching mtime must succeed; expectedMtime on a brand-new note is ignored.
 *
 * Uses ONE fixture for the file (beforeAll) because getVault caches the resolved
 * vault in a closure — a per-test fixture would not be seen by the tools. Each
 * test resets the target note's content before acting.
 *
 *   bun test extensions/__tests__/expectedMtime.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { stat, utimes, writeFile } from "node:fs/promises";
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
		"note.md": "---\ncreated: 2026-01-01\ntags: [keep]\n---\n\n# Note\n\n## Log\n\n- first\n",
	});
	process.env.OB_VAULT_PATH = vault; // forces resolveVault to this fixture once
});
afterAll(async () => {
	delete process.env.OB_VAULT_PATH;
	await rmFixture(vault);
});

const CANONICAL = "---\ncreated: 2026-01-01\ntags: [keep]\n---\n\n# Note\n\n## Log\n\n- first\n";
/** Reset note.md to canonical content with a known mtime. */
async function reset() {
	await writeFile(join(vault, "note.md"), CANONICAL, "utf8");
	const future = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);
	await utimes(join(vault, "note.md"), future, future);
}

async function call(toolName, params) {
	const ctx = { cwd: vault };
	delete process.env.OB_USE_GLOBAL;
	process.env.OB_VAULT_PATH = vault;
	return await tools[toolName].execute("id", params, undefined, undefined, ctx);
}

async function mtimeOf(rel) {
	return (await stat(join(vault, rel))).mtimeMs;
}
/** Simulate an external (Obsidian-app) edit: bump mtime to a distinct value. */
async function bumpMtime(rel) {
	const future = new Date(Math.floor(Date.now() / 1000) * 1000 + 120_000);
	await utimes(join(vault, rel), future, future);
	return (await stat(join(vault, rel))).mtimeMs;
}

describe("WS-A4 — obsidian_append optimistic concurrency", () => {
	it("rejects a stale expectedMtime with code CONFLICT", async () => {
		await reset();
		const stale = (await mtimeOf("note.md")) - 1000;
		const r = await call("obsidian_append", {
			note: "note.md",
			content: "more",
			expectedMtime: stale,
		});
		expect(r.isError).toBe(true);
		expect(r.details.code).toBe("CONFLICT");
		expect(r.details.conflict).toBe(true);
	});

	it("accepts a matching expectedMtime", async () => {
		await reset();
		const cur = await mtimeOf("note.md");
		const r = await call("obsidian_append", {
			note: "note.md",
			content: "more",
			expectedMtime: cur,
		});
		expect(r.isError).toBeFalsy();
	});

	it("ignores expectedMtime when creating a new note", async () => {
		const r = await call("obsidian_append", {
			note: "brand-new.md",
			content: "fresh",
			expectedMtime: 99999,
		});
		expect(r.isError).toBeFalsy();
	});
});

describe("WS-A4 — obsidian_append_section optimistic concurrency", () => {
	it("rejects a stale expectedMtime (note edited in Obsidian app meanwhile)", async () => {
		await reset();
		const seen = await mtimeOf("note.md");
		const afterEdit = await bumpMtime("note.md");
		expect(afterEdit).not.toBe(seen);
		const r = await call("obsidian_append_section", {
			note: "note.md",
			heading: "Log",
			content: "- second",
			expectedMtime: seen, // caller's stale view
		});
		expect(r.isError).toBe(true);
		expect(r.details.code).toBe("CONFLICT");
	});

	it("accepts a matching expectedMtime after the external edit", async () => {
		await reset();
		const afterEdit = await bumpMtime("note.md");
		const r = await call("obsidian_append_section", {
			note: "note.md",
			heading: "Log",
			content: "- second",
			expectedMtime: afterEdit,
		});
		expect(r.isError).toBeFalsy();
	});
});

describe("WS-A4 — obsidian_update_frontmatter optimistic concurrency", () => {
	it("rejects a stale expectedMtime with code CONFLICT", async () => {
		await reset();
		const stale = (await mtimeOf("note.md")) - 5000;
		const r = await call("obsidian_update_frontmatter", {
			note: "note.md",
			patch: { tags: ["new"] },
			expectedMtime: stale,
		});
		expect(r.isError).toBe(true);
		expect(r.details.code).toBe("CONFLICT");
	});

	it("accepts a matching expectedMtime and merges tags", async () => {
		await reset();
		const cur = await mtimeOf("note.md");
		const r = await call("obsidian_update_frontmatter", {
			note: "note.md",
			patch: { tags: ["new"] },
			expectedMtime: cur,
		});
		expect(r.isError).toBeFalsy();
		expect(r.details.updated).toContain("tags");
	});
});

describe("WS-A4 — no expectedMtime = legacy behavior (no false conflicts)", () => {
	it("append without expectedMtime always proceeds", async () => {
		await reset();
		const r = await call("obsidian_append", { note: "note.md", content: "x" });
		expect(r.isError).toBeFalsy();
	});
	it("update_frontmatter without expectedMtime always proceeds", async () => {
		await reset();
		const r = await call("obsidian_update_frontmatter", {
			note: "note.md",
			patch: { newkey: "v" },
		});
		expect(r.isError).toBeFalsy();
	});
});
