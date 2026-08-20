import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShDeploy } from "../scripts/deploy.ts";
import { parseShConfig } from "../scripts/lib/config.ts";
import {
	scanBinaryForeignPaths,
	scanSymlinkEscapes,
	verifyVendoredClosure,
	verifyVendoredCompleteness,
} from "../scripts/lib/offline-gate.ts";
import { freezeTree, rmTree, unfreezeTree } from "../scripts/lib/fs.ts";

const RUN = process.env.PI_AGENT_E2E === "1";
const describeE2E = RUN ? describe : describe.skip;

const outRoot = mkdtempSync(join(tmpdir(), "sh-e2e-"));
afterAll(() => rmTree(outRoot));

// The expected extension set is DERIVED from pi-agent.registry.yaml, never
// written out here. This file used to assert ["power-tool", "task"] — true when
// the base set was two, silently wrong from #1713 (hyperframes) onward and
// flatly red after #1738 took it to fourteen. Nothing caught that for two
// releases because no gate ran this file: check-deploy-e2e.sh runs the PROBE
// e2e, and the PI_AGENT_E2E gate hides the rest from a plain `bun test`. Same
// lesson as the probe suite's own header — the registry is the source of truth
// for what a deploy ships.
const BUN_APPS_DIR = join(import.meta.dir, "..", "..");
const shConfig = parseShConfig(
	readFileSync(join(BUN_APPS_DIR, "pi-agent", "pi-agent.registry.yaml"), "utf8"),
	{ bunAppsDir: BUN_APPS_DIR },
);
/** Config order — what `--ext-list` reports, and what the loader loads in. */
const configuredNames = shConfig.extensions.map((e) => e.name);
const configuredNamesSorted = [...configuredNames].sort();

function extList(binary: string) {
	const p = Bun.spawnSync([binary, "--ext-list"], { stdout: "pipe", stderr: "pipe" });
	return { exitCode: p.exitCode, payload: JSON.parse(p.stdout.toString()) };
}

describeE2E("pi-agent-sh deploy e2e", () => {
	test("full deploy produces a working core, extensions, and current symlink", async () => {
		const r = await runShDeploy({ outRoot, force: true });
		expect(r.mode).toBe("full");
		expect(r.extensions.map((e) => e.name).sort()).toEqual(configuredNamesSorted);
		expect(r.currentUpdated).toBe(true);

		expect(existsSync(join(r.target, "pi-agent"))).toBe(true);
		expect(existsSync(join(r.target, "run.sh"))).toBe(true);
		expect(existsSync(join(r.target, "deploy.json"))).toBe(true);
		// pi reads its version from <packageDir>/package.json, and in compiled-
		// binary mode packageDir = dirname(execPath) = the version dir. Without
		// this file the startup banner / --version report "0.0.0".
		expect(JSON.parse(readFileSync(join(r.target, "package.json"), "utf8")).version).toBe(r.version);
		expect(existsSync(join(r.target, "ext", "power-tool", "ext.json"))).toBe(true);
		expect(readlinkSync(join(outRoot, "current"))).toBe(r.version);

		// frozen: no write bits anywhere
		expect(statSync(join(r.target, "ext", "power-tool", "ext.cjs")).mode & 0o222).toBe(0);

		// state 1: extensions load, in config order
		const withExt = extList(join(r.target, "pi-agent"));
		expect(withExt.exitCode).toBe(0);
		expect(withExt.payload.loaded).toEqual(configuredNames);
		expect(withExt.payload.skipped).toEqual([]);

		// the binary reports the deploy version, not the "0.0.0" fallback
		const v = Bun.spawnSync([join(r.target, "pi-agent"), "--version"], { stdout: "pipe", stderr: "pipe" });
		expect(v.exitCode).toBe(0);
		expect(v.stdout.toString().trim()).toBe(r.version);
	}, 300_000);

	test("the core still runs with ext/ deleted", () => {
		const version = readlinkSync(join(outRoot, "current"));
		const target = join(outRoot, version);
		const parked = join(target, "ext-parked");
		// unfreeze just enough to move the directory
		unfreezeTree(target);
		renameSync(join(target, "ext"), parked);
		try {
			const without = extList(join(target, "pi-agent"));
			expect(without.exitCode).toBe(0);
			expect(without.payload.loadedCount).toBe(0);
		} finally {
			renameSync(parked, join(target, "ext"));
			freezeTree(target);
		}
	}, 60_000);

	test("single-extension rebuild updates that extension in place", async () => {
		const version = readlinkSync(join(outRoot, "current"));
		const target = join(outRoot, version);
		const before = readFileSync(join(target, "ext", "power-tool", "ext.json"), "utf8");

		const r = await runShDeploy({ outRoot, version, onlyExt: ["power-tool"] });
		expect(r.mode).toBe("ext-only");
		expect(r.extensions.map((e) => e.name)).toEqual(["power-tool"]);

		const after = readFileSync(join(target, "ext", "power-tool", "ext.json"), "utf8");
		expect(JSON.parse(after).name).toBe("power-tool");
		expect(before.length).toBeGreaterThan(0);
		expect(after.length).toBeGreaterThan(0);

		// still frozen and still loading both extensions
		expect(statSync(join(target, "ext", "power-tool", "ext.cjs")).mode & 0o222).toBe(0);
		expect(extList(join(target, "pi-agent")).payload.loaded).toEqual(configuredNames);
	}, 180_000);

	test("--ext against a version that does not exist is refused", async () => {
		await expect(runShDeploy({ outRoot, version: "0.0.0-absent", onlyExt: ["power-tool"] })).rejects.toThrow(
			/existing deploy/,
		);
	});

	// The static half of Gate 5, asserted against what SHIPPED rather than what
	// the in-process build scanned — the same discipline as the gate-4 static
	// test in the probe suite. Gate 5 runs on the staging tree before the
	// rename; this re-runs the pure scans against the final, frozen tree.
	test("the shipped tree is offline-contained (Gate 5 static half)", async () => {
		const version = readlinkSync(join(outRoot, "current"));
		const target = join(outRoot, version);

		expect(scanSymlinkEscapes(target), "symlink(s) escape the deploy tree").toEqual([]);
		expect(verifyVendoredCompleteness(target), "declared vendor package(s) missing").toEqual([]);
		expect(verifyVendoredClosure(target), "vendored package(s) with dangling hard deps").toEqual([]);
		expect(scanBinaryForeignPaths(join(target, "pi-agent"), target).foreign, "binary bakes build-machine path(s)").toEqual([]);
	}, 60_000);
});
