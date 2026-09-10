/**
 * lanes/production.ts — the PRODUCTION-faithful query lane (planner D1/D6):
 * golden questions flow through `inferQueryTags` + `buildRetrieveOptions` +
 * `retrieveRecords` — the exact symbols the `knowledge_query` tool serves —
 * instead of a hand-rolled ranker. The prior raw-cosine lane measured a
 * non-production path (0.153/0.162); this lane is the design gate's
 * measurement surface.
 *
 * Env: KCARD_USAGE_LOG=0 (hermetic — buildRetrieveOptions sets usageLog:true,
 * which would write ledger rows into the sandbox and tax calls on a down
 * Surreal), KCARD_HIER_DEFAULT=0 (pin the deterministic flat lane; the hier
 * lane is measured separately when Surreal + fresh index exist).
 */
import { buildRetrieveOptions, inferQueryTags } from "@repo/s2-agent-ext-knowledge-card/src/host-fns.ts";
import { retrieveRecords } from "@repo/s2-agent-ext-knowledge-card/src/index.ts";

export interface ProductionMrrResult {
	questions: number;
	mrr: number;
	hitAt3: number;
	neverRanked: string[];
	/** Per-question rank detail (diagnostic column). */
	detail: { question: string; rank: number; arxivId: string }[];
}

export async function productionMrr(
	vaultPath: string,
	golden: { arxivId: string; questions: { question: string; answerable: boolean }[] }[],
	noteMap: Record<string, { graphNote: string }>,
): Promise<ProductionMrrResult> {
	process.env.KCARD_USAGE_LOG = process.env.KCARD_USAGE_LOG ?? "0";
	process.env.KCARD_HIER_DEFAULT = process.env.KCARD_HIER_DEFAULT ?? "0";
	const recips: number[] = [];
	const neverRanked: string[] = [];
	const detail: { question: string; rank: number; arxivId: string }[] = [];
	for (const paper of golden) {
		const entry = noteMap[paper.arxivId];
		if (!entry || !entry.graphNote) continue;
		for (const q of paper.questions) {
			if (!q.answerable) continue;
			const opts = buildRetrieveOptions(
				{ tags: inferQueryTags(q.question), query: q.question, topK: 10 },
				vaultPath,
			);
			const res = await retrieveRecords(opts);
			const paths = res.cards.map((c) => (c as { path?: string }).path ?? "");
			const rank = paths.findIndex((p) => entry.graphNote.includes(p.split("/").pop() ?? "\u0000")) + 1;
			recips.push(rank === 0 ? 0 : 1 / rank);
			if (rank === 0) neverRanked.push(paper.arxivId);
			detail.push({ question: q.question, rank, arxivId: paper.arxivId });
		}
	}
	const mrr = recips.length === 0 ? 0 : recips.reduce((a, b) => a + b, 0) / recips.length;
	const hitAt3 = recips.length === 0 ? 0 : recips.filter((r) => r > 0 && 1 / r <= 3).length / recips.length;
	return { questions: recips.length, mrr, hitAt3, neverRanked: [...new Set(neverRanked)], detail };
}
