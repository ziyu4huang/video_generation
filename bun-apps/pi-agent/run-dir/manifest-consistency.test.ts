/**
 * manifest.json ↔ package.json ↔ static-extensions.ts must agree.
 *
 * WHY THIS EXISTS
 * ---------------
 * The static-extension count had drifted independently in SIX places —
 * CONTEXT.md said 5, README said 10, deploy-single-binary.md said 10,
 * extension-dependency-tree.PRD.md said 12, PRD.md said 12, and
 * .github/workflows/ci.yml.disabled asserted `len(statics) == 13` — while the
 * code had 14. Six independent drifts is the evidence that restating a number
 * in prose does not work; a seventh correction would not have been a fix.
 *
 * Separately, six registered extension packages (btw, webui, tool-gate, devops,
 * zai-mcp, archify) were absent from pi-agent's package.json dependencies. That
 * works today only because static-extensions.ts imports by RELATIVE path,
 * bypassing package resolution entirely — but it puts a hole in
 * `assertWorkspaceDeps()` (which iterates declared deps) exactly where the
 * static set is, and it means CI's dependency-graph test routing does not
 * schedule pi-agent's suite when webui or btw change, even though their code is
 * inlined into pi-agent's binary.
 *
 * So: assert set EQUALITY against the manifest, never a literal count.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "./manifest.json";
import { parseManifestEntries } from "./manifest-types.ts";
import { STATIC_EXTENSION_FACTORIES } from "../src/static-extensions.ts";

const PKG_DIR = join(import.meta.dir, "..");
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

/** Package dir → the `@repo/<name>` specifier pi-agent would declare for it. */
const specifierFor = (dir: string) => `@repo/${dir}`;

const dynamicDirs = parseManifestEntries(manifest.extensions ?? []).map(
	(e) => e.entry.split("/")[0]!,
);
const staticDirs = [...(manifest.staticExtensions ?? [])];
const skillDirs = [
	...(manifest.skills ?? []),
	...(manifest.binarySkills ?? []),
].map((rel) => rel.split("/")[0]!);

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
	});

	test("no package is registered both statically and dynamically", () => {
		const both = staticDirs.filter((d) => dynamicDirs.includes(d));
		expect(both).toEqual([]);
	});
});

describe("every manifest-referenced package exists on disk", () => {
	const allDirs = [...new Set([...dynamicDirs, ...staticDirs, ...skillDirs])];

	for (const dir of allDirs) {
		test(`${dir}/ exists`, () => {
			expect(existsSync(join(BUN_APPS, dir))).toBe(true);
		});
	}

	for (const entry of parseManifestEntries(manifest.extensions ?? [])) {
		test(`${entry.entry} is a real file`, () => {
			expect(existsSync(join(BUN_APPS, entry.entry))).toBe(true);
		});
	}

	for (const rel of [...(manifest.skills ?? []), ...(manifest.binarySkills ?? [])]) {
		test(`${rel} exists`, () => {
			expect(existsSync(join(BUN_APPS, rel))).toBe(true);
		});
	}
});

describe("every registered extension is a declared workspace dependency", () => {
	// docs/deploy-single-binary.md's "adding a static extension" procedure says
	// to do BOTH the manifest and the package.json edge. Only the manifest half
	// was being done.
	const registered = [...new Set([...dynamicDirs, ...staticDirs])];

	for (const dir of registered) {
		test(`${specifierFor(dir)} is declared in pi-agent/package.json`, () => {
			expect(declaredRepoDeps.has(specifierFor(dir))).toBe(true);
		});
	}
});

describe("binarySkills is a subset of skills", () => {
	test("a binary-embedded skill dir is also loaded in source/bundle mode", () => {
		const skills = new Set(manifest.skills ?? []);
		const orphans = (manifest.binarySkills ?? []).filter((s) => !skills.has(s));
		expect(orphans).toEqual([]);
	});
});

describe("declared-but-unenforced manifest fields", () => {
	test("bundleMode is only ever a value the builder actually honours", () => {
		// build-extensions.ts is thin-only by construction and never reads
		// bundleMode. A manifest declaring "full" was silently built thin — the
		// exact silent-drift the FULL mode was removed to avoid. Until the field
		// is either wired or dropped, pin that nothing uses the unhandled values.
		const unsupported = parseManifestEntries(manifest.extensions ?? [])
			.map((e) => e.bundleMode)
			.filter((m) => m !== undefined && m !== "thin");
		expect(unsupported).toEqual([]);
	});

	test("testGate commands do not use a top-level `cd`", () => {
		// The repo's no-cd-drift.sh hook blocks that form, so any runner wired to
		// these strings later would have them rejected.
		const gates = parseManifestEntries(manifest.extensions ?? [])
			.map((e) => (e as { testGate?: string }).testGate)
			.filter((g): g is string => typeof g === "string");
		const offenders = gates.filter((g) => /^\s*cd\s/.test(g));
		expect(offenders).toEqual([]);
	});
});
