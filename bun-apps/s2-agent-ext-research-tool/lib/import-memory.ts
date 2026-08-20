/**
 * pi-hermes-memory → vault-mind collection importer.
 * Port of study-news import-hermes-to-vaultmind.js.
 *
 * Fixes vs. original:
 *  - No hardcoded Windows paths. HERMES_DIR resolves from $HOME
 *    (~/.pi/agent/pi-hermes-memory), overridable via PI_HERMES_MEMORY_DIR env.
 *  - Output collection path resolves via the active vault (lib/vault.ts),
 *    overridable via `outputPath` param.
 */
import { existsSync, readFileSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface HermesEntry {
	id: string;
	domain: string;
	source: string;
	fact: string;
	tag: string;
	created: string;
}

export interface ImportResult {
	total: number;
	added: number;
	existing: number;
	outputPath: string;
}

/** Resolve the hermes-memory directory (cross-platform). */
export function resolveHermesDir(): string {
	return process.env.PI_HERMES_MEMORY_DIR ?? join(homedir(), ".pi", "agent", "pi-hermes-memory");
}

const FILE_MAP = [
	{ file: "MEMORY.md", domain: "pi-memory", source: "hermes-memory", tag: "global-memory" },
	{ file: "USER.md", domain: "user", source: "hermes-user", tag: "user-preference" },
	{ file: "failures.md", domain: "pi-failure", source: "hermes-failure", tag: "lesson" },
] as const;

/** Parse §-delimited hermes entries (with optional <!-- created=… --> + [category]). */
export function parseEntries(text: string, domain: string, source: string, baseTag: string): HermesEntry[] {
	const entries: HermesEntry[] = [];
	const sections = text.split("§");
	let seq = 0;
	for (const raw of sections) {
		const section = raw.trim();
		if (!section) continue;
		const dateMatch = section.match(/<!--\s*created=([^,]+?)(?:,\s*last=[^>]+?)?\s*-->/);
		const created = dateMatch ? (dateMatch[1] ?? "").trim() : new Date().toISOString().slice(0, 10);
		const categoryMatch = section.match(/^\[(\w+)\]\s*/);
		const category = categoryMatch ? categoryMatch[1] : null;
		const fact = section
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/^\[\w+\]\s*/, "")
			.replace(/—\s*Failed:.*$/, "")
			.trim();
		if (!fact) continue;
		seq++;
		entries.push({
			id: `${domain}-${seq}`,
			domain,
			source,
			fact,
			tag: category ? `${baseTag}-${category}` : baseTag,
			created,
		});
	}
	return entries;
}

/** Read existing ids from a jsonl collection (dedup set). */
function readExistingIds(outputPath: string): Set<string> {
	const ids = new Set<string>();
	if (!existsSync(outputPath)) return ids;
	const lines = readFileSync(outputPath, "utf-8").trim().split("\n").filter(Boolean);
	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			if (obj.id) ids.add(obj.id);
		} catch {
			// skip malformed
		}
	}
	return ids;
}

/**
 * Import hermes MEMORY/USER/failures → jsonl (dedup by id).
 * `hermesDir` and `outputPath` default to cross-platform locations.
 */
export function importMemory(outputPath: string, hermesDir = resolveHermesDir(), dryRun = false): ImportResult {
	let allEntries: HermesEntry[] = [];
	for (const meta of FILE_MAP) {
		const filePath = join(hermesDir, meta.file);
		if (!existsSync(filePath)) continue;
		const content = readFileSync(filePath, "utf-8");
		allEntries = allEntries.concat(parseEntries(content, meta.domain, meta.source, meta.tag));
	}
	const total = allEntries.length;
	const existingIds = readExistingIds(outputPath);
	const newEntries = allEntries.filter((e) => !existingIds.has(e.id));
	if (!dryRun && newEntries.length > 0) {
		const fd = openSync(outputPath, "as");
		writeSync(fd, "\n" + newEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");
		closeSync(fd);
	}
	return {
		total,
		added: newEntries.length,
		existing: total - newEntries.length,
		outputPath,
	};
}
