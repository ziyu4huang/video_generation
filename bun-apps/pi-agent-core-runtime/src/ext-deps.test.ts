/**
 * The regression this file exists for: a deployed extension dir is an ordinary
 * path with no node_modules above it, so a layout-walking probe reports every
 * host-provided dependency as missing. The "deployed" cases below are the ones
 * that were absent when obsidian shipped into the sh base set (#1738) and
 * printed a red "missing npm packages" error on every start.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findWorkspaceRoot,
	isDeployedExtDir,
	missingExtDeps,
	packageBaseName,
} from "./ext-deps.js";

const DEP = "@earendil-works/pi-coding-agent";

/** A throwaway `<root>/ext/<name>/` that looks exactly like a deployed one. */
function deployedExtDir(manifest: unknown): string {
	const dir = join(mkdtempSync(join(tmpdir(), "ext-deps-")), "ext", "obsidian");
	mkdirSync(dir, { recursive: true });
	if (manifest !== undefined) writeFileSync(join(dir, "ext.json"), JSON.stringify(manifest));
	return dir;
}

describe("packageBaseName", () => {
	test("keeps both segments of a scoped name, drops any deep path", () => {
		expect(packageBaseName("@scope/pkg")).toBe("@scope/pkg");
		expect(packageBaseName("@scope/pkg/sub/deep")).toBe("@scope/pkg");
		expect(packageBaseName("pkg")).toBe("pkg");
		expect(packageBaseName("pkg/sub")).toBe("pkg");
	});
});

describe("isDeployedExtDir", () => {
	test("an ext.json declaring a numeric hostApi is the deploy's signature", () => {
		expect(isDeployedExtDir(deployedExtDir({ name: "obsidian", hostApi: 2 }))).toBe(true);
	});

	test("no ext.json at all — a source checkout", () => {
		expect(isDeployedExtDir(deployedExtDir(undefined))).toBe(false);
	});

	test("an ext.json without hostApi is not the deploy's manifest", () => {
		// Presence alone would be too weak a signal to hang the whole check on.
		expect(isDeployedExtDir(deployedExtDir({ name: "something-else" }))).toBe(false);
	});

	test("unparseable ext.json is not treated as a deploy", () => {
		const dir = deployedExtDir(undefined);
		writeFileSync(join(dir, "ext.json"), "{ not json");
		expect(isDeployedExtDir(dir)).toBe(false);
	});
});

describe("missingExtDeps", () => {
	test("a deployed extension reports nothing — its deps were settled at build time", () => {
		// THE BUG. Before the fix this returned [DEP]: the walk climbs out of
		// <root>/ext/obsidian to / without ever meeting a node_modules.
		expect(missingExtDeps([DEP], deployedExtDir({ hostApi: 2 }))).toEqual([]);
	});

	test("a compiled binary reports nothing — deps are inlined", () => {
		expect(missingExtDeps([DEP], "/$bunfs/root")).toEqual([]);
		expect(missingExtDeps([DEP], "/~BUN/root")).toEqual([]);
		expect(missingExtDeps([DEP], "/%7EBUN/root")).toEqual([]);
	});

	test("an undetermined dir reports nothing rather than guessing", () => {
		expect(missingExtDeps([DEP], undefined)).toEqual([]);
	});

	test("source mode still finds an installed dep by walking up", () => {
		expect(missingExtDeps([DEP], import.meta.dir)).toEqual([]);
	});

	test("source mode still REPORTS a genuinely absent dep", () => {
		// The falsification case: without it every assertion above is satisfied
		// by a function that returns [] unconditionally.
		const dir = deployedExtDir(undefined);
		expect(missingExtDeps(["@nobody/nothing-here"], dir)).toEqual(["@nobody/nothing-here"]);
	});

	test("a deep specifier resolves against its package root", () => {
		expect(missingExtDeps(["typebox/value"], import.meta.dir)).toEqual([]);
	});
});

describe("findWorkspaceRoot", () => {
	test("finds the bun-apps workspace root from inside this package", () => {
		expect(findWorkspaceRoot(import.meta.dir)).toMatch(/bun-apps$/);
	});

	test("falls back to a literal when there is no workspace above", () => {
		expect(findWorkspaceRoot(undefined)).toBe("(repo root)");
		expect(findWorkspaceRoot(deployedExtDir({ hostApi: 2 }))).toBe("(repo root)");
	});
});
