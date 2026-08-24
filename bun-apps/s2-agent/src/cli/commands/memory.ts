/**
 * `memory <query>` — search pi-hermes-memory entries (offline, no LLM).
 *
 * The persistent memory lives in `~/.pi/agent/pi-hermes-memory/` as markdown:
 *   MEMORY.md  — global notes, environment facts, durable learnings
 *   failures.md — categorized failures/corrections/insights (§-delimited entries)
 *   USER.md    — user preferences, communication style, standing instructions
 *
 * This command searches those files (case-insensitive substring) and prints
 * matching entries with context. CLI equivalent of the in-agent memory_search
 * tool — but offline (pure file scan, no LLM).
 *
 * Design: the search core (`searchMemory`) is a PURE function over file
 * contents (module-internal; no current test imports it). `run()` wires the
 * real memory dir in.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveAgentDir } from "../../paths.ts";
import type { ParsedArgs } from "../args.ts";
import { clipSnippet } from "../format.ts";

export interface MemoryMatch {
	file: string;
	category: string; // [failure], [correction], etc. or "(uncategorized)"
	snippet: string; // context around the match
}

/**
 * Search memory file contents for a substring. Entries in failures.md are
 * §-delimited with leading [category] tags; other files are line-searched.
 *
 * @param fileContents  map of filename → raw text
 * @param query         substring (case-insensitive)
 * @param limit         max matches
 */
function searchMemory(
	fileContents: Map<string, string>,
	query: string,
	limit = 20,
): MemoryMatch[] {
	const needle = query.toLowerCase();
	const matches: MemoryMatch[] = [];

	for (const [file, content] of fileContents) {
		// failures.md: split on § delimiters, search each entry
		if (content.includes("§")) {
			const entries = content.split("§");
			for (const entry of entries) {
				const trimmed = entry.trim();
				if (!trimmed) continue;
				const idx = trimmed.toLowerCase().indexOf(needle);
				if (idx === -1) continue;

				// Extract category tag [failure], [correction], etc.
				const catMatch = trimmed.match(/^\[(\w+)\]/);
				const category = catMatch ? `[${catMatch[1]}]` : "(uncategorized)";

				// Snippet around the match (wider radius than sessions: whole-entry context)
				const snippet = clipSnippet(trimmed, idx, needle.length, 120);

				matches.push({ file, category, snippet });
				if (matches.length >= limit) return matches;
			}
		} else {
			// Other files: line-based search with context
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const idx = lines[i]!.toLowerCase().indexOf(needle);
				if (idx === -1) continue;

				// Grab context: this line + a few after
				const ctxEnd = Math.min(lines.length, i + 4);
				const snippet = lines
					.slice(i, ctxEnd)
					.join("\n")
					.slice(0, 400)
					.replace(/\s+/g, " ")
					.trim();

				matches.push({ file, category: "(line)", snippet });
				if (matches.length >= limit) return matches;
			}
		}
	}

	return matches;
}

/** Load the core memory markdown files (MEMORY.md, failures.md, USER.md). */
function loadMemoryFiles(memoryDir: string): Map<string, string> {
	const files = new Map<string, string>();
	const core = ["MEMORY.md", "failures.md", "USER.md"];
	for (const name of core) {
		const p = join(memoryDir, name);
		if (existsSync(p)) {
			try {
				files.set(name, readFileSync(p, "utf8"));
			} catch {
				/* skip */
			}
		}
	}
	return files;
}

export const memoryCommand = {
	name: "memory",
	summary: "search pi-hermes-memory entries (MEMORY.md, failures.md, USER.md)",
	details: `Usage:
  s2-agent cli memory <query> [options]

Searches the persistent memory files in ~/.pi/agent/pi-hermes-memory/ for a
case-insensitive substring and prints matching entries with context.

Files searched:
  MEMORY.md    global notes, environment facts, durable learnings
  failures.md  categorized failures/corrections/insights (§-delimited)
  USER.md      user preferences, communication style, standing instructions

This is the CLI equivalent of the in-agent memory_search tool, but offline.

Options:
  --limit <n>           max matches (default 20)

Examples:
  s2-agent cli memory "bun workspace"
  s2-agent cli memory "argparse loop"
  s2-agent cli memory "verbose flag" --limit 5`,

	async run(parsed: ParsedArgs): Promise<void> {
		const query = parsed.positionals.join(" ").trim();
		if (!query) {
			throw new Error("No query given. Usage: memory <query>");
		}

		const limit = parsed.limit ?? 20;
		const memoryDir = join(resolveAgentDir(), "pi-hermes-memory");
		const files = loadMemoryFiles(memoryDir);

		if (files.size === 0) {
			console.log("No memory files found at ~/.pi/agent/pi-hermes-memory/");
			return;
		}

		const matches = searchMemory(files, query, limit);

		if (matches.length === 0) {
			const fileList = [...files.keys()].join(", ");
			console.log(`No matches for "${query}" in: ${fileList}`);
			return;
		}

		console.log(`Found ${matches.length} match(es) for "${query}":\n`);
		for (const m of matches) {
			console.log(`  ${m.file} ${m.category}`);
			console.log(`    ${m.snippet}`);
			console.log();
		}
	},
};
