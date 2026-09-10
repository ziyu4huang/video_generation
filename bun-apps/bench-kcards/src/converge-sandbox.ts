/**
 * converge-sandbox.ts — T4: converge the sandbox vault IN-PROCESS
 * (`ingestRecords`, planner D2 — never the bridge), with the two
 * structural gates that make the finding-2 bypass class impossible:
 *  - idempotence: converging the same cards twice changes nothing;
 *  - orphan red-gate: a card written directly into the vault (bypassing
 *    ingest) must be ABSENT from retrieval — proving the gates can see
 *    the difference instead of silently trusting the label.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	adaptGenericMarkdown,
	ingestRecords,
	type IngestSummary,
	type KnowledgeRecord,
} from "@repo/s2-agent-ext-knowledge-card/src/index.ts";
import { getCardEmbeddings } from "@repo/s2-agent-ext-knowledge-card/src/semantic.ts";

/** Read every `Paper - *.md` card from `cardsDir` as generic records. */
export function loadPaperCards(cardsDir: string): { rec: KnowledgeRecord; name: string }[] {
	const out: { rec: KnowledgeRecord; name: string }[] = [];
	for (const name of readdirSync(cardsDir).sort()) {
		if (!name.startsWith("Paper - ") || !name.endsWith(".md")) continue;
		const content = readFileSync(join(cardsDir, name), "utf8");
		const rec = adaptGenericMarkdown(content, name);
		if (rec) out.push({ rec, name });
	}
	return out;
}

/** Converge the loaded paper records into the sandbox vault (in-process). */
export async function converge(vaultPath: string, cards: { rec: KnowledgeRecord }[]): Promise<IngestSummary> {
	return ingestRecords(
		cards.map((c) => c.rec),
		{
			vaultPath,
			source: "generic",
			sourceLabel: "generic:paper-cards",
			folder: "Zettelkasten/knowledge-graph",
			indexRebuild: true,
		},
	);
}

/**
 * Open a fresh sandbox vault seeded with the real vault's content AND the
 * paper cards converged in-process. Returns the sandbox path + both
 * summaries (first run and the idempotence run).
 */
export async function openConvergedSandbox(
	realVaultPath: string,
	cardsDir: string,
): Promise<{
	vaultPath: string;
	first: IngestSummary;
	idempotence: IngestSummary;
	cards: { rec: KnowledgeRecord; name: string }[];
}> {
	const vaultPath = join(tmpdir(), `bench-converged-${Date.now()}-${process.pid}`);
	mkdirSync(vaultPath, { recursive: true });
	cpSync(realVaultPath, vaultPath, { recursive: true });
	// Force a fresh semantic-index build: the copied cache's fingerprint
	// (name+mtime) would otherwise reuse vectors embedded under the OLD
	// adapter composition — the lanes would measure stale text.
	rmSync(join(vaultPath, ".knowledge-semantic"), { recursive: true, force: true });
	const cards = loadPaperCards(cardsDir);
	if (cards.length === 0) throw new Error(`no Paper cards found in ${cardsDir}`);
	const first = await converge(vaultPath, cards);
	const idempotence = await converge(vaultPath, cards);
	// Refresh the file-based vector cache ONLY in the embed tier: embedding
	// all 2364 vault notes takes minutes and the offline lanes are tag-lexical
	// (they never read vectors). The MRR lane requires BENCH_EMBED=1 anyway.
	if (process.env.BENCH_EMBED === "1") {
		await getCardEmbeddings(vaultPath, "Zettelkasten/knowledge-graph");
	}
	return { vaultPath, first, idempotence, cards };
}
