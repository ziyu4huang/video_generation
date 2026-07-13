import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry, Survivor, KilledEntry, GateResult } from "./types.ts";

const STALE_DAYS = 90;
const MIN_CONTENT_LEN = 5;
const SIM_THRESHOLD = 0.72;

/** Normalize text for fuzzy comparison (lowercase, collapse whitespace, strip punctuation). */
function normalize(s: string): string {
	return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Token-based Jaccard similarity (cheap fuzzy match). */
function similarity(a: string, b: string): number {
	const ta = new Set(normalize(a).split(" ").filter((w) => w.length > 2));
	const tb = new Set(normalize(b).split(" ").filter((w) => w.length > 2));
	if (ta.size === 0 || tb.size === 0) return 0;
	let inter = 0;
	for (const w of ta) if (tb.has(w)) inter++;
	return inter / (ta.size + tb.size - inter);
}

/** Extract body text from an existing vault card (strip frontmatter). */
function cardBody(absPath: string): string {
	const raw = readFileSync(absPath, "utf-8");
	return raw.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Scan existing vault cards for body text (for cross-dedup). */
function existingCardBodies(vaultPath: string): string[] {
	const dir = join(vaultPath, "Zettelkasten", "knowledge-graph");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => cardBody(join(dir, f)));
}

export function runGate(entries: MemoryEntry[], vaultPath: string): GateResult {
	const cardBodies = existingCardBodies(vaultPath);
	const survivors: Survivor[] = [];
	const killed: KilledEntry[] = [];
	const seenContents: string[] = [];

	for (const entry of entries) {
		// Format check
		if (!entry.content || entry.content.trim().length < MIN_CONTENT_LEN) {
			killed.push({ entry, reason: "malformed", detail: "content too short or empty" });
			continue;
		}
		// Staleness check
		const lastTs = entry.last ?? entry.created;
		const ageDays = (Date.now() - new Date(lastTs).getTime()) / 86400000;
		if (ageDays > STALE_DAYS) {
			killed.push({ entry, reason: "stale", detail: `${Math.round(ageDays)} days old` });
			continue;
		}
		// Dedup against prior survivors (in-batch)
		let dup = seenContents.some((c) => similarity(entry.content, c) >= SIM_THRESHOLD);
		// Dedup against existing vault cards
		if (!dup) dup = cardBodies.some((c) => similarity(entry.content, c) >= SIM_THRESHOLD);
		if (dup) {
			killed.push({ entry, reason: "duplicate", detail: "near-identical content already present" });
			continue;
		}
		seenContents.push(entry.content);
		survivors.push({ entry, reason: "unique, recent, well-formed" });
	}

	return { candidates: entries.length, survivors, killed };
}
