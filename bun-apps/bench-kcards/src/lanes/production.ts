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
import { classifyQuestion, type QuestionClass } from "./classify.ts";
import { retrieveRecords } from "@repo/s2-agent-ext-knowledge-card/src/index.ts";

export interface ProductionMrrResult {
	questions: number;
	mrr: number;
	hitAt3: number;
	neverRanked: string[];
	/** Per-question rank detail (diagnostic column). */
	detail: { question: string; rank: number; arxivId: string; /** retrieved paths (audit column — reviewer finding 1) */ paths: string[] }[];
	/** Per-class hit@3 / MRR (kcard-hit3-residual T1) — a lever is judged
	 *  on the classes it claims to fix. Derived classification, goldens
	 *  untouched. */
	perClass: Record<QuestionClass, { n: number; hitAt3: number; mrr: number }>;
	/** Design gates as DATA rows (kcard-hit3-residual T4) — the gate lives
	 *  in the scorecard, not in a comment. pass/fail computed per run. */
	gates: { name: string; threshold: number; measured: number; pass: boolean }[];
}

export async function productionMrr(
	vaultPath: string,
	golden: { arxivId: string; questions: { question: string; answerable: boolean }[] }[],
	noteMap: Record<string, { graphNote: string }>,
	/** Receipt knob (retrieval-lift-2 α-band): override the semantic blend
	 *  weight; undefined keeps the production default (SEMANTIC_ALPHA_DEFAULT). */
	semanticAlphaOverride?: number,
): Promise<ProductionMrrResult> {
	process.env.KCARD_USAGE_LOG = process.env.KCARD_USAGE_LOG ?? "0";
	process.env.KCARD_HIER_DEFAULT = process.env.KCARD_HIER_DEFAULT ?? "0";
	const recips: number[] = [];
	const neverRanked: string[] = [];
	const detail: { question: string; rank: number; arxivId: string; paths: string[] }[] = [];
	const perClassRecips: Record<QuestionClass, number[]> = {
		"relation-anchored": [],
		"relation-bare": [],
		page: [],
		topical: [],
	};
	for (const paper of golden) {
		const entry = noteMap[paper.arxivId];
		if (!entry || !entry.graphNote) continue;
		for (const q of paper.questions) {
			if (!q.answerable) continue;
			const opts = buildRetrieveOptions(
				{ tags: inferQueryTags(q.question), query: q.question, topK: 10 },
				vaultPath,
			);
			if (semanticAlphaOverride !== undefined) opts.semanticAlpha = semanticAlphaOverride;
			const res = await retrieveRecords(opts);
			const paths = res.cards.map((c) => (c as { path?: string }).path ?? "");
			// EXACT basename equality — the degenerate pure-CJK slug
			// `generic-paper` is a substring of every `generic-paper-*` note
			// name, so `includes` let it false-hit 12/13 targets (reviewer
			// finding 1; latent — no measured inflation, now un-landmine-able).
			const targetBase = entry.graphNote.split("/").pop() ?? "\u0000";
			const rank = paths.findIndex((p) => p.split("/").pop() === targetBase) + 1;
			recips.push(rank === 0 ? 0 : 1 / rank);
			perClassRecips[classifyQuestion(q.question)].push(rank === 0 ? 0 : 1 / rank);
			if (rank === 0) neverRanked.push(paper.arxivId);
			detail.push({ question: q.question, rank, arxivId: paper.arxivId, paths });
		}
	}
	const mrr = recips.length === 0 ? 0 : recips.reduce((a, b) => a + b, 0) / recips.length;
	const hitAt3 = recips.length === 0 ? 0 : recips.filter((r) => r > 0 && 1 / r <= 3).length / recips.length;
	const perClass = Object.fromEntries(
		Object.entries(perClassRecips).map(([cls, rs]) => [
			cls,
			{
				n: rs.length,
				hitAt3: rs.length ? rs.filter((r) => r > 0 && 1 / r <= 3).length / rs.length : 0,
				mrr: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
			},
		]),
	) as Record<QuestionClass, { n: number; hitAt3: number; mrr: number }>;
	const gates = [
		{ name: "mrr", threshold: 0.7, measured: mrr, pass: mrr >= 0.7 },
		{ name: "hitAt3", threshold: 0.85, measured: hitAt3, pass: hitAt3 >= 0.85 },
		{ name: "hitAt3:relation-anchored", threshold: 0.75, measured: perClass["relation-anchored"].hitAt3, pass: perClass["relation-anchored"].hitAt3 >= 0.75 },
		{ name: "hitAt3:page", threshold: 0.6, measured: perClass.page.hitAt3, pass: perClass.page.hitAt3 >= 0.6 },
		{ name: "hitAt3:topical-no-regression", threshold: 0.885, measured: perClass.topical.hitAt3, pass: perClass.topical.hitAt3 >= 0.885 },
		// relation-bare (4 questions, 3 byte-equal targeting 3 different
		// cards) is structurally unservable by question-only retrieval —
		// recorded gap with probe evidence, never gated as passable.
	];
	return { questions: recips.length, mrr, hitAt3, neverRanked: [...new Set(neverRanked)], detail, perClass, gates };
}
