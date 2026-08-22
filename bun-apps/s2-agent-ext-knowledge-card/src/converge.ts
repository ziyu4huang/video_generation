/**
 * src/converge.ts — route a `pi:knowledge` bus emission to the deterministic
 * ingest sink. Owned by the HUB (tier rule): foundation extensions emit on the
 * bus without importing the hub; this module + the subscriber in
 * extensions/knowledge-card.ts are the sink side.
 *
 * Pure w.r.t. vault resolution — the caller passes `vaultPath` (resolved by the
 * subscriber via `resolveVault`), so this module is unit-testable with a temp
 * vault and no env coupling.
 */
import { readFileSync } from "node:fs";
import { ingestRecords } from "./ingest.ts";
import {
	collectInputFiles,
	adaptGenericMarkdown,
	parseKnowledgeJsonl,
} from "./adapters.ts";
import type { KnowledgeRecord, IngestSummary } from "./types.ts";
import type { KnowledgeEmission } from "./emit.ts";

export interface ConvergeOptions {
	/** Absolute vault path (the convergence sink — single shared vault). */
	vaultPath: string;
	/** cwd used to resolve relative dir/kbFile paths in the payload. */
	cwd: string;
	/** Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). */
	folder?: string;
}

/**
 * Route a {@link KnowledgeEmission} to `ingestRecords`:
 *  - `dir`     → directory-expansion generic ingest (file2md's path): recurse
 *               the dir, `adaptGenericMarkdown` per `.md`, ingest as `generic`.
 *  - `kbFile`  → `parseKnowledgeJsonl` the file, ingest.
 *  - `records` → ingest the inline records as-is.
 * Returns the ingest summary, or `null` if the payload carried no records.
 * Does NOT vault-resolve (caller does) and does NOT swallow — the subscriber
 * wraps this in its own try/catch.
 */
export async function convergeKnowledgeEmission(
	payload: KnowledgeEmission,
	opts: ConvergeOptions,
): Promise<IngestSummary | null> {
	const records: KnowledgeRecord[] = [];

	if (payload.dir) {
		const { files } = collectInputFiles([payload.dir], { source: "generic", cwd: opts.cwd });
		for (const abs of files) {
			const rec = adaptGenericMarkdown(readFileSync(abs, "utf8"), abs);
			if (rec) records.push(rec);
		}
	} else if (payload.kbFile) {
		records.push(...parseKnowledgeJsonl(readFileSync(payload.kbFile, "utf8")).records);
	} else if (payload.records?.length) {
		records.push(...payload.records);
	}

	if (records.length === 0) return null;

	return ingestRecords(records, {
		vaultPath: opts.vaultPath,
		source: payload.source,
		sourceLabel: payload.sourceLabel,
		folder: opts.folder,
		wikiAware: true,
	});
}
