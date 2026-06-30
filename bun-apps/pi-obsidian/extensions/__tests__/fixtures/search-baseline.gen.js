// Replicates the ORIGINAL searchVault behavior (search-old-behavior.snapshot.ts)
// and prints baseline outputs for representative queries against vault/.
// Usage: node packages/pi-obsidian/extensions/__tests__/fixtures/search-baseline.gen.js
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Run from repo root; vault is at ./vaults_root/pi-agent-vault regardless of this
// file's location (remounted in PR #24 — previously ./vault).
const VAULT = resolve(process.cwd(), "vaults_root", "pi-agent-vault");

async function listNotes(vaultPath, folder) {
	const root = resolve(vaultPath, folder);
	const out = [];
	async function walk(dir) {
		let entries;
		try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.name === ".obsidian" || e.name.startsWith(".")) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) await walk(full);
			else if (e.isFile() && e.name.endsWith(".md")) {
				out.push(full.slice(vaultPath.length).replace(/^[/\\]+/, ""));
			}
		}
	}
	await walk(root);
	return out.sort();
}

async function searchVault(vaultPath, query, opts = {}) {
	const needle = opts.caseSensitive ? query : query.toLowerCase();
	const files = await listNotes(vaultPath, "");
	const results = [];
	const max = opts.max ?? 50;
	for (const f of files) {
		let content;
		try { content = await readFile(join(vaultPath, f), "utf8"); } catch { continue; }
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const hay = opts.caseSensitive ? lines[i] : lines[i].toLowerCase();
			if (hay.includes(needle)) {
				results.push({ file: f, line: i + 1, text: lines[i].trim() });
				if (results.length >= max) return results;
			}
		}
	}
	return results;
}

function fmt(query, matches, label) {
	const header = `### ${label}\nquery=${JSON.stringify(query)}`;
	if (!matches.length) return `${header}\nNo matches.`;
	return `${header}\n${matches.length} match(es):\n` + matches.map(m => `${m.file}:${m.line}: ${m.text}`).join("\n");
}

const cases = [
	// [label, query, opts]
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

const files = await listNotes(VAULT, "");
const out = [
	"# obsidian_search baseline (original substring implementation)",
	`Generated: ${new Date().toISOString().slice(0,16)}`,
	`Vault note count: ${files.length}`,
	"",
	"This file is the regression baseline. After each phase, re-run the substring",
	"default path and diff against this file — the output MUST be identical for the",
	"cases marked [SUBSTRING-DEFAULT], which exercise only default params.",
	"",
];

for (const [label, query, opts] of cases) {
	const isDefault = Object.keys(opts).length === 0;
	const tag = isDefault ? " [SUBSTRING-DEFAULT]" : "";
	const matches = await searchVault(VAULT, query, opts);
	out.push(fmt(query, matches, label + tag));
	out.push("");
}

console.log(out.join("\n"));
