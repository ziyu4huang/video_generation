import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HISTORY_CAP = 100;

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
	return join(agentDir, "prompt-history", projectKey(cwd), "history.jsonl");
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
