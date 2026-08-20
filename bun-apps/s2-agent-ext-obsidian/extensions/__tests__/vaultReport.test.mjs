/**
 * D2 — vaultReport (summarizeVault + renderReportMD).
 *   bun test extensions/__tests__/vaultReport.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getIndex, dropIndex } from "../obsidian.ts";
import { makeFixture, rmFixture } from "./helpers/fixture.mjs";
import { summarizeVault, renderReportMD } from "../../lib/vaultReport.ts";

let vault;
beforeAll(async () => {
	vault = await makeFixture({
		"a.md": "---\ncreated: 2026-01-01\ntags: [alpha, shared]\n---\n\n# Alpha\n\nLinks to [[Beta]].\n",
		"b.md": "---\ntags: [beta, shared]\n---\n\n# Beta\n\nLinks to [[Alpha]].\n",
		"c.md": "# Gamma\n\nIsolated note.\n",
		"d.md": "# Delta\n\nLinks to [[Nonexistent]].\n",
	});
});
afterAll(async () => { dropIndex(vault); await rmFixture(vault); });

describe("summarizeVault (D2)", () => {
	it("computes stats correctly", async () => {
		const r = summarizeVault(await getIndex(vault));
		expect(r.stats.noteCount).toBe(4);
		// Alpha->Beta, Beta->Alpha, Delta->Nonexistent
		expect(r.stats.edgeCount).toBe(3);
		expect(r.stats.tagCount).toBe(3); // alpha, beta, shared
		expect(r.stats.orphans).toBe(r.orphans.length); // count must match the orphan list (B2.2: no-inbound)
		expect(r.orphans.length).toBe(2); // c.md + d.md: neither has any inbound links
		expect(r.stats.deadLinks).toBe(1); // Delta->Nonexistent
	});

	it("top tags sorted by count desc", async () => {
		const r = summarizeVault(await getIndex(vault));
		// shared appears in 2 notes -> first
		expect(r.topTags[0].tag).toBe("shared");
		expect(r.topTags[0].count).toBe(2);
	});

	it("detects orphan Gamma", async () => {
		const r = summarizeVault(await getIndex(vault));
		expect(r.orphans.map((o) => o.path)).toContain("c.md");
		expect(r.orphans.map((o) => o.path)).toContain("d.md"); // Delta has no inbound links -> orphan too (B2.2)
		expect(r.orphans.map((o) => o.path)).not.toContain("a.md");
		// GraphResult carries the title in `text`; summarizeVault must surface it as
		// the report's `title` (was undefined before the r.title -> r.text fix).
		expect(r.orphans.find((o) => o.path === "c.md")?.title).toBe("gamma");
	});

	it("detects dead link Delta -> Nonexistent", async () => {
		const r = summarizeVault(await getIndex(vault));
		expect(r.deadLinks.length).toBe(1);
		expect(r.deadLinks[0].source).toBe("d.md");
	});
});

describe("renderReportMD (D2)", () => {
	it("renders expected Traditional-Chinese sections", async () => {
		const md = renderReportMD(summarizeVault(await getIndex(vault)));
		expect(md).toContain("# 📊 Vault 知識庫報告");
		expect(md).toContain("## 概覽");
		expect(md).toContain("## 標籤聚類");
		expect(md).toContain("## 主題聚類");
		expect(md).toContain("## 健康度");
		expect(md).toContain("筆記數：**4**");
	});

	it("includes orphan and dead-link details", async () => {
		const md = renderReportMD(summarizeVault(await getIndex(vault)));
		expect(md).toContain("`c.md`");
		expect(md).toContain("`d.md`");
		// Orphan line renders its title (not the literal "undefined").
		expect(md).toContain("`c.md` — gamma");
		expect(md).not.toContain("undefined");
	});
});
