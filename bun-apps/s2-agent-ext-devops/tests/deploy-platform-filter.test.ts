/**
 * crossos-deploy D5 (ticket 08) — the per-platform ext filter.
 *
 * filterForTarget is pure and owns ONE decision: an entry with a registry
 * `platforms` list ships only to targets on that list; an entry without the
 * field is portable and ships everywhere. The deploy pipeline uses the
 * shipped half for the build loop AND the tree's deploy.json expected set, so
 * per-tree Gate 3 / E2E counts come out per-tree, not registry-total.
 *
 * Also pins the live-registry fact (measured 2026-08-27): NO shipped entry
 * carries `platforms` today — every darwin-by-nature ext is already
 * deploy-excluded — so the filter is currently the identity. That assertion
 * is the tripwire that forces the first platform-bound SHIPPING ext to
 * update this file consciously.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { filterForTarget, shConfig, type ShExtConfig } from "../src/deploy/lib/config.ts";

const ext = (name: string, platforms?: string[]): ShExtConfig => ({
	name,
	package: `s2-agent-ext-${name}`,
	entry: `extensions/${name}.ts`,
	order: 10,
	skills: [],
	copy: [],
	vendor: [],
	assets: [],
	externals: [],
	vendorExclude: [],
	enabled: true,
	platforms,
});

describe("filterForTarget (pure, D5)", () => {
	test("portable entries (no platforms field) ship to every target", () => {
		for (const platform of ["darwin", "linux", "win32"]) {
			const r = filterForTarget([ext("task"), ext("obsidian")], platform);
			expect(r.shipped.map((e) => e.name)).toEqual(["task", "obsidian"]);
			expect(r.dropped).toEqual([]);
		}
	});

	test("a darwin-only entry drops from linux and win32 trees, stays on darwin", () => {
		const mlx = ext("mlx-runner", ["darwin"]);
		expect(filterForTarget([mlx], "darwin").shipped).toHaveLength(1);
		expect(filterForTarget([mlx], "darwin").dropped).toEqual([]);
		const linux = filterForTarget([mlx], "linux");
		expect(linux.shipped).toEqual([]);
		expect(linux.dropped).toEqual([{ name: "mlx-runner", package: "s2-agent-ext-mlx-runner", platforms: ["darwin"] }]);
		expect(filterForTarget([mlx], "win32").dropped).toHaveLength(1);
	});

	test("a multi-platform list ships to each listed platform only", () => {
		const dual = ext("posix-tool", ["darwin", "linux"]);
		expect(filterForTarget([dual], "linux").shipped).toHaveLength(1);
		expect(filterForTarget([dual], "win32").dropped).toHaveLength(1);
	});

	test("a deploy-disabled entry is neither shipped nor dropped-reported", () => {
		const disabled = { ...ext("off", ["darwin"]), enabled: false };
		const r = filterForTarget([disabled], "win32");
		expect(r.shipped).toEqual([]);
		expect(r.dropped).toEqual([]);
	});
});

describe("filterForTarget × the live registry", () => {
	test("MEASURED 2026-08-27: no shipped entry carries platforms — the filter is the identity today", () => {
		const cfg = shConfig({ bunAppsDir: join(import.meta.dir, "..", "..") });
		expect(cfg.extensions.some((e) => e.platforms !== undefined)).toBe(false);
		for (const platform of ["darwin", "linux", "win32"]) {
			const r = filterForTarget(cfg.extensions, platform);
			expect(r.shipped).toHaveLength(cfg.extensions.length);
			expect(r.dropped).toEqual([]);
		}
	});
});
