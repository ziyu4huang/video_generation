import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HISTORY_CAP = 100;

/**
 * CACHE-COMPAT POLICY (2026-08-22) — semver-style, per the user's rule:
 *
 *   The cache is keyed ONLY by project cwd (`projectKey`). Compatible
 *   extension/schema changes must NEVER move it — x.y.* shares the cache.
 *   Only an INCOMPATIBLE format change (a version where the old reader
 *   could misread the file) bumps `SCHEMA_VERSION`, and the bump changes
 *   the FILENAME (`history.jsonl` → `history.v<N>.jsonl`), never the
 *   directory: the old file is left in place, not migrated, not deleted.
 *
 * Why filename-not-directory: the directory is the project identity; churning
 * it on every release re-created the "cache always changes" symptom observed
 * on 2026-08-22 (30 throwaway `0.1.0-g<sha>-*` dirs from deploy/e2e runs,
 * whose cwd WAS the version dir — fixed separately by the agent-dir isolation
 * in the deploy e2e suites).
 *
 * v1 format: newline-delimited JSON strings, newest-first, HISTORY_CAP cap.
 */
export const SCHEMA_VERSION = 1;

/** The history filename for a schema version — `history.jsonl` for v1 (the
 * original name, byte-stable), `history.v<N>.jsonl` from v2 on. */
export function historyFileName(schemaVersion: number = SCHEMA_VERSION): string {
	return schemaVersion <= 1 ? "history.jsonl" : `history.v${schemaVersion}.jsonl`;
}

export function sanitizePathSegment(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return sanitized || "project";
}

export function projectKey(cwd: string): string {
	const projectPath = resolve(cwd);
	const slug = sanitizePathSegment(basename(projectPath) || "project");
	const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
	return `${slug}-${hash}`;
}

export function historyFilePath(cwd: string, agentDir: string = getAgentDir()): string {
	return join(agentDir, "prompt-history", projectKey(cwd), historyFileName());
}

/** Read persisted history, newest-first. Returns [] if the file is missing or unparseable. */
export function readHistory(cwd: string, agentDir: string = getAgentDir()): string[] {
	const file = historyFilePath(cwd, agentDir);
	if (!existsSync(file)) return [];
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string)
			.filter((x): x is string => typeof x === "string");
	} catch {
		return [];
	}
}

/**
 * Record a prompt (newest-first). Excludes empty, whitespace, and `!` bash lines;
 * skips a consecutive duplicate of the most-recent entry; caps at HISTORY_CAP.
 * Returns the resulting history (newest-first).
 */
export function recordPrompt(cwd: string, text: string, agentDir: string = getAgentDir()): string[] {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("!")) return readHistory(cwd, agentDir);
	const existing = readHistory(cwd, agentDir);
	if (existing.length > 0 && existing[0] === trimmed) return existing;
	const next = [trimmed, ...existing].slice(0, HISTORY_CAP);
	const file = historyFilePath(cwd, agentDir);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
	return next;
}
