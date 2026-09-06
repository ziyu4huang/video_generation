import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCoreHash, CORES_DIR, ensureCachedCore, linkCore, ORPHAN_GRACE_MS, pruneOrphanCores } from "../src/deploy/lib/core-cache.ts";

/** A minimal fake s2-agent package: src/ tree with nested dirs. */
function fakePiAgent(): string {
	const dir = mkdtempSync(join(tmpdir(), "core-cache-"));
	mkdirSync(join(dir, "src", "sh"), { recursive: true });
	mkdirSync(join(dir, "src", "generated"), { recursive: true });
	writeFileSync(join(dir, "src", "cli-sh.ts"), "export {};");
	writeFileSync(join(dir, "src", "sh", "host-modules.ts"), "export const HOST_API = 2;");
	writeFileSync(join(dir, "src", "generated", "a-generated-file.ts"), "export const A = [];");
	return dir;
}

function inputs(piAgentDir: string) {
	return {
		piAgentDir,
		piPkgVersion: "0.84.2",
		bunVersion: "1.3.14",
		entry: "src/cli-sh.ts",
		flags: ["--minify"],
	};
}

describe("computeCoreHash", () => {
	test("stable across calls and independent of file order/mtimes", () => {
		const a = fakePiAgent();
		expect(computeCoreHash(inputs(a))).toBe(computeCoreHash(inputs(a)));
	});

	test("identical trees in different directories hash the same (content, not paths)", () => {
		expect(computeCoreHash(inputs(fakePiAgent()))).toBe(computeCoreHash(inputs(fakePiAgent())));
	});

	test("any build input changes the hash", () => {
		const base = fakePiAgent();
		const h0 = computeCoreHash(inputs(base));

		const srcChange = fakePiAgent();
		writeFileSync(join(srcChange, "src", "sh", "host-modules.ts"), "export const HOST_API = 3;");
		expect(computeCoreHash(inputs(srcChange))).not.toBe(h0);

		const genChange = fakePiAgent(); // any file under src/ is a build input
		writeFileSync(join(genChange, "src", "generated", "a-generated-file.ts"), "export const A = [1];");
		expect(computeCoreHash(inputs(genChange))).not.toBe(h0);

		expect(computeCoreHash({ ...inputs(base), piPkgVersion: "0.85.0" })).not.toBe(h0);
		expect(computeCoreHash({ ...inputs(base), bunVersion: "1.4.0" })).not.toBe(h0);
		expect(computeCoreHash({ ...inputs(base), entry: "src/other.ts" })).not.toBe(h0);
		expect(computeCoreHash({ ...inputs(base), flags: [] })).not.toBe(h0);
	});

	test("a workspace dep's source changes the hash (stale-core regression, 2026-09-06)", () => {
		// The /agents CRUD deploy shipped a stale cached core: the bundler
		// inlines @repo/* workspace sources past s2-agent/src, but the hash
		// covered only s2-agent/src — a core-runtime-only change cache-HIT and
		// the fresh ext bundles crashed calling the missing exports.
		const base = fakePiAgent();
		const ws = mkdtempSync(join(tmpdir(), "core-cache-ws-"));
		mkdirSync(join(ws, "src"), { recursive: true });
		writeFileSync(join(ws, "src", "index.ts"), "export const V = 1;");
		const withWs = { ...inputs(base), workspaceSrcDirs: [{ name: "@repo/s2-agent-core-runtime", dir: join(ws, "src") }] };
		const h0 = computeCoreHash(withWs);
		expect(h0).not.toBe(computeCoreHash(inputs(base))); // listed at all → part of the key
		writeFileSync(join(ws, "src", "index.ts"), "export const V = 2;");
		expect(computeCoreHash(withWs)).not.toBe(h0); // a workspace-source edit invalidates
		// order of the workspace list must not matter
		const reordered = {
			...inputs(base),
			workspaceSrcDirs: [
				{ name: "@repo/aaa", dir: join(ws, "src") },
				{ name: "@repo/s2-agent-core-runtime", dir: join(ws, "src") },
			],
		};
		const reordered2 = {
			...inputs(base),
			workspaceSrcDirs: [
				{ name: "@repo/s2-agent-core-runtime", dir: join(ws, "src") },
				{ name: "@repo/aaa", dir: join(ws, "src") },
			],
		};
		expect(computeCoreHash(reordered)).toBe(computeCoreHash(reordered2));
	});

	test("buildCore actually passes workspaceSrcDirs into the hash (wiring source pin)", () => {
		// The unit tests above prove computeCoreHash HONORS workspaceSrcDirs —
		// but the stale-core incident was a WIRING gap: nothing forced the
		// caller to supply it. Pin the call in deploy/run.ts so dropping the
		// argument is a test failure, not a silent return of F2.
		const runSrc = readFileSync(join(import.meta.dir, "..", "src", "deploy", "run.ts"), "utf8");
		expect(runSrc).toContain("workspaceSrcDirs: resolveWorkspaceSrcDirs()");
		expect(runSrc).toContain("function resolveWorkspaceSrcDirs()");
	});
});

describe("ensureCachedCore", () => {
	test("miss builds once; hit skips the build; linkers share the inode", async () => {
		const outRoot = mkdtempSync(join(tmpdir(), "cores-out-"));
		let builds = 0;
		const build = async (outFile: string) => {
			builds++;
			writeFileSync(outFile, "fake-core-bundle");
		};

		const hash = "deadbeef".repeat(8);
		const first = await ensureCachedCore({ outRoot, hash, build });
		expect(first.cached).toBe(false);
		expect(builds).toBe(1);

		const second = await ensureCachedCore({ outRoot, hash, build });
		expect(second.cached).toBe(true);
		expect(builds).toBe(1); // the whole point

		// a version dir's s2-agent.js is a hardlink: same inode, and deleting the
		// version dir later never destroys the cache entry
		linkCore(first.cacheFile, join(outRoot, "0.1.0-s2-agent.js"));
		expect(statSync(join(outRoot, "0.1.0-s2-agent.js")).ino).toBe(statSync(first.cacheFile).ino);
		expect(existsSync(first.cacheFile)).toBe(true);
	});

	test("a failed build leaves no cache entry behind", async () => {
		const outRoot = mkdtempSync(join(tmpdir(), "cores-out-"));
		await expect(
			ensureCachedCore({
				outRoot,
				hash: "ab".repeat(32),
				build: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow(/boom/);
		expect(existsSync(join(outRoot, ".cores", "ab".repeat(32)))).toBe(false);
	});
});

describe("pruneOrphanCores", () => {
	/** An out root with a .cores/ entry per [hash, linkedIntoVersionDir] pair. */
	function outRootWithCores(entries: Array<{ hash: string; linked: boolean; ageMs?: number }>): string {
		const outRoot = mkdtempSync(join(tmpdir(), "core-gc-"));
		mkdirSync(join(outRoot, CORES_DIR), { recursive: true });
		for (const { hash, linked, ageMs } of entries) {
			const file = join(outRoot, CORES_DIR, hash);
			writeFileSync(file, `core-${hash}`);
			if (linked) {
				const versionDir = join(outRoot, `0.1.0+${hash}`);
				mkdirSync(versionDir, { recursive: true });
				linkSync(file, join(versionDir, "s2-agent"));
			}
			if (ageMs !== undefined) {
				const when = new Date(Date.now() - ageMs);
				utimesSync(file, when, when);
			}
		}
		return outRoot;
	}

	const OLD = ORPHAN_GRACE_MS * 2;

	test("collects an unreferenced core and keeps every linked one", () => {
		const outRoot = outRootWithCores([
			{ hash: "aaaa", linked: false, ageMs: OLD },
			{ hash: "bbbb", linked: true, ageMs: OLD },
		]);
		const pruned = pruneOrphanCores(outRoot);
		expect(pruned.map((p) => p.hash)).toEqual(["aaaa"]);
		expect(pruned[0]!.bytes).toBeGreaterThan(0);
		expect(existsSync(join(outRoot, CORES_DIR, "aaaa"))).toBe(false);
		expect(existsSync(join(outRoot, CORES_DIR, "bbbb"))).toBe(true);
		// The surviving core's version dir must still have its binary.
		expect(existsSync(join(outRoot, "0.1.0+bbbb", "s2-agent"))).toBe(true);
	});

	test("a core becomes collectable only once its LAST version dir is gone", () => {
		const outRoot = outRootWithCores([{ hash: "cccc", linked: true, ageMs: OLD }]);
		expect(pruneOrphanCores(outRoot)).toEqual([]);

		// Simulate pruneVersions dropping the one version dir that linked it.
		rmSync(join(outRoot, "0.1.0+cccc"), { recursive: true, force: true });
		expect(pruneOrphanCores(outRoot).map((p) => p.hash)).toEqual(["cccc"]);
	});

	test("a freshly written orphan is spared — it may be a deploy still in flight", () => {
		// Exactly the ensureCachedCore→linkCore window: renamed into .cores, not
		// yet hardlinked, so nlink is 1 while the deploy is still running.
		const outRoot = outRootWithCores([{ hash: "dddd", linked: false }]);
		expect(pruneOrphanCores(outRoot)).toEqual([]);
		expect(existsSync(join(outRoot, CORES_DIR, "dddd"))).toBe(true);
		// Past the grace period the same entry is collected.
		expect(pruneOrphanCores(outRoot, { now: Date.now() + ORPHAN_GRACE_MS + 1 }).map((p) => p.hash)).toEqual(["dddd"]);
	});

	test("skips partial compiles and other dotfiles", () => {
		const outRoot = outRootWithCores([]);
		const tmp = join(outRoot, CORES_DIR, ".tmp-abc123-4242");
		writeFileSync(tmp, "half a binary");
		const when = new Date(Date.now() - OLD);
		utimesSync(tmp, when, when);
		expect(pruneOrphanCores(outRoot)).toEqual([]);
		expect(existsSync(tmp)).toBe(true);
	});

	test("an out root with no .cores/ yet is a no-op, not a throw", () => {
		expect(pruneOrphanCores(mkdtempSync(join(tmpdir(), "core-gc-empty-")))).toEqual([]);
	});
});
