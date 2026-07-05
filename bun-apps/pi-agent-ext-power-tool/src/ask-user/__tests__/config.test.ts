/**
 * Tests for config I/O — collapse key resolution, JSON config loading.
 *
 * Ported from rpiv-ask-user-question config.test.ts (upstream).
 * Adapted from vitest to bun:test.
 *
 * Tier: P1 — config I/O paths, lower regression risk but exercised by runtime.
 *
 * Covers: resolveCollapseKey (default, normalization, off sentinel, malformed
 *         specs, special keys), loadConfig (no file, valid JSON).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// We must dynamically import the module AFTER setting up any HOME override.
// The config module resolves CONFIG_PATH at import time via homedir().
// We use the real HOME for the import, then manage a temp config file.
import {
	type AskUserQuestionConfig,
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	loadConfig,
	resolveCollapseKey,
} from "../config.js";

// ─── resolveCollapseKey ──────────────────────────────────────────────────────

describe("resolveCollapseKey", () => {
	test("returns the default when config has no collapseKey", () => {
		expect(resolveCollapseKey({})).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: undefined })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	test("returns the default when collapseKey is empty or whitespace", () => {
		expect(resolveCollapseKey({ collapseKey: "" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "   " })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	test("normalizes the spec (trim + lowercase)", () => {
		expect(resolveCollapseKey({ collapseKey: "  Ctrl+}  " })).toBe("ctrl+}");
		expect(resolveCollapseKey({ collapseKey: "ALT+O" })).toBe("alt+o");
	});

	test("returns the off sentinel unchanged (case-insensitive)", () => {
		expect(resolveCollapseKey({ collapseKey: "off" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "OFF" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "  off  " })).toBe(COLLAPSE_KEY_OFF);
	});

	test("falls back to the default for malformed specs", () => {
		expect(resolveCollapseKey({ collapseKey: "+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl++" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl+]" })).toBe("ctrl+]");
		expect(resolveCollapseKey({ collapseKey: "ctrl+shift+h" })).toBe("ctrl+shift+h");
	});

	test("falls back to the default for typo'd modifiers and unknown key names", () => {
		expect(resolveCollapseKey({ collapseKey: "ctr+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "control+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl+nosuchkey" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "hello" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	test("accepts named special keys and bare base keys", () => {
		expect(resolveCollapseKey({ collapseKey: "ctrl+pageup" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "Ctrl+PageUp" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "f5" })).toBe("f5");
		expect(resolveCollapseKey({ collapseKey: "alt+escape" })).toBe("alt+escape");
	});
});

// ─── loadConfig ──────────────────────────────────────────────────────────────

describe("loadConfig", () => {
	const home = process.env.HOME ?? "";
	const configPath = join(home, ".config", "rpiv-ask-user-question", "config.json");

	// Track whether the config dir existed before we started
	let configDirExisted = false;
	let configFileExisted = false;

	beforeAll(() => {
		configDirExisted = existsSync(join(home, ".config", "rpiv-ask-user-question"));
		configFileExisted = existsSync(configPath);
	});

	afterAll(() => {
		// Only remove the test config file if we created it during testing
		if (!configFileExisted && existsSync(configPath)) rmSync(configPath);
		// Only remove the config dir if we created it during testing
		if (!configDirExisted && existsSync(join(home, ".config", "rpiv-ask-user-question"))) {
			rmSync(join(home, ".config", "rpiv-ask-user-question"), { recursive: true });
		}
	});

	test("returns an empty config when no file is present", () => {
		if (existsSync(configPath)) rmSync(configPath);
		expect(loadConfig().collapseKey).toBeUndefined();
	});

	test("reads a valid JSON config", () => {
		mkdirSync(join(home, ".config", "rpiv-ask-user-question"), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({ collapseKey: "alt+o", guidance: { promptSnippet: "x" } } satisfies AskUserQuestionConfig),
		);
		const c = loadConfig();
		expect(c.collapseKey).toBe("alt+o");
		expect(c.guidance?.promptSnippet).toBe("x");
	});
});
