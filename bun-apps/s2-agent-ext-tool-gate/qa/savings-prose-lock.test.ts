/**
 * Prose-drift lock (code-review R1 #1).
 *
 * The single-source-of-truth must hold in PROSE, not just measured↔constant.
 * Before this guard, `qa/savings.test.ts` asserted *measured ≈ CLAIMED_SAVED_TOK*
 * but nothing asserted *prose ≈ CLAIMED_SAVED_TOK* — so a one-line edit to
 * README ("~8,500 tokens") would pass CI green while the canonical constant
 * stayed 8,050. That is the exact recurrence this extension's drift bug existed
 * to prevent (three different gross numbers — ~7,900 / ~7,940 / ~8,050 — once
 * coexisted in docs).
 *
 * This test scans the four prose surfaces for `~N,NNN` thousands-figures and
 * asserts each is in SANCTIONED_PROSE_TOK. Any new/changed literal savings
 * figure fails CI until the sanctioned set is updated ON PURPOSE.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { SANCTIONED_PROSE_TOK, CLAIMED_SAVED_TOK, CLAIMED_NET_TOK } from "./savings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, ".."); // bun-apps/s2-agent-ext-tool-gate

const PROSE_FILES = ["README.md", "CONTEXT.md", "extensions/tool-gate.ts", "PRD.md"];

/** Extract every `~N,NNN` (or `~N,NNN,NNN`) thousands-figure as a plain number. */
function thousandsLiterals(text: string): number[] {
	return [...text.matchAll(/~(\d{1,3}(?:,\d{3})+)/g)].map((m) =>
		Number(m[1].replace(/,/g, "")),
	);
}

test("every ~N,NNN thousands-figure in prose is sanctioned (no silent prose drift)", () => {
	const offenders: string[] = [];
	for (const rel of PROSE_FILES) {
		const text = readFileSync(join(extRoot, rel), "utf8");
		for (const n of thousandsLiterals(text)) {
			if (!SANCTIONED_PROSE_TOK.has(n)) {
				offenders.push(`${rel}: ~${n.toLocaleString()}`);
			}
		}
	}
	expect(
		offenders,
		`unsanctioned savings figures in prose (sanctioned: ${[...SANCTIONED_PROSE_TOK]
			.map((n) => `~${n.toLocaleString()}`)
			.join(", ")}). Either fix the prose or intentionally update SANCTIONED_PROSE_TOK.`,
	).toEqual([]);
});

test("the canonical gross claim is actually cited in the prose (guard against silent removal)", () => {
	// If someone deletes the ~9,800 claim from every file, the sanctioned-set
	// test above still passes (vacuously) — so explicitly assert the claim is present.
	const readme = readFileSync(join(extRoot, "README.md"), "utf8");
	expect(readme).toContain("~15,186");
});

test("sanctioned set is internally consistent (gross + net derive from the claims)", () => {
	expect(SANCTIONED_PROSE_TOK.has(CLAIMED_SAVED_TOK)).toBe(true);
	expect(SANCTIONED_PROSE_TOK.has(Math.round(CLAIMED_NET_TOK / 100) * 100)).toBe(true);
	expect(CLAIMED_NET_TOK).toBe(CLAIMED_SAVED_TOK - 309); // net derives from gross − overhead (post ticket-02 + 06)
});
