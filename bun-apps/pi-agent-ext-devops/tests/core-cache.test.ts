import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCoreHash, ensureCachedCore, linkCore } from "../scripts/lib/core-cache.ts";

/** A minimal fake pi-agent package: src/ tree with nested dirs. */
function fakePiAgent(): string {
	const dir = mkdtempSync(join(tmpdir(), "core-cache-"));
	mkdirSync(join(dir, "src", "sh"), { recursive: true });
	mkdirSync(join(dir, "src", "generated"), { recursive: true });
	writeFileSync(join(dir, "src", "cli-sh.ts"), "export {};");
	writeFileSync(join(dir, "src", "sh", "host-modules.ts"), "export const HOST_API = 2;");
	writeFileSync(join(dir, "src", "generated", "embedded-assets.ts"), "export const EMBEDDED_ASSETS = [];");
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

		const genChange = fakePiAgent(); // the codegen output is part of the compiled src tree
		writeFileSync(join(genChange, "src", "generated", "embedded-assets.ts"), "export const EMBEDDED_ASSETS = [1];");
		expect(computeCoreHash(inputs(genChange))).not.toBe(h0);

		expect(computeCoreHash({ ...inputs(base), piPkgVersion: "0.85.0" })).not.toBe(h0);
		expect(computeCoreHash({ ...inputs(base), bunVersion: "1.4.0" })).not.toBe(h0);
		expect(computeCoreHash({ ...inputs(base), entry: "src/other.ts" })).not.toBe(h0);
		expect(computeCoreHash({ ...inputs(base), flags: [] })).not.toBe(h0);
	});
});

describe("ensureCachedCore", () => {
	test("miss compiles once; hit skips the compile; linkers share the inode", async () => {
		const outRoot = mkdtempSync(join(tmpdir(), "cores-out-"));
		let compiles = 0;
		const compile = async (outFile: string) => {
			compiles++;
			writeFileSync(outFile, "fake-core-binary");
			chmodSync(outFile, 0o755);
		};

		const hash = "deadbeef".repeat(8);
		const first = await ensureCachedCore({ outRoot, hash, compile });
		expect(first.cached).toBe(false);
		expect(compiles).toBe(1);

		const second = await ensureCachedCore({ outRoot, hash, compile });
		expect(second.cached).toBe(true);
		expect(compiles).toBe(1); // the whole point

		// a version dir's pi-agent is a hardlink: same inode, and deleting the
		// version dir later never destroys the cache entry
		linkCore(first.cacheFile, join(outRoot, "0.1.0-pi-agent"));
		expect(statSync(join(outRoot, "0.1.0-pi-agent")).ino).toBe(statSync(first.cacheFile).ino);
		expect(existsSync(first.cacheFile)).toBe(true);
	});

	test("a failed compile leaves no cache entry behind", async () => {
		const outRoot = mkdtempSync(join(tmpdir(), "cores-out-"));
		await expect(
			ensureCachedCore({
				outRoot,
				hash: "ab".repeat(32),
				compile: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow(/boom/);
		expect(existsSync(join(outRoot, ".cores", "ab".repeat(32)))).toBe(false);
	});
});
