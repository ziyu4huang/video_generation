/**
 * `sessions <query>` — search past s2-agent session transcripts.
 *
 * Every s2-agent run appends a JSONL transcript under
 * `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. This command
 * searches the TEXT of user + assistant messages across all sessions and
 * prints matching snippets with the session date and project path.
 *
 * CLI equivalent of the in-agent `session_search` tool — but offline (pure
 * file scan, no LLM, no network).
 *
 * Design: the search core (`searchSessions`) is a PURE function over already-
 * read file contents (module-internal; no current test imports it). `run()`
 * wires the real `~/.pi/agent/sessions` tree in (mirrors `tools-metrics.ts`).
 */
import { homedir } from "node:os";
import type { ParsedArgs } from "../args.ts";
import { clipSnippet } from "../format.ts";
import { loadSessionFiles, resolveSessionsDir, type SessionFile } from "../sessions/discover.ts";

export interface SessionMatch {
	file: string;
	date: string; // ISO timestamp of the matching message
	cwd: string; // decoded project path from the session header
	role: string; // user | assistant
	snippet: string; // context around the match
}

/**
 * Pure search over already-loaded session files. Returns matches ranked by
 * recency (newest first).
 *
 * @param files    pre-loaded session files (path + cwd + raw lines)
 * @param query    substring to search for (case-insensitive)
 * @param limit    max matches to return
 */
function searchSessions(
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

			// Context snippet around the match
			const snippet = clipSnippet(text, idx, needle.length, 80);

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

export const sessionsCommand = {
	name: "sessions",
	summary: "search past s2-agent session transcripts (offline, no LLM)",
	details: `Usage:
  s2-agent cli sessions <query> [options]

Searches the TEXT of user + assistant messages across all past s2-agent
session transcripts (~/.pi/agent/sessions/) and prints matching snippets
with date + project path. Case-insensitive substring match.

This is the CLI equivalent of the in-agent session_search tool, but fully
offline (pure file scan, no LLM, no network).

Options:
  --limit <n>           max matches (default 20)

Examples:
  s2-agent cli sessions "flux2 self-improve"
  s2-agent cli sessions "bun workspace" --limit 5`,

	async run(parsed: ParsedArgs): Promise<void> {
		const query = parsed.positionals.join(" ").trim();
		if (!query) {
			throw new Error("No query given. Usage: sessions <query>");
		}

		const limit = parsed.limit ?? 20;

		// Sessions root honors $PI_SESSIONS_DIR / $PI_CODING_AGENT_DIR via the
		// shared discovery leaf (gained env support in effort 2026-08-24 ticket
		// 03 — was hardcoded to ~/.pi/agent/sessions).
		const sessionsDir = resolveSessionsDir(process.env);
		const files = loadSessionFiles(sessionsDir);

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
