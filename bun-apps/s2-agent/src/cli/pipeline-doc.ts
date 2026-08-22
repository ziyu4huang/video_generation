/**
 * Shared helpers for the resumable pipeline.json coordination layer used by
 * the `pipeline` orchestrator commands (pdf-to-vault, memory-to-vault).
 *
 * Each command owns its own doc TYPE (their stage schemas genuinely differ);
 * only the timestamp + read/write plumbing is shared here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Compact local timestamp: YYYYMMDD-HHMMSS (run-dir naming sort = chronological). */
export function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const iso = () => new Date().toISOString();

/**
 * Write a pipeline doc, stamping updatedAt. Trailing newline so the file is
 * diff/git friendly.
 */
export function writePipelineJson<T extends { updatedAt: string }>(
	path: string,
	doc: T,
): void {
	doc.updatedAt = iso();
	writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

/** Best-effort read: null when missing or corrupt (a torn write must not kill resume). */
export function readPipelineJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}
