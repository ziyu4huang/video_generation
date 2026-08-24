/**
 * discover.ts — ONE transcript-discovery leaf for the session-scanning CLI
 * commands (effort 2026-08-24-s2-agent-simplify ticket 03).
 *
 * Before this file existed, three commands each carried a private copy:
 *   - tools-metrics.ts had a recursive walk + `<resolveAgentDir>/sessions`
 *   - agent-trends.ts had a 2-level walk + `PI_SESSIONS_DIR` override
 *   - sessions.ts had its own recursive walk with a hardcoded ~/.pi/agent path
 * The recursive walk is the superset: on the real archive layout
 * (`sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` — every file at depth 2,
 * measured 2026-08-24: 4,730 files, zero at deeper or shallower depth) it
 * returns the same files in the same readdirSync order as agent-trends'
 * 2-level walk, so both commands now share it without output drift.
 *
 * Stays inside the cli namespace (cli/ never enters the cli-sh cjs bundle —
 * map D6) and imports nothing beyond node builtins + ../paths.ts.
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir, type AgentDirEnv } from "../../paths.ts";

/**
 * The env slice `resolveSessionsDir` reads. Accepts `process.env` verbatim or
 * any partial env record (tests pass `{ PI_SESSIONS_DIR: <tmpdir> }`).
 */
export type SessionsDirEnv = AgentDirEnv & { PI_SESSIONS_DIR?: string };

/**
 * Resolve the sessions root:
 *   $PI_SESSIONS_DIR → <resolveAgentDir>/sessions (i.e. $PI_CODING_AGENT_DIR
 *   → ~/.pi/agent), then `/sessions`.
 *
 * `PI_SESSIONS_DIR` is a legacy alias agent-trends has honored since inception;
 * it is likely a typo of pi's actual `PI_CODING_SESSION_DIR` (pi config.js
 * ENV_SESSION_DIR) but is preserved EXACTLY as-is — someone may rely on it.
 */
export function resolveSessionsDir(env: SessionsDirEnv = process.env): string {
	return env.PI_SESSIONS_DIR ?? join(resolveAgentDir(env), "sessions");
}

/** A loaded transcript: absolute path, decoded project cwd, raw JSONL lines. */
export interface SessionFile {
	path: string;
	cwd: string;
	lines: string[];
}

/** Recursively collect *.jsonl paths under `dir` (empty if absent). */
export function listSessionFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && p.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(dir);
	return out;
}

/**
 * Load up to `maxFiles` session transcripts (walk order, newest-dirs-first is
 * NOT guaranteed — callers rank by content) with the project cwd decoded from
 * the first `session` header line of each file.
 */
export function loadSessionFiles(sessionsDir: string, maxFiles = 500): SessionFile[] {
	const files: SessionFile[] = [];
	for (const p of listSessionFiles(sessionsDir).slice(0, maxFiles)) {
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
	return files;
}
