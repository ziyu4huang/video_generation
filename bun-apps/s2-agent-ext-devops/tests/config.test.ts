import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { excludedExtensionsFromRegistry, shConfig } from "../src/deploy/lib/config.ts";
import { DEPLOY_CONFIG, shippedEntries } from "../../s2-agent/src/registry-config.ts";
import {
	HOST_API,
	HOST_MODULE_IDS,
} from "../../s2-agent/src/sh/host-modules.ts";

const BUN_APPS = join(import.meta.dir, "..", "..");

describe("shConfig — the deploy projection (post-t04: typed REGISTRY only)", () => {
	test("the real repo registry matches the core's host contract", () => {
		const cfg = shConfig({ bunAppsDir: BUN_APPS });
		expect(cfg.hostApi).toBe(HOST_API);
		expect([...cfg.hostModules].sort()).toEqual([...HOST_MODULE_IDS].sort());
		// The expected set is DERIVED from the typed registry itself
		// (registry-code-as-config t03): no hand-maintained name list to go
		// stale — the exact failure mode PR #1958 hit. What this still pins is
		// the PROJECTION: shippedEntries() (deploy block present + enabled)
		// is exactly what shConfig() ships, in deploy order.
		expect(cfg.extensions.map((e) => e.name).sort()).toEqual(
			shippedEntries().map((e) => e.name).sort(),
		);
		expect(cfg.extensions.length).toBeGreaterThanOrEqual(10);
		// The keep→prune plumbing is this single projection (run.ts passes
		// cfg.keep ?? DEFAULT_KEEP to pruneVersions); behavior itself is
		// unit-covered in version.test.ts.
		expect(cfg.keep).toBe(DEPLOY_CONFIG.keep);
		// subagent must load before ultracode (registry population order).
		const order = (name: string) =>
			cfg.extensions.find((e) => e.name === name)!.order;
		expect(order("subagent")).toBeLessThan(order("ultracode"));
	});

	test("projection completes the normalized arrays (absent fields default to [])", () => {
		// The retired parseShConfig fixture tests asserted these defaults on
		// YAML fixtures; post-t04 the same normalization is asserted over the
		// real registry, which contains entries with deploy blocks that omit
		// copy/vendor/externals/vendorExclude (task, subagent, ultracode, …).
		const cfg = shConfig({ bunAppsDir: BUN_APPS });
		for (const ext of cfg.extensions) {
			expect(Number.isInteger(ext.order)).toBe(true);
			expect(ext.skills).toBeArray();
			expect(ext.copy).toBeArray();
			expect(ext.vendor).toBeArray();
			expect(ext.externals).toBeArray();
			expect(ext.vendorExclude).toBeArray();
			expect(ext.enabled).toBe(true);
		}
	});

	test("excludedExtensionsFromRegistry names the not-shipped half with reasons", () => {
		const excluded = excludedExtensionsFromRegistry({ bunAppsDir: BUN_APPS });
		const names = excluded.map((e) => e.name);
		// The projection works on the real registry, not pinning the exact set.
		expect(names).toContain("s2-agent-ext-movie-director");
		// file2md flipped into the deploy set with ticket 05 (smart-enhance).
		expect(names).not.toContain("file2md");
		expect(names).not.toContain("task");
		expect(names).not.toContain("hyperframes");
		for (const e of excluded) expect(e.reason.length).toBeGreaterThan(0);
	});
});
