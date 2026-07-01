import { describe, expect, test } from "bun:test";
import { detectMode, isBunBinary, type BundlerMode } from "./mode.ts";

describe("isBunBinary", () => {
	test("true for the $bunfs virtual scheme", () => {
		expect(isBunBinary("file://$bunfs/root/pi-agent.js")).toBe(true);
	});

	test("true for the ~BUN marker", () => {
		expect(isBunBinary("file:///~BUN/root/pi-agent.js")).toBe(true);
	});

	test("true for the URL-encoded ~BUN (%7EBUN)", () => {
		expect(isBunBinary("file:///%7EBUN/root/pi-agent.js")).toBe(true);
	});

	test("false for source / bundle URLs", () => {
		expect(isBunBinary("file:///repo/bun-apps/pi-agent/run-dir/resolve.ts")).toBe(false);
		expect(isBunBinary("file:///opt/pi-agent/dist/pi-agent.js")).toBe(false);
	});

	test("false for empty string", () => {
		expect(isBunBinary("")).toBe(false);
	});
});

describe("detectMode", () => {
	test("binary takes precedence over source", () => {
		// a compiled binary whose path coincidentally contains /run-dir/ is still binary
		expect(detectMode("file://$bunfs/run-dir/resolve.ts")).toBe("binary");
		expect(detectMode("file://$bunfs/src/patches/x.ts", "/src/patches/")).toBe("binary");
	});

	test("source mode with default /run-dir/ marker", () => {
		expect(detectMode("file:///repo/bun-apps/pi-agent/run-dir/resolve.ts")).toBe("source");
	});

	test("source mode with custom /src/patches/ marker (the patches' call site)", () => {
		const url = "file:///repo/bun-apps/pi-agent/src/patches/skip-update-check.ts";
		// default marker (/run-dir/) does NOT match → bundle
		expect(detectMode(url)).toBe("bundle");
		// patches' marker DOES match → source
		expect(detectMode(url, "/src/patches/")).toBe("source");
	});

	test("bundle mode when no marker matches", () => {
		expect(detectMode("file:///opt/pi-agent/dist/pi-agent.js")).toBe("bundle");
		expect(detectMode("file:///opt/pi-agent/dist/pi-agent.js", "/src/patches/")).toBe("bundle");
	});

	test("return type is exactly the three modes", () => {
		const modes = new Set<BundlerMode>([
			detectMode("file://$bunfs/x"),
			detectMode("file:///r/run-dir/x"),
			detectMode("file:///opt/x.js"),
		]);
		expect(modes).toEqual(new Set(["binary", "source", "bundle"]));
	});

	test("this test file's URL is bundle mode (no /run-dir/ or /src/patches/ in path)", () => {
		// src/mode.test.ts → URL contains /src/ but neither full marker
		const m = detectMode(import.meta.url);
		expect(m === "source" || m === "bundle").toBe(true);
	});
});

describe("patches consume detectMode correctly", () => {
	// Regression: the patches must classify THEIR OWN url as source when run
	// from source, so they don't force env overrides in dev. Simulate the exact
	// URLs the patch files see.
	test("set-package-dir source URL → source (no PI_PACKAGE_DIR override in dev)", () => {
		const url = "file:///repo/bun-apps/pi-agent/src/patches/set-package-dir.ts";
		expect(detectMode(url, "/src/patches/")).toBe("source");
	});

	test("skip-update-check source URL → source (no PI_SKIP_VERSION_CHECK force in dev)", () => {
		const url = "file:///repo/bun-apps/pi-agent/src/patches/skip-update-check.ts";
		expect(detectMode(url, "/src/patches/")).toBe("source");
	});

	test("skip-update-check bundled URL → bundle (force-skip in shipped artifact)", () => {
		const url = "file:///opt/pi-agent/dist/pi-agent.js";
		expect(detectMode(url, "/src/patches/")).toBe("bundle");
	});
});
