#!/usr/bin/env node
// @ts-nocheck
/**
 * multi-hop-anchor-rerank-probe.mjs — C.2 CHEAP VIABILITY GATE (no LLM).
 *
 * The A.2 baseline showed: on the leak-free eval, bridge cards are pool-resident
 * (rank 6-31) but under-ranked by QUERY-tag count (they share only the bridge tag
 * with the query, losing to cluster siblings). Content-rerank is structurally
 * doomed (C.1 retired). The expensive bet is an LLM entity layer (~76 min).
 *
 * BEFORE that cost: this probe tests the CHEAPEST structural signal that could
 * surface the bridge — RE-RANK THE POOL BY SHARED-TAGS-WITH-THE-ANCHOR (not the
 * query). The anchor and bridge share many TYPE tags (gotcha/avoid/correctness/
 * sev:high) + the bridge concept tag, so an anchor-neighborhood rank should lift
 * the bridge into top-K. This is "graph-by-existing-tags" — FREE, no LLM. If it
 * clears the gate, the entity layer is unnecessary (the tag graph already has the
 * structural signal); if not, the entity bet is justified.
 *
 * GATE: fullRecall@4 >= 0.475 (baseline 0.375 + 0.10).
 */
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";
import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const FOLDER = "Zettelkasten/knowledge-graph";
const EVAL_FILE = join(REPO, "scripts/multi-hop-eval.json");
const OUT_DIR = join(REPO, "output/multi-hop-measurements");
const KS = [4, 8, 16];
const POOL = 60;
const GATE = 0.475;

function queryToTags(q) {
	return q.toLowerCase().replace(/[^a-z0-9-]+/g, " ").trim().split(/\s+/).filter((t) => t.length >= 3 && t.length <= 30).slice(0, 10);
}
function normTag(t) { return t.trim().toLowerCase().replace(/\s+/g, "-"); }
function cardMatches(c, expect) { return `${c.path} ${c.id} ${c.title}`.toLowerCase().includes(expect.toLowerCase()); }

// read a card's full tag set (normTag'd) for anchor-neighborhood scoring
const tagCache = new Map();
function cardTagSet(vault, id) {
	if (tagCache.has(id)) return tagCache.get(id);
	let tags = new Set();
	try {
		const txt = readFileSync(join(vault, FOLDER, `${id}.md`), "utf8");
		const m = txt.match(/tags:\s*\[([^\]]*)\]/);
		if (m) for (const t of m[1].split(",")) { const nt = normTag(t.trim().replace(/^["']|["']$/g, "")); if (nt) tags.add(nt); }
	} catch { /* missing */ }
	tagCache.set(id, tags);
	return tags;
}

async function main() {
	const vault = (await resolveVault(REPO)).path;
	const evalSet = JSON.parse(readFileSync(EVAL_FILE, "utf8"));
	const queries = evalSet.queries;
	mkdirSync(OUT_DIR, { recursive: true });

	const baselineFull = Object.fromEntries(KS.map((k) => [k, 0]));
	const anchorFull = Object.fromEntries(KS.map((k) => [k, 0]));
	const perQuery = [];

	console.log(`anchor-rerank probe: ${queries.length} queries | gate fullRecall@4 >= ${GATE}\n`);

	for (let i = 0; i < queries.length; i++) {
		const item = queries[i];
		const tags = queryToTags(item.q);
		const res = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags, topK: POOL });
		const pool = res.cards; // already query-tag ranked
		const expected = item.expect;

		// resolve the anchor = first expected card found in pool (the single-hop seed)
		const anchorCard = pool.find((c) => cardMatches(c, expected[0])) ?? null;
		const anchorTags = anchorCard ? cardTagSet(vault, anchorCard.id) : new Set();

		// ANCHOR-RERANK: re-score pool by |shared tags with ANCHOR| (excluding zettel)
		const anchorRanked = [...pool].map((c) => {
			const ctags = cardTagSet(vault, c.id);
			let shared = 0;
			for (const t of anchorTags) if (ctags.has(t) && t !== "zettel") shared++;
			return { c, shared };
		}).sort((a, b) => b.shared - a.shared || a.c.id.localeCompare(b.c.id)).map((x) => x.c);

		const row = { q: item.q.slice(0, 50), bridge: item.bridgeTag, expected, anchorFound: !!anchorCard };
		for (const k of KS) {
			const topk = pool.slice(0, k);
			const topkAR = anchorRanked.slice(0, k);
			const baseFound = expected.filter((e) => topk.some((c) => cardMatches(c, e)));
			const arFound = expected.filter((e) => topkAR.some((c) => cardMatches(c, e)));
			baselineFull[k] += baseFound.length === expected.length ? 1 : 0;
			anchorFull[k] += arFound.length === expected.length ? 1 : 0;
			row[`baseFull@${k}`] = baseFound.length === expected.length;
			row[`anchorFull@${k}`] = arFound.length === expected.length;
			row[`arRanks@${k}`] = expected.map((e) => { const idx = anchorRanked.findIndex((c) => cardMatches(c, e)); return idx < 0 ? null : idx + 1; });
		}
		perQuery.push(row);
		console.log(`[${String(i + 1).padStart(2)}/${queries.length}] ${item.bridgeTag.padEnd(14)} anchor=${anchorCard ? anchorCard.id.slice(0, 28).padEnd(28) : "NOT FOUND"} baseF@4=${row.baseFullAt4 ?? row["baseFull@4"]}?"+":"x"} arRanks@4=${JSON.stringify(row["arRanks@4"])}`);
	}

	const n = queries.length;
	console.log("\n=== ANCHOR-RERANK PROBE (receipt) ===");
	for (const k of KS) {
		const b = baselineFull[k] / n, a = anchorFull[k] / n;
		console.log(`  fullRecall@${k}  baseline=${b.toFixed(3)}  anchor-rerank=${a.toFixed(3)}  Δ=${(a - b >= 0 ? "+" : "")}${(a - b).toFixed(3)}`);
	}
	const d4 = anchorFull[4] / n - baselineFull[4] / n;
	const verdict = anchorFull[4] / n >= GATE
		? `→ WINS (fullRecall@4 ${(anchorFull[4] / n).toFixed(3)} >= ${GATE}) — anchor-neighborhood re-rank is the FREE lever; entity LLM extraction UNNECESSARY`
		: d4 > 0
			? `→ positive (+${d4.toFixed(3)}) but below gate — partial; entity layer may still add signal`
			: `→ neutral/negative — anchor-neighborhood doesn't bridge; entity LLM extraction JUSTIFIED`;
	console.log(`\n${verdict}`);

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const receipt = { timestamp: new Date().toISOString(), mode: "anchor-rerank probe (no LLM)", gate: GATE, baselineFullRecall4: baselineFull[4] / n, anchorFullRecall4: anchorFull[4] / n, perQuery };
	writeFileSync(join(OUT_DIR, `anchor-rerank-probe-${ts}.json`), JSON.stringify(receipt, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
