/**
 * Search backward-compatibility CONTRACT — the gate that actually runs in CI.
 *
 * Unlike baseline.test.mjs (which snapshots the REAL submodule vault and is
 * skipped when that submodule isn't initialized), this test runs against an
 * in-package, content-controlled fixture vault (fixtures/frozen-vault/). It
 * therefore executes everywhere — fresh clone, CI, any branch — and does NOT
 * false-alarm when real notes are added.
 *
 * The [SUBSTRING-DEFAULT] cases MUST stay byte-identical to frozen-baseline.txt.
 * If you intentionally change searchVault/buildMatcher behavior OR edit the
 * frozen-vault notes, regenerate:
 *   bun run --cwd bun-apps/pi-obsidian regen:contract
 *
 * Header lines (Generated:, note count:) are excluded from the diff since the
 * count is informational; only the `### ` case blocks are the contract.
 */
import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMatcher, searchVault } from "../obsidian.ts";

const HERE = import.meta.dir;
const VAULT = join(HERE, "fixtures", "frozen-vault");
const FIXTURE = join(HERE, "fixtures", "frozen-baseline.txt");

// Same canonical 9 cases as frozen-baseline.gen.mjs / baseline.test.mjs.
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
	const idx = text.indexOf("### ");
	return idx === -1 ? "" : text.slice(idx);
}

describe("A0.9 search contract (frozen vault — runs in CI, no submodule dep)", () => {
	it("reproduces frozen-baseline.txt byte-for-byte (excl. header)", async () => {
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
