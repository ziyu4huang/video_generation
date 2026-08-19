import { describe, expect, test } from "bun:test";
import { HOST_API, HOST_MODULE_IDS, HostModuleNotFoundError, hostRequire } from "./host-modules.ts";

describe("host-modules", () => {
	test("HOST_API is the integer contract version", () => {
		expect(HOST_API).toBe(1);
	});

	test("exposes exactly the whitelisted specifiers", () => {
		expect([...HOST_MODULE_IDS].sort()).toEqual([
			"@earendil-works/pi-ai",
			"@earendil-works/pi-ai/compat",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
			"@repo/pi-agent-core-runtime",
			"@repo/pi-agent-ext-subagent",
			"typebox",
			"typebox/value",
		]);
	});

	test("hostRequire returns the host's own module instance", () => {
		const mod = hostRequire("typebox") as { Type: unknown };
		expect(mod.Type).toBeDefined();
		// identity: two calls must hand back the SAME object, not a copy
		expect(hostRequire("typebox")).toBe(mod);
	});

	test("hostRequire on pi-coding-agent exposes defineTool", () => {
		const mod = hostRequire("@earendil-works/pi-coding-agent") as { defineTool: unknown };
		expect(typeof mod.defineTool).toBe("function");
	});

	test("hostRequire serves node builtins the bundle's interop shims ask for", () => {
		// A minified extension bundle requires `module` / `child_process` even when
		// the extension source never mentions them; rejecting those skipped every
		// real extension at boot.
		expect(typeof hostRequire("child_process")).toBe("object");
		expect(typeof hostRequire("module")).toBe("function");
		expect(typeof hostRequire("node:fs")).toBe("object");
	});

	test("hostRequire throws a typed error for an unknown specifier", () => {
		expect(() => hostRequire("left-pad")).toThrow(HostModuleNotFoundError);
		expect(() => hostRequire("left-pad")).toThrow(/left-pad/);
	});
});
