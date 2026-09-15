/** Gate-inertness proof (offline, deterministic): for all 66 non-relation
 *  golden questions, the lexical lane (semantic:false) must produce
 *  BYTE-IDENTICAL results with vs without the T2 lever. */
import { openConvergedSandbox } from "/Users/huangziyu/proj/video_generation__file2md/bun-apps/bench-kcards/src/converge-sandbox.ts";
import { realVaultPath } from "/Users/huangziyu/proj/video_generation__file2md/bun-apps/bench-kcards/src/vault-sandbox.ts";
import { buildNoteMap } from "/Users/huangziyu/proj/video_generation__file2md/bun-apps/bench-kcards/src/lanes/query-gates.ts";
import { classifyQuestion, isRelationIntent } from "/Users/huangziyu/proj/video_generation__file2md/bun-apps/bench-kcards/src/lanes/classify.ts";
import { inferQueryTags, buildRetrieveOptions } from "/Users/huangziyu/proj/video_generation__file2md/bun-apps/s2-agent-ext-knowledge-card/src/host-fns.ts";
import { retrieveRecords } from "/Users/huangziyu/proj/video_generation__file2md/bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const GOLDEN_V2 = "/Users/huangziyu/proj/video_generation__file2md/bun-apps/bench-kcards/fixtures/golden-v2";
const goldens = readdirSync(GOLDEN_V2).filter((f) => f.endsWith(".json")).sort()
	.map((f) => { const g = JSON.parse(readFileSync(join(GOLDEN_V2, f), "utf8")); return { ...g, arxivId: String(g.arxivId).replace(/^arXiv:/, "") }; });
const { vaultPath } = await openConvergedSandbox(realVaultPath(), join(realVaultPath(), "Zettelkasten"));
const noteMap = buildNoteMap(vaultPath, goldens.map((g) => g.arxivId));
const out: string[] = [];
for (const paper of goldens) {
	const entry = noteMap[paper.arxivId];
	if (!entry?.graphNote) continue;
	for (const q of paper.questions) {
		if (!q.answerable) continue;
		const cls = classifyQuestion(q.question);
		if (isRelationIntent(q.question)) continue; // relation queries: lever intended
		const opts = { ...buildRetrieveOptions({ tags: inferQueryTags(q.question), query: q.question, topK: 10 }, vaultPath), semantic: false, usageLog: false } as never;
		const res = await retrieveRecords(opts);
		out.push(`${paper.arxivId}|${cls}|${res.cards.map((c) => c.id).join(",")}`);
	}
}
writeFileSync(process.argv[2]!, out.join("\n"));
console.log(`wrote ${out.length} non-relation question signatures -> ${process.argv[2]}`);
