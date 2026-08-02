import { describe, expect, test } from "bun:test";
import manifest from "../run-dir/manifest.json";
import { STATIC_EXTENSION_FACTORIES } from "./static-extensions.ts";

/**
 * Drift guard: scripts/deploy.ts copies package dirs from
 * manifest.staticExtensions, while runtime loading uses the static imports in
 * static-extensions.ts. If the two lists drift, a deploy silently ships
 * without a package the runtime needs (or copies dead weight). Names must
 * match 1:1.
 */
describe("static extensions ↔ manifest.staticExtensions", () => {
	test("factory names equal manifest.staticExtensions exactly", () => {
		const factoryNames = [...STATIC_EXTENSION_FACTORIES.map((f) => f.name)].sort();
		const manifestNames = [...(manifest.staticExtensions ?? [])].sort();
		expect(factoryNames).toEqual(manifestNames);
	});

	test("dynamic extensions ↔ staticExtensions are disjoint (no double-registration) (I-2)", () => {
		// A package listed in BOTH would double-register and crash pi's loader
		// with "Tool <name> conflicts" (static factory + dynamic -e path). Only
		// the slow e2e / manual `ext doctor` caught this before; lock it at the
		// fast tier. Dynamic entry → its package = the first path segment.
		const dynPkgs = new Set(
			(manifest.extensions ?? []).map((e) => {
				const entry = typeof e === "string" ? e : e.entry ?? "";
				return entry.split("/")[0];
			}),
		);
		const staticPkgs = new Set(manifest.staticExtensions ?? []);
		const overlap = [...dynPkgs].filter((p) => staticPkgs.has(p));
		expect(
			overlap,
			`packages registered both dynamically AND statically: ${overlap.join(", ")}`,
		).toEqual([]);
	});
});
