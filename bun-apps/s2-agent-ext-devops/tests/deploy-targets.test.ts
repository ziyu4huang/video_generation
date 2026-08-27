import { afterAll, describe, expect, test } from "bun:test";
import { bunBinaryName, githubBunArtifact, hostTargetName, isHostTarget, parseTargetName } from "../src/deploy/lib/targets.ts";
import { digestFromShasums } from "../src/deploy/lib/bun-acquire.ts";
import { listTargetLayout } from "../src/deploy/lib/version.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseTargetName (crossos t05)", () => {
	test("parses the D4 matrix names", () => {
		expect(parseTargetName("darwin-arm64")).toEqual({ platform: "darwin", arch: "arm64", libc: undefined });
		expect(parseTargetName("linux-x64")).toEqual({ platform: "linux", arch: "x64", libc: "glibc" });
		expect(parseTargetName("linux-x64-musl")).toEqual({ platform: "linux", arch: "x64", libc: "musl" });
		expect(parseTargetName("win32-x64")).toEqual({ platform: "win32", arch: "x64", libc: undefined });
	});

	test("hostTargetName round-trips through parseTargetName as the host", () => {
		const name = hostTargetName();
		expect(isHostTarget(parseTargetName(name))).toBe(true);
	});

	test("malformed names throw before any layout depends on them", () => {
		expect(() => parseTargetName("win32")).toThrow(/expected <platform>-<arch>/);
		expect(() => parseTargetName("win32-x64-extra")).toThrow(/expected <platform>-<arch>/);
		expect(() => parseTargetName("win32-ppc64")).toThrow(/unknown arch/);
		expect(() => parseTargetName("darwin-arm64-musl")).toThrow(/linux-only convention/);
		expect(() => parseTargetName("../escape")).toThrow();
	});

	test("githubBunArtifact follows oven-sh arch spellings (D7)", () => {
		expect(githubBunArtifact(parseTargetName("darwin-arm64"))).toBe("bun-darwin-aarch64.zip");
		expect(githubBunArtifact(parseTargetName("linux-x64"))).toBe("bun-linux-x64.zip");
		expect(githubBunArtifact(parseTargetName("linux-arm64"))).toBe("bun-linux-aarch64.zip");
		expect(githubBunArtifact(parseTargetName("win32-x64"))).toBe("bun-windows-x64.zip");
	});

	test("bunBinaryName is the Windows exe convention, Node-style elsewhere", () => {
		expect(bunBinaryName(parseTargetName("win32-x64"))).toBe("bun.exe");
		expect(bunBinaryName(parseTargetName("linux-x64"))).toBe("bun");
	});
});

describe("digestFromShasums (D7: checksum is official and mandatory)", () => {
	test("finds the artifact's row in sha256sum format", () => {
		const text = `${"a".repeat(64)}  bun-linux-x64.zip\n${"b".repeat(64)} *bun-windows-x64.zip\n`;
		expect(digestFromShasums(text, "bun-linux-x64.zip")).toBe("a".repeat(64));
		expect(digestFromShasums(text, "bun-windows-x64.zip")).toBe("b".repeat(64)); // binary-mode * prefix tolerated
	});

	test("a missing row is an error, never a skip", () => {
		expect(() => digestFromShasums("nope\n", "bun-linux-x64.zip")).toThrow(/no row for/);
	});
});

describe("listTargetLayout (D6 subroot enumeration)", () => {
	const outRoot = mkdtempSync(join(tmpdir(), "t05-layout-"));
	afterAll(() => rmSync(outRoot, { recursive: true, force: true }));

	test("splits target subroots from legacy flat version dirs", () => {
		// Target subroot with a version + current pointer.
		mkdirSync(join(outRoot, "win32-x64", "0.1.0"), { recursive: true });
		symlinkSync("0.1.0", join(outRoot, "win32-x64", "current"));
		// Legacy flat version dir (pre-t05 shape) — a version string never
		// matches the target-name shape.
		mkdirSync(join(outRoot, "0.9.0+g1234567"), { recursive: true });

		const layout = listTargetLayout(outRoot);
		expect(layout.targets["win32-x64"]).toEqual({ versions: ["0.1.0"], current: "0.1.0" });
		expect(layout.legacy.versions).toEqual(["0.9.0+g1234567"]);
		expect(layout.legacy.current).toBeNull();
	});

	test("a missing outRoot is an empty layout, not an error", () => {
		const layout = listTargetLayout(join(outRoot, "does-not-exist"));
		expect(layout.targets).toEqual({});
		expect(layout.legacy).toEqual({ versions: [], current: null });
	});

	test("a dash-y legacy version dir (`demo-run`) never misclassifies as a subroot", () => {
		mkdirSync(join(outRoot, "demo-run"), { recursive: true });
		const layout = listTargetLayout(outRoot);
		expect(layout.targets["demo-run"]).toBeUndefined();
		expect(layout.legacy.versions).toContain("demo-run");
	});
});
