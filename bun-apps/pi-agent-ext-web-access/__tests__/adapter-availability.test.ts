/**
 * adapter-availability.test.ts — deterministic env-driven availability tests
 * for the provider adapters, satisfying the web-access baseline's
 * "SSRF + ≥2 provider adapters" coverage clause.
 *
 * getApiKey() checks process.env.<PROVIDER>_API_KEY FIRST, then a config file.
 * Env precedence means setting the var deterministically flips is*Available()
 * without touching the filesystem. (The env-unset → unavailable case depends on
 * no config file existing on the host; we assert it only when the config is
 * absent to stay machine-independent.)
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { isBraveAvailable } from "../brave.ts";
import { isTavilyAvailable } from "../tavily.ts";
import { isExaAvailable, hasExaApiKey } from "../exa.ts";
import { hasParallelApiKey, clearParallelConfigCache } from "../parallel.ts";
import { getWebSearchConfigPath } from "../utils.ts";

const CONFIG_PRESENT = existsSync(getWebSearchConfigPath());

/** Snapshot + clear a set of env vars; restore on teardown. */
function withEnv(overrides: Record<string, string | undefined>) {
	const backup: Record<string, string | undefined> = {};
	const keys = Object.keys(overrides);
	for (const k of keys) backup[k] = process.env[k];
	beforeEach(() => {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		clearParallelConfigCache();
	});
	return () => {
		for (const k of keys) {
			if (backup[k] === undefined) delete process.env[k];
			else process.env[k] = backup[k];
		}
	};
}

describe("brave adapter availability (env-driven)", () => {
	const restore = withEnv({ BRAVE_API_KEY: "test-brave-key" });
	afterAll(restore);

	test("isBraveAvailable() is true when BRAVE_API_KEY is set", () => {
		expect(isBraveAvailable()).toBe(true);
	});

	testWithoutEnv("isBraveAvailable() is false when no key is configured", () => {
		expect(isBraveAvailable()).toBe(false);
	});
});

describe("tavily adapter availability (env-driven)", () => {
	const restore = withEnv({ TAVILY_API_KEY: "test-tavily-key" });
	afterAll(restore);

	test("isTavilyAvailable() is true when TAVILY_API_KEY is set", () => {
		expect(isTavilyAvailable()).toBe(true);
	});
});

describe("exa adapter availability", () => {
	const restore = withEnv({ EXA_API_KEY: "test-exa-key" });
	afterAll(restore);

	test("isExaAvailable() is always true (MCP fallback needs no key)", () => {
		// exa is the one adapter with a no-key MCP fallback.
		delete process.env.EXA_API_KEY;
		expect(isExaAvailable()).toBe(true);
	});

	test("hasExaApiKey() tracks EXA_API_KEY", () => {
		process.env.EXA_API_KEY = "test-exa-key";
		expect(hasExaApiKey()).toBe(true);
		delete process.env.EXA_API_KEY;
		expect(hasExaApiKey()).toBe(false);
	});
});

describe("parallel adapter availability", () => {
	const restore = withEnv({ PARALLEL_API_KEY: "test-parallel-key" });
	afterAll(restore);

	test("hasParallelApiKey() is true when PARALLEL_API_KEY is set", () => {
		expect(hasParallelApiKey()).toBe(true);
	});
});

// ─── helper: a test that runs only when the host has no web-search config ────
function testWithoutEnv(name: string, fn: () => void) {
	if (CONFIG_PRESENT) {
		// Can't assert the "unavailable" branch deterministically if a real config
		// file supplies a key on this machine — skip rather than risk a flake.
		test.skip(name, fn);
		return;
	}
	// Run the body with ALL provider API-key env vars cleared + the config cache
	// invalidated, then restore. The enclosing describe's withEnv() beforeEach
	// sets the provider's key for the "available" sibling test; without this
	// guard the "unavailable" test would inherit that key. That was masked on
	// dev machines (CONFIG_PRESENT skip) but fails on CI (no config file → the
	// test runs while the env key is still set). Clearing every provider key
	// makes the "no key" assertion deterministic on every host.
	const PROVIDER_KEYS = [
		"BRAVE_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "PARALLEL_API_KEY",
		"PERPLEXITY_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "ZAI_API_KEY",
		"CLOUDFLARE_API_KEY",
	];
	test(name, () => {
		const backup: Record<string, string | undefined> = {};
		for (const k of PROVIDER_KEYS) {
			backup[k] = process.env[k];
			delete process.env[k];
		}
		clearParallelConfigCache();
		try {
			fn();
		} finally {
			for (const k of PROVIDER_KEYS) {
				if (backup[k] === undefined) delete process.env[k];
				else process.env[k] = backup[k];
			}
			clearParallelConfigCache();
		}
	});
}
