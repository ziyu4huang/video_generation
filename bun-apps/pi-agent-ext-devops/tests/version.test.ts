import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeVersion, listVersions, resolveTargetDir, swapCurrent } from "../scripts/lib/version.ts";
import { freezeTree, unfreezeTree } from "../scripts/lib/fs.ts";

const roots: string[] = [];
function makeRoot(): string {
	const d = mkdtempSync(join(tmpdir(), "sh-ver-"));
	roots.push(d);
	return d;
}
afterEach(() => {
	for (const r of roots.splice(0)) {
		unfreezeTree(r);
		rmSync(r, { recursive: true, force: true });
	}
});

describe("computeVersion", () => {
	test("appends the git short sha when enabled", () => {
		expect(computeVersion({ pkgVersion: "0.1.0", gitSha: "520acb928", useGitSha: true })).toBe("0.1.0+g520acb9");
	});

	test("omits the sha when disabled", () => {
		expect(computeVersion({ pkgVersion: "0.1.0", gitSha: "520acb928", useGitSha: false })).toBe("0.1.0");
	});

	test("omits the sha when git is unavailable", () => {
		expect(computeVersion({ pkgVersion: "0.1.0", gitSha: null, useGitSha: true })).toBe("0.1.0");
	});
});

describe("resolveTargetDir", () => {
	test("returns the version dir under the out root", () => {
		expect(resolveTargetDir("/out", "0.1.0+g520acb9")).toBe("/out/0.1.0+g520acb9");
	});

	test("rejects a version string with a path separator", () => {
		expect(() => resolveTargetDir("/out", "../escape")).toThrow(/version/);
		expect(() => resolveTargetDir("/out", "a/b")).toThrow(/version/);
	});
});

describe("swapCurrent", () => {
	test("creates the symlink when absent", () => {
		const root = makeRoot();
		mkdirSync(join(root, "1.0.0"));
		swapCurrent(root, "1.0.0");
		expect(readlinkSync(join(root, "current"))).toBe("1.0.0");
	});

	test("repoints an existing symlink", () => {
		const root = makeRoot();
		mkdirSync(join(root, "1.0.0"));
		mkdirSync(join(root, "2.0.0"));
		swapCurrent(root, "1.0.0");
		swapCurrent(root, "2.0.0");
		expect(readlinkSync(join(root, "current"))).toBe("2.0.0");
		expect(lstatSync(join(root, "current")).isSymbolicLink()).toBe(true);
	});

	test("refuses to replace a real directory named current", () => {
		const root = makeRoot();
		mkdirSync(join(root, "1.0.0"));
		mkdirSync(join(root, "current"));
		expect(() => swapCurrent(root, "1.0.0")).toThrow(/not a symlink/);
	});

	test("refuses to point at a version that does not exist", () => {
		const root = makeRoot();
		expect(() => swapCurrent(root, "9.9.9")).toThrow(/9\.9\.9/);
	});
});

describe("listVersions", () => {
	test("lists version dirs and the current target", () => {
		const root = makeRoot();
		mkdirSync(join(root, "1.0.0"));
		mkdirSync(join(root, "2.0.0"));
		swapCurrent(root, "2.0.0");
		expect(listVersions(root)).toEqual({ versions: ["1.0.0", "2.0.0"], current: "2.0.0" });
	});

	test("handles a missing out root", () => {
		expect(listVersions(join(makeRoot(), "absent"))).toEqual({ versions: [], current: null });
	});
});

describe("freezeTree / unfreezeTree", () => {
	test("freeze clears the write bits, unfreeze restores them", () => {
		const root = makeRoot();
		const sub = join(root, "ext", "alpha");
		mkdirSync(sub, { recursive: true });
		const file = join(sub, "ext.cjs");
		writeFileSync(file, "x");

		freezeTree(root);
		expect(statSync(file).mode & 0o222).toBe(0);

		unfreezeTree(root);
		expect(statSync(file).mode & 0o200).not.toBe(0);
		writeFileSync(file, "y"); // must not throw
		expect(existsSync(file)).toBe(true);
	});
});
