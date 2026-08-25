#!/usr/bin/env bun
/**
 * resource-eval.mjs — ticket 04 (effort 2026-08-25-kcard-resource-tier, D8):
 * USB4 eval gate, resource-tier vs flat vs generic-card A/B(/C/D).
 *
 * Arms (all over the SAME 839-page corpus, in ONE throwaway Surreal ns):
 *   "resource-recursive" — the ticket-03 heap lane over the `resource` table
 *     (L0/L1 seed pass → best-first directory descent → α propagation).
 *   "resource-flat"      — plain KNN over the same `resource` rows (the
 *     ticket-01 lane; the (a)-vs-(b) pair is the ticket's hard gate).
 *   "generic-hier"       — the morning baseline scaled to the whole corpus:
 *     every page adapted through the GENERIC adapter (`zk-ingest --source
 *     generic` path) into a temp vault, indexed as `card` rows, retrieved
 *     through the card lane's DEFAULT (hierarchicalRetrieve — KNN+FTS seeds,
 *     γ propagation; the D36 production default).
 *   "generic-flat-vector" — pure KNN over the same generic `card` rows
 *     (leaves only) — isolates what the card lane's lexical blend adds.
 *
 * Battery: `.planning/2026-08-25-kcard-resource-tier/eval/questions.json`
 * (committed BLIND before any arm ran — TOC-derived questions, target pages
 * located by section-heading search). Coverage is re-verified per run: a
 * question whose target page is missing from the corpus is reported as a
 * coverage miss, never scored as a retrieval miss.
 *
 * WHY THIS HOME: same neutral-tier rule as recall-audit.mjs (bun-apps/scripts/
 * sits above every package; the script only imports, never owned by either).
 *
 * Run (live, bge-m3 @ LM Studio + local SurrealDB required):
 *   bun bun-apps/scripts/resource-eval.mjs \
 *     --corpus "<usb4-clean-tree>" \
 *     --battery .planning/2026-08-25-kcard-resource-tier/eval/questions.json
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const { values: args } = parseArgs({
	options: {
		corpus: { type: "string" },
		battery: { type: "string", default: join(ROOT, ".planning", "2026-08-25-kcard-resource-tier", "eval", "questions.json") },
		namespace: { type: "string" },
		runs: { type: "string", default: "2" },
		k: { type: "string", default: "5" },
		alpha: { type: "string", default: "0.5" },
		arm: { type: "string", default: "resource-recursive,resource-flat,generic-hier,generic-flat-vector" },
		"surreal-endpoint": { type: "string", default: "http://127.0.0.1:8000" },
		receipt: { type: "string" },
		keep: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
});

if (args.help) {
	console.log(`usage: bun bun-apps/scripts/resource-eval.mjs --corpus <path> [options]
  --corpus <path>        USB4 clean tree root (the dir containing pages/)
  --battery <path>       question JSON (default: the effort's committed set)
  --namespace <ns>       scratch Surreal ns (default: kcard_resource_eval_<pid>_<ts>;
                         NEVER the production ns — this script REMOVEs it at exit)
  --runs <n>             repetitions per arm (default 2; ticket requires 2)
  --k <n>                hit depth (default 5)
  --alpha <f>            recursive propagation α (default 0.5)
  --arm <a,b,...>        subset of the four arms (default all)
  --surreal-endpoint <u> default http://127.0.0.1:8000
  --receipt <path>       JSON receipt (default output/resource-eval/receipt-<ts>.json)
  --keep                 keep the scratch ns + temp vault for inspection`);
	process.exit(0);
}

if (!args.corpus || !existsSync(args.corpus)) {
	console.error("--corpus <path> must exist (the usb4 clean tree root)");
	process.exit(2);
}

const K = Number(args.k);
const RUNS = Number(args.runs);
const ALPHA = Number(args.alpha);
const ARMS = new Set(args.arm.split(",").map((s) => s.trim()));
const battery = JSON.parse(readFileSync(args.battery, "utf8"));
const corpusAbs = resolve(args.corpus);
const pagesDir = join(corpusAbs, "pages");
if (!existsSync(pagesDir)) {
	console.error(`no pages/ under corpus: ${corpusAbs}`);
	process.exit(2);
}
const tree = basename(corpusAbs);

// ── shared plumbing ─────────────────────────────────────────────────────────

/** Rank of the first hit under `match` (1-based, 0 = miss). */
function firstHitRank(rankedIds, match) {
	for (let i = 0; i < rankedIds.length; i++) if (match(rankedIds[i])) return i + 1;
	return 0;
}

/** Score one arm's battery. `run(q)` → ranked ids (best first). */
async function scoreArm(questions, negatives, run, match) {
	let h1 = 0, h3 = 0, hk = 0, mrr = 0, n = 0;
	const perQuery = [];
	for (const e of questions) {
		const ranked = await run(e.q);
		n++;
		const rank = firstHitRank(ranked, (id) => match(id, e));
		if (rank === 1) h1++;
		if (rank >= 1 && rank <= 3) h3++;
		if (rank >= 1 && rank <= K) hk++;
		if (rank >= 1) mrr += 1 / rank;
		// Full top-K rides the receipt so post-hoc diagnostics (e.g. the
		// section-heading-page ±1 granularity lens) never need a re-run.
		perQuery.push({ q: e.q, anchor: e.anchor, target: e.targetPages, rank: rank > 0 ? rank : "MISS", top1: ranked[0] ?? "(none)", topK: ranked.slice(0, K) });
	}
	const negativeRows = [];
	for (const e of negatives) {
		const ranked = await run(e.q);
		negativeRows.push({ q: e.q, top1: ranked[0] ?? "(none)", retrieved: ranked.length });
	}
	return {
		metrics: { graded: n, hit1: h1, hit3: h3, hitK: hk, mrr: Number((mrr / Math.max(1, n)).toFixed(3)), misses: n - hk },
		perQuery,
		negatives: negativeRows,
	};
}

const fmt = (m) => (m ? `hit@1=${m.hit1}/${m.graded} hit@3=${m.hit3}/${m.graded} hit@${K}=${m.hitK}/${m.graded} MRR=${m.mrr}` : "n/a");

// ── coverage check (before any arm; absent targets never score as misses) ──

// Dotfile sidecars (.overview.md/.abstract.md) are the resource tier's L0/L1
// rows — the generic baseline arm must NOT ingest them as cards (they are not
// part of the morning path, and they'd be 2 asymmetric distractor cards).
const pageFiles = new Set(readdirSync(pagesDir).filter((n) => n.endsWith(".md") && !n.startsWith(".")));
const coveredQuestions = [];
const absentQuestions = [];
for (const e of battery.questions ?? []) {
	const missing = (e.targetPages ?? []).filter((p) => !pageFiles.has(`${p}.md`));
	(missing.length ? absentQuestions : coveredQuestions).push(e);
}
console.log(`battery: ${coveredQuestions.length} graded + ${(battery.negatives ?? []).length} negatives; absent targets: ${absentQuestions.length}`);
if (absentQuestions.length > 0) {
	console.error(`target pages missing from corpus: ${absentQuestions.map((e) => `${e.anchor}:${e.targetPages}`).join(", ")}`);
	process.exit(2);
}

// ── scratch ns + temp vault ─────────────────────────────────────────────────

const ns = args.namespace ?? `kcard_resource_eval_${process.pid}_${Math.floor(Date.now() / 1000) % 100000}`;
const tmpVault = mkdtempSync(join(tmpdir(), "resource-eval-vault-"));
const receipt = {
	meta: {
		ranAt: new Date().toISOString(),
		k: K,
		runs: RUNS,
		alpha: ALPHA,
		battery: args.battery,
		corpus: corpusAbs,
		tree,
		namespace: ns,
		arms: [...ARMS],
		embedder: "live-bge-m3",
	},
	coverage: { graded: coveredQuestions.length, negatives: (battery.negatives ?? []).length, absent: absentQuestions.length },
	setup: {},
	runs: [],
};

const { makeContextClient } = await import("../s2-agent-ext-knowledge-card/src/surreal-index.ts");
const { defaultEmbedder, embedQuery } = await import("../s2-agent-ext-knowledge-card/src/semantic.ts");
const client = makeContextClient({
	endpoint: args["surreal-endpoint"],
	namespace: ns,
	requestTimeoutMs: 120_000,
});

try {
	// ── build: resource tier (arms a/b) ──────────────────────────────────────
	if (ARMS.has("resource-recursive") || ARMS.has("resource-flat")) {
		const { rebuildResourceIndex } = await import("../s2-agent-ext-knowledge-card/src/resource-index.ts");
		console.log(`building resource index (${tree}) in ns ${ns} …`);
		const t0 = Date.now();
		const build = await rebuildResourceIndex({ client, treePath: corpusAbs, tree, embedder: defaultEmbedder });
		receipt.setup.resource = { skipped: build.skipped, inserted: build.inserted, dim: build.dim, embedModel: build.embedModel, embedded: build.embedded, cached: build.cached, elapsedMs: build.elapsedMs };
		console.log(`resource rows: ${build.inserted} dim=${build.dim} model=${build.embedModel} embedded=${build.embedded} cached=${build.cached} in ${build.elapsedMs}ms (total ${Date.now() - t0}ms)`);
	}

	// ── build: generic-card baseline (arms c/d) ─────────────────────────────
	if (ARMS.has("generic-hier") || ARMS.has("generic-flat-vector")) {
		const { adaptGenericMarkdown } = await import("../s2-agent-ext-knowledge-card/src/adapters.ts");
		const { ingestRecords } = await import("../s2-agent-ext-knowledge-card/src/ingest.ts");
		const { rebuildCardIndex } = await import("../s2-agent-ext-knowledge-card/src/surreal-index.ts");
		console.log(`adapting ${pageFiles.size} pages through the generic adapter …`);
		const t0 = Date.now();
		const records = [];
		for (const name of [...pageFiles].sort()) {
			const rec = adaptGenericMarkdown(readFileSync(join(pagesDir, name), "utf8"), name);
			if (rec) records.push(rec);
		}
		const summary = await ingestRecords(records, {
			vaultPath: tmpVault,
			source: "generic",
			sourceLabel: `resource-eval:${tree}`,
		});
		receipt.setup.genericIngest = { adapted: records.length, written: summary.written ?? summary.created ?? null, elapsedMs: Date.now() - t0 };
		console.log(`generic cards: ${records.length} adapted+written in ${Date.now() - t0}ms`);
		console.log(`building card index over the temp vault …`);
		const t1 = Date.now();
		const build = await rebuildCardIndex({ client, vaultPath: tmpVault, folder: "Zettelkasten/knowledge-graph", embedder: defaultEmbedder });
		receipt.setup.cardIndex = { skipped: build.skipped, inserted: build.inserted, leaves: build.leafCount, aggs: build.aggCount, dim: build.dim, embedModel: build.embedModel, elapsedMs: build.elapsedMs };
		console.log(`card rows: leaves=${build.leafCount} aggs=${build.aggCount} dim=${build.dim} in ${build.elapsedMs}ms (total ${Date.now() - t1}ms)`);
	}

	// ── arms ─────────────────────────────────────────────────────────────────
	const NEGATIVES = battery.negatives ?? [];

	for (let r = 1; r <= RUNS; r++) {
		const runReceipt = { run: r, arms: {} };

		if (ARMS.has("resource-recursive")) {
			const { resourceRecursiveQuery } = await import("../s2-agent-ext-knowledge-card/src/resource-recursive.ts");
			const scored = await scoreArm(coveredQuestions, NEGATIVES, async (q) => {
				const res = await resourceRecursiveQuery({ client, query: q, tree, topK: K, embedder: defaultEmbedder, alpha: ALPHA, maxLevel: 2 });
				return res.hits.map((h) => h.uri);
			}, (id, e) => (e.targetPages ?? []).some((p) => id.includes(`${p}.md`)));
			runReceipt.arms["resource-recursive"] = scored;
			console.log(`run ${r} resource-recursive: ${fmt(scored.metrics)}`);
		}

		if (ARMS.has("resource-flat")) {
			const { resourceKnnQuery } = await import("../s2-agent-ext-knowledge-card/src/resource-index.ts");
			const scored = await scoreArm(coveredQuestions, NEGATIVES, async (q) => {
				const res = await resourceKnnQuery({ client, query: q, tree, topK: K, embedder: defaultEmbedder });
				return res.hits.map((h) => h.uri);
			}, (id, e) => (e.targetPages ?? []).some((p) => id.includes(`${p}.md`)));
			runReceipt.arms["resource-flat"] = scored;
			console.log(`run ${r} resource-flat:      ${fmt(scored.metrics)}`);
		}

		if (ARMS.has("generic-hier")) {
			const { hierarchicalRetrieve } = await import("../s2-agent-ext-knowledge-card/src/hierarchical-retrieval.ts");
			const scored = await scoreArm(coveredQuestions, NEGATIVES, async (q) => {
				const res = await hierarchicalRetrieve(client, { query: q, topK: K });
				return res.cards.map((c) => `${c.stem} :: ${c.path}`);
			}, (id, e) => (e.targetPages ?? []).some((p) => id.includes(`-${p} `) || id.includes(`-${p}::`) || id.includes(`-${p}.md`)));
			runReceipt.arms["generic-hier"] = scored;
			console.log(`run ${r} generic-hier:        ${fmt(scored.metrics)}`);
		}

		if (ARMS.has("generic-flat-vector")) {
			const scored = await scoreArm(coveredQuestions, NEGATIVES, async (q) => {
				const qv = await embedQuery(q);
				if (!qv) return [];
				const rows = await client.query(
					`SELECT stem, path, is_leaf FROM card WHERE vec <|${K + 20},100|> $qv;`,
					{ qv },
				);
				return (rows ?? []).filter((x) => x.is_leaf).map((x) => `${x.stem} :: ${x.path}`);
			}, (id, e) => (e.targetPages ?? []).some((p) => id.includes(`-${p} `) || id.includes(`-${p}::`) || id.includes(`-${p}.md`)));
			runReceipt.arms["generic-flat-vector"] = scored;
			console.log(`run ${r} generic-flat-vector: ${fmt(scored.metrics)}`);
		}

		receipt.runs.push(runReceipt);
	}
} finally {
	if (!args.keep) {
		try {
			await client.query(`REMOVE NAMESPACE ${ns};`);
		} catch {
			// best effort — a failed remove never fails the eval
		}
		rmSync(tmpVault, { recursive: true, force: true });
	}
}

// ── emit ────────────────────────────────────────────────────────────────────

const receiptPath = args.receipt ?? join(ROOT, "output", "resource-eval", `receipt-${receipt.meta.ranAt.replace(/[:.]/g, "-")}.json`);
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

// Run-over-run reproduction summary (ticket: "reproduced winner noted").
const armNames = [...ARMS];
const repro = {};
for (const a of armNames) {
	const ms = receipt.runs.map((r) => r.arms[a]?.metrics).filter(Boolean);
	if (ms.length > 1) {
		repro[a] = {
			identical: ms.every((m) => m.hitK === ms[0].hitK && m.mrr === ms[0].mrr),
			hitK: ms.map((m) => m.hitK),
			mrr: ms.map((m) => m.mrr),
		};
	}
}
console.log("=== RESOURCE EVAL ===");
for (const r of receipt.runs) {
	for (const a of armNames) if (r.arms[a]) console.log(`run ${r.run} ${a}: ${fmt(r.arms[a].metrics)}`);
}
console.log(`reproduction: ${JSON.stringify(repro)}`);
console.log(`receipt: ${receiptPath}`);
