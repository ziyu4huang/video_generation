/**
 * A0.9 — Regression baseline lock.
 *   bun test extensions/__tests__/baseline.test.mjs
 *
 * Re-runs the canonical 9-case baseline through the REAL searchVault and diffs
 * against the committed fixtures/search-baseline.txt. The [SUBSTRING-DEFAULT]
 * cases MUST stay byte-identical across all subsequent phases — this is the
 * backward-compatibility gate for the whole stability plan.
 *
 * Header lines (Generated:, Vault note count:) are excluded from the diff
 * since they legitimately drift as notes are added.
 */
import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMatcher, searchVault } from "../obsidian.ts";
import { vaultAvailable, VAULT, SKIP_REASON } from "./_vault-fixture.ts";

const HERE = import.meta.dir;
const FIXTURE = join(HERE, "fixtures", "search-baseline.txt");

// The canonical 9 cases (must match search-baseline.gen.js / .real.mjs).
const CASES = [
	["common word (lowercase)", "obsidian", {}],
	["title-ish term", "Zettelkasten", {}],
	["mixed-case query, default insensitive", "Obsidian", {}],
	["case-sensitive mismatch", "Obsidian", { caseSensitive: true }],
	["tag-like inline token", "#tag", {}],
	["frontmatter key", "sources:", {}],
	["no-match term", "zzznomatchzzz", {}],
	["max cap = 3", "obsidian", { max: 3 }],
	["short substring inside word", "agent", {}],
];

function fmt(query, matches, label) {
	const header = `### ${label}\nquery=${JSON.stringify(query)}`;
	if (!matches.length) return `${header}\nNo matches.`;
	return `${header}\n${matches.length} match(es):\n` + matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
}

function stripHeader(text) {
	// Drop lines before the first "### " case header (the Generated/count/preamble).
	const idx = text.indexOf("### ");
	return idx === -1 ? "" : text.slice(idx);
}

describe.skipIf(!vaultAvailable())("A0.9 regression baseline (substring default contract) — skipped: " + SKIP_REASON, () => {
	it("reproduces the committed search-baseline.txt byte-for-byte (excl. header)", async () => {
		const out = [];
		for (const [label, query, opts] of CASES) {
			const isDefault = Object.keys(opts).length === 0;
			const tag = isDefault ? " [SUBSTRING-DEFAULT]" : "";
			const built = buildMatcher(query, "substring", opts.caseSensitive ?? false);
			const matches = await searchVault(VAULT, {
				match: built.match,
				fields: null,
				folder: "",
				max: opts.max ?? 50,
			});
			out.push(fmt(query, matches, label + tag));
			out.push("");
		}
		const regenerated = out.join("\n");

		const committed = await readFile(FIXTURE, "utf8");
		// trimEnd: the runner emits via console.log (extra trailing newline);
		// trailing whitespace is not part of the semantic contract.
		expect(stripHeader(regenerated).trimEnd()).toBe(stripHeader(committed).trimEnd());
	});

	it("all [SUBSTRING-DEFAULT] cases produce non-error matchers", () => {
		for (const [, query] of CASES) {
			const built = buildMatcher(query, "substring", false);
			expect(built.error).toBeUndefined();
			expect(typeof built.match).toBe("function");
		}
	});
});
