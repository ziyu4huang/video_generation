/**
 * Positive round-trip coverage for `obsidian_read`.
 *
 * errorCodes.test.mjs pins the read error paths (NOT_FOUND on a missing note,
 * PERMISSION_DENIED on a chmod-000 file); the positive path — reading an
 * existing note returns its raw content verbatim — had no tool-level test.
 * Fake-pi pattern + ONE beforeAll fixture (getVault closure cache; same rule
 * as toolSmoke / expectedMtime / deleteTool).
 *
 *   bun test extensions/__tests__/readTool.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
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

const BODY = "---\ntags: [alpha]\n---\n\n# Hello\n\nreadmarkertext here.\n";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"Inbox/idea.md": BODY,
		"Notes/plain.md": "# Plain\n\nno frontmatter body.\n",
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

describe("obsidian_read — positive round-trip", () => {
	it("returns the raw file content + bytes for an existing note", async () => {
		const r = await call("obsidian_read", { note: "Notes/plain.md" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("# Plain\n\nno frontmatter body.\n");
		expect(r.details.note).toBe("Notes/plain.md");
		expect(r.details.bytes).toBe("# Plain\n\nno frontmatter body.\n".length);
		expect(typeof r.details.vault).toBe("string");
	});

	it("resolves a note given without the .md extension", async () => {
		const r = await call("obsidian_read", { note: "Inbox/idea" });
		expect(r.isError).toBeFalsy();
		// safeNotePath normalizes the missing suffix → finds Inbox/idea.md.
		expect(r.content[0].text).toBe(BODY);
	});

	it("preserves frontmatter verbatim in the returned text (read is raw)", async () => {
		const r = await call("obsidian_read", { note: "Inbox/idea.md" });
		expect(r.content[0].text).toContain("---");
		expect(r.content[0].text).toContain("tags: [alpha]");
		expect(r.content[0].text).toContain("readmarkertext here.");
	});
});
