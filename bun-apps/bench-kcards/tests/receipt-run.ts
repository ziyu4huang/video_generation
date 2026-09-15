/** One-off receipt runner (retrieval-lift-2 T4): opens the converged sandbox
 *  on the CURRENT tree, measures the production lane, dumps per-question
 *  detail + summary JSON to the effort receipts dir. Not a test file — run
 *  directly: BENCH_EMBED=1 bun tests/receipt-run.ts <label> */
import { openConvergedSandbox } from "../src/converge-sandbox.ts";
import { realVaultPath } from "../src/vault-sandbox.ts";
import { buildNoteMap } from "../src/lanes/query-gates.ts";
import { productionMrr } from "../src/lanes/production.ts";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const label = process.argv[2] ?? "run";
const alpha = process.argv[3] ? Number(process.argv[3]) : undefined;
const outDir = process.argv[4] ?? join(import.meta.dir, "..", "..", "..", ".planning", "2026-09-15-kcard-retrieval-lift-2", "receipts");
const dir = join(import.meta.dir, "..");
const GOLDEN_V2 = join(dir, "fixtures", "golden-v2");
const goldens = readdirSync(GOLDEN_V2).filter((f) => f.endsWith(".json")).sort()
	.map((f) => {
				const g = JSON.parse(readFileSync(join(GOLDEN_V2, f), "utf8"));
				return { ...g, arxivId: String(g.arxivId).replace(/^arXiv:/, "") };
			});
const { vaultPath } = await openConvergedSandbox(realVaultPath(), join(realVaultPath(), "Zettelkasten"));
const noteMap = buildNoteMap(vaultPath, goldens.map((g) => g.arxivId));
const r = await productionMrr(vaultPath, goldens, noteMap, alpha);
const zh = r.detail.filter((d) => !/[a-z]{3}/i.test(d.question.replace(/arXiv|GPT|LLM|CUDA|GPU|h\d|p\.\d/gi, "")));
const en = r.detail.filter((d) => !zh.includes(d));
const mrrOf = (rows: { rank: number }[]) => (rows.length ? rows.reduce((a, d) => a + (d.rank ? 1 / d.rank : 0), 0) / rows.length : 0);
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `production-mrr-${label}.json`);
writeFileSync(out, JSON.stringify({ label, alpha: alpha ?? 0.18, mrr: r.mrr, hitAt3: r.hitAt3, questions: r.questions, neverRanked: r.neverRanked, perClass: r.perClass, langSplit: { zhMrr: mrrOf(zh), enMrr: mrrOf(en), zhN: zh.length, enN: en.length }, detail: r.detail }, null, 1));
console.log(`[${label}] MRR=${r.mrr.toFixed(3)} hit@3=${r.hitAt3.toFixed(3)} questions=${r.questions} neverRanked=${r.neverRanked.length} zhMRR=${mrrOf(zh).toFixed(3)}(${zh.length}) enMRR=${mrrOf(en).toFixed(3)}(${en.length})`);
console.log("receipt:", out);
