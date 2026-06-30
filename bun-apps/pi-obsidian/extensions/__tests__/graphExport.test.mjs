/**
 * D1 — graphExport (toGraphJSON / toDOT / toMermaid).
 *   bun test extensions/__tests__/graphExport.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getIndex, dropIndex } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";
import { toGraphJSON, toDOT, toMermaid } from "../../lib/graphExport.ts";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"a.md": "# Alpha\n\nLinks to [[Beta]] and [[Gamma]].\n",
		"b.md": "---\ntags: [x]\n---\n\n# Beta\n\nLinks to [[Gamma]].\n",
		"c.md": "# Gamma\n\nNo links out.\n",
		"d.md": "# Delta\n\nNo links, isolated.\n",
	});
});
afterAll(async () => { dropIndex(vault); await rmFixture(vault); });

describe("toGraphJSON (D1)", () => {
	it("produces correct node + edge counts", async () => {
		const idx = await getIndex(vault);
		const g = toGraphJSON(idx);
		expect(g.nodes.length).toBe(4);
		// Alpha->Beta, Alpha->Gamma, Beta->Gamma
		expect(g.edges.length).toBe(3);
	});

	it("counts orphans (no in/out edges)", async () => {
		const idx = await getIndex(vault);
		const g = toGraphJSON(idx);
		// Delta is isolated
		expect(g.stats.orphans).toBe(1);
		expect(g.stats.nodeCount).toBe(4);
		expect(g.stats.edgeCount).toBe(3);
	});

	it("node carries tags + created", async () => {
		const idx = await getIndex(vault);
		const g = toGraphJSON(idx);
		const beta = g.nodes.find((n) => n.title === "beta");
		expect(beta.tags).toContain("x");
	});
});

describe("toDOT (D1)", () => {
	it("emits a valid DOT digraph", async () => {
		const idx = await getIndex(vault);
		const dot = toDOT(idx);
		expect(dot.startsWith("digraph vault {")).toBe(true);
		expect(dot.trim().endsWith("}")).toBe(true);
		expect(dot).toContain("->");
		// edge present
		expect(dot).toContain('"a" -> "b"');
	});
});

describe("toMermaid (D1)", () => {
	it("emits a valid Mermaid graph TD", async () => {
		const idx = await getIndex(vault);
		const m = toMermaid(idx);
		expect(m.startsWith("graph TD")).toBe(true);
		expect(m).toContain("-->");
		// 3 edges
		expect(m.split("\n").filter((l) => l.includes("-->")).length).toBe(3);
	});

	it("Mermaid keys are safe (alphanumeric/underscore)", async () => {
		const idx = await getIndex(vault);
		const m = toMermaid(idx);
		// every arrow line: `  KEY --> KEY`
		for (const line of m.split("\n")) {
			if (!line.includes("-->")) continue;
			const m2 = line.match(/^\s*(\S+)\s*-->\s*(\S+)/);
			expect(m2).not.toBeNull();
			expect(/^[A-Za-z0-9_-]+$/.test(m2[1])).toBe(true);
		}
	});
});
