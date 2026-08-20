/**
 * A0.5 — safeNotePath traversal / validation tests.
 *   bun test extensions/__tests__/safeNotePath.test.mjs
 *
 * Symlink-specific tests land in A1.2 once the guard is hardened (A1.1).
 * Here we cover the current contract: reject ../, absolute, control chars;
 * accept nested + with/without .md.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { safeNotePath } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => { vault = await makeFixture(); });
afterAll(async () => { await rmFixture(vault); });

describe("safeNotePath — valid paths", () => {
	it("accepts a simple note name, adds .md", () => {
		const p = safeNotePath(vault, "Inbox/plain");
		expect(p.endsWith("Inbox/plain.md")).toBe(true);
	});

	it("accepts a note name already ending in .md", () => {
		const p = safeNotePath(vault, "Inbox/plain.md");
		expect(p.endsWith("Inbox/plain.md")).toBe(true);
	});

	it("accepts a nested folder path", () => {
		const p = safeNotePath(vault, "Zettelkasten/deep/nested/note");
		expect(p.endsWith("Zettelkasten/deep/nested/note.md")).toBe(true);
	});

	it("strips a leading slash", () => {
		const p1 = safeNotePath(vault, "/Inbox/plain");
		const p2 = safeNotePath(vault, "Inbox/plain");
		expect(p1).toBe(p2);
	});
});

describe("safeNotePath — rejects traversal", () => {
	it("rejects ../ escaping the vault", () => {
		expect(() => safeNotePath(vault, "../etc/passwd")).toThrow();
	});

	it("rejects deeply nested ../", () => {
		expect(() => safeNotePath(vault, "Inbox/../../../etc/passwd")).toThrow();
	});

	it("a leading-slash absolute-looking path is normalized INTO the vault (no escape)", () => {
		// `/etc/passwd` is not an escape: leading `/` is stripped per the
		// normalization rule (same as `/Inbox/plain` → `Inbox/plain.md`), so it
		// resolves to `<vault>/etc/passwd.md` — inside the vault, not /etc on disk.
		const p = safeNotePath(vault, "/etc/passwd");
		expect(p.startsWith(vault)).toBe(true);
		expect(p.endsWith("etc/passwd.md")).toBe(true);
	});
});

describe("safeNotePath — control chars (A1.4)", () => {
	it("rejects NUL byte in path", () => {
		expect(() => safeNotePath(vault, "evil\u0000.md")).toThrow();
	});

	it("rejects newline in path", () => {
		expect(() => safeNotePath(vault, "evil\nname")).toThrow();
	});

	it("rejects empty path", () => {
		expect(() => safeNotePath(vault, "")).toThrow();
	});
});

describe("safeNotePath — A6 control/formatting chars beyond C0", () => {
	// Control chars are built via code points so the test source carries no
	// embedded invisible bytes (which editors/transports tend to strip).
	const cp = (n) => String.fromCodePoint(n);
	it("rejects C1 DEL (U+007F)", () => {
		expect(() => safeNotePath(vault, "del" + cp(0x7f) + "name")).toThrow();
	});
	it("rejects a C1 control (U+009F)", () => {
		expect(() => safeNotePath(vault, "c1" + cp(0x9f) + "end")).toThrow();
	});
	it("rejects Zero-Width Space (U+200B)", () => {
		expect(() => safeNotePath(vault, "evil" + cp(0x200b))).toThrow();
	});
	it("rejects Right-to-Left Mark (U+200F)", () => {
		expect(() => safeNotePath(vault, "rlm" + cp(0x200f))).toThrow();
	});
	it("rejects Zero-Width Joiner (U+200D)", () => {
		expect(() => safeNotePath(vault, "zwj" + cp(0x200d))).toThrow();
	});
	it("rejects a bidi override (U+202E RLO)", () => {
		expect(() => safeNotePath(vault, "over" + cp(0x202e))).toThrow();
	});
	it("rejects BOM / ZWNBSP (U+FEFF)", () => {
		expect(() => safeNotePath(vault, cp(0xfeff) + "bom")).toThrow();
	});
	it("rejects line separator (U+2028)", () => {
		expect(() => safeNotePath(vault, "line" + cp(0x2028) + "sep")).toThrow();
	});
});

describe("safeNotePath — A6 Windows reserved names + chars", () => {
	it("rejects reserved device name CON", () => {
		expect(() => safeNotePath(vault, "CON")).toThrow(/reserved/i);
	});
	it("rejects reserved device name as a segment", () => {
		expect(() => safeNotePath(vault, "folder/AUX")).toThrow(/reserved/i);
	});
	it("rejects COM1", () => {
		expect(() => safeNotePath(vault, "COM1")).toThrow(/reserved/i);
	});
	it("rejects lpt9 (case-insensitive)", () => {
		expect(() => safeNotePath(vault, "lpt9")).toThrow(/reserved/i);
	});
	it("rejects reserved char '<'", () => {
		expect(() => safeNotePath(vault, "a<b")).toThrow(/reserved char/i);
	});
	it("rejects reserved char ':'", () => {
		expect(() => safeNotePath(vault, "a:b")).toThrow(/reserved char/i);
	});
	it("rejects reserved char '?'", () => {
		expect(() => safeNotePath(vault, "a?b")).toThrow(/reserved char/i);
	});
	it("rejects reserved char '*'", () => {
		expect(() => safeNotePath(vault, "a*b")).toThrow(/reserved char/i);
	});
	it("does NOT over-reject a normal name containing 'com' substring", () => {
		expect(() => safeNotePath(vault, "community")).not.toThrow();
	});
	it("does NOT over-reject 'concat'", () => {
		expect(() => safeNotePath(vault, "concat")).not.toThrow();
	});
});
