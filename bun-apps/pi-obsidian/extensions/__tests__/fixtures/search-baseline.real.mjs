// Produces the SAME 9-case output as search-baseline.gen.js, but using the REAL
// searchVault from the extension. Diff against fixtures/search-baseline.txt —
// for substring-default cases the output MUST be identical (backward compat).
//   bun run packages/pi-obsidian/extensions/__tests__/fixtures/search-baseline.real.mjs > search-baseline.real.txt
//   diff search-baseline.txt search-baseline.real.txt
import { buildMatcher, searchVault } from "../../obsidian.ts";

// __tests__/fixtures/ → vault is 5 levels up then under vaults_root/ (remounted
// in PR #24 — previously ./vault at repo root).
const VAULT = new URL("../../../../../vaults_root/pi-agent-vault", import.meta.url).pathname;

const cases = [
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
	return `${header}\n${matches.length} match(es):\n` + matches.map(m => `${m.file}:${m.line}: ${m.text}`).join("\n");
}

const out = [
	"# obsidian_search baseline (original substring implementation)",
	`Generated: ${new Date().toISOString().slice(0,16)}`,
	`Vault note count: 18`,
	"",
	"This file is the regression baseline. After each phase, re-run the substring",
	"default path and diff against this file — the output MUST be identical for the",
	"cases marked [SUBSTRING-DEFAULT], which exercise only default params.",
	"",
];
for (const [label, query, opts] of cases) {
	const isDefault = Object.keys(opts).length === 0;
	const tag = isDefault ? " [SUBSTRING-DEFAULT]" : "";
	const built = buildMatcher(query, "substring", opts.caseSensitive ?? false);
	const matches = await searchVault(VAULT, {
		match: built.match, fields: null, folder: "",
		max: opts.max ?? 50,
	});
	out.push(fmt(query, matches, label + tag));
	out.push("");
}
console.log(out.join("\n"));
