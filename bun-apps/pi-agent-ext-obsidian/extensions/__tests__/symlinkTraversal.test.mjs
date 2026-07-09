/**
 * A1.2 — Symlink traversal tests.
 *   bun test extensions/__tests__/symlinkTraversal.test.mjs
 *
 * A symlink inside the vault pointing to a file OUTSIDE the vault must be
 * rejected by safeNotePath (and by write tools). Validates the realpath-based
 * containment added in A1.1 follow-up.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { safeNotePath, assertWithinVault } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";
import { symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let vault;
let outsideTarget;
beforeAll(async () => {
	vault = await makeFixture({});
	// a file outside the vault
	outsideTarget = join(await mkdir(join(tmpdir(), "pio-out-" + process.pid), { recursive: true }) || tmpdir(), "secret.md");
	// mkdir above returns undefined; do it explicitly
	const outsideDir = join(tmpdir(), "pio-out-" + process.pid);
	await mkdir(outsideDir, { recursive: true });
	outsideTarget = join(outsideDir, "secret.md");
	await writeFile(outsideTarget, "TOP SECRET", "utf8");
	// symlink inside vault pointing outside
	await symlink(outsideTarget, join(vault, "evil.md"));
});
afterAll(async () => {
	await rmFixture(vault);
	await rmFixture(join(tmpdir(), "pio-out-" + process.pid));
});

describe("assertWithinVault — symlink escape (A1.2)", () => {
	it("rejects a symlink that points outside the vault", async () => {
		const abs = safeNotePath(vault, "evil");
		await expect(assertWithinVault(vault, abs)).rejects.toThrow(/escapes vault/);
	});

	it("rejects a path that traverses through a symlinked directory", async () => {
		const outsideDir2 = join(tmpdir(), "pio-outdir-" + process.pid);
		await mkdir(join(outsideDir2, "sub"), { recursive: true });
		await writeFile(join(outsideDir2, "sub", "leak.md"), "x", "utf8");
		await symlink(outsideDir2, join(vault, "linkdir"));
		try {
			const abs = safeNotePath(vault, "linkdir/sub/leak");
			await expect(assertWithinVault(vault, abs)).rejects.toThrow(/escapes vault/);
		} finally {
			await rmFixture(join(vault, "linkdir"));
			await rmFixture(outsideDir2);
		}
	});

	it("allows a normal (non-symlink) in-vault path", async () => {
		const abs = safeNotePath(vault, "Inbox/ok");
		await expect(assertWithinVault(vault, abs)).resolves.toBeUndefined();
	});
});
