/**
 * Tool-boundary coverage for `obsidian_delete` (B3.4).
 *
 * deleteCleanup.test.mjs pins the internal `deleteNote()` link-cleanup logic;
 * this file pins the TOOL wrapper: the confirm:true safety guard, param
 * forwarding (cleanupLinks default vs false), success shaping, and the
 * rm({force:true}) behavior on a missing note. Fake-pi pattern + ONE beforeAll
 * fixture (getVault caches the resolved vault in a closure, so a per-test
 * fixture would be invisible — same rule as toolSmoke / expectedMtime).
 *
 *   bun test extensions/__tests__/deleteTool.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFile, access } from "node:fs/promises";
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
		// Happy-path cleanup target (has inbound links from links_doomed.md).
		"Notes/Doomed.md": "---\ntags: [alpha]\n---\n\n# Doomed\n\ndoomedmarkertext.\n",
		"Inbox/links_doomed.md":
			"# Links\n\nRefs [[Doomed]] and [[Doomed|alias]].\n",
		// cleanupLinks:false target — its inbound link must survive.
		"Notes/KeepLinks.md": "# KeepLinks\n\nbody.\n",
		"Inbox/links_keeplinks.md": "# Links\n\nRef [[KeepLinks]].\n",
		// confirm:false guard target — must survive every test.
		"Notes/Guarded.md": "# Guarded\n\nsurvives.\n",
	});
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

async function exists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

// ---- confirm:false safety guard ------------------------------------------

describe("obsidian_delete — confirm guard", () => {
	it("refuses to delete when confirm is not true (isError, no disk change)", async () => {
		const r = await call("obsidian_delete", {
			note: "Notes/Guarded.md",
			confirm: false,
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/confirm:true/i);
		expect(r.details).toEqual({ note: "Notes/Guarded.md", confirmed: false });
		// Nothing was deleted.
		expect(await exists(join(vault, "Notes/Guarded.md"))).toBe(true);
	});

	it("omitting confirm entirely is also refused", async () => {
		const r = await call("obsidian_delete", { note: "Notes/Guarded.md" });
		expect(r.isError).toBe(true);
		expect(await exists(join(vault, "Notes/Guarded.md"))).toBe(true);
	});
});

// ---- happy path: cleanupLinks defaults to true ----------------------------

describe("obsidian_delete — happy path (cleanupLinks default true)", () => {
	it("deletes the note, strips inbound [[wiki-links]], reports linksCleaned", async () => {
		const r = await call("obsidian_delete", {
			note: "Notes/Doomed.md",
			confirm: true,
		});
		expect(r.isError).toBeFalsy();
		expect(r.details.deleted).toBe(true);
		expect(r.details.note).toBe("Notes/Doomed.md");
		expect(r.details.linksCleaned).toEqual(
			expect.arrayContaining(["Inbox/links_doomed.md"]),
		);
		expect(r.content[0].text).toMatch(/Deleted Notes\/Doomed\.md/);

		// File is gone from disk.
		expect(await exists(join(vault, "Notes/Doomed.md"))).toBe(false);

		// Inbound links were stripped from the source note.
		const src = await readFile(join(vault, "Inbox/links_doomed.md"), "utf8");
		expect(src).not.toMatch(/\[\[Doomed/);
	});
});

// ---- cleanupLinks:false leaves dangling refs ------------------------------

describe("obsidian_delete — cleanupLinks:false", () => {
	it("deletes the note but leaves [[wiki-links]] in other notes", async () => {
		const r = await call("obsidian_delete", {
			note: "Notes/KeepLinks.md",
			confirm: true,
			cleanupLinks: false,
		});
		expect(r.isError).toBeFalsy();
		expect(r.details.deleted).toBe(true);
		// No cleanup → empty linksCleaned list.
		expect(r.details.linksCleaned).toEqual([]);

		// Note gone, but the dangling reference survives.
		expect(await exists(join(vault, "Notes/KeepLinks.md"))).toBe(false);
		const src = await readFile(join(vault, "Inbox/links_keeplinks.md"), "utf8");
		expect(src).toMatch(/\[\[KeepLinks\]\]/);
	});
});

// ---- missing note: rm({force:true}) is a no-op success --------------------

describe("obsidian_delete — missing note", () => {
	it("confirm:true on a non-existent note succeeds with zero links cleaned", async () => {
		const r = await call("obsidian_delete", {
			note: "Notes/NeverExisted.md",
			confirm: true,
		});
		// deleteNote uses rm({force:true}) → missing source is not an error.
		expect(r.isError).toBeFalsy();
		expect(r.details.deleted).toBe(true);
		expect(r.details.note).toBe("Notes/NeverExisted.md");
		expect(r.details.linksCleaned).toEqual([]);
	});
});
