import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_MD, STANDALONE_QUICKSTART, writeAgentsMd } from "./agents-md.ts";

/** ext-standalone-import t03 — the dist AGENTS.md contract. */

const tmpDirs: string[] = [];

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "agents-md-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("AGENTS_MD content", () => {
	test("embeds the canonical quickstart verbatim (doc and E2E probe share one source)", () => {
		expect(AGENTS_MD).toContain(STANDALONE_QUICKSTART);
	});

	test("is version-agnostic — no version-pinned strings", () => {
		expect(AGENTS_MD).not.toMatch(/\d+\.\d+\.\d+/);
		expect(AGENTS_MD).not.toMatch(/0\.7\.|g[0-9a-f]{7,}/);
		expect(AGENTS_MD).toContain("current");
	});

	test("names the shim, the API surface, and the runtime fallback", () => {
		expect(AGENTS_MD).toContain("ext-standalone.mjs");
		expect(AGENTS_MD).toContain("loadExt");
		expect(AGENTS_MD).toContain("listExts");
		expect(AGENTS_MD).toContain("bin/bun");
	});
});

describe("writeAgentsMd", () => {
	test("writes when absent, is a no-op on identical content, rewrites on drift", () => {
		const outRoot = tmp();
		const first = writeAgentsMd(outRoot);
		expect(first.written).toBe(true);
		expect(existsSync(join(outRoot, "AGENTS.md"))).toBe(true);

		const second = writeAgentsMd(outRoot);
		expect(second.written).toBe(false);
		expect(second.bytes).toBe(first.bytes);

		// Drift (hand-edit or older deploy's wording) is repaired.
		const path = join(outRoot, "AGENTS.md");
		const before = readFileSync(path, "utf8");
		require("node:fs").writeFileSync(path, "stale content");
		const third = writeAgentsMd(outRoot);
		expect(third.written).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});
