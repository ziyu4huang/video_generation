import { describe, expect, test } from "bun:test";
import { detectMode, type BundlerMode } from "./mode.ts";

describe("detectMode", () => {
	test("a .ts module URL is source", () => {
		expect(detectMode("file:///repo/bun-apps/s2-agent/run-dir/resolve.ts")).toBe("source");
		expect(detectMode("file:///repo/bun-apps/s2-agent/src/patches/skip-update-check.ts")).toBe("source");
	});

	test("a non-.ts URL is a bun-run bundle", () => {
		// The sh deploy's core: one minified .js whose dir is the deploy root.
		// Every bundled module's rewritten import.meta.url points at it, so
		// the extension alone separates it from a source boot (always .ts).
		expect(detectMode("file:///opt/s2-agent-sh/1.0.0/s2-agent.js")).toBe("bundle");
	});

	test("the return type is exactly the two modes", () => {
		const modes = new Set<BundlerMode>([
			detectMode("file:///r/run-dir/x.ts"),
			detectMode("file:///opt/x.js"),
		]);
		expect(modes).toEqual(new Set(["bundle", "source"]));
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

	test("skip-update-check inside the shipped bundle → bundle (force-skip)", () => {
		expect(detectMode("file:///opt/s2-agent-sh/1.0.0/s2-agent.js")).toBe("bundle");
	});
});
