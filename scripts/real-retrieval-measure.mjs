#!/usr/bin/env node
// @ts-nocheck
/**
 * real-retrieval-measure.mjs — deterministic retrieval-quality measurement
 * for the real-retrieval-validation cycle.
 *
 * WHAT THIS MEASURES (all deterministic, no LLM, no model noise)
 *   For each real query in scripts/real-retrieval-eval.json:
 *     1. Tokenize the query into tags (the SAME logic knowledge_query uses).
 *     2. retrieveRecords(tags, topK=60) — one call returns every scored card
 *        with its `sharedTags` and `hasCallouts` retained in the output.
 *     3. Re-rank WITH boost:    sort by sharedTags + (hasCallouts ? 0.5 : 0).
 *        Re-rank WITHOUT boost: sort by sharedTags only.
 *        (Both from the SAME data — the boost is recoverable from the output,
 *         so no production code change is needed to run the ablation.)
 *     4. Check whether the expected card is in the top-4 of each ranking.
 *
 * METRICS
 *   A. hitRate@4 (natural-tokenized query, WITH boost)  — real-world recall.
 *   A'. hitRate@4 using the expected card's OWN tags     — sanity (is the card
 *        retrievable at all when you query with its tags?).
 *   B. calloutSurfaceRate — for callout-bearing expected cards that DID hit,
 *        did the callout headline text reach the digest?
 *   C. P1 ablation Δ = hitRateWithBoost − hitRateWithoutBoost  — P1's real-world
 *        contribution (the decisive metric).
 *
 * OUTPUT: output/real-retrieval-measurements/measure-<ts>.json (the receipt).
 *
 * HONEST DESIGN: a null/negative Δ is a VALID outcome — it means P1's bounded
 * tie-break boost doesn't move real-world ranking (callout cards rarely tie an
 * equal-tag prose card AND matter for top-4 at 20/449 density). Do NOT
 * manufacture a positive delta.
 */
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";
import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const FOLDER = "Zettelkasten/knowledge-graph";
const TOPK = 4; // relevance@4, matching iter-7

// --- query → tags (identical to knowledge_query's inference) ---
function queryToTags(q) {
	return q.toLowerCase()
		.replace(/[^a-z0-9-]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((t) => t.length >= 3 && t.length <= 30)
		.slice(0, 10);
}

function rankWith(cards, boost) {
	const scored = cards.map((c) => ({
		c,
		s: c.sharedTags + (boost && c.hasCallouts ? 0.5 : 0),
	}));
	scored.sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id));
	return scored.map((x) => x.c);
}

function cardMatches(c, expect) {
	const hay = `${c.path} ${c.id} ${c.title}`.toLowerCase();
	return hay.includes(expect.toLowerCase());
}

// --- full-text proxy for zk_ask recall ---
// zk_ask uses obsidian_search (full-text over card BODIES), not shared-tags.
// A query word appearing in the expected card's body+title is a proxy for
// "zk_ask's obsidian_search would find this card". This does NOT need the LLM.
const STOP = new Set(["the","and","for","with","that","this","how","why","does","was","were","after","before","when","what","have","has","not","but","are","is","it","to","of","in","on","my","i","a","an","run","set","even","right","out","come","made","one","them","applied"]);
function fullTextMatch(vault, folder, expect, naturalTags) {
	// find the expected card file
	const slug = expect;
	const candidates = [
		join(vault, folder, `${slug}.md`),
		join(vault, folder, `gotcha-${slug}.md`),
		join(vault, folder, `auto-memory-${slug}.md`),
	];
	let body = "";
	for (const p of candidates) { if (existsSync(p)) { body = readFileSync(p, "utf8").toLowerCase(); break; } }
	if (!body) return { matched: false, reason: "file-not-found", tokens: [] };
	const tokens = naturalTags.filter((t) => !STOP.has(t) && body.includes(t));
	return { matched: tokens.length > 0, tokens };
}

async function main() {
	const vault = (await resolveVault(REPO)).path;
	const evalSet = JSON.parse(readFileSync(`${REPO}/scripts/real-retrieval-eval.json`, "utf8"));
	const queries = evalSet.queries;

	const results = [];
	let hitNatural = 0, hitOwnTags = 0, calloutHit = 0, calloutTotal = 0;
	let hitWithBoost = 0, hitWithoutBoost = 0, fullTextHit = 0;

	for (const item of queries) {
		const naturalTags = queryToTags(item.q);
		// retrieve a wide top so re-ranking is meaningful
		const res = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: naturalTags, topK: 60 });
		const cards = res.cards;

		const withBoost = rankWith(cards, true).slice(0, TOPK);
		const withoutBoost = rankWith(cards, false).slice(0, TOPK);

		const hitNaturalBool = withBoost.some((c) => cardMatches(c, item.expect));
		const hitWB = withBoost.some((c) => cardMatches(c, item.expect));
		const hitWoB = withoutBoost.some((c) => cardMatches(c, item.expect));

		// sanity: query with the expected card's own tags (if any seeded card)
		let hitOwnBool = null;
		let ownTagsRank = null;
		// find the expected card in the FULL vault via a tag it carries
		// (use a distinctive tag from the expect slug's domain)
		const sanityTag = item.expect.split("-")[0]; // e.g. 'fp8','vae','seedvr2','argparse'
		if (sanityTag && sanityTag.length >= 3) {
			const sanity = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: [sanityTag], topK: 60 });
			const sRanked = rankWith(sanity.cards, true);
			const idx = sRanked.findIndex((c) => cardMatches(c, item.expect));
			hitOwnBool = idx >= 0 && idx < TOPK;
			ownTagsRank = idx;
		}

		// Metric B: callout surfacing
		let calloutSurfaced = null;
		if (item.calloutCard) {
			calloutTotal++;
			const hitCard = withBoost.find((c) => cardMatches(c, item.expect));
			if (hitCard) {
				calloutHit++;
				calloutSurfaced = !!(hitCard.calloutText && hitCard.calloutText.length > 0);
			} else {
				calloutSurfaced = false;
			}
		}

		// Metric E: full-text proxy (zk_ask recall estimate)
		const ft = fullTextMatch(vault, FOLDER, item.expect, naturalTags);

		if (hitNaturalBool) hitNatural++;
		if (hitOwnBool) hitOwnTags++;
		if (hitWB) hitWithBoost++;
		if (hitWoB) hitWithoutBoost++;
		if (ft.matched) fullTextHit++;

		results.push({
			q: item.q,
			expect: item.expect,
			calloutCard: item.calloutCard,
			naturalTags,
			scanned: res.scanned,
			sharedMax: cards.length ? Math.max(...cards.map((c) => c.sharedTags)) : 0,
			hitNatural: hitNaturalBool,
			hitWithBoost: hitWB,
			hitWithoutBoost: hitWoB,
			boostFlippedRank: hitWB !== hitWoB,
			ownTagHit: hitOwnBool,
			ownTagRank: ownTagsRank,
			calloutSurfaced,
			fullTextProxy: ft,
			top4WithBoost: withBoost.map((c) => ({ id: c.id, shared: c.sharedTags, callout: c.hasCallouts })),
		});
	}

	const total = queries.length;
	const receipt = {
		timestamp: new Date().toISOString(),
		vault,
		folder: FOLDER,
		totalQueries: total,
		metrics: {
			A_hitRateNatural: { value: hitNatural / total, raw: `${hitNatural}/${total}`, note: "natural-language query tokenized to tags (what knowledge_query does)" },
			Aprime_hitRateOwnTag: { value: hitOwnTags / total, raw: `${hitOwnTags}/${total}`, note: "sanity — query using a tag the expected card carries" },
			B_calloutSurfaceRate: { value: calloutTotal ? calloutHit / calloutTotal : null, raw: `${calloutHit}/${calloutTotal}`, note: "callout-bearing expected cards that surfaced in top-4" },
			C_p1AblationDelta: { value: (hitWithBoost - hitWithoutBoost) / total, raw: `withBoost ${hitWithBoost}/${total} − withoutBoost ${hitWithoutBoost}/${total}`, note: "P1's real-world contribution (decisive)" },
			E_fullTextProxy: { value: fullTextHit / total, raw: `${fullTextHit}/${total}`, note: "zk_ask recall ESTIMATE — query tokens appear in expected card body (obsidian_search would find it). NOT a live zk_ask run." },
			boostFlippedCount: results.filter((r) => r.boostFlippedRank).length,
		},
		results,
	};

	const dir = `${REPO}/output/real-retrieval-measurements`;
	mkdirSync(dir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const out = `${dir}/measure-${ts}.json`;
	writeFileSync(out, JSON.stringify(receipt, null, 2));

	console.log("\n=== REAL RETRIEVAL MEASUREMENT (receipt) ===");
	console.log(JSON.stringify(receipt.metrics, null, 2));
	console.log(`\nreceipt: ${out}`);
	console.log(`queries where boost flipped rank: ${receipt.metrics.boostFlippedCount}/${total}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
