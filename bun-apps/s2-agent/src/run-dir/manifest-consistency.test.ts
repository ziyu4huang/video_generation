/**
 * manifest.json ↔ package.json ↔ static-extensions.ts must agree.
 *
 * WHY THIS EXISTS
 * ---------------
 * The static-extension count had drifted independently in SIX places —
 * CONTEXT.md said 5, README said 10, one deploy doc said 10,
 * two PRDs said 12, and
 * .github/workflows/ci.yml.disabled asserted `len(statics) == 13` — while the
 * code had 14. Six independent drifts is the evidence that restating a number
 * in prose does not work; a seventh correction would not have been a fix.
 *
 * Separately, six registered extension packages (btw, webui, tool-gate, devops,
 * zai-mcp, archify) were absent from s2-agent's package.json dependencies. That
 * works today only because static-extensions.ts imports by RELATIVE path,
 * bypassing package resolution entirely — but it puts a hole in
 * `assertWorkspaceDeps()` (which iterates declared deps) exactly where the
 * static set is, and it means CI's dependency-graph test routing does not
 * schedule s2-agent's suite when webui or btw change, even though their code is
 * inlined into s2-agent's binary.
 *
 * So: assert set EQUALITY against the manifest, never a literal count.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "./manifest.json";
import { parseManifestEntries } from "./manifest-types.ts";
import { STATIC_EXTENSION_FACTORIES } from "../static-extensions.ts";
import { buildStaticExtensionsSource } from "../static-extensions-gen.ts";

const PKG_DIR = join(import.meta.dir, "..", "..");
const BUN_APPS = join(PKG_DIR, "..");

const pkgJson = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

const declaredRepoDeps = new Set(
	Object.keys({
		...pkgJson.dependencies,
		...pkgJson.devDependencies,
		...pkgJson.peerDependencies,
	}).filter((d) => d.startsWith("@repo/")),
);

/** Package dir → the `@repo/<name>` specifier s2-agent would declare for it. */
const specifierFor = (dir: string) => `@repo/${dir}`;

const dynamicDirs = parseManifestEntries(manifest.extensions ?? []).map(
	(e) => e.entry.split("/")[0]!,
);
const staticDirs = [...(manifest.staticExtensions ?? [])];
const skillDirs = [...(manifest.skills ?? [])].map((rel) => rel.split("/")[0]!);

describe("staticExtensions ↔ STATIC_EXTENSION_FACTORIES", () => {
	test("the two sets are equal (no hardcoded count anywhere)", () => {
		const fromCode = STATIC_EXTENSION_FACTORIES.map((f) => f.name).sort();
		expect([...staticDirs].sort()).toEqual(fromCode);
	});

	test("order matches — it is load order, and subagent must precede workflow", () => {
		// static-extensions.ts documents the constraint: workflow's /subagents
		// viewer reads a registry subagent populates. A manifest reordering that
		// silently diverged from the code would break that invisibly.
		expect(staticDirs).toEqual(STATIC_EXTENSION_FACTORIES.map((f) => f.name));
		// With static-extensions.ts GENERATED from this manifest, the equality
		// above compares one source with itself — it can no longer catch a
		// reorder. Assert the invariant against the manifest array directly.
		const idx = (dir: string) => staticDirs.indexOf(dir);
		expect(idx("s2-agent-ext-subagent")).toBeLessThan(idx("s2-agent-ext-ultracode"));
	});

	test("no package is registered both statically and dynamically", () => {
		const both = staticDirs.filter((d) => dynamicDirs.includes(d));
		expect(both).toEqual([]);
	});

	test("static-extensions.ts is exactly the generated output (byte-for-byte)", () => {
		// The set/order equality tests above catch membership drift; this catches
		// HAND drift — editing static-extensions.ts directly (a renamed binding, a
		// moved comment) leaves the two files agreeing on membership while the
		// generator can no longer reproduce the file. The manifest is the only
		// edit point: run `bun run regen:static` (bun-apps/s2-agent).
		const generated = buildStaticExtensionsSource({
			staticExtensions: manifest.staticExtensions ?? [],
		});
		const onDisk = readFileSync(join(PKG_DIR, "src", "static-extensions.ts"), "utf8");
		expect(onDisk).toBe(generated);
	});
});

describe("every manifest-referenced skill exists on disk", () => {
	// Package dirs + extension entry files are covered pre-generation by
	// registry-config.test.ts ("every entry's package dir and entry file exist
	// on disk", asserted over REGISTRY directly), and registry-freshness
	// proves manifest.json is byte-generated from that registry — so those two
	// loops here were transitively equal (dedup 2026-08-25, round-2 ticket 03).
	// Skill paths are a separate manifest field with NO other cover — kept.
	for (const rel of manifest.skills ?? []) {
		test(`${rel} exists`, () => {
			expect(existsSync(join(BUN_APPS, rel))).toBe(true);
		});
	}
});

describe("every registered extension is a declared workspace dependency", () => {
	// The old deploy doc's "adding a static extension" procedure says
	// to do BOTH the manifest and the package.json edge. Only the manifest half
	// was being done.
	const registered = [...new Set([...dynamicDirs, ...staticDirs])];

	for (const dir of registered) {
		test(`${specifierFor(dir)} is declared in s2-agent/package.json`, () => {
			expect(declaredRepoDeps.has(specifierFor(dir))).toBe(true);
		});
	}
});

describe("declared-but-unenforced manifest fields", () => {
	test("the manifest declares no field the builder does not honour", () => {
		// bundleMode/fullReason/testGate died with FULL mode (Phase 1b) and left
		// the generated manifest in Phase 2a; Phase 2b removed them from the
		// TYPE too. Pin that they never come back — a manifest declaring fields
		// nothing reads is exactly the silent-drift class this describe guards.
		const RETIRED = ["bundleMode", "fullReason", "testGate"] as const;
		const offenders = (manifest.extensions ?? [])
			.filter((e) => typeof e === "object")
			.flatMap((e) => RETIRED.filter((k) => k in (e as object)));
		expect(offenders).toEqual([]);
	});
});
