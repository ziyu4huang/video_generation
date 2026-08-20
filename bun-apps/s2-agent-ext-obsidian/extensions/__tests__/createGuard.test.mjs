/**
 * A2.2 / A2.3 — obsidian_create overwrite guard + mtime conflict detection.
 *   bun test extensions/__tests__/createGuard.test.mjs
 *
 * Tests the tool's execute() directly (no pi runtime needed).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

// Import the extension factory + a minimal fake ExtensionAPI that captures tools.
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

let vault;
let create;
beforeAll(async () => {
	vault = await makeFixture({ "existing.md": "old content" });
	const { pi, tools } = makeFakePi();
	mod.default(pi);
	create = tools["obsidian_create"];
});
afterAll(async () => { await rmFixture(vault); });

async function call(note, extra = {}) {
	const ctx = { cwd: vault };
	// OB_VAULT_PATH (checked first by resolveVault) forces resolution to fixture.
	delete process.env.OB_USE_GLOBAL;
	process.env.OB_VAULT_PATH = vault;
	try {
		return await create.execute("id", { note, ...extra }, undefined, undefined, ctx);
	} finally {
		delete process.env.OB_VAULT_PATH;
	}
}

describe("obsidian_create — overwrite guard (A2.3)", () => {
	it("creates a new note", async () => {
		const r = await call("fresh.md", { content: "hi", overwrite: true });
		expect(r.isError).toBeFalsy();
		expect(await readFile(join(vault, "fresh.md"), "utf8")).toBe("hi");
	});

	it("refuses to overwrite an existing note by default", async () => {
		const r = await call("existing.md", { content: "new" });
		expect(r.isError).toBe(true);
		expect(r.details.exists).toBe(true);
		// content unchanged
		expect(await readFile(join(vault, "existing.md"), "utf8")).toBe("old content");
	});

	it("overwrites when overwrite:true", async () => {
		const r = await call("existing.md", { content: "new", overwrite: true });
		expect(r.isError).toBeFalsy();
		expect(await readFile(join(vault, "existing.md"), "utf8")).toBe("new");
	});
});

describe("obsidian_create — mtime conflict detection (A2.2)", () => {
	it("rejects when expectedMtime does not match on-disk mtime", async () => {
		const r = await call("existing.md", { content: "x", expectedMtime: 12345 });
		expect(r.isError).toBe(true);
		expect(r.details.conflict).toBe(true);
	});

	it("accepts when expectedMtime matches current mtime", async () => {
		const { stat } = await import("node:fs/promises");
		const st = await stat(join(vault, "existing.md"));
		const r = await call("existing.md", { content: "via-mtime", expectedMtime: st.mtimeMs });
		expect(r.isError).toBeFalsy();
		expect(await readFile(join(vault, "existing.md"), "utf8")).toBe("via-mtime");
	});
});
