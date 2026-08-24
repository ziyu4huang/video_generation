import { describe, expect, test } from "bun:test";
import { detectMode } from "./mode.ts";

describe("detectMode", () => {
	test("a .ts module URL is source", () => {
		expect(detectMode("file:///repo/bun-apps/s2-agent/src/run-dir/resolve.ts")).toBe("source");
		expect(detectMode("file:///repo/bun-apps/s2-agent/src/patches/skip-update-check.ts")).toBe("source");
	});

	test("a non-.ts URL is a bun-run bundle", () => {
		// The sh deploy's core: one minified .js whose dir is the deploy root.
		// Every bundled module's rewritten import.meta.url points at it, so
		// the extension alone separates it from a source boot (always .ts).
		expect(detectMode("file:///opt/s2-agent-sh/1.0.0/s2-agent.js")).toBe("bundle");
	});

	test("this test file's own URL is source", () => {
		// Regression shape: a patch must classify ITS OWN url as source when
		// run from source (skip-update-check.ts URL covered above), so dev
		// never gets a shipped-artifact override forced on it.
		expect(detectMode(import.meta.url)).toBe("source");
	});
});
