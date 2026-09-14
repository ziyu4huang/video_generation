/**
 * note-map.test.ts — buildNoteMap binding rule (retrieval-lift-2 T0).
 *
 * The shipped binding scanned knowledge-graph notes for the FIRST note whose
 * CONTENT contains the paper title. Graph notes cross-link sibling paper
 * titles in their 連結 sections, so a sibling note can steal the binding
 * (measured on the real vault: GMSBench → privescalate note, ReCite →
 * procedural-graphs note, SPINE → procedural-graphs note — 6-7/13 wrong),
 * which corrupted every lane that consumes buildNoteMap (tag recall AND the
 * production MRR baseline). The corrected rule binds via the graph note's
 * FRONTMATTER `source:`/`sources:` = `generic:<origin-card-stem>` — exact,
 * order-independent. These tests are offline (tmp vault, no ingest/embeds).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNoteMap } from "../src/lanes/query-gates.ts";

let vault: string;
const ZK = "Zettelkasten";
const KG = "Zettelkasten/knowledge-graph";

const ORIGIN_A = "Paper - Alpha 論文";
const ORIGIN_B = "Paper - Beta 機器";
const ID_A = "1111.11111";
const ID_B = "2222.22222";

function originCard(stem: string, arxivId: string): string {
	return [
		"---",
		`id: "arXiv:${arxivId}"`,
		'type: reference',
		"status: active",
		`sources: ["arXiv:${arxivId}"]`,
		"---",
		`# ${stem}`,
		"",
		"## 核心想法",
		"- 蒸餾後的內容主張。",
		"",
	].join("\n");
}

function graphNote(stem: string, ownStem: string, extraLinks: string[] = []): string {
	const links = extraLinks.map((l) => `- 相關：${l}`).join("\n");
	return [
		"---",
		`id: "generic:${stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}"`,
		"status: active",
		`sources: ["generic:${stem}"]`,
		`source: "generic:${stem}"`,
		"---",
		`# ${stem}`,
		"",
		"## 核心想法",
		"- 圖譜卡內容。",
		"",
		"## 連結",
		links,
		"- 上層概念：Tags/Index",
		"",
	].join("\n");
}

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-notemap-"));
	mkdirSync(join(vault, KG), { recursive: true });
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

describe("buildNoteMap target binding (T0 ruler fix)", () => {
	test("a sibling title mention in another note's 連結 never steals an absent target", () => {
		// Only Alpha has a graph note; its 連結 section mentions Beta's TITLE.
		// Beta's target is ABSENT and must bind "" — the old first-substring
		// scan deterministically stole Alpha's note for Beta.
		writeFileSync(join(vault, ZK, `${ORIGIN_A}.md`), originCard(ORIGIN_A, ID_A));
		writeFileSync(join(vault, ZK, `${ORIGIN_B}.md`), originCard(ORIGIN_B, ID_B));
		writeFileSync(join(vault, KG, "generic-paper-alpha.md"), graphNote(ORIGIN_A, ORIGIN_A, [ORIGIN_B]));

		const m = buildNoteMap(vault, [ID_A, ID_B]);
		expect(m[ID_A]?.graphNote).toBe(`${KG}/generic-paper-alpha`);
		// THE RED ASSERTION (fails on the shipped title-substring scan):
		expect(m[ID_B]?.graphNote).toBe("");
	});

	test("binding is by frontmatter source, exact — never by title substring order", () => {
		writeFileSync(join(vault, ZK, `${ORIGIN_A}.md`), originCard(ORIGIN_A, ID_A));
		writeFileSync(join(vault, ZK, `${ORIGIN_B}.md`), originCard(ORIGIN_B, ID_B));
		// Alpha's note cross-links Beta's title; BOTH notes exist with correct
		// frontmatter. The binding must resolve each to its OWN note.
		writeFileSync(join(vault, KG, "generic-paper-alpha.md"), graphNote(ORIGIN_A, ORIGIN_A, [ORIGIN_B]));
		writeFileSync(join(vault, KG, "generic-paper-beta.md"), graphNote(ORIGIN_B, ORIGIN_B));

		const m = buildNoteMap(vault, [ID_A, ID_B]);
		expect(m[ID_A]?.graphNote).toBe(`${KG}/generic-paper-alpha`);
		expect(m[ID_B]?.graphNote).toBe(`${KG}/generic-paper-beta`);
	});

	test("a body-only `generic:<stem>` mention does not bind — frontmatter only", () => {
		// Gamma has no note. Delta's note carries `generic:Paper - Gamma 論文`
		// in its BODY (not frontmatter) — the frontmatter rule must not bind
		// Gamma to Delta's note.
		const ORIGIN_G = "Paper - Gamma 論文";
		const ORIGIN_D = "Paper - Delta 機器";
		const ID_G = "3333.33333";
		const ID_D = "4444.44444";
		writeFileSync(join(vault, ZK, `${ORIGIN_G}.md`), originCard(ORIGIN_G, ID_G));
		writeFileSync(join(vault, ZK, `${ORIGIN_D}.md`), originCard(ORIGIN_D, ID_D));
		const d = graphNote(ORIGIN_D, ORIGIN_D).replace(
			"- 圖譜卡內容。",
			`- 圖譜卡內容。provenance: generic:${ORIGIN_G}`,
		);
		writeFileSync(join(vault, KG, "generic-paper-delta.md"), d);

		const m = buildNoteMap(vault, [ID_G, ID_D]);
		expect(m[ID_G]?.graphNote ?? "").toBe("");
		expect(m[ID_D]?.graphNote).toBe(`${KG}/generic-paper-delta`);
	});
});
