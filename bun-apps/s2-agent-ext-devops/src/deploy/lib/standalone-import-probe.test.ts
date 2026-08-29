import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStandaloneShim } from "./standalone-shim.ts";
import { standaloneImportProbe } from "./standalone-import-probe.ts";

/**
 * ext-standalone-import t04 — the standalone-import probe.
 *
 * The pass-path test builds a REAL shim (cache-shared with the t02 test) into
 * a fake version dir carrying a fixture "devops" ext that registers
 * sync_default_branch — the quickstart then runs end-to-end in a subprocess
 * with a real bun, exactly as an external consumer would. The fail-path test
 * proves detection: a broken shim fails the probe, not just crashes it.
 */

const tmpDirs: string[] = [];

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "sip-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A fake deployed devops ext: cjs-wrapper bundle registering the sync tool. */
function writeFakeDevopsExt(versionDir: string): void {
	const dir = join(versionDir, "ext", "devops");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "ext.json"),
		JSON.stringify({ name: "devops", package: "@repo/s2-agent-ext-devops", version: "0.0.0", hostApi: 2, entry: "ext.cjs", hostModules: [] }),
	);
	writeFileSync(
		join(dir, "ext.cjs"),
		`// @bun @bun-cjs
(function(exports, require, module, __filename, __dirname) {
module.exports.default = function factory(api) {
	api.registerTool({
		name: "sync_default_branch",
		execute: async () => ({ details: { aborted: false, mode: "full", commands: ["git fetch"] }, content: [{ type: "text", text: "ok" }] }),
	});
};
})
`,
	);
}

describe("standaloneImportProbe", () => {
	test("skips (not fails) on a tree without the shim — pre-t02 deploy", async () => {
		const versionDir = tmp();
		const r = await standaloneImportProbe(versionDir);
		expect(r.verdict).toBe("skip");
		expect(r.note).toContain("pre-t02");
	});

	test("fails loudly on a broken shim — the probe detects, not just executes", async () => {
		const versionDir = tmp();
		mkdirSync(join(versionDir, "ext"), { recursive: true });
		writeFileSync(join(versionDir, "ext", "ext-standalone.mjs"), 'throw new Error("broken shim");\n');
		const r = await standaloneImportProbe(versionDir, { shippedBun: process.execPath });
		expect(r.verdict).toBe("fail");
		expect(r.detail ?? r.note).toMatch(/broken shim|exited/);
	});

	test(
		"passes end-to-end: real shim + fixture devops ext + real bun subprocess",
		async () => {
			const versionDir = tmp();
			writeFakeDevopsExt(versionDir);
			await buildStandaloneShim({
				outFile: join(versionDir, "ext", "ext-standalone.mjs"),
				outRoot: tmp(),
				freeze: false,
				deployRoot: versionDir,
			});
			const r = await standaloneImportProbe(versionDir, { shippedBun: process.execPath });
			expect(r.verdict).toBe("pass");
			expect(r.note).toContain("scratch dir");
			expect(r.note).toContain("file2md not in deploy set"); // the fake tree has no file2md
			expect(r.note).toContain("gate re-check");
		},
		{ timeout: 120_000 },
	);
});
