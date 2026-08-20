import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_KEEP, computeVersion, listVersions, pruneVersions, resolveTargetDir, swapCurrent } from "../scripts/lib/version.ts";
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
	test("freeze clears write bits; unfreeze reopens DIRECTORIES only (hardlink-safe)", () => {
		const root = makeRoot();
		const sub = join(root, "ext", "alpha");
		mkdirSync(sub, { recursive: true });
		const file = join(sub, "ext.cjs");
		writeFileSync(file, "x");

		freezeTree(root);
		expect(statSync(file).mode & 0o222).toBe(0);
		expect(statSync(sub).mode & 0o200).toBe(0);

		unfreezeTree(root);
		// directories regain u+w — enough to unlink or reorganise inside the
		// tree — while FILES stay a-w: the version dir's core is a hardlink
		// into .cores, and chmod-ing it through one link would re-mode every
		// version sharing the inode.
		expect(statSync(sub).mode & 0o200).not.toBe(0);
		expect(statSync(file).mode & 0o200).toBe(0);
		rmSync(file); // unlink needs the parent dir's write bit, not the file's
		expect(existsSync(file)).toBe(false);
	});
});

describe("pruneVersions", () => {
	/** A fake version dir with a controlled mtime (deploy time). */
	function makeVersion(root: string, v: string, ageMs: number): string {
		const dir = join(root, v);
		mkdirSync(dir);
		writeFileSync(join(dir, "s2-agent"), "core");
		const at = new Date(ageMs);
		utimesSync(join(dir, "s2-agent"), at, at);
		utimesSync(dir, at, at);
		return dir;
	}
	const T0 = Date.now() - 10 * 60_000;

	test("prunes oldest-first down to keep, never the current target", () => {
		const root = makeRoot();
		for (let i = 1; i <= 4; i++) makeVersion(root, `v${i}`, T0 + i * 1000);
		swapCurrent(root, "v4");
		const pruned = pruneVersions(root, { keep: 2 });
		expect(pruned).toEqual(["v1", "v2"]);
		expect(listVersions(root).versions).toEqual(["v3", "v4"]);
	});

	test("a current target outside the newest keep still survives (keep+1)", () => {
		const root = makeRoot();
		for (let i = 1; i <= 4; i++) makeVersion(root, `v${i}`, T0 + i * 1000);
		swapCurrent(root, "v1"); // current is the OLDEST
		const pruned = pruneVersions(root, { keep: 2 });
		expect(pruned).toEqual(["v2", "v3"]);
		expect(listVersions(root)).toEqual({ versions: ["v1", "v4"], current: "v1" });
	});

	test("never drops below keep — nothing pruned when already within budget", () => {
		const root = makeRoot();
		for (let i = 1; i <= 3; i++) makeVersion(root, `v${i}`, T0 + i * 1000);
		swapCurrent(root, "v3");
		expect(pruneVersions(root, { keep: 5 })).toEqual([]);
		expect(existsSync(join(root, "v1"))).toBe(true);
	});

	test("pruning removes only unlinks — a hardlinked core's other links keep it alive", () => {
		const root = makeRoot();
		const coreA = join(root, "v1", "s2-agent");
		for (let i = 1; i <= 3; i++) makeVersion(root, `v${i}`, T0 + i * 1000);
		linkSync(coreA, join(root, "v2", "s2-agent-clone")); // simulate the .cores link
		swapCurrent(root, "v3");
		pruneVersions(root, { keep: 2 }); // only v1 (oldest) goes
		expect(existsSync(coreA)).toBe(false); // v1 pruned — its link to the bytes is unlinked
		expect(existsSync(join(root, "v2", "s2-agent-clone"))).toBe(true); // sibling link intact
	});

	test("DEFAULT_KEEP is a sane positive integer", () => {
		expect(Number.isInteger(DEFAULT_KEEP) && DEFAULT_KEEP >= 1).toBe(true);
	});
});
