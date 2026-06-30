/**
 * A1.5 — Windows / cross-platform path parity.
 *   bun test extensions/__tests__/pathParity.test.mjs
 *
 * Confirms safeNotePath handles posix-style input (`a/b`) regardless of host
 * platform, since path.relative/isAbsolute (used since A1.1) are platform-aware.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { safeNotePath } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => { vault = await makeFixture({}); });
afterAll(async () => { await rmFixture(vault); });

describe("safeNotePath — cross-platform input forms", () => {
	it("accepts posix forward-slash nested path", () => {
		const p = safeNotePath(vault, "Zettelkasten/sub/note");
		expect(p.endsWith("Zettelkasten/sub/note.md") || p.endsWith("Zettelkasten\\sub\\note.md")).toBe(true);
	});

	it("accepts backslash-style nested path (windows form)", () => {
		const p = safeNotePath(vault, "Zettelkasten\\sub\\note2");
		// normalized to host separator
		expect(p.includes("Zettelkasten")).toBe(true);
		expect(p.includes("note2.md")).toBe(true);
	});

	it("rejects traversal expressed with backslashes", () => {
		expect(() => safeNotePath(vault, "..\\..\\etc\\passwd")).toThrow();
	});

	it("rejects traversal expressed with forward slashes", () => {
		expect(() => safeNotePath(vault, "../../etc/passwd")).toThrow();
	});

	it("mixed separators are normalized, not rejected", () => {
		const p = safeNotePath(vault, "Inbox/sub\\deep");
		expect(p.includes("Inbox")).toBe(true);
	});
});
