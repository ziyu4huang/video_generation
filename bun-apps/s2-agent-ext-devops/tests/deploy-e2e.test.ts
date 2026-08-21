import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from "node:fs";
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
import { HOST_API, HOST_MODULE_IDS } from "../../s2-agent/src/sh/host-modules.ts";

const RUN = process.env.PI_AGENT_E2E === "1";
const describeE2E = RUN ? describe : describe.skip;

const outRoot = mkdtempSync(join(tmpdir(), "sh-e2e-"));
afterAll(() => rmTree(outRoot));

// The expected extension set is DERIVED from s2-agent.registry.yaml, never
// written out here. This file used to assert ["power-tool", "task"] — true when
// the base set was two, silently wrong from #1713 (hyperframes) onward and
// flatly red after #1738 took it to fourteen. Nothing caught that for two
// releases because no gate ran this file: check-deploy-e2e.sh runs the PROBE
// e2e, and the PI_AGENT_E2E gate hides the rest from a plain `bun test`. Same
// lesson as the probe suite's own header — the registry is the source of truth
// for what a deploy ships.
const BUN_APPS_DIR = join(import.meta.dir, "..", "..");
const shConfig = parseShConfig(
	readFileSync(join(BUN_APPS_DIR, "s2-agent", "s2-agent.registry.yaml"), "utf8"),
	{ bunAppsDir: BUN_APPS_DIR },
);
/** Config order — what `--ext-list` reports, and what the loader loads in. */
const configuredNames = shConfig.extensions.map((e) => e.name);
const configuredNamesSorted = [...configuredNames].sort();

function extList(binary: string) {
	const p = Bun.spawnSync([binary, "--ext-list"], { stdout: "pipe", stderr: "pipe" });
	return { exitCode: p.exitCode, payload: JSON.parse(p.stdout.toString()) };
}

describeE2E("s2-agent-sh deploy e2e", () => {
	test("full deploy produces a working core, extensions, and current symlink", async () => {
		const r = await runShDeploy({ outRoot, force: true });
		expect(r.extensions.map((e) => e.name).sort()).toEqual(configuredNamesSorted);
		expect(r.currentUpdated).toBe(true);

		expect(existsSync(join(r.target, "s2-agent"))).toBe(true);
		expect(existsSync(join(r.target, "run.sh"))).toBe(true);
		expect(existsSync(join(r.target, "deploy.json"))).toBe(true);
		// pi reads its version from <packageDir>/package.json, and in compiled-
		// binary mode packageDir = dirname(execPath) = the version dir. Without
		// this file the startup banner / --version report "0.0.0".
		expect(JSON.parse(readFileSync(join(r.target, "package.json"), "utf8")).version).toBe(r.version);
		// piConfig.name brands the banner AND the exit resume hint ("To resume
		// this session: <APP_NAME> --session …"); without it both read "pi",
		// which names a binary that does not exist on the deploy target.
		expect(JSON.parse(readFileSync(join(r.target, "package.json"), "utf8")).piConfig).toEqual({
			name: "s2-agent",
			configDir: ".pi",
		});
		expect(existsSync(join(r.target, "ext", "power-tool", "ext.json"))).toBe(true);
		expect(readlinkSync(join(outRoot, "current"))).toBe(r.version);

		// frozen: no write bits anywhere
		expect(statSync(join(r.target, "ext", "power-tool", "ext.cjs")).mode & 0o222).toBe(0);

		// state 1: extensions load, in config order
		const withExt = extList(join(r.target, "s2-agent"));
		expect(withExt.exitCode).toBe(0);
		expect(withExt.payload.loaded).toEqual(configuredNames);
		expect(withExt.payload.skipped).toEqual([]);

		// the binary reports the deploy version, not the "0.0.0" fallback
		const v = Bun.spawnSync([join(r.target, "s2-agent"), "--version"], { stdout: "pipe", stderr: "pipe" });
		expect(v.exitCode).toBe(0);
		expect(v.stdout.toString().trim()).toBe(r.version);

		// pollution regression: a parent s2-agent exports its embedded-assets
		// cache redirect (PI_PACKAGE_DIR) on the session environment; a child
		// binary must still report ITS OWN deploy version. The poison dir is
		// embedded-assets-shaped — the shape the entry's first-import scrub
		// drops — and lives under the test's own tmp: no writes to real state.
		const poisonDir = join(outRoot, "pkg-dir-poison", ".pi", "agent", "embedded-assets", "leak");
		mkdirSync(poisonDir, { recursive: true });
		writeFileSync(join(poisonDir, "package.json"), JSON.stringify({ version: "9.9.9+polluted" }));
		const polluted = Bun.spawnSync([join(r.target, "s2-agent"), "--version"], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_PACKAGE_DIR: poisonDir },
		});
		expect(polluted.exitCode).toBe(0);
		expect(polluted.stdout.toString().trim()).toBe(r.version);
	}, 300_000);

	test("the core still runs with ext/ deleted", () => {
		const version = readlinkSync(join(outRoot, "current"));
		const target = join(outRoot, version);
		const parked = join(target, "ext-parked");
		// unfreeze just enough to move the directory
		unfreezeTree(target);
		renameSync(join(target, "ext"), parked);
		try {
			const without = extList(join(target, "s2-agent"));
			expect(without.exitCode).toBe(0);
			expect(without.payload.loadedCount).toBe(0);
		} finally {
			renameSync(parked, join(target, "ext"));
			freezeTree(target);
		}
	}, 60_000);

	// Phase 3 §b deleted the in-place ext rebuild: the flag no longer parses
	// (pinned in deploy-sh-argv.test.ts: "--ext is rejected") and runShDeploy
	// has no onlyExt option. An extension-only change is an ordinary deploy —
	// the core cache (below) makes it compile-free.

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
		expect(scanBinaryForeignPaths(join(target, "s2-agent"), target).foreign, "binary bakes build-machine path(s)").toEqual([]);
	}, 60_000);
});

// ── Phase 3: content-addressed core + keep:N retention ─────────────────────
//
// A fixture registry that ships ZERO extensions (the one entry carries an
// excludeReason) keeps these deploys compile-only, so the cache/prune flow is
// exercised without paying 14 extension builds each time.
describeE2E("core cache + keep:N retention", () => {
	const keepRoot = mkdtempSync(join(tmpdir(), "sh-keep-"));
	const configPath = join(keepRoot, "registry.yaml");
	writeFileSync(
		configPath,
		[
			"deploy:",
			"  outRoot: /tmp/unused",
			"  version: { from: package.json, gitSha: false }",
			"  freeze: true",
			"  current: true",
			"  keep: 2",
			`hostApi: ${HOST_API}`,
			"hostModules:",
			...HOST_MODULE_IDS.map((m) => `  - "${m}"`),
			"extensions:",
			"  - name: power-tool",
			"    package: s2-agent-ext-power-tool",
			"    entry: extensions/power-tool.ts",
			"    load: dynamic",
			"    excludeReason: e2e fixture — deploys a zero-extension core",
			"lazyExtensions: {}",
			"",
		].join("\n"),
	);
	const deploy = (version: string) => runShDeploy({ outRoot: keepRoot, version, configPath });

	test("second deploy with no source change reuses the cached core (same inode)", async () => {
		const a = await deploy("e2e-cache-a");
		expect(a.coreCached).toBe(false); // miss: the compile really happened
		const b = await deploy("e2e-cache-b");
		expect(b.coreCached).toBe(true); // hit: no recompile
		// the two version dirs hardlink ONE cached core — same inode
		expect(statSync(join(keepRoot, "e2e-cache-a", "s2-agent")).ino).toBe(
			statSync(join(keepRoot, "e2e-cache-b", "s2-agent")).ino,
		);
	}, 300_000);

	test("keep:N prunes oldest-first and current still resolves", async () => {
		// state: [a, b], current → b. Two more deploys at keep: 2 prune a then b.
		const c = await deploy("e2e-cache-c");
		expect(c.pruned).toEqual(["e2e-cache-a"]);
		const d = await deploy("e2e-cache-d");
		expect(d.pruned).toEqual(["e2e-cache-b"]);

		expect(existsSync(join(keepRoot, "e2e-cache-a"))).toBe(false);
		expect(existsSync(join(keepRoot, "e2e-cache-b"))).toBe(false);
		expect(readlinkSync(join(keepRoot, "current"))).toBe("e2e-cache-d");
		// the pruned dirs' core links are gone but the cache entry survived
		// every prune — d still boots through it.
		expect(extList(join(keepRoot, "e2e-cache-d", "s2-agent")).payload.loadedCount).toBe(0);
	}, 300_000);
});
