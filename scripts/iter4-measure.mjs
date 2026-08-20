#!/usr/bin/env node
// @ts-nocheck
/**
 * iter4-measure.mjs — controlled-corpus measurement for graph-neighbor dilution.
 *
 * The controlled corpus has TWO disjoint domains: papers-docagent (DocAgent
 * paper concepts) and distill (Krea2 / code findings). They share no vocabulary,
 * so a paper-domain query has exactly one correct domain. Any distill card in a
 * paper query's top-k is OFF-TOPIC noise — and that is precisely what graph
 * expansion drags in (a paper seed's wiki-links reach other paper cards, but the
 * blend score's link_count term plus N-hop traversal pulls in linked distill
 * cards). This gives a DETERMINISTIC relevance metric with no LLM judge:
 *
 *   domain-precision@k = (refs whose path is in the query's home domain) / k
 *
 * Acceptance (criterion 3): semantic-lexical domain-precision@k > default's on
 * the adversarial (paraphrase / cross-lingual) paper subset. Runs default,
 * three-way, semantic-lexical so graph-dilution (three-way vs semantic-lexical)
 * AND the acceptance test (default vs semantic-lexical) come from one run.
 *
 * NOTE: zk-ask -p often completes (output fully written, "zk-ask done" present)
 * but the process doesn't exit cleanly, so execSync hits its wall-clock timeout.
 * The file holds the real result — parsed regardless of exit status.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const VAULT = process.argv[2] ?? `${ROOT}/output/controlled-corpus-vault`;
const FOLDER = process.argv[3] ?? "Zettelkasten/papers-docagent";
const HOME_DOMAIN = "Zettelkasten/papers-docagent";
const OUT = `${ROOT}/output/iter4-measurements`;
const MODES = ["default", "three-way", "semantic-lexical"];
const TOP_K = 4;
const MODEL = "deepseek-v4-flash";

// Adversarial English queries — paraphrase / symptom-cause, zero keyword overlap
// with the Chinese card titles. Each names its expected card for a hit-rank check.
const QUERIES = [
	{ id: 1, text: "how are incorrect initial answers caught and fixed before being returned",
		expectedStem: "Reviewer Agent 的交叉驗證機制" },
	{ id: 2, text: "why randomize the sequence of tasks when benchmarking an agent",
		expectedStem: "任務順序隨機化對代理性能的影響" },
	{ id: 3, text: "how to turn a long pdf into a hierarchical nested outline of sections",
		expectedStem: "樹狀結構文件大綱的建構方法" },
	{ id: 4, text: "what is the cost benefit of keeping a persistent cross task memory versus starting fresh each time",
		expectedStem: "任務無關記憶庫與反思學習" },
	{ id: 5, text: "how does the system stay accurate when a document has repeated overlapping content across text and image panels",
		expectedStem: "DocAgent 對結構性雜訊的魯棒性" },
];

function reconstructText(ndjson) {
	// --mode json emits NDJSON; the assistant's final text arrives as a stream of
	// {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"…"}}
	// events. Re-accrete them to recover the full Reference-notes section that
	// -p print mode truncates on retrieve-only runs with a local LLM.
	let text = "";
	let semanticCount = 0;
	let fellBack = false;
	for (const line of ndjson.split("\n")) {
		const s = line.trim();
		if (!s) continue;
		let d;
		try { d = JSON.parse(s); } catch { continue; }
		const ev = d.assistantMessageEvent ?? d;
		if (ev?.type === "text_delta" && typeof ev.delta === "string") text += ev.delta;
		const s2 = JSON.stringify(d);
		if (s2.includes("obsidian_semantic_search")) semanticCount++;
		if (/iserror|fall back|unreachable/i.test(s2)) fellBack = true;
	}
	return { text, semanticCount, fellBack };
}

function parseRefsFromText(text) {
	const refs = [];
	const refBlock = text.split("**Reference notes:**")[1] || "";
	for (const line of refBlock.split("\n")) {
		const m = line.match(/^-\s*\[\[([^\]]+)\]\]\s*\(([^)]+)\)(?:\s*\[modes:\s*([^\]]*)\])?\s*[—-]\s*(.*)$/);
		if (m) refs.push({ title: m[1].trim(), path: m[2].trim(), modes: (m[3] || "").trim() });
	}
	return refs;
}

function runMode(q, mode) {
	const esc = q.text.replace(/'/g, "'\\''");
	const f = `/tmp/iter4-measure-${mode}-${q.id}-${Date.now()}.txt`;
	let error = null;
	try {
		execSync(
			`OB_VAULT_PATH='${VAULT}' bun --cwd '${ROOT}/bun-apps/s2-agent' src/cli.ts cli zk-ask '${esc}' ` +
			`--retrieve-only --no-refine --blend ${mode} --folder '${FOLDER}' --top-k ${TOP_K} ` +
			`--model ${MODEL} --thinking medium --mode json -p > '${f}' 2>&1`,
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90000 },
		);
	} catch (e) {
		error = (e.status === null && e.signal === "SIGTERM") ? "proc-no-exit" : `exit:${e.status}`;
	}
	let ndjson = "";
	try { ndjson = readFileSync(f, "utf8"); } catch { ndjson = ""; }
	const rec = reconstructText(ndjson);
	const refs = parseRefsFromText(rec.text).map((r) => ({
		...r, homeDomain: r.path.includes(HOME_DOMAIN), graphTag: /graph/.test(r.modes),
	}));
	const onDomain = refs.filter((r) => r.homeDomain).length;
	const graphNeighbors = refs.filter((r) => r.graphTag).length;
	const hitIdx = refs.findIndex((r) => r.title.includes(q.expectedStem) || q.expectedStem.includes(r.title));
	return { mode, semanticLive: rec.semanticCount > 0 && !rec.fellBack, error, textLen: rec.text.length,
		refCount: refs.length,
		domainPrecision: refs.length ? +(onDomain / refs.length).toFixed(3) : null,
		graphNeighborCount: graphNeighbors, expectedHitRank: hitIdx >= 0 ? hitIdx + 1 : null,
		refs: refs.map((x) => ({ title: x.title, homeDomain: x.homeDomain, modes: x.modes })) };
}

mkdirSync(OUT, { recursive: true });
const results = [];
for (const q of QUERIES) {
	const row = { id: q.id, query: q.text, expectedStem: q.expectedStem, byMode: {} };
	for (const mode of MODES) {
		process.stderr.write(`  [q${q.id}] ${mode.padEnd(17)} ... `);
		const r = runMode(q, mode);
		row.byMode[mode] = r;
		process.stderr.write(`refs=${r.refCount} prec=${r.domainPrecision} graph=${r.graphNeighborCount} hit=${r.expectedHitRank ?? "MISS"} ${r.error ?? ""}\n`);
		execSync("sleep 1.5"); // let LM Studio KV-cache settle between runs
	}
	results.push(row);
}

const table = MODES.map((mode) => {
	const rows = results.map((r) => r.byMode[mode]);
	const completed = rows.filter((r) => r.refCount > 0);
	const meanPrec = completed.length ? completed.reduce((a, r) => a + r.domainPrecision, 0) / completed.length : null;
	const meanGraph = completed.length ? completed.reduce((a, r) => a + r.graphNeighborCount, 0) / completed.length : null;
	const hits = rows.filter((r) => r.expectedHitRank !== null).length;
	const live = rows.filter((r) => r.semanticLive).length;
	return { mode, completedRefs: `${completed.length}/${rows.length}`,
		meanDomainPrecision: meanPrec != null ? +meanPrec.toFixed(3) : null,
		meanGraphNeighbors: meanGraph != null ? +meanGraph.toFixed(2) : null,
		expectedHits: `${hits}/${rows.length}`, semanticLive: `${live}/${rows.length}` };
});

const summary = { vault: VAULT, folder: FOLDER, homeDomain: HOME_DOMAIN, topK: TOP_K,
	note: "domain-precision@k = home-domain refs / total refs (deterministic, no LLM judge). Higher = less graph dilution.",
	semanticModes: ["three-way", "semantic-lexical"], table, results };
const stamp = execSync("date -u +%Y-%m-%dT%H-%M-%S", { encoding: "utf8" }).trim();
const path = `${OUT}/measure-${stamp}.json`;
writeFileSync(path, JSON.stringify(summary, null, 2));
console.log(`\n=== measurement table (n=${QUERIES.length} adversarial paper queries) ===`);
console.table(table);
console.log(`written: ${path}`);
