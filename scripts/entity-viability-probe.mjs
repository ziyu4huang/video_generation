#!/usr/bin/env node
// @ts-nocheck
/**
 * entity-viability-probe.mjs — cheap DECISIVE gate before the expensive Track 3.3
 * full-vault extraction. Answers: "do the two expected cards of each multi-hop
 * query share ≥1 entity?" If most pairs DON'T share an entity, entity-graph
 * expansion CANNOT bridge them → RETIRE 3.3 without the 76-min full extraction.
 * If most pairs DO share → the bridge is viable → proceed to the full measure.
 *
 * Extracts entities for ONLY the 30 expected cards (2×15), max_tokens 3000
 * (room for gemma-4-26b's reasoning budget). ~3 min, cached.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const EVAL_FILE = join(REPO, "scripts/multi-hop-eval.json");
const OUT_DIR = join(REPO, "output/multi-hop-entity-measurements");
const CACHE = join(OUT_DIR, "viability-entities.json");
const VAULT = process.env.OB_VAULT_PATH ?? "/Users/huangziyu/proj/video_generation/vaults_root/s2-agent-vault";
const FOLDER_DIR = join(VAULT, "Zettelkasten/knowledge-graph");
const LM_URL = "http://127.0.0.1:1234/v1/chat/completions";
const MODEL = "google/gemma-4-26b-a4b-qat";

function normName(n) { return n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

async function extract(title, body) {
	const prompt = `Extract 3-8 SPECIFIC named entities (tools, functions, files, CLI flags, errors, concepts) from this technical card. Be specific and multi-word where possible (e.g. "argparse shared parser", "resolveVault tier-2", "bun.lock"). Respond with ONLY a JSON array of {"name","type"}.\n\nTitle: ${title}\nBody: ${body.slice(0, 700)}`;
	const res = await fetch(LM_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 3000, chat_template_kwargs: { enable_thinking: false } }), signal: AbortSignal.timeout(150_000) });
	const data = await res.json();
	const text = data.choices?.[0]?.message?.content ?? "";
	const m = text.match(/\[[\s\S]*\]/);
	if (!m) return [];
	try { return JSON.parse(m[0]).filter((e) => e?.name).map((e) => normName(e.name)).filter((n) => n.length > 1).slice(0, 8); } catch { return []; }
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	let cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8") || "{}") : {};
	const evalSet = JSON.parse(readFileSync(EVAL_FILE, "utf8"));

	// resolve expected slugs → actual filenames
	const allFiles = readdirSync(FOLDER_DIR).filter((n) => n.endsWith(".md"));
	const resolveFile = (slug) => allFiles.find((f) => f.toLowerCase().includes(slug.toLowerCase())) ?? null;

	// collect the unique set of expected files to extract
	const need = new Set();
	for (const q of evalSet.queries) for (const slug of q.expect) { const f = resolveFile(slug); if (f) need.add(f); }
	const todo = [...need].filter((f) => !cache[f]);
	console.log(`viability probe: ${need.size} expected cards; ${Object.keys(cache).length} cached, extracting ${todo.length} (max_tokens 3000, sequential)`);

	for (let i = 0; i < todo.length; i++) {
		const f = todo[i];
		const raw = readFileSync(join(FOLDER_DIR, f), "utf8");
		const fm = raw.match(/^---\n([\s\S]*?)\n---/);
		const title = fm?.[1].match(/^title:\s*"?([^\n"]+)"?/m)?.[1] ?? f.replace(/\.md$/, "");
		const body = raw.slice(fm?.[0].length ?? 0);
		try { cache[f] = await extract(title, body); }
		catch (e) { cache[f] = []; console.log(`  ✗ ${f}: ${e.message}`); }
		writeFileSync(CACHE, JSON.stringify(cache, null, 2));
		console.log(`  [${i + 1}/${todo.length}] ${f} → ${cache[f].length} entities`);
	}

	// measure pairwise entity-overlap per query
	let bridged = 0, total = 0; const perQuery = [];
	for (const q of evalSet.queries) {
		const sets = q.expect.map((slug) => { const f = resolveFile(slug); return f ? new Set(cache[f] ?? []) : new Set(); });
		if (sets.length < 2 || sets.some((s) => s.size === 0)) { perQuery.push({ bridge: q.bridge, status: "missing-entities", shared: [] }); continue; }
		total++;
		const shared = [...sets[0]].filter((e) => sets[1].has(e));
		const isBridged = shared.length > 0;
		if (isBridged) bridged++;
		perQuery.push({ bridge: q.bridge, expect: q.expect, shared, e1: [...sets[0]], e2: [...sets[1]], bridged: isBridged });
	}
	const rate = total ? bridged / total : 0;
	const verdict = rate >= 0.5 ? `VIABLE (${bridged}/${total} pairs share an entity) → proceed to full measure`
		: rate > 0 ? `PARTIAL (${bridged}/${total}) → bridge weak; full measure may underperform`
			: `NOT VIABLE (0/${total} pairs share an entity) → RETIRE 3.3: entity expansion cannot bridge these multi-hop pairs`;
	const receipt = { timestamp: new Date().toISOString(), model: MODEL, total, bridged, bridgeRate: rate, verdict, perQuery };
	writeFileSync(join(OUT_DIR, `viability-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
	console.log(`\n=== ENTITY-BRIDGE VIABILITY ===`);
	console.log(`pairs bridged: ${bridged}/${total} (rate ${rate.toFixed(2)})`);
	for (const p of perQuery) console.log(`  ${p.bridge.padEnd(12)} ${p.bridged !== undefined ? (p.bridged ? "BRIDGED" : "no-bridge") : p.status}  shared=${JSON.stringify(p.shared ?? [])}`);
	console.log(`\n${verdict}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
