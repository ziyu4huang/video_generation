/**
 * version-bump-cli — unit tests. Spawn-free: runVersionBumpCli operates on a
 * mkdtemp repoRoot fixture (fake bun-apps/s2-agent tree), so the arithmetic,
 * the anchor rewrites, the dry-run no-op, and every failure shape are
 * exercised without touching the real repo files.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bumpVersion,
	parseVersionBumpArgs,
	rewriteDispatch,
	rewritePkgJson,
	runVersionBumpCli,
} from "../src/version-bump-cli.js";

describe("parseVersionBumpArgs", () => {
	test("defaults: patch, no dry-run; requires --package s2-agent", () => {
		const r = parseVersionBumpArgs(["--package", "s2-agent"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.level).toBe("patch");
			expect(r.args.dryRun).toBe(false);
		}
		expect(parseVersionBumpArgs([]).ok).toBe(false);
	});
	test("an unknown flag is a usage error, never silently ignored", () => {
		const r = parseVersionBumpArgs(["--package", "s2-agent", "--not-a-flag"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("--not-a-flag");
	});
	test("--help parses as 'not ok' so the caller can render usage at exit 0", () => {
		expect(parseVersionBumpArgs(["--help"]).ok).toBe(false);
	});
	test("bump levels are mutually exclusive; unknown packages rejected", () => {
		expect(parseVersionBumpArgs(["--package", "s2-agent", "--minor", "--major"]).ok).toBe(false);
		expect(parseVersionBumpArgs(["--package", "hermes-memory"]).ok).toBe(false);
	});
});

describe("bumpVersion (pure arithmetic)", () => {
	test("patch / minor / major", () => {
		expect(bumpVersion("0.1.0", "patch")).toEqual({ ok: true, next: "0.1.1" });
		expect(bumpVersion("0.1.9", "patch")).toEqual({ ok: true, next: "0.1.10" });
		expect(bumpVersion("0.1.0", "minor")).toEqual({ ok: true, next: "0.2.0" });
		expect(bumpVersion("0.1.0", "major")).toEqual({ ok: true, next: "1.0.0" });
	});
	test("rejects prerelease/buildmetadata forms (plain x.y.z only)", () => {
		for (const v of ["0.1.0-alpha", "0.1.0+gabc1234", "v0.1.0", "1.2"]) {
			expect(bumpVersion(v, "patch").ok).toBe(false);
		}
	});
});

describe("anchor rewrites (pure)", () => {
	test("package.json: exact-field replace", () => {
		const r = rewritePkgJson('{\n\t"name": "x",\n\t"version": "0.1.0",\n\t"private": true\n}\n', "0.1.0", "0.1.1");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toContain('"version": "0.1.1"');
	});
	test("package.json: wrong current version → loud fail", () => {
		expect(rewritePkgJson('"version": "0.2.0"', "0.1.0", "0.1.1").ok).toBe(false);
	});
	test("dispatch.ts: VERSION const replace", () => {
		const r = rewriteDispatch('const VERSION = "0.1.0";\n', "0.1.0", "0.1.1");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toBe('const VERSION = "0.1.1";\n');
	});
	test("dispatch.ts: anchor moved/renamed → loud fail, not silent skip", () => {
		expect(rewriteDispatch("const APP_VERSION = '0.1.0';", "0.1.0", "0.1.1").ok).toBe(false);
	});
});

describe("runVersionBumpCli (temp fixture tree)", () => {
	const root = mkdtempSync(join(tmpdir(), "version-bump-"));
	const pkgDir = join(root, "bun-apps", "s2-agent");
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	function makeTree(version: string, dispatchVersion = version): void {
		mkdirSync(join(pkgDir, "src", "cli"), { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), `{\n\t"name": "@repo/s2-agent",\n\t"version": "${version}"\n}\n`);
		writeFileSync(join(pkgDir, "src", "cli", "dispatch.ts"), `import { x } from "y";\n\nconst VERSION = "${dispatchVersion}";\n`);
	}

	test("dry-run reports the bump and mutates NOTHING", async () => {
		makeTree("0.1.0");
		const res = await runVersionBumpCli(["--package", "s2-agent", "--minor", "--dry-run"], { repoRoot: root });
		expect(res.exitCode).toBe(0);
		const payload = JSON.parse(res.stdout);
		expect(payload).toMatchObject({ ok: true, from: "0.1.0", to: "0.2.0", level: "minor", dryRun: true });
		expect(payload.files).toEqual([]);
		expect(readFileSync(join(pkgDir, "package.json"), "utf8")).toContain('"version": "0.1.0"');
	});

	test("real run rewrites BOTH sync sites", async () => {
		makeTree("0.1.0");
		const res = await runVersionBumpCli(["--package", "s2-agent", "--patch"], { repoRoot: root });
		expect(res.exitCode).toBe(0);
		expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, from: "0.1.0", to: "0.1.1" });
		expect(readFileSync(join(pkgDir, "package.json"), "utf8")).toContain('"version": "0.1.1"');
		expect(readFileSync(join(pkgDir, "src", "cli", "dispatch.ts"), "utf8")).toContain('const VERSION = "0.1.1";');
	});

	test("dispatch.ts out of sync with package.json → structured fail, no partial write", async () => {
		makeTree("0.1.0", "0.0.9"); // dispatch anchor won't match
		const res = await runVersionBumpCli(["--package", "s2-agent"], { repoRoot: root });
		expect(res.exitCode).toBe(1);
		expect(JSON.parse(res.stdout).error).toContain("dispatch.ts anchor missing");
		// package.json must NOT have been bumped before the dispatch failure.
		expect(readFileSync(join(pkgDir, "package.json"), "utf8")).toContain('"version": "0.1.0"');
	});

	test("--help: usage on stderr with exit 0, nothing on stdout", async () => {
		const res = await runVersionBumpCli(["--help"]);
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("");
		expect(res.stderr).toContain("usage:");
	});
});
