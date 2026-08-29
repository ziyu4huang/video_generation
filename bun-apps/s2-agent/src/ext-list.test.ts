/**
 * Tests for the dev-mode `--ext-list` report (src/ext-list.ts) — the twin of
 * sh/ext-list.test.ts. The contract under test is the PARITY one: dev and the
 * sh launcher must answer the same JSON payload (same formatExtList), with the
 * dev half derived from the REGISTRY instead of ext/ manifests, so the deploy
 * E2E's parse (loaded/loadedCount) can never drift between modes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devExtListResult } from "./ext-list.ts";
import { formatExtList } from "./sh/ext-list.ts";
import { REGISTRY, type RegistryEntry } from "./registry-config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// <pkg>/src/ → up two levels is the bun-apps/ workspace root.
const BUN_APPS = join(__dirname, "..", "..");

/** Minimal registry row factory (defaults mirror a plain enabled dynamic ext). */
function row(over: Partial<RegistryEntry> & Pick<RegistryEntry, "name" | "package" | "entry">): RegistryEntry {
	return { load: "dynamic", enabled: true, ...over };
}

const REG = [
	row({ name: "task", package: "s2-agent-ext-task", entry: "extensions/task.ts", load: "static", skills: true }),
	row({ name: "gone", package: "s2-agent-ext-gone", entry: "extensions/gone.ts", enabled: false }),
	row({ name: "missing", package: "s2-agent-ext-missing", entry: "extensions/missing.ts" }),
	row({ name: "devops", package: "s2-agent-ext-devops", entry: "extensions/devops.ts", skills: true }),
];

/** exists() that knows only the two healthy rows' entry/skill paths. */
function exists(p: string): boolean {
	return (
		p === join("/apps", "s2-agent-ext-task", "extensions/task.ts") ||
		p === join("/apps", "s2-agent-ext-task", "skills") ||
		p === join("/apps", "s2-agent-ext-devops", "extensions/devops.ts") ||
		p === join("/apps", "s2-agent-ext-devops", "skills")
	);
}

describe("devExtListResult (pure projection)", () => {
	test("loaded = enabled entries whose entry file exists; disabled and missing are skipped with reasons", () => {
		const r = devExtListResult({ bunAppsDir: "/apps", registry: REG, exists, userFlags: {} });
		expect(r.loaded).toEqual(["task", "devops"]); // registry order, static first
		expect(r.skipped).toEqual([
			{ name: "gone", reason: "disabled in registry" },
			{
				name: "missing",
				reason: `extension path not found, skipping: ${join("/apps", "s2-agent-ext-missing", "extensions/missing.ts")}`,
			},
		]);
	});

	test("skills:true entries contribute existing skill dirs, in registry order", () => {
		const r = devExtListResult({ bunAppsDir: "/apps", registry: REG, exists, userFlags: {} });
		expect(r.skillPaths).toEqual([
			join("/apps", "s2-agent-ext-task", "skills"),
			join("/apps", "s2-agent-ext-devops", "skills"),
		]);
	});

	test("-ne → empty report (mirrors cli-sh's suppressed loader)", () => {
		const r = devExtListResult({
			bunAppsDir: "/apps",
			registry: REG,
			exists,
			userFlags: { noExtensions: true },
		});
		expect(r).toEqual({ factories: [], skillPaths: [], loaded: [], skipped: [] });
	});

	test("-ns drops skill paths but keeps extensions", () => {
		const r = devExtListResult({
			bunAppsDir: "/apps",
			registry: REG,
			exists,
			userFlags: { noSkills: true },
		});
		expect(r.loaded).toEqual(["task", "devops"]);
		expect(r.skillPaths).toEqual([]);
	});

	test("unresolved bun-apps dir → a single '*' skip, nothing loaded (mirrors the run-dir warn)", () => {
		const r = devExtListResult({ bunAppsDir: undefined, registry: REG, exists, userFlags: {} });
		expect(r.loaded).toEqual([]);
		expect(r.skillPaths).toEqual([]);
		expect(r.skipped).toEqual([{ name: "*", reason: "could not determine bun-apps/ directory" }]);
	});
});

describe("payload parity with sh/ext-list (the deploy E2E contract)", () => {
	test("formatExtList over the real registry parses with every field the fake asserts on", () => {
		const r = devExtListResult({
			bunAppsDir: BUN_APPS,
			registry: REGISTRY,
			exists: existsSync,
			userFlags: {},
		});
		const parsed = JSON.parse(formatExtList(BUN_APPS, 2, r));
		// The exact keys sh/ext-list.test.ts pins + the deploy E2E fake reads.
		expect(Object.keys(parsed).sort()).toEqual(
			["extRoot", "hostApi", "loaded", "loadedCount", "skillPaths", "skipped"].sort(),
		);
		expect(parsed.loadedCount).toBe(parsed.loaded.length);
		expect(Array.isArray(parsed.skipped)).toBe(true);
		expect(parsed.hostApi).toBe(2);
		expect(parsed.extRoot).toBe(BUN_APPS);
	});

	test("against THIS worktree every enabled registry entry reports loaded (this repo is fully checked out)", () => {
		const r = devExtListResult({
			bunAppsDir: BUN_APPS,
			registry: REGISTRY,
			exists: existsSync,
			userFlags: {},
		});
		const enabled = REGISTRY.filter((e) => e.enabled);
		expect(r.loaded.sort()).toEqual(enabled.map((e) => e.name).sort());
		// Disabled entries are VALUES, not deletions (registry D2): they must be
		// visible in skipped, not silently absent.
		expect(r.skipped.map((s) => s.name).sort()).toEqual(
			REGISTRY.filter((e) => !e.enabled).map((e) => e.name).sort(),
		);
	});

	test("loaded names are unique (a dup would double-register in the report and mask drift)", () => {
		const r = devExtListResult({
			bunAppsDir: BUN_APPS,
			registry: REGISTRY,
			exists: existsSync,
			userFlags: {},
		});
		expect(new Set(r.loaded).size).toBe(r.loaded.length);
	});
});
