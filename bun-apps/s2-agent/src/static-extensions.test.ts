import { describe, expect, test } from "bun:test";
import manifest from "./run-dir/manifest.json";
import { STATIC_EXTENSION_FACTORIES } from "./static-extensions.ts";

/**
 * Drift guard: manifest.staticExtensions and the static imports in
 * static-extensions.ts are two hand-maintained lists of the same set, and only
 * the second one is what actually loads. Names must match 1:1.
 *
 * The list used to have a second consumer — scripts/deploy.ts copied package
 * dirs from it — which is gone with the four legacy deploy modes. The
 * double-registration hazard below is now the whole reason this guard exists,
 * and it holds until the registry consolidation collapses both lists into one.
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
