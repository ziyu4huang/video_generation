import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildStandaloneShim, gateStandaloneShim, probeStandaloneShimImport } from "./standalone-shim.ts";

/**
 * ext-standalone-import t02 — the shim build step's gate + cache contract.
 *
 * The poisoned-fixture tests write the fixture to a file (the s4 gate reads
 * bytes, matching Gate 5b's scanner); the build test pays ONE real `bun
 * build` of the shim per run and proves both the cache-miss and cache-hit
 * paths plus the import probe against real bytes.
 */

const tmpDirs: string[] = [];

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "shim-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const DEPLOY_ROOT = "/tmp/fake-deploy-root";

async function fixture(code: string): Promise<string> {
	const dir = tmp();
	const file = join(dir, "fixture.mjs");
	await Bun.write(file, code);
	return file;
}

describe("gateStandaloneShim (poisoned fixtures)", () => {
	test("clean code passes (static specifiers not scanned — map D8; the s2 import probe owns them)", async () => {
		await gateStandaloneShim(await fixture('const x = 1;\n'), DEPLOY_ROOT);
	});

	test("a bare dynamic import outside the native-compat set is rejected (s1b)", async () => {
		const f = await fixture('const p = import("left-pad");\n');
		expect(() => gateStandaloneShim(f, DEPLOY_ROOT)).toThrow(/dynamic import/i);
	});

	test("a native-compat dynamic import passes (bun resolves node-fetch/ws/undici with no node_modules)", async () => {
		await gateStandaloneShim(await fixture('const p = import("node-fetch"); const q = import("ws");\n'), DEPLOY_ROOT);
	});

	test("a baked build-machine home path is rejected (s4)", async () => {
		const f = await fixture(`const secret = "${homedir()}/secret-project/x";\n`);
		expect(() => gateStandaloneShim(f, DEPLOY_ROOT)).toThrow(/build-machine/);
	});

	test("a baked bun install-cache path is ALLOWLISTED like the core bundle's photon-node fold (s4)", async () => {
		// Same class as the production core's var __dirname photon-node fold —
		// inert string, Gate 5b's allowlist covers it (warning, not failure).
		await gateStandaloneShim(
			await fixture(`var __dirname = "${homedir()}/.bun/install/cache/links/pkg@1.0.0/node_modules/pkg";\n`),
			DEPLOY_ROOT,
		);
	});

	test("a path under the deploy tree itself is fine (s4 exemption)", async () => {
		await gateStandaloneShim(await fixture(`const here = "${DEPLOY_ROOT}/ext/devops/ext.cjs";\n`), DEPLOY_ROOT);
	});
});

describe("buildStandaloneShim (one real build)", () => {
	test(
		"builds, gates, imports, and the second call is a cache hit",
		async () => {
			const outRoot = tmp();
			const stage = tmp();
			const outFile = join(stage, "ext", "ext-standalone.mjs");
			const gateIds: string[] = [];
			const first = await buildStandaloneShim({
				outFile,
				outRoot,
				freeze: true,
				deployRoot: stage,
				onGate: (id) => gateIds.push(id),
			});
			expect(existsSync(outFile)).toBe(true);
			expect(first.cached).toBe(false);
			expect(first.bytes).toBeGreaterThan(100_000); // host registry inlined — core-order bytes
			expect(statSync(outFile).size).toBe(first.bytes);
			// All three gates fired, in order.
			expect(gateIds).toEqual(["s1b", "s4", "s2"]);

			const second = await buildStandaloneShim({
				outFile: join(stage, "ext-2", "ext-standalone.mjs"),
				outRoot,
				freeze: true,
				deployRoot: stage,
			});
			expect(second.cached).toBe(true);
			expect(second.bytes).toBe(first.bytes);
		},
		{ timeout: 120_000 },
	);

	test("probeStandaloneShimImport throws on a file without the contract exports", async () => {
		const dir = tmp();
		const bad = join(dir, "not-a-shim.mjs");
		await Bun.write(bad, "export const other = 1;\n");
		expect(probeStandaloneShimImport(bad)).rejects.toThrow("loadExt");
	});
});
