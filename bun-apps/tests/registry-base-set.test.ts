/**
 * registry-base-set.test.ts — unit tests for the shared base-set reader
 * (tests/lib/registry-base-set.ts).
 *
 * The reader is the DERIVED scope of two gated contract suites
 * (extension-isolation-contract, dep-guard): every extension the registry
 * ships. Since registry-code-as-config ticket 03 the reader is the typed
 * REGISTRY (s2-agent/src/registry-config.ts); ticket 04 retired the YAML and
 * its line scanner together, and the scanner-divergence-parity role (flow-
 * style `deploy: {order: 10}` and `enabled: false` inside a deploy block,
 * which the two historical scanner copies each missed) is now carried by the
 * typed data itself — one source, no second scanner to diverge.
 *
 * What this file pins instead: the typed reader's REAL-DATA invariants — the
 * anti-vacuity guarantee the ticket's Notes demand of the import path (an
 * empty REGISTRY import must fail loudly, not pass every contract suite
 * vacuously).
 *
 * Run: bun test tests/registry-base-set.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registryBaseSetNames } from "./lib/registry-base-set.ts";
import { shippedEntries } from "../s2-agent/src/registry-config.ts";

const BUN_APPS_DIR = join(import.meta.dir, "..");

describe("registryBaseSetNames (t03: typed REGISTRY reader)", () => {
	test("is exactly the shippedEntries projection (no drift between the two exports)", () => {
		expect(registryBaseSetNames()).toEqual(shippedEntries().map((e) => e.name));
	});

	test("is anti-vacuity: the shipped set is large enough to be a real registry", () => {
		// Same spirit as the MIN_EXPECTED floors at the contract call sites —
		// an empty import must trip here, not silently pass every gate.
		expect(registryBaseSetNames().length).toBeGreaterThanOrEqual(10);
	});

	test("every shipping entry's package lives on disk under bun-apps/", () => {
		for (const e of shippedEntries()) {
			expect(existsSync(join(BUN_APPS_DIR, e.package)), `${e.package} not on disk`).toBe(true);
		}
	});

	test("names are non-empty, unique, and short-name shaped", () => {
		const names = registryBaseSetNames();
		expect(new Set(names).size).toBe(names.length);
		for (const n of names) {
			expect(n.length).toBeGreaterThan(0);
			expect(n).toMatch(/^[a-z0-9][a-z0-9-]*$/);
		}
	});
});
