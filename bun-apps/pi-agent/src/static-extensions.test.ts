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
});
