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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Determinism: loadConfig reads from ~/.config/rpiv-ask-user-question/config.json
// (real host state). The module resolves CONFIG_PATH at import via os.homedir(),
// and Bun's homedir() ignores process.env.HOME — so the OLD test wrote to
// process.env.HOME while the module read os.homedir() (a divergence that
// intermittently failed) AND polluted the real ~/.config. The __setConfigPathForTest
// seam points BOTH the read and the write at a per-test tmpdir: deterministic +
// never touches the real host.
import {
	type AskUserQuestionConfig,
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	__setConfigPathForTest,
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
	// Per-test tmpdir: the seam makes loadConfig read here, and we write fixtures
	// to the same path — read and write agree, and the real ~/.config is untouched.
	const tmpHome = mkdtempSync(join(tmpdir(), "ask-user-config-test-"));
	const configDir = join(tmpHome, ".config", "rpiv-ask-user-question");
	const configPath = join(configDir, "config.json");

	beforeAll(() => {
		__setConfigPathForTest(configPath);
	});

	afterAll(() => {
		__setConfigPathForTest(null);
		rmSync(tmpHome, { recursive: true, force: true });
	});

	test("returns an empty config when no file is present", () => {
		if (existsSync(configPath)) rmSync(configPath);
		expect(loadConfig().collapseKey).toBeUndefined();
	});

	test("reads a valid JSON config", () => {
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({ collapseKey: "alt+o", guidance: { promptSnippet: "x" } } satisfies AskUserQuestionConfig),
		);
		const c = loadConfig();
		expect(c.collapseKey).toBe("alt+o");
		expect(c.guidance?.promptSnippet).toBe("x");
	});
});
