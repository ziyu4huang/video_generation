import { describe, expect, test } from "bun:test";
import { detectMode, isBunBinary, type BundlerMode } from "./mode.ts";

describe("isBunBinary", () => {
	test("true for the $bunfs virtual scheme", () => {
		expect(isBunBinary("file://$bunfs/root/s2-agent.js")).toBe(true);
	});

	test("true for the ~BUN marker", () => {
		expect(isBunBinary("file:///~BUN/root/s2-agent.js")).toBe(true);
	});

	test("true for the URL-encoded ~BUN (%7EBUN)", () => {
		expect(isBunBinary("file:///%7EBUN/root/s2-agent.js")).toBe(true);
	});

	test("false for a source URL", () => {
		expect(isBunBinary("file:///repo/bun-apps/s2-agent/run-dir/resolve.ts")).toBe(false);
	});

	test("false for empty string", () => {
		expect(isBunBinary("")).toBe(false);
	});
});

describe("detectMode", () => {
	test("the virtual-fs scheme wins wherever it appears in the path", () => {
		// A compiled binary whose virtual path coincidentally contains a real
		// source-tree segment is still binary.
		expect(detectMode("file://$bunfs/run-dir/resolve.ts")).toBe("binary");
		expect(detectMode("file://$bunfs/src/patches/x.ts")).toBe("binary");
	});

	test("anything that is not the virtual-fs scheme is source", () => {
		// This is the whole rule now. While "bundle" existed, a URL outside a
		// caller's own directory marker was classified as a shipped s2-agent.js;
		// nothing produces one since #1740, so an unrecognised path is a source
		// checkout rather than a third thing.
		expect(detectMode("file:///repo/bun-apps/s2-agent/run-dir/resolve.ts")).toBe("source");
		expect(detectMode("file:///repo/bun-apps/s2-agent/src/patches/skip-update-check.ts")).toBe("source");
		expect(detectMode("file:///opt/s2-agent/dist/s2-agent.js")).toBe("source");
	});

	test("the return type is exactly the two modes", () => {
		const modes = new Set<BundlerMode>([
			detectMode("file://$bunfs/x"),
			detectMode("file:///r/run-dir/x"),
			detectMode("file:///opt/x.js"),
		]);
		expect(modes).toEqual(new Set(["binary", "source"]));
	});

	test("this test file's own URL is source", () => {
		expect(detectMode(import.meta.url)).toBe("source");
	});
});

describe("the patches consume detectMode correctly", () => {
	// Regression: a patch must classify ITS OWN url as source when run from
	// source, so dev never gets a shipped-artifact override forced on it.
	test("skip-update-check's source URL → source (no PI_SKIP_VERSION_CHECK in dev)", () => {
		expect(detectMode("file:///repo/bun-apps/s2-agent/src/patches/skip-update-check.ts")).toBe("source");
	});

	test("skip-update-check inside the compiled binary → binary (force-skip)", () => {
		expect(detectMode("file://$bunfs/root/src/patches/skip-update-check.ts")).toBe("binary");
	});
});
