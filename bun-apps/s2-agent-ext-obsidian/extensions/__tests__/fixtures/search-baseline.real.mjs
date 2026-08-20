// Produces the 9-case snapshot for the REAL submodule vault, using the REAL
// searchVault from the extension (the same code path baseline.test.mjs asserts,
// so the snapshot cannot diverge from what the test checks).
//   bun run --cwd bun-apps/pi-obsidian regen:baseline
// NOTE: this drifts whenever real vault notes are added/removed — that is by
// design. The backward-compatibility CONTRACT (impl behavior must not change)
// lives in frozen-baseline.txt / baseline-contract.test.mjs, which runs against
// a content-controlled in-package vault and does NOT drift on real growth.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { buildMatcher, searchVault } from "../../obsidian.ts";

// __tests__/fixtures/ → vault is 5 levels up then under vaults_root/ (remounted
// in PR #24 — previously ./vault at repo root).
const VAULT = new URL("../../../../../vaults_root/s2-agent-vault", import.meta.url).pathname;

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

// Live note count (was previously hardcoded to 18 and silently went stale).
function countNotes() {
	let n = 0;
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.name === ".obsidian" || e.name.startsWith(".")) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name.endsWith(".md")) n++;
		}
	};
	walk(VAULT);
	return n;
}

const out = [
	"# obsidian_search baseline (real submodule vault — drifts on content growth)",
	`Generated: ${new Date().toISOString().slice(0,16)}`,
	`Vault note count: ${countNotes()}`,
	"",
	"Real-vault snapshot (NOT the contract). This legitimately drifts whenever",
	"notes are added/removed; baseline.test.mjs is skip-gated on submodule",
	"availability. The backward-compat CONTRACT lives in frozen-baseline.txt.",
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
