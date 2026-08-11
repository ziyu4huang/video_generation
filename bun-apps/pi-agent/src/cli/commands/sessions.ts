/**
 * `sessions <query>` — search past pi-agent session transcripts.
 *
 * Every pi-agent run appends a JSONL transcript under
 * `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. This command
 * searches the TEXT of user + assistant messages across all sessions and
 * prints matching snippets with the session date and project path.
 *
 * CLI equivalent of the in-agent `session_search` tool — but offline (pure
 * file scan, no LLM, no network).
 *
 * Design: the search core (`searchSessions`) is a PURE function over already-
 * read file contents, so it is unit-testable with tiny fixtures. `run()` wires
 * the real `~/.pi/agent/sessions` tree in (mirrors `tools-metrics.ts`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ParsedArgs } from "../args.ts";

export interface SessionMatch {
	file: string;
	date: string; // ISO timestamp of the matching message
	cwd: string; // decoded project path from the session header
	role: string; // user | assistant
	snippet: string; // context around the match
}

export interface SessionFile {
	path: string;
	cwd: string;
	lines: string[];
}

/**
 * Pure search over already-loaded session files. Returns matches ranked by
 * recency (newest first).
 *
 * @param files    pre-loaded session files (path + cwd + raw lines)
 * @param query    substring to search for (case-insensitive)
 * @param limit    max matches to return
 */
export function searchSessions(
	files: SessionFile[],
	query: string,
	limit = 20,
): SessionMatch[] {
	const needle = query.toLowerCase();
	const matches: SessionMatch[] = [];

	for (const sf of files) {
		for (const line of sf.lines) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message") continue;

			const msg = entry.message;
			if (!msg?.content) continue;

			// Extract text from content (string or array of {type,text} blocks)
			let text: string;
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				text = msg.content
					.filter((b: any) => b?.type === "text" && typeof b.text === "string")
					.map((b: any) => b.text)
					.join("\n");
			} else {
				continue;
			}

			const lower = text.toLowerCase();
			const idx = lower.indexOf(needle);
			if (idx === -1) continue;

			// Build a context snippet around the match
			const radius = 80;
			const start = Math.max(0, idx - radius);
			const end = Math.min(text.length, idx + needle.length + radius);
			const snippet =
				(start > 0 ? "…" : "") +
				text.slice(start, end).replace(/\s+/g, " ").trim() +
				(end < text.length ? "…" : "");

			matches.push({
				file: sf.path,
				date: entry.timestamp ?? "",
				cwd: sf.cwd,
				role: msg.role ?? "?",
				snippet,
			});
			if (matches.length >= limit) return matches;
		}
	}

	// Sort newest first
	matches.sort((a, b) => b.date.localeCompare(a.date));
	return matches;
}

/** Recursively load *.jsonl session files with their decoded cwd. */
function loadSessionFiles(sessionsDir: string, maxFiles = 500): SessionFile[] {
	if (!existsSync(sessionsDir)) return [];
	const files: SessionFile[] = [];

	const walk = (dir: string): void => {
		if (files.length >= maxFiles) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (files.length >= maxFiles) return;
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && p.endsWith(".jsonl")) {
				try {
					const lines = readFileSync(p, "utf8").trim().split("\n");
					// Extract cwd from the first "session" line
					let cwd = "";
					for (const l of lines.slice(0, 5)) {
						try {
							const hdr = JSON.parse(l);
							if (hdr.type === "session" && hdr.cwd) {
								cwd = hdr.cwd;
								break;
							}
						} catch {
							/* skip */
						}
					}
					files.push({ path: p, cwd, lines });
				} catch {
					/* skip unreadable */
				}
			}
		}
	};

	walk(sessionsDir);
	return files;
}

export const sessionsCommand = {
	name: "sessions",
	summary: "search past pi-agent session transcripts (offline, no LLM)",
	details: `Usage:
  pi-agent cli sessions <query> [options]

Searches the TEXT of user + assistant messages across all past pi-agent
session transcripts (~/.pi/agent/sessions/) and prints matching snippets
with date + project path. Case-insensitive substring match.

This is the CLI equivalent of the in-agent session_search tool, but fully
offline (pure file scan, no LLM, no network).

Options:
  --limit <n>           max matches (default 20)
  --cwd <path>          restrict to sessions from this project path

Examples:
  pi-agent cli sessions "flux2 self-improve"
  pi-agent cli sessions "bun workspace" --limit 5
  pi-agent cli sessions "RAG" --cwd /Users/me/proj/myrepo`,

	async run(parsed: ParsedArgs): Promise<void> {
		const query = parsed.positionals.join(" ").trim();
		if (!query) {
			throw new Error("No query given. Usage: sessions <query>");
		}

		const limit = parsed.limit ?? 20;
		const cwdFilter = (parsed as any).cwd as string | undefined;

		const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
		let files = loadSessionFiles(sessionsDir);

		if (cwdFilter) {
			const filter = cwdFilter.toLowerCase();
			files = files.filter((f) => f.cwd.toLowerCase().includes(filter));
		}

		if (files.length === 0) {
			console.log("No session transcripts found.");
			return;
		}

		const matches = searchSessions(files, query, limit);

		if (matches.length === 0) {
			console.log(`No matches for "${query}" across ${files.length} session(s).`);
			return;
		}

		console.log(`Found ${matches.length} match(es) for "${query}":\n`);
		for (const m of matches) {
			const date = m.date ? m.date.slice(0, 10) : "????";
			const time = m.date ? m.date.slice(11, 19) : "";
			const proj = m.cwd ? m.cwd.replace(homedir(), "~") : "(unknown)";
			console.log(`  ${date} ${time}  [${m.role}]  ${proj}`);
			console.log(`    ${m.snippet}`);
			console.log();
		}
		console.log(`(${files.length} session(s) scanned)`);
	},
};
