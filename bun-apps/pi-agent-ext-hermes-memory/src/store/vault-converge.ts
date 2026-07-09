/**
 * Single-hop memory → vault convergence.
 *
 * Collapses the old 2-step handoff (memory `transfer` wrote a
 * `.knowledge.jsonl` archive, then the caller manually ran `zk_ingest`) into
 * ONE step: `transfer` calls `convergeToVault`, which resolves the default
 * vault (via pi-obsidian's `resolveVault`) and ingests the entries directly as
 * atomic zettel cards via pi-knowledge-card's `ingestRecords`.
 *
 * Optional dependency — standalone-safe:
 *   `pi-knowledge-card` + `pi-obsidian` are dynamically imported. If they are
 *   absent (a standalone pi-hermes-memory install without the knowledge-card
 *   extension), `convergeToVault` returns `{ ok: false, reason: "unavailable" }`
 *   and the caller falls back to the archive-handoff message. This keeps the
 *   published package working without the workspace-only knowledge graph.
 *
 * Idempotent ids:
 *   The canonical record id is `pi-memory:<target>:<shortHash(entry)>` — a
 *   stable hash of the entry text, so re-converging the same entry upserts the
 *   SAME card (created → updated → unchanged) instead of spawning duplicates.
 */

/** A lightweight stable record shape — mapped 1:1 onto KnowledgeRecord by
 *  ingestRecords. Kept structural so this module does not import the type at
 *  module-load time (preserves the dynamic-import fallback). */
interface ConvergeRecord {
	id: string;
	type: string;
	title: string;
	detail: string;
	tags: string[];
	dimension: string | null;
	confidence: number;
	status: string;
	superseded_by: string | null;
	evidence?: { extracted_at?: string };
}

export interface ConvergeCard {
	id: string;
	path: string;
}

export interface ConvergeResult {
	ok: boolean;
	/** Present when `ok === false`. */
	reason?: string;
	/** Present when `ok === true`. */
	vaultPath?: string;
	created?: number;
	updated?: number;
	unchanged?: number;
	skipped?: number;
	linked?: number;
	wikiMerged?: number;
	cards?: ConvergeCard[];
	/** True when the knowledge-card extension was not available and the caller
	 *  should fall back to the archive-handoff path. */
	unavailable?: boolean;
}

/** DJB2 string hash → base36, truncated. Stable across runs for the same
 *  input (no Math.random / Date), so converge is idempotent. */
function shortHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36);
}

/** Build the stable KnowledgeRecord-shaped object for a single memory entry.
 *  One entry → one card (atomic). The entry text is the detail; the title is
 *  its first line truncated. */
function entryToRecord(
	entry: string,
	target: "memory" | "user" | "failure",
	projectName?: string | null,
): ConvergeRecord {
	const id = `pi-memory:${target}:${shortHash(entry)}`;
	const tags = ["pi-memory", `target:${target}`];
	if (projectName && projectName.trim()) tags.push(projectName.trim());
	return {
		id,
		// "pattern" is the general knowledge record_type (memory is human-curated,
		// not a workflow gotcha/lever). The target + category ride as tags.
		type: "pattern",
		title: entry.slice(0, 80).replace(/\n/g, " ").trim() || "(memory entry)",
		detail: entry,
		tags,
		dimension: target,
		confidence: 1,
		status: "active",
		superseded_by: null,
		evidence: { extracted_at: new Date().toISOString() },
	};
}

/**
 * Resolve the default vault and ingest `entries` as atomic zettel cards in one
 * step. Returns a {@link ConvergeResult}; never throws — all failures are
 * reported via `ok: false` + `reason` so the caller can fall back gracefully.
 *
 * @param cwd   the agent's working directory (vault resolution Tier 1b config
 *              is relative to this).
 */
export async function convergeToVault(
	entries: string[],
	target: "memory" | "user" | "failure",
	cwd: string,
	projectName?: string | null,
): Promise<ConvergeResult> {
	if (entries.length === 0) {
		return { ok: true, created: 0, updated: 0, unchanged: 0, skipped: 0, linked: 0, cards: [] };
	}

	// Dynamic import — keeps pi-hermes-memory standalone-safe when the
	// knowledge-card extension is not installed.
	let resolveVaultFn: ((cwd: string) => Promise<{ path: string }>) | null = null;
	let ingestRecordsFn: ((records: ConvergeRecord[], opts: {
		vaultPath: string;
		source: string;
		sourceLabel: string;
		folder?: string;
	}) => Promise<IngestShape>) | null = null;
	try {
		// @ts-expect-error — optional workspace peer; not declared in dependencies
		const obs = await import("@repo/pi-agent-ext-obsidian/extensions/obsidian.ts");
		// @ts-expect-error — optional workspace peer; not declared in dependencies
		const kc = await import("@repo/pi-agent-ext-knowledge-card/src/ingest.ts");
		resolveVaultFn = obs.resolveVault;
		ingestRecordsFn = kc.ingestRecords;
	} catch (err) {
		return {
			ok: false,
			unavailable: true,
			reason: `pi-knowledge-card / pi-obsidian not installed (${err instanceof Error ? err.message : String(err)}); use the archive file + zk_ingest handoff.`,
		};
	}

	if (typeof resolveVaultFn !== "function" || typeof ingestRecordsFn !== "function") {
		return { ok: false, unavailable: true, reason: "resolveVault / ingestRecords not exported by the installed peers." };
	}

	let vaultPath: string;
	try {
		const vault = await resolveVaultFn(cwd);
		vaultPath = vault.path;
	} catch (err) {
		return { ok: false, reason: `vault resolution failed (${err instanceof Error ? err.message : String(err)})` };
	}

	const records = entries.map((e) => entryToRecord(e, target, projectName));

	try {
		const summary = await ingestRecordsFn(records, {
			vaultPath,
			source: "hermes",
			sourceLabel: `hermes:${target}`,
			folder: "Zettelkasten/knowledge-graph",
			wikiAware: true,
			wikiThreshold: 0.85,
		});
		return {
			ok: true,
			vaultPath,
			created: summary.created,
			updated: summary.updated,
			unchanged: summary.unchanged,
			skipped: summary.skipped,
			linked: summary.linked,
			wikiMerged: summary.wikiMerged,
			cards: (summary.cards ?? []).map((c) => ({ id: c.id, path: c.path })),
		};
	} catch (err) {
		return { ok: false, reason: `ingest failed (${err instanceof Error ? err.message : String(err)})` };
	}
}

/** Structural shape of the IngestSummary we consume (kept local so the dynamic
 *  import does not need a type dependency). */
interface IngestShape {
	created: number;
	updated: number;
	unchanged: number;
	skipped: number;
	linked: number;
	wikiMerged: number;
	cards: { id: string; path: string }[];
}
