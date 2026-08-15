import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";
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

/** An existing graph card with the frontmatter fields the gate needs to
 *  distinguish a raw hermes card (upgrade candidate) from a curated one. */
interface ExistingCard {
	id: string;
	status: string;
	body: string;
}

/** Scan existing graph cards WITH frontmatter (id + status) so the gate can
 *  distinguish a raw hermes card (upgrade candidate) from a curated one.
 *  Replaces the old body-only scan — mechanism B (C1 fix). */
function existingCards(vaultPath: string): ExistingCard[] {
	const dir = join(vaultPath, "Zettelkasten", "knowledge-graph");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const raw = readFileSync(join(dir, f), "utf-8");
			const { data } = parseFrontmatter(raw);
			return {
				id: typeof data?.id === "string" ? data.id : "",
				status: typeof data?.status === "string" ? data.status.trim() : "active",
				body: raw.replace(/^---\n[\s\S]*?\n---\n/, ""),
			};
		});
}

/** RAW-card id prefixes the gate treats as UPGRADE candidates (survive + carry
 *  their id for converge to supersede) instead of true duplicates:
 *  - `hermes:<slug>`  — the CURRENT hub auto-converge adapter
 *    (convergeHermesMemory → adaptHermesMarkdown) mints these (F3: the C1
 *    partition was doc↔code drifted — the gate only knew the legacy prefix, so
 *    every auto-converged hermes card was killed as a "duplicate" and the
 *    curated upgrade path was dead-on-arrival for the live producer).
 *  - `pi-memory:*`    — legacy ids minted by the PRE-ADR-0001 hermes
 *    auto-converge (kept so older graph folders still upgrade). */
const RAW_UPGRADE_PREFIXES = ["hermes:", "pi-memory:"];

function isRawUpgradeCard(id: string, status: string): boolean {
	return status === "active" && RAW_UPGRADE_PREFIXES.some((p) => id.startsWith(p));
}

export function runGate(entries: MemoryEntry[], vaultPath: string): GateResult {
	const cards = existingCards(vaultPath);
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
		// In-batch duplicate → kill (unchanged)
		let dup = seenContents.some((c) => similarity(entry.content, c) >= SIM_THRESHOLD);
		// Cross-vault match: a raw active card (`hermes:*` — the live hub
		// auto-converge adapter — or legacy `pi-memory:*`) is an UPGRADE
		// candidate (survive + carry its id for converge to supersede); any
		// other match (curated distill:/other id, or already-superseded) is a
		// true duplicate.
		let supersedesCardId: string | undefined;
		if (!dup) {
			const match = cards.find((c) => similarity(entry.content, c.body) >= SIM_THRESHOLD);
			if (match) {
				if (isRawUpgradeCard(match.id, match.status)) {
					supersedesCardId = match.id; // upgrade candidate — do NOT kill
				} else {
					dup = true; // curated or already-superseded → true duplicate
				}
			}
		}
		if (dup) {
			killed.push({ entry, reason: "duplicate", detail: "near-identical content already present" });
			continue;
		}
		seenContents.push(entry.content);
		survivors.push({
			entry,
			reason: supersedesCardId
				? "upgrade: supersedes a raw pi-memory card"
				: "unique, recent, well-formed",
			supersedesCardId,
		});
	}

	return { candidates: entries.length, survivors, killed };
}
