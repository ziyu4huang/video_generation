#!/usr/bin/env node
// @ts-nocheck
/**
 * multi-hop-eval-leakcheck.mjs — Track A.1 ACCEPTANCE GATE (the leak-free ruler).
 *
 * A query is LEAK-FREE for the 2nd expected card if that card is NOT findable by
 * direct content match — only by the shared bridge tag. Mechanically:
 *
 *   overlap(card) = | queryTokens ∩ cardTokens | / | queryTokens |
 *
 * where queryTokens = the query minus stopwords, and cardTokens = the card's
 * id + title + body + tags tokenized the same way. The ANCHOR card (expect[0])
 * SHOULD score high (the query is written in its vocabulary); the BRIDGE card
 * (expect[1]) MUST score < 0.30 (it is reachable only via the shared bridge tag).
 *
 * GATE: every query's BRIDGE-card (expect[1]) overlap < 0.30.
 *       Also flags if the ANCHOR card (expect[0]) overlap < 0.30 (bad anchor —
 *       query doesn't even name card 1, so it's not a valid single-hop seed).
 *
 * USAGE:  node scripts/multi-hop-eval-leakcheck.mjs
 * EXIT 0 if PASS, 1 if any query fails the gate.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";

const REPO = process.cwd();
const EVAL_FILE = join(REPO, "scripts/multi-hop-eval.json");
const GATE = 0.30; // bridge-card overlap must be strictly below this

const STOP = new Set([
	"the","and","for","with","that","this","how","why","does","was","were","after",
	"before","when","what","which","have","has","had","not","but","are","is","it",
	"to","of","in","on","at","my","i","a","an","as","or","by","be","been","from",
	"into","its","their","there","also","same","other","related","sits","sit","filed",
	"under","tag","cluster","defect","gotcha","review","memory","auto","shares","shared",
	"both","two","one","next","same","about","these","those","they","them","his","her",
	"finding","findings","exists","exist","else","step","note","notes","item","items",
]);

function tokenize(s) {
	return (s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((t) => t.length >= 3 && t.length <= 28 && !STOP.has(t));
}

function cardTokens(c) {
	// id hyphens → spaces so "bare-except" matches query tokens "bare except"
	const norm = (s) => (s || "").replace(/[-_]+/g, " ");
	const blob = `${norm(c.id)} ${norm(c.title)} ${norm(c.tags.join(" "))} ${norm(c.body)}`;
	return new Set(tokenize(blob));
}

function overlap(queryTokens, cset) {
	if (queryTokens.length === 0) return 1; // degenerate query → fail
	let hit = 0;
	for (const t of queryTokens) if (cset.has(t)) hit++;
	return hit / queryTokens.length;
}

async function main() {
	const evalSet = JSON.parse(readFileSync(EVAL_FILE, "utf8"));
	// Build the card corpus directly from the convergence folder so the gate is
	// self-contained (no external dump dependency). Vault resolves via the same
	// resolveVault tier chain the measure scripts use (run under `bun`).
	const vault = (await resolveVault(REPO)).path;
	const KG = join(vault, "Zettelkasten/knowledge-graph");
	if (!existsSync(KG)) { console.error(`knowledge-graph folder not found: ${KG}`); process.exit(1); }
	const dump = [];
	for (const f of readdirSync(KG).filter((f) => f.endsWith(".md"))) {
		const txt = readFileSync(join(KG, f), "utf8");
		const id = f.replace(/\.md$/, "");
		const tm = txt.match(/tags:\s*\[([^\]]*)\]/);
		const tags = tm ? tm[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean) : [];
		const t2 = txt.match(/^#\s+(.*)$/m);
		const body = txt.replace(/^---[\s\S]*?---/, "").trim();
		dump.push({ id, title: t2 ? t2[1].trim() : id, tags, body });
	}
	const byId = new Map(dump.map((c) => [c.id, c]));

	const rows = [];
	let fail = 0;
	console.log(`multi-hop-eval LEAK CHECK — ${evalSet.queries.length} queries | gate = bridge-overlap < ${GATE}\n`);
	for (let i = 0; i < evalSet.queries.length; i++) {
		const q = evalSet.queries[i];
		const qtok = tokenize(q.q);
		const overlaps = q.expect.map((eid) => {
			// resolve expected id (may be a substring; find the real card)
			let c = byId.get(eid);
			if (!c) {
				const match = [...byId.keys()].find((k) => k.includes(eid) || eid.includes(k));
				c = match ? byId.get(match) : null;
			}
			if (!c) return { id: eid, overlap: 1, missing: true };
			return { id: c.id, overlap: overlap(qtok, cardTokens(c)) };
		});
		const anchor = overlaps[0];
		const bridge = overlaps[1];
		const bridgePass = bridge && bridge.overlap < GATE;
		const anchorPass = anchor && anchor.overlap >= GATE;
		const ok = bridgePass && anchorPass && !anchor.missing && !bridge.missing;
		if (!ok) fail++;
		rows.push({ i: i + 1, bridge: q.bridge, anchor, bridgeCard: bridge, bridgePass, anchorPass, ok });
	}

	// print table
	const fmt = (x) => x == null ? "  —  " : x.toFixed(2).padStart(4);
	for (const r of rows) {
		const flag = r.ok ? "OK " : "FAIL";
		const a = r.anchor ? `${r.anchor.id.slice(0, 34).padEnd(34)} ${fmt(r.anchor.overlap)}` : "anchor missing";
		const b = r.bridgeCard ? `${r.bridgeCard.id.slice(0, 34).padEnd(34)} ${fmt(r.bridgeCard.overlap)}` : "bridge missing";
		console.log(`[${String(r.i).padStart(2)}] ${flag}  bridge=${r.bridge.padEnd(14)}`);
		console.log(`       anchor  ${a}${r.anchorPass ? "" : "  <-- low anchor!"}`);
		console.log(`       bridge  ${b}${r.bridgePass ? "" : "  <-- LEAKS"}`);
	}

	const meanAnchor = rows.reduce((s, r) => s + (r.anchor?.overlap ?? 0), 0) / rows.length;
	const meanBridge = rows.reduce((s, r) => s + (r.bridgeCard?.overlap ?? 0), 0) / rows.length;
	console.log(`\nmean anchor-overlap = ${meanAnchor.toFixed(3)}  (should be HIGH — query names card 1)`);
	console.log(`mean bridge-overlap = ${meanBridge.toFixed(3)}  (should be LOW — card 2 only via bridge tag)`);
	console.log(`\n${fail === 0 ? "✅ PASS — eval is leak-free" : `❌ FAIL — ${fail} query(ies) fail the gate`}`);
	process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
