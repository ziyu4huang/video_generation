/**
 * source-markers — the artifact-attestation primitives (self-arc-22 t01,
 * F-deploy-1): deterministic marker derivation from a source tree, and the
 * build-time assert that a bundle built from those sources must contain them.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertMarkersInArtifact, deriveSourceMarkers } from "../src/deploy/lib/source-markers.ts";

const FIXTURE = join(import.meta.dir, "..", ".tmp-source-markers-fixture");

function seedFixture(): void {
	rmSync(FIXTURE, { recursive: true, force: true });
	mkdirSync(join(FIXTURE, "src", "nested"), { recursive: true });
	writeFileSync(
		join(FIXTURE, "src", "index.ts"),
		[
			`export const SHORT = "tiny";`,
			`export const A = "alpha-literal-with-more-than-sixteen-characters";`,
			`export function f() { return 'single-quoted-literal-also-very-long-indeed'; }`,
			`export const TPL = \`template \${A} not a plain literal\`;`,
		].join("\n"),
	);
	writeFileSync(
		join(FIXTURE, "src", "nested", "deep.ts"),
		`export const B = "beta-literal-in-a-nested-directory-long-enough";`,
	);
	writeFileSync(join(FIXTURE, "src", "ignored.test.ts"), `export const C = "test-file-literal-must-never-become-a-marker";`);
	writeFileSync(join(FIXTURE, "src", "types.d.ts"), `export const D: string = "declaration-file-literal-also-excluded";`);
}

describe("deriveSourceMarkers", () => {
	test("deterministic: same sources → same markers, longest first", () => {
		seedFixture();
		const r1 = deriveSourceMarkers(join(FIXTURE, "src"));
		const r2 = deriveSourceMarkers(join(FIXTURE, "src"));
		expect(r1.markers).toEqual(r2.markers);
		expect(r1.markers[0].length).toBeGreaterThanOrEqual(r1.markers[r1.markers.length - 1].length);
		expect(r1.markers.length).toBeLessThanOrEqual(3);
		rmSync(FIXTURE, { recursive: true, force: true });
	});

	test("excludes test/declaration files; plain literals only (no templates)", () => {
		seedFixture();
		const { markers, sources } = deriveSourceMarkers(join(FIXTURE, "src"));
		expect(markers.join("\n")).not.toContain("test-file-literal");
		expect(markers.join("\n")).not.toContain("declaration-file-literal");
		expect(markers.join("\n")).not.toContain("template ");
		expect(sources.some((s) => s.includes("nested"))).toBe(true);
		rmSync(FIXTURE, { recursive: true, force: true });
	});

	test("empty/missing src dir → no markers (attestation trivially passes)", () => {
		const r = deriveSourceMarkers(join(FIXTURE, "does-not-exist"));
		expect(r.markers).toEqual([]);
		expect(() => assertMarkersInArtifact("anything", r.markers, "x")).not.toThrow();
	});
});

describe("assertMarkersInArtifact", () => {
	test("partial presence → throws with the missing count", () => {
		expect(() =>
			assertMarkersInArtifact(
				`bundle bytes ... "alpha-literal-with-more-than-sixteen-characters" ... done`,
				["alpha-literal-with-more-than-sixteen-characters", "never-present-anywhere-at-all"],
				"unit",
			),
		).toThrow(/1\/2 source markers missing/);
	});

	test("missing marker → throws naming the artifact and the missing literal", () => {
		expect(() =>
			assertMarkersInArtifact("bundle without the marker", ["a-missing-marker-literal-oh-yes"], "ext/subagent/ext.cjs"),
		).toThrow(/ext\/subagent\/ext\.cjs.*a-missing-marker-literal/);
	});
});
