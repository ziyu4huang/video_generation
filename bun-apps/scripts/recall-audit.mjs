#!/usr/bin/env bun
/**
 * recall-audit.mjs — committed recall-audit harness (context-lifecycle ticket 04, D10).
 *
 * Measures recall quality on a graded natural-language battery over the two
 * post-fold retrieval surfaces (2026-08-22 hermes fold, ticket 03):
 *
 *   arm "journal" — the hermes capture-only journal (SurrealDB `memories`,
 *     SELECT-only) via the folded exact-match lexical arm: FTS `content @@ $q`
 *     with a `string::contains` fallback, ORDER BY lastReferenced DESC. Mirrors
 *     `SurrealMemoryRepository.searchMemories`'s lexical arm (neighbor
 *     augmentation + ranker not replicated — the documented deviation since the
 *     2026-08-19 audit, `.planning/knowledge/hermes-recall-audit.md`).
 *   arm "kcard" — the SAME questions through kcard `retrieveRecords`
 *     (bodyMatch + slugDom + semantic blend; graceful lexical fallback when no
 *     embedder is reachable, recorded in the receipt via trace.semanticUsed).
 *   arm "kcard-hier" — hierarchical retrieval over the SurrealDB `card` index
 *     (kcard-parity ticket 07): KNN + per-token FTS seeds, γ-propagation BFS.
 *   arm "kcard-flat-vector" — pure KNN over the same index, leaves only, no
 *     FTS lane, no blend (kcard-parity ticket 09 D23 ablation arm).
 *
 * Battery: graded queries (2 per target + negative controls) per arm, defined
 * in `recall-audit-battery.json` next to this script. Journal-arm targets are
 * hermes MEMORY.md mdIds; kcard-arm targets are vault-card filename/id
 * substrings (the vault carries no mdId linkage — targets verified against the
 * folder listing, and queries whose target card is ABSENT are reported as a
 * separate corpus-coverage line, not silently scored as retrieval misses).
 *
 * Emits a JSON receipt (hit@1/3/5 + MRR + per-query appendix + coverage) under
 * `output/recall-audit/` by default; numbers land in the effort map Context.
 *
 * WHY THIS HOME: the script needs BOTH `SurrealClient` (hermes, TIER-0) and
 * `retrieveRecords` (knowledge-card, TIER-1). The dep-guard tier rule forbids a
 * hermes→knowledge-card import edge in ANY direction a package could carry, so
 * the harness lives at the neutral workspace level (bun-apps/scripts/), which
 * sits above both tiers. Do not move it into either package.
 *
 * Run (live): bun bun-apps/scripts/recall-audit.mjs --vault vaults_root/s2-agent-vault
 * Run (CI-safe fixture): see scripts/recall-audit.test.ts in s2-agent-ext-hermes-memory
 *   (temp corpus + `--test-embedder` deterministic hashing embedder, zero network).
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const { values: args } = parseArgs({
	options: {
		battery: { type: "string", default: join(HERE, "recall-audit-battery.json") },
		vault: { type: "string" },
		folder: { type: "string", default: "Zettelkasten/knowledge-graph" },
		k: { type: "string", default: "5" },
		arm: { type: "string", default: "journal,kcard" },
		"surreal-endpoint": { type: "string", default: "http://127.0.0.1:8000" },
		"surreal-database": { type: "string", default: "memory" },
		"surreal-namespace": { type: "string" },
		semantic: { type: "string", default: "on" },
		"test-embedder": { type: "boolean", default: false },
		// ticket 08: --hotness on measures the kcard arm with the D37 bounded
		// fold armed (and --warmup n real accesses playing through the ledger
		// first — the honest "usage feed" for the A/B). Default off: the arm
		// pins hotness:false explicitly, so a KCARD_HOTNESS_DEFAULT flip in
		// the environment never leaks into a "baseline" receipt.
		hotness: { type: "string", default: "off" },
		warmup: { type: "string", default: "1" },
		receipt: { type: "string" },
		help: { type: "boolean", default: false },
	},
});

if (args.help) {
	console.log(`usage: bun bun-apps/scripts/recall-audit.mjs [options]
  --battery <path>        battery JSON (default: recall-audit-battery.json next to this script)
  --vault <path>          vault root for the kcard arm (required when kcard arm is on)
  --folder <rel>          convergence folder (default Zettelkasten/knowledge-graph)
  --k <n>                 retrieval depth (default 5)
  --arm <a,b>             journal,kcard,kcard-hier,kcard-flat-vector (default journal,kcard)
  --surreal-endpoint <u>  default http://127.0.0.1:8000
  --surreal-database <d>  default memory
  --surreal-namespace <n> default: per-user derivation (tests isolate a throwaway ns)
  --semantic on|off       kcard semantic blend (default on; graceful lexical fallback)
  --test-embedder         deterministic hashing embedder (offline/CI; skips availability check)
  --hotness on|off        kcard D37 bounded fold on the measured arm (default off;
                          off pins hotness:false — env flip never leaks into a baseline)
  --warmup <n>            with --hotness on: n rounds of battery accesses played through
                          the usage ledger BEFORE measuring (the honest feed; default 1)
  --receipt <path>        JSON receipt path (default output/recall-audit/receipt-<ts>.json)`);
	process.exit(0);
}

const K = Number(args.k);
const ARMS = new Set(args.arm.split(",").map((s) => s.trim()));
const SEMANTIC = args.semantic !== "off";
const battery = JSON.parse(readFileSync(args.battery, "utf8"));

// ── helpers ─────────────────────────────────────────────────────────────────

/** Query → tag tokens (mirrors knowledge-search-tool's tokenize). */
function tokenize(query) {
	return query.toLowerCase().split(/[^a-z0-9]+/g).filter((t) => t.length > 0);
}

/** Deterministic hashing embedder for offline/CI runs: L2-normalized bag-of-
 *  words hashed into `dim` buckets. Same-word texts land near each other; no
 *  network. Passed as retrieveRecords' `_testEmbedder` (availability check
 *  skipped, semantic blend exercised deterministically). */
function makeTestEmbedder(dim = 256) {
	return async (texts) =>
		texts.map((t) => {
			const v = new Array(dim).fill(0);
			for (const tok of t.toLowerCase().split(/[^a-z0-9]+/g)) {
				if (!tok) continue;
				let h = 0;
				for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
				v[Math.abs(h) % dim] += 1;
			}
			const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
			return v.map((x) => x / norm);
		});
}

/** Rank of the first hit in `rankedIds` under `match(id)` (1-based, 0 = miss). */
function firstHitRank(rankedIds, match) {
	for (let i = 0; i < rankedIds.length; i++) if (match(rankedIds[i])) return i + 1;
	return 0;
}

/** Score one arm's graded battery. `run(q)` → ranked target-ids (best first).
 *  Returns metrics + per-query appendix. */
async function scoreArm(entries, run, match) {
	let h1 = 0, h3 = 0, hk = 0, mrr = 0, n = 0;
	const perQuery = [];
	const negatives = [];
	for (const e of entries) {
		const ranked = await run(e.q);
		if (e.negative) {
			negatives.push({ q: e.q, top1: ranked[0] ?? "(none)", retrieved: ranked.length });
			continue;
		}
		n++;
		const rank = firstHitRank(ranked, (id) => match(id, e));
		if (rank === 1) h1++;
		if (rank >= 1 && rank <= 3) h3++;
		if (rank >= 1 && rank <= K) hk++;
		if (rank >= 1) mrr += 1 / rank;
		perQuery.push({ q: e.q, target: e.target ?? e.vaultTargets, rank: rank > 0 ? rank : "MISS", top1: ranked[0] ?? "(none)", targetAbsent: e._absent ?? false });
	}
	return {
		metrics: { graded: n, hit1: h1, hit3: h3, hitK: hk, mrr: Number((mrr / Math.max(1, n)).toFixed(3)), misses: n - hk },
		perQuery,
		negatives,
	};
}

/** Restrict metrics to queries whose target actually exists in the corpus
 *  (retrieval quality, unconfounded by corpus coverage). */
function metricsTargetPresent(scored) {
	const kept = scored.perQuery.filter((p) => !p.targetAbsent);
	const n = kept.length;
	let h1 = 0, h3 = 0, hk = 0, mrr = 0;
	for (const p of kept) {
		const r = p.rank === "MISS" ? 0 : p.rank;
		if (r === 1) h1++;
		if (r >= 1 && r <= 3) h3++;
		if (r >= 1 && r <= K) hk++;
		if (r >= 1) mrr += 1 / r;
	}
	return { graded: n, hit1: h1, hit3: h3, hitK: hk, mrr: Number((mrr / Math.max(1, n)).toFixed(3)), misses: n - hk };
}

const receipt = {
	meta: {
		ranAt: new Date().toISOString(),
		k: K,
		battery: args.battery,
		arms: [...ARMS],
		vault: args.vault ?? null,
		folder: args.folder,
		semantic: SEMANTIC,
		embedder: args["test-embedder"] ? "test-hashing" : "live-bge-m3",
		surrealEndpoint: args["surreal-endpoint"],
	},
	journal: null,
	kcard: null,
	"kcard-hier": null,
	"kcard-flat-vector": null,
};

// ── arm 1: hermes journal (SurrealDB, SELECT-only) ─────────────────────────

if (ARMS.has("journal")) {
	const { SurrealClient } = await import("@repo/s2-agent-core-interface");
	const { derivePerUserNamespace } = await import("../s2-agent-ext-hermes-memory/src/store/surreal/per-user-db.ts");
	const client = new SurrealClient({
		endpoint: args["surreal-endpoint"],
		namespace: derivePerUserNamespace(),
		database: args["surreal-database"],
		username: "root",
		password: "root",
	});
	try {
		await client.query("SELECT mdId FROM memories LIMIT 1;");
		const scored = await scoreArm(battery.journal ?? [], async (q) => {
			// Lexical arm, with the SurrealQL projection fix from the 2026-08-19
			// audit (lastReferenced must be SELECTed to appear in ORDER BY).
			let rows = [];
			try {
				rows = await client.query(
					`SELECT mdId, content, lastReferenced FROM memories WHERE content @@ $q ORDER BY lastReferenced DESC LIMIT ${K};`,
					{ q },
				);
			} catch {
				rows = await client.query(
					`SELECT mdId, content, lastReferenced FROM memories WHERE string::contains(content, $q) ORDER BY lastReferenced DESC LIMIT ${K};`,
					{ q },
				);
			}
			return rows.map((r) => r.mdId);
		}, (id, e) => id === e.target);
		receipt.journal = { available: true, ...scored, metricsTargetPresent: null };
	} catch (err) {
		receipt.journal = { available: false, error: String(err?.message ?? err) };
	}
}

let cardIndexShared = null;
async function ensureCardIndex() {
	if (cardIndexShared) return cardIndexShared;
	if (!args.vault) {
		console.error("kcard-hier / kcard-flat-vector arms require --vault <path>");
		process.exit(2);
	}
	const { makeContextClient, rebuildCardIndex } = await import("../s2-agent-ext-knowledge-card/src/surreal-index.ts");
	const client = makeContextClient({
		endpoint: args["surreal-endpoint"],
		...(args["surreal-namespace"] ? { namespace: args["surreal-namespace"] } : {}),
		requestTimeoutMs: 60_000,
	});
	// --test-embedder wires the SAME deterministic hashing embedder into the
	// Surreal arms (offline/CI fixture runs) as into the kcard arm.
	const testEmb = args["test-embedder"] ? { embedder: makeTestEmbedder() } : {};
	const build = await rebuildCardIndex({ client, vaultPath: args.vault, folder: args.folder, ...testEmb });
	cardIndexShared = { client, build, testEmbedder: testEmb.embedder ?? null };
	return cardIndexShared;
}

// ── arm 2: kcard retrieveRecords (vault convergence folder) ────────────────

if (ARMS.has("kcard")) {
	if (!args.vault) {
		console.error("kcard arm requires --vault <path>");
		process.exit(2);
	}
	const { retrieveRecords } = await import("../s2-agent-ext-knowledge-card/src/retrieve.ts");
	const folderAbs = join(args.vault, args.folder);
	if (!existsSync(folderAbs)) {
		console.error(`vault folder does not exist: ${folderAbs}`);
		process.exit(2);
	}
	const files = readdirSync(folderAbs).filter((n) => n.endsWith(".md"));

	// Corpus coverage: mark queries whose target card is absent from the folder
	// (scored separately so retrieval quality is never confounded by coverage).
	for (const e of battery.kcard ?? []) {
		if (e.negative || !Array.isArray(e.vaultTargets)) continue;
		const targets = e.vaultTargets.map((t) => t.toLowerCase());
		e._absent = !files.some((n) => targets.some((t) => n.toLowerCase().includes(t)));
	}

	// ticket 08 A/B surface (D38): --hotness on plays `--warmup` rounds of the
	// battery through the real usage writer FIRST (honest accesses), then
	// measures the kcard arm with the D37 bounded fold armed against the
	// aggregates. Reads + writes go through a namespace-scoped client so the
	// A/B never touches the real ledger (pass --surreal-namespace for a
	// throwaway ns — same isolation as the hier arms).
	const hotnessOn = args.hotness === "on";
	const warmupN = hotnessOn ? Math.max(0, Number(args.warmup ?? "1")) : 0;
	const usrClient = hotnessOn ? (await import("../s2-agent-ext-knowledge-card/src/surreal-index.ts")) : null;
	let hotnessStats = new Map();
	if (hotnessOn) {
		const { makeContextClient, logUsage, usageStats } = usrClient;
		const ucl = makeContextClient({
			endpoint: args["surreal-endpoint"],
			...(args["surreal-namespace"] ? { namespace: args["surreal-namespace"] } : {}),
			requestTimeoutMs: 60_000,
		});
		if (warmupN > 0) {
			for (let w = 0; w < warmupN; w++) {
				for (const e of battery.kcard ?? []) {
					const res = await retrieveRecords({
						vaultPath: args.vault,
						folder: args.folder,
						tags: tokenize(e.q),
						queryText: e.q,
						topK: K,
						bodyMatch: true,
						slugDom: true,
						semantic: SEMANTIC,
						includeTrace: true,
						hotness: false,
						usageLog: false,
						...(args["test-embedder"] ? { _testEmbedder: makeTestEmbedder() } : {}),
						// D36 default lane: keep the same index (and throwaway ns)
						// the hier arms / the A/B use — hermetic in CI, and
						// apples-to-apples when a namespace is named for a
						// bounded-A/B (OFF vs ON must share ONE index).
						...(args["test-embedder"] || hotnessOn || args["surreal-namespace"] ? { _hierClient: (await ensureCardIndex()).client } : {}),
					});
					const stems = (res.trace?.cards ?? []).map((c) => c.path.split("/").pop()).filter(Boolean);
					if (stems.length > 0) await logUsage(ucl, stems);
				}
			}
		}
		hotnessStats = await usageStats(ucl);
	}

	let semanticUsedOnce = false;
	const scored = await scoreArm(battery.kcard ?? [], async (q) => {
		const result = await retrieveRecords({
			vaultPath: args.vault,
			folder: args.folder,
			tags: tokenize(q),
			queryText: q,
			topK: K,
			bodyMatch: true,
			slugDom: true,
			semantic: SEMANTIC,
			includeTrace: true,
			// Explicit pin — the measurement must not ride an env default flip.
			hotness: hotnessOn,
			usageLog: false,
			...(hotnessOn ? { _usageStats: hotnessStats } : {}),
			...(args["test-embedder"] ? { _testEmbedder: makeTestEmbedder() } : {}),
			...(args["test-embedder"] || hotnessOn || args["surreal-namespace"] ? { _hierClient: (await ensureCardIndex()).client } : {}),
		});
		if (result.trace?.semanticUsed) semanticUsedOnce = true;
		// Rank key = "card-id :: path" so target matching can hit either side.
		return result.cards.map((c) => `${c.id} :: ${c.path}`);
	}, (id, e) => {
		const targets = (e.vaultTargets ?? []).map((t) => t.toLowerCase());
		return targets.some((t) => id.toLowerCase().includes(t));
	});

	receipt.kcard = {
		vaultCards: files.length,
		coverage: {
			present: (battery.kcard ?? []).filter((e) => !e.negative && !e._absent).length,
			absent: (battery.kcard ?? []).filter((e) => !e.negative && e._absent).length,
			absentQueries: (battery.kcard ?? []).filter((e) => !e.negative && e._absent).map((e) => e.q),
		},
		semanticUsed: semanticUsedOnce,
		hotness: hotnessOn
			? { on: true, warmupRounds: warmupN, feedStems: [...hotnessStats.keys()].length }
			: { on: false },
		...scored,
		metricsTargetPresent: metricsTargetPresent(scored),
	};
}

// ── arm 3: kcard hierarchical retrieval (SurrealDB card index, ticket 07) ──
// ── arm 4: kcard flat vector-only (pure KNN over the same index, ticket 09 D23) ──
//
// The two Surreal arms share ONE index build (memoized — the fingerprint skip
// makes a warm rebuild cheap, but the first build embeds the whole folder).



const hierTargetMatch = (id, e) => {
	const targets = (e.vaultTargets ?? []).map((t) => t.toLowerCase());
	return targets.some((t) => id.toLowerCase().includes(t));
};

if (ARMS.has("kcard-hier")) {
	const { hierarchicalRetrieve } = await import("../s2-agent-ext-knowledge-card/src/hierarchical-retrieval.ts");
	try {
		const { client, build, testEmbedder } = await ensureCardIndex();
		let semanticLaneUsed = false;
		const scored = await scoreArm(battery.kcard ?? [], async (q) => {
			const res = await hierarchicalRetrieve(client, {
				query: q,
				topK: K,
				includeTrace: true,
				...(testEmbedder ? { embedder: testEmbedder } : {}),
			});
			if (res.trace?.semanticLane) semanticLaneUsed = true;
			// Rank key mirrors the kcard arm: "stem :: path" (stem ≈ card id lane).
			return res.cards.map((c) => `${c.stem} :: ${c.path}`);
		}, hierTargetMatch);
		receipt["kcard-hier"] = {
			available: true,
			index: { skipped: build.skipped, inserted: build.inserted, leaves: build.leafCount, aggs: build.aggCount, dim: build.dim, embedModel: build.embedModel, elapsedMs: build.elapsedMs },
			semanticUsed: semanticLaneUsed,
			...scored,
			metricsTargetPresent: metricsTargetPresent(scored),
		};
	} catch (err) {
		receipt["kcard-hier"] = { available: false, error: String(err?.message ?? err) };
	}
}

if (ARMS.has("kcard-flat-vector")) {
	// D23 ablation arm: the semantic lane ALONE — one KNN over `card`, leaves
	// only, cosine order. No FTS lane, no α blend, no γ propagation. Isolates
	// "what does the hierarchy + lexical blend add over raw vectors".
	const { embedQuery } = await import("../s2-agent-ext-knowledge-card/src/semantic.ts");
	try {
		const { client, build, testEmbedder } = await ensureCardIndex();
		const scored = await scoreArm(battery.kcard ?? [], async (q) => {
			const qv = await embedQuery(q, undefined, testEmbedder ?? undefined);
			if (!qv) return [];
			// KNN fetch is widened (K + agg headroom) then filtered to leaves
			// client-side — the KNN operator is not mixed with extra WHERE terms.
			const rows = await client.query(
				`SELECT stem, path, is_leaf FROM card WHERE vec <|${K + 20},100|> $qv;`,
				{ qv },
			);
			return (rows ?? [])
				.filter((r) => r.is_leaf)
				.map((r) => `${r.stem} :: ${r.path}`);
		}, hierTargetMatch);
		receipt["kcard-flat-vector"] = {
			available: true,
			index: { skipped: build.skipped, inserted: build.inserted, leaves: build.leafCount, aggs: build.aggCount, dim: build.dim, embedModel: build.embedModel, elapsedMs: build.elapsedMs },
			...scored,
			metricsTargetPresent: metricsTargetPresent(scored),
		};
	} catch (err) {
		receipt["kcard-flat-vector"] = { available: false, error: String(err?.message ?? err) };
	}
}

// ── emit ────────────────────────────────────────────────────────────────────

const receiptPath = args.receipt ?? join(ROOT, "output", "recall-audit", `receipt-${receipt.meta.ranAt.replace(/[:.]/g, "-")}.json`);
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

const fmt = (m) => (m ? `hit@1=${m.hit1}/${m.graded} hit@3=${m.hit3}/${m.graded} hit@${K}=${m.hitK}/${m.graded} MRR=${m.mrr}` : "n/a");
console.log("=== RECALL AUDIT ===");
console.log(`meta: k=${K} arms=${[...ARMS].join("+")} semantic=${SEMANTIC} embedder=${receipt.meta.embedder}`);
if (receipt.journal) {
	console.log(`journal: ${receipt.journal.available ? fmt(receipt.journal.metrics) : `UNAVAILABLE (${receipt.journal.error})`}`);
}
if (receipt.kcard) {
	console.log(`kcard:   ${fmt(receipt.kcard.metrics)}`);
	console.log(`kcard (target-present ${receipt.kcard.coverage.present}/${receipt.kcard.coverage.present + receipt.kcard.coverage.absent}): ${fmt(receipt.kcard.metricsTargetPresent)} semanticUsed=${receipt.kcard.semanticUsed}`);
}
if (receipt["kcard-hier"]) {
	const h = receipt["kcard-hier"];
	console.log(
		`kcard-hier: ${h.available ? fmt(h.metrics) : `UNAVAILABLE (${h.error})`}` +
		(h.available ? ` [index leaves=${h.index.leaves} aggs=${h.index.aggs} dim=${h.index.dim} model=${h.index.embedModel} semanticUsed=${h.semanticUsed}]` : ""),
	);
}
if (receipt["kcard-flat-vector"]) {
	const f = receipt["kcard-flat-vector"];
	console.log(`kcard-flat-vector: ${f.available ? fmt(f.metrics) : `UNAVAILABLE (${f.error})`}`);
}
console.log(`receipt: ${receiptPath}`);
