/**
 * structural.test.ts — lane 1c against the REAL vault's 13 paper cards
 * (read-only; the lane never mutates). Gates: schema, sections, wiki-link
 * resolution, evidence anchors, sources format. Also pins the D4 adapter
 * contract at the artifact level: graph notes must not carry sibling-title
 * tags or the double-rendered H1.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runStructuralLane } from "../src/lanes/structural.ts";
import { realVaultPath } from "../src/vault-sandbox.ts";

const zk = join(realVaultPath(), "Zettelkasten");

describe("lane 1c — structural compliance (13 real cards)", () => {
	const result = runStructuralLane(realVaultPath());

	test("finds exactly 13 paper cards", () => {
		expect(result.cardsChecked).toBe(13);
	});

	test("zero violations (schema + sections + links + anchors + sources)", () => {
		const msg = result.violations.map((v) => `${v.card}: [${v.check}] ${v.detail}`).join("\n");
		expect(msg).toBe("");
		expect(result.pass).toBe(true);
	});
});

describe("D4 adapter contract — artifact-level regression pins", () => {
	test("graph notes carry no sibling-title tags (wiki-link harvest removed)", () => {
		const recite = readFileSync(join(zk, "knowledge-graph", "generic-paper-recite.md"), "utf8");
		expect(recite).not.toContain("paper---procedural-graphs");
		expect(recite).not.toContain("tags/index");
	});

	test("no double-rendered H1 in converged notes", () => {
		const recite = readFileSync(join(zk, "knowledge-graph", "generic-paper-recite.md"), "utf8");
		const count = (recite.match(/^# Paper - ReCite/gm) ?? []).length;
		expect(count).toBe(1);
	});
});

import { readFileSync } from "node:fs";
