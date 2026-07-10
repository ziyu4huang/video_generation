/**
 * Phase 1 / WS-A1 + WS-A2 — structured error codes on tool results.
 * Tool failures must surface a machine-branchable `details.code` (and keep the
 * legacy `details.error` / boolean flags for back-comat). ENOENT vs EACCES must
 * be distinguishable at the user-facing read/write surface.
 *
 *   bun test extensions/__tests__/errorCodes.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chmod, stat } from "node:fs/promises";
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

let vault, tools;
beforeAll(async () => {
	vault = await makeFixture({ "exists.md": "---\ncreated: 2026-01-01\n---\n\n# Exists\n" });
	const { pi, tools: t } = makeFakePi();
	mod.default(pi);
	tools = t;
});
afterAll(async () => { await rmFixture(vault); });

async function call(toolName, params) {
	const ctx = { cwd: vault };
	delete process.env.OB_USE_GLOBAL;
	process.env.OB_VAULT_PATH = vault;
	try {
		return await tools[toolName].execute("id", params, undefined, undefined, ctx);
	} finally {
		delete process.env.OB_VAULT_PATH;
	}
}

describe("WS-A2 — structured error codes surface on details.code", () => {
	it("obsidian_read on a missing note -> code NOT_FOUND", async () => {
		const r = await call("obsidian_read", { note: "nope.md" });
		expect(r.isError).toBe(true);
		expect(r.details.code).toBe("NOT_FOUND");
		// legacy human field still present (back-compat)
		expect(r.details.error).toBe("NOT_FOUND");
	});

	it("obsidian_create on an existing note (no overwrite) -> code ALREADY_EXISTS", async () => {
		const r = await call("obsidian_create", { note: "exists.md", content: "x" });
		expect(r.isError).toBe(true);
		expect(r.details.code).toBe("ALREADY_EXISTS");
		expect(r.details.exists).toBe(true); // legacy boolean preserved
	});

	it("obsidian_create with stale expectedMtime -> code CONFLICT", async () => {
		const r = await call("obsidian_create", {
			note: "exists.md",
			content: "x",
			expectedMtime: 12345,
		});
		expect(r.isError).toBe(true);
		expect(r.details.code).toBe("CONFLICT");
		expect(r.details.conflict).toBe(true); // legacy boolean preserved
	});

	it("obsidian_update_frontmatter on a missing note -> code NOT_FOUND", async () => {
		const r = await call("obsidian_update_frontmatter", {
			note: "ghost.md",
			patch: { tags: ["x"] },
		});
		expect(r.isError).toBe(true);
		expect(r.details.code).toBe("NOT_FOUND");
	});

	it("obsidian_create matching expectedMtime succeeds (no false CONFLICT)", async () => {
		const st = await stat(join(vault, "exists.md"));
		const r = await call("obsidian_create", {
			note: "exists.md",
			content: "# Rewritten\n",
			expectedMtime: st.mtimeMs,
		});
		expect(r.isError).toBeFalsy();
	});
});

// PERMISSION_DENIED requires actually-unreadable files; skip when running as
// root (bypasses perms) or when chmod is ineffective (Windows/odd fs).
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
describe.skipIf(isRightlessEnv())("WS-A1 — ENOENT vs EACCES distinguished", () => {
	it("obsidian_read on a chmod-000 file -> code PERMISSION_DENIED (not NOT_FOUND)", async () => {
		const { writeFile } = await import("node:fs/promises");
		const locked = join(vault, "locked.md");
		await writeFile(locked, "secret\n", "utf8");
		await chmod(locked, 0o000);
		try {
			const r = await call("obsidian_read", { note: "locked.md" });
			expect(r.isError).toBe(true);
			expect(r.details.code).toBe("PERMISSION_DENIED");
		} finally {
			await chmod(locked, 0o644); // restore so rmFixture can clean up
		}
	});
});

function isRightlessEnv() {
	return isRoot || process.platform === "win32";
}
