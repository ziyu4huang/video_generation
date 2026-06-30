/**
 * A2.1 / A2.3 / A2.4 — atomic write, overwrite guard, cache invalidation.
 *   bun test extensions/__tests__/atomicWrite.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { atomicWriteFile, invalidateCache, readCached } from "../obsidian.ts";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => { vault = await makeFixture({ "note.md": "# Old\n" }); });
afterAll(async () => { await rmFixture(vault); });

describe("atomicWriteFile (A2.1)", () => {
	it("writes content to the target path", async () => {
		const p = join(vault, "new.md");
		await atomicWriteFile(p, "hello");
		expect(await readFile(p, "utf8")).toBe("hello");
	});

	it("overwrites an existing file", async () => {
		const p = join(vault, "note.md");
		await atomicWriteFile(p, "# Updated\n");
		expect(await readFile(p, "utf8")).toBe("# Updated\n");
	});

	it("leaves no .tmp file behind on success", async () => {
		const p = join(vault, "clean.md");
		await atomicWriteFile(p, "x");
		const files = await readdir(vault);
		expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	it("cleans up temp file on failure", async () => {
		const p = join(vault, "NOEXIST_DIR", "fail.md"); // parent missing → write fails
		await expect(atomicWriteFile(p, "x")).rejects.toThrow();
		const files = await readdir(vault).catch(() => []);
		// no stray tmp at vault root
		expect(files.some((f) => f.includes(".tmp"))).toBe(false);
	});
});

describe("readCached reflects writes after invalidateCache (A2.4)", () => {
	it("returns new content after write + invalidate", async () => {
		const p = join(vault, "cached.md");
		await writeFile(p, "v1", "utf8");
		let entry = await readCached(p);
		expect(entry?.content).toBe("v1");
		await writeFile(p, "v2", "utf8");
		// without invalidate, cache may still hold v1 (mtime-driven, but fs mtime
		// resolution may not tick — explicit invalidate is the contract)
		invalidateCache(p);
		entry = await readCached(p);
		expect(entry?.content).toBe("v2");
	});
});
