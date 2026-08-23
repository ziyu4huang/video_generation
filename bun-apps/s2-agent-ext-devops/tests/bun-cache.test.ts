import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUNS_DIR,
	computeBunHash,
	ensureCachedBun,
	linkBun,
	ORPHAN_GRACE_MS,
	pruneOrphanBuns,
} from "../src/deploy/lib/bun-cache.ts";

describe("computeBunHash", () => {
	test("keys on version+platform+arch — the runtime identity", () => {
		const base = computeBunHash({ bunVersion: "1.4.0", platform: "darwin", arch: "arm64" });
		expect(computeBunHash({ bunVersion: "1.4.1", platform: "darwin", arch: "arm64" })).not.toBe(base);
		expect(computeBunHash({ bunVersion: "1.4.0", platform: "linux", arch: "arm64" })).not.toBe(base);
		expect(computeBunHash({ bunVersion: "1.4.0", platform: "darwin", arch: "x64" })).not.toBe(base);
		expect(computeBunHash({ bunVersion: "1.4.0", platform: "darwin", arch: "arm64" })).toBe(base);
	});
});

describe("ensureCachedBun", () => {
	test("miss copies this process's bun once; hit skips the copy; linkers share the inode", () => {
		const outRoot = mkdtempSync(join(tmpdir(), "buns-out-"));
		const first = ensureCachedBun({ outRoot });
		expect(first.cached).toBe(false);
		expect(first.bytes).toBeGreaterThan(1_000_000); // a real bun, not a stub
		expect(existsSync(join(outRoot, BUNS_DIR))).toBe(true);

		const second = ensureCachedBun({ outRoot });
		expect(second.cached).toBe(true); // the whole point: no second 63 MB copy
		expect(second.cacheFile).toBe(first.cacheFile);

		// a version dir's bin/bun is a hardlink: same inode, and deleting the
		// version dir later never destroys the cache entry
		mkdirSync(join(outRoot, "0.2.5+g1", "bin"), { recursive: true });
		linkBun(first.cacheFile, join(outRoot, "0.2.5+g1", "bin", "bun"));
		expect(statSync(join(outRoot, "0.2.5+g1", "bin", "bun")).ino).toBe(statSync(first.cacheFile).ino);
		expect(statSync(join(outRoot, "0.2.5+g1", "bin", "bun")).mode & 0o111).not.toBe(0); // executable
	}, 120_000);
});

describe("pruneOrphanBuns", () => {
	/** An out root with a .buns/ entry per [hash, linkedIntoVersionDir] pair. */
	function seeded(entries: Array<{ hash: string; linked: boolean; ageMs?: number }>): string {
		const outRoot = mkdtempSync(join(tmpdir(), "buns-prune-"));
		mkdirSync(join(outRoot, BUNS_DIR), { recursive: true });
		const now = Date.now();
		for (const e of entries) {
			const f = join(outRoot, BUNS_DIR, e.hash);
			writeFileSync(f, "fake-bun");
			if (e.linked) linkBun(f, join(outRoot, `linked-${e.hash.slice(0, 6)}`));
			const at = new Date(now - (e.ageMs ?? 0));
			chmodSync(f, 0o755); // utimes on a read-only file would fail
			utimesSync(f, at, at);
		}
		return outRoot;
	}

	test("collects only old, unlinked entries; grace window protects in-flight deploys", () => {
		const old = "a".repeat(64);
		const linked = "b".repeat(64);
		const fresh = "c".repeat(64);
		const outRoot = seeded([
			{ hash: old, linked: false, ageMs: ORPHAN_GRACE_MS + 60_000 },
			{ hash: linked, linked: true, ageMs: ORPHAN_GRACE_MS + 60_000 },
			{ hash: fresh, linked: false, ageMs: 1_000 },
		]);
		const pruned = pruneOrphanBuns(outRoot);
		expect(pruned.map((p) => p.hash)).toEqual([old]);
		expect(existsSync(join(outRoot, BUNS_DIR, linked))).toBe(true);
		expect(existsSync(join(outRoot, BUNS_DIR, fresh))).toBe(true);
	});

	test("an absent .buns dir is a no-op, and dotfile temps are never touched", () => {
		const empty = mkdtempSync(join(tmpdir(), "buns-empty-"));
		expect(pruneOrphanBuns(empty)).toEqual([]);
	});
});
