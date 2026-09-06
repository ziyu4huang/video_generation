/**
 * workspace-links.test.ts — the deploy preflight that repairs the bun
 * isolated-linker's dangling @repo workspace symlinks (found live twice on
 * 2026-09-06: full `bun install` runs rewrite the links with a root-layout
 * target `../../bun-apps/<pkg>`, which dangles from the real location; the
 * deploy vendor step then dies with ENOENT while `bun install` itself
 * reports "no changes").
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairWorkspaceLinks } from "../src/deploy/lib/workspace-links.ts";

function bunAppsWithLinks(links: Record<string, string | null>): string {
	const dir = mkdtempSync(join(tmpdir(), "ws-links-"));
	mkdirSync(join(dir, "s2-agent-ext-archify"), { recursive: true });
	mkdirSync(join(dir, "s2-agent-core-runtime"), { recursive: true });
	writeFileSync(join(dir, "s2-agent-ext-archify", "package.json"), "{}");
	mkdirSync(join(dir, "node_modules", "@repo"), { recursive: true });
	for (const [name, target] of Object.entries(links)) {
		if (target !== null) symlinkSync(target, join(dir, "node_modules", "@repo", name));
	}
	return dir;
}

describe("repairWorkspaceLinks", () => {
	test("repoints dangling links at ../../<pkg> and leaves healthy ones alone", () => {
		const dir = bunAppsWithLinks({
			// the broken shape bun's isolated linker writes (root-layout target)
			"s2-agent-ext-archify": "../../bun-apps/s2-agent-ext-archify",
			// already-correct link
			"s2-agent-core-runtime": "../../s2-agent-core-runtime",
		});
		const out = repairWorkspaceLinks(dir);
		expect(out.repaired).toEqual(["s2-agent-ext-archify"]);
		expect(out.healthy).toBe(1);
		// both now resolve to the real package dirs, via the correct target
		const { readlinkSync } = require("node:fs");
		expect(readlinkSync(join(dir, "node_modules/@repo/s2-agent-ext-archify"))).toBe("../../s2-agent-ext-archify");
		expect(readlinkSync(join(dir, "node_modules/@repo/s2-agent-core-runtime"))).toBe("../../s2-agent-core-runtime");
		rmSync(dir, { recursive: true, force: true });
	});

	test("a missing scope dir is a no-op, not a throw", () => {
		const dir = mkdtempSync(join(tmpdir(), "ws-links-empty-"));
		expect(repairWorkspaceLinks(dir)).toEqual({ repaired: [], healthy: 0 });
		rmSync(dir, { recursive: true, force: true });
	});
});
