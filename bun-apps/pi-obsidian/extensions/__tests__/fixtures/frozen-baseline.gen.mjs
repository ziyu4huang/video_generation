// Generates the contract baseline snapshot for the FROZEN in-package vault
// (fixtures/frozen-vault/). Uses the REAL searchVault from the extension — the
// same code path baseline-contract.test.mjs asserts — so the snapshot cannot
// diverge from what the test checks.
//
//   bun run --cwd bun-apps/pi-obsidian regen:contract
//
// Commit the regenerated frozen-baseline.txt together with any frozen-vault
// note change. See fixtures/frozen-vault/README.md.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { buildMatcher, searchVault } from "../../obsidian.ts";

const VAULT = new URL("./frozen-vault/", import.meta.url).pathname;

// Same canonical 9 cases as baseline.test.mjs / search-baseline.real.mjs.
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
	return `${header}\n${matches.length} match(es):\n` + matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
}

// Live note count (no hardcoded stale value).
function countNotes() {
	let n = 0;
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.name.startsWith(".")) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name.endsWith(".md")) n++;
		}
	};
	walk(VAULT);
	return n;
}

const out = [
	"# obsidian_search contract baseline (frozen in-package vault)",
	`Generated: ${new Date().toISOString().slice(0, 16)}`,
	`Vault: fixtures/frozen-vault/ — note count: ${countNotes()}`,
	"",
	"This snapshot is the backward-compatibility contract for searchVault's",
	"substring-default path. It runs against a CONTENT-CONTROLLED fixture vault",
	"(not the real submodule vault), so it executes in CI and does NOT drift when",
	"real notes are added. The [SUBSTRING-DEFAULT] cases MUST stay byte-identical.",
	"If you intentionally change searchVault behavior OR edit frozen-vault notes,",
	"regenerate via `bun run --cwd bun-apps/pi-obsidian regen:contract`.",
	"",
];
for (const [label, query, opts] of cases) {
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
console.log(out.join("\n"));
