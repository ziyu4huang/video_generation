/**
 * C2 — cross-platform URI launcher.
 *   bun test extensions/__tests__/uriLauncher.test.mjs
 */
import { describe, it, expect } from "bun:test";
import { launcherForUri } from "../obsidian.ts";

describe("launcherForUri (C2.1)", () => {
	it("macOS uses `open`", () => {
		const r = launcherForUri("obsidian://open?vault=x", "darwin");
		expect(r.command).toBe("open");
		expect(r.args).toEqual(["obsidian://open?vault=x"]);
	});

	it("Linux uses `xdg-open`", () => {
		const r = launcherForUri("obsidian://open?vault=x", "linux");
		expect(r.command).toBe("xdg-open");
	});

	it("Windows uses `cmd /c start`", () => {
		const r = launcherForUri("obsidian://open?vault=x", "win32");
		expect(r.command).toBe("cmd");
		expect(r.args[0]).toBe("/c");
		expect(r.args[1]).toBe("start");
		expect(r.args[r.args.length - 1]).toBe("obsidian://open?vault=x");
	});

	it("defaults to host platform when omitted", () => {
		const r = launcherForUri("obsidian://x");
		expect(["open", "xdg-open", "cmd"]).toContain(r.command);
	});
});
