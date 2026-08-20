/**
 * markSuperseded — flip a card's `status` to `superseded` + set `superseded_by`.
 *
 * Used by zk_ingest converge action (mechanism B) to retire a raw
 * `hermes:*` / legacy `pi-memory:*` card when a curated `distill:*` card is
 * written on top of it. retrieveRecords already excludes `status: superseded`
 * cards (`retrieve.ts:426,572`), so the raw card silently drops out of answers
 * once superseded — leaving the curated one as the single active card for that
 * knowledge.
 *
 * Surgical: rewrites ONLY the `status` and `superseded_by` frontmatter lines
 * (never the body or other additive keys). Idempotent — a card already
 * superseded by the same id is a no-op (returns `updated: false`).
 *
 * Library only — no ExtensionAPI, no LLM, no network. Reuses pi-obsidian's
 * `parseFrontmatter` (the card-format owner) to locate the card by id.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@repo/pi-agent-ext-obsidian";
import { yamlScalar } from "./card-format.ts";

const GRAPH_FOLDER = "Zettelkasten/knowledge-graph";

export interface SupersedeResult {
	/** True if a card with `cardId` was found in the graph folder. */
	found: boolean;
	/** True if the card's frontmatter was actually changed this call. */
	updated: boolean;
	/** Path of the (super)seeded card, when found. */
	path?: string;
}

/**
 * Mark the card with `cardId` as superseded by `supersededById`.
 *
 * @param cardId          the raw card id to retire (e.g. `pi-memory:failure:<hash>`).
 * @param supersededById  the curated card id that replaces it (e.g. `distill:<slug>`).
 * @param vaultPath       the Obsidian vault root.
 */
export function markSuperseded(
	cardId: string,
	supersededById: string,
	vaultPath: string,
): SupersedeResult {
	const dir = join(vaultPath, GRAPH_FOLDER);
	if (!existsSync(dir)) return { found: false, updated: false };

	let targetPath: string | null = null;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".md")) continue;
		const raw = readFileSync(join(dir, f), "utf-8");
		const { data } = parseFrontmatter(raw);
		if (data && data.id === cardId) {
			targetPath = join(dir, f);
			break;
		}
	}
	if (targetPath === null) return { found: false, updated: false };

	const raw = readFileSync(targetPath, "utf-8");
	const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) return { found: true, updated: false, path: targetPath };

	const before = fmMatch[1]!; // invariant: fmMatch truthy (guarded above) + 1 mandatory capture group
	let fm = before.replace(/^status:.*$/m, `status: superseded`);
	if (/^superseded_by:/m.test(fm)) {
		fm = fm.replace(/^superseded_by:.*$/m, `superseded_by: ${yamlScalar(supersededById)}`);
	} else {
		fm = fm.replace(/^(status: superseded)$/m, `$1\nsuperseded_by: ${yamlScalar(supersededById)}`);
	}
	if (fm === before) return { found: true, updated: false, path: targetPath };

	const out = `---\n${fm}\n---` + raw.slice(fmMatch[0].length);
	writeFileSync(targetPath, out);
	return { found: true, updated: true, path: targetPath };
}
