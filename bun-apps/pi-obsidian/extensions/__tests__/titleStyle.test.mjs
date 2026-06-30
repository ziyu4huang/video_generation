/** C3.4 — title style outlier detection. */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getIndex, dropIndex, detectTitleStyleOutliers } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"a.md": "# Topic — Subtopic\n",      // em (dominant)
		"b.md": "# Other — Thing\n",          // em
		"c.md": "# Legacy: Old Style\n",      // colon (outlier)
		"d.md": "# Plain Title\n",            // plain (outlier)
	});
});
afterAll(async () => { dropIndex(vault); await rmFixture(vault); });

describe("detectTitleStyleOutliers (C3.4)", () => {
	it("flags titles not matching the dominant separator", async () => {
		const idx = await getIndex(vault);
		const out = detectTitleStyleOutliers(idx);
		const paths = out.map((o) => o.path).sort();
		expect(paths).toContain("c.md");
		expect(paths).toContain("d.md");
		expect(paths).not.toContain("a.md");
	});
});
