/** Offline pre-adjudication probe: relation-mention overlap vs 連結 sections. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cjkBigrams } from "/Users/huangziyu/proj/video_generation__file2md/bun-apps/s2-agent-ext-knowledge-card/src/card-format.ts";
import { buildNoteMap } from "/Users/huangziyu/proj/video_generation__file2md/bun-apps/bench-kcards/src/lanes/query-gates.ts";

const VAULT = "/Users/huangziyu/proj/video_generation__file2md/vaults_root/s2-agent-vault";
const KG = join(VAULT, "Zettelkasten", "knowledge-graph");
const r = JSON.parse(readFileSync("/Users/huangziyu/proj/video_generation__file2md/.planning/2026-09-15-kcard-retrieval-lift-2/receipts/production-mrr-final-tree.json", "utf8"));
const arxivIds = [...new Set(r.detail.map((d) => d.arxivId))];
const noteMap = buildNoteMap(VAULT, arxivIds);
const REL_STOP = new Set("這張 張卡 卡片 的卡 與哪 哪張 哪兩 兩張 互為 的相 相關 連結 指向 同屬 形成 對照 位於 論文 什麼 哪些 如何".split(" "));
const ascii = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, " ").trim().split(/\s+/).filter((t) => t.length >= 3 && t.length <= 30);
const linkText = (content) => {
	const lines = content.split("\n"); const out = []; let inSec = false;
	for (const ln of lines) {
		if (/^##\s/.test(ln)) { inSec = /^## 連結/.test(ln); continue; }
		if (inSec) out.push(ln);
	}
	return out.join("\n");
};
const cards = readdirSync(KG).filter((n) => n.endsWith(".md")).map((n) => {
	const raw = readFileSync(join(KG, n), "utf8");
	const lt = linkText(raw);
	return { name: n.replace(/\.md$/, ""), sig: new Set([...cjkBigrams(lt), ...ascii(lt)]), hasLinks: lt.length > 0 };
});
console.log(`cards=${cards.length} withLinks=${cards.filter((c) => c.hasLinks).length}`);
const REL = (q) => /連結/.test(q) && /相關|互為|同屬|指向/.test(q);
const anchored = (q) => REL(q) && /(理論|視覺|能力|顯式|GPU|記憶體|安全|已落地|同伴)/.test(q);
for (const d of r.detail) {
	if (!REL(d.question)) continue;
	const qTok = [...new Set([...cjkBigrams(d.question), ...ascii(d.question)])].filter((t) => !REL_STOP.has(t));
	const target = noteMap[d.arxivId]?.graphNote?.split("/").pop() ?? "??";
	const scored = cards.map((c) => ({ name: c.name, s: qTok.filter((t) => c.sig.has(t)).length })).sort((a, b) => b.s - a.s || a.name.localeCompare(b.name));
	const rank = scored.findIndex((x) => x.name === target) + 1;
	const best = scored[0];
	console.log(`${anchored(d.question) ? "ANCH" : "BARE "} ${d.arxivId} curRank=${d.rank} relRank=${rank || "-"} qTok=[${qTok.slice(0,10).join(",")}] best=${best.name}:${best.s}`);
	if (rank === 0) console.log(`      TARGET ${target} zero-scored`);
}
