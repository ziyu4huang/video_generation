#!/usr/bin/env bun
// @ts-nocheck
/**
 * retrieval-eval.mjs — one-command retrieval eval harness (context-lifecycle
 * ticket 15, D10 consolidation).
 *
 * Consolidates the effort's scattered eval assets into ONE opt-in command:
 * corpus choice, retrieval dimensions, and metrics (hit@k / MRR /
 * tokens-per-render) in a single JSON receipt under `output/retrieval-eval/`.
 * Never part of `test` or any local_ci gate (D10, ≤5-min rule) — CI-verify the
 * harness itself via `bun run test:eval` (fixture corpus + mock embedder,
 * offline) and `__tests__/retrieval-eval.test.ts` (pins the metric math).
 *
 * Corpora:
 *   fixture    — inline hand-written card set (offline; mock embedder FORCED);
 *               the `test:eval` default. Asserts nothing itself — the package
 *               suite pins this mode's receipt shape.
 *   controlled — the controlled corpus staged from the real vault
 *               (papers-docagent + distill merged into one clean folder — the
 *               two domains share no vocabulary, so cross-domain noise is
 *               visible; cf. scripts/controlled-corpus.mjs at the repo root).
 *               Battery DERIVED deterministically: query = the card's H1
 *               title, target = the filename stem.
 *   real       — the real vault convergence folder + the committed eval set
 *               `scripts/real-retrieval-eval.json` (the t07 hit@4 bar).
 *
 * Dimensions: --model bge-m3|nomic (cache-keyed .knowledge-semantic/<model>.json
 * — the D3 A/B), --blend semantic|lexical, --tier abstract|overview|full,
 * --hotness on|off (t12 used-ledger multiplier; unseeded = production ledger
 * state), --k.
 *
 * Run (live A/B, real corpus):
 *   bun bun-apps/s2-agent-ext-knowledge-card/scripts/retrieval-eval.mjs \
 *     --corpus real --model bge-m3   # then --model nomic
 * Run (offline CI self-check):
 *   bun run --cwd bun-apps/s2-agent-ext-knowledge-card test:eval
 */
import { parseArgs } from "node:util";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const ROOT = resolve(PKG, "..", "..");

const MODELS = {
	"bge-m3": "text-embedding-bge-m3",
	nomic: "text-embedding-nomic-embed-text-v1.5",
};

const { values: args } = parseArgs({
	options: {
		corpus: { type: "string", default: "fixture" },
		vault: { type: "string" },
		folder: { type: "string", default: "Zettelkasten/knowledge-graph" },
		k: { type: "string", default: "4" },
		model: { type: "string", default: "bge-m3" },
		blend: { type: "string", default: "semantic" },
		tier: { type: "string", default: "abstract" },
		hotness: { type: "string", default: "off" },
		"test-embedder": { type: "boolean", default: false },
		receipt: { type: "string" },
		help: { type: "boolean", default: false },
	},
});

if (args.help) {
	console.log(`usage: bun ${join(PKG, "scripts", "retrieval-eval.mjs")} [options]
  --corpus fixture|controlled|real   corpus + battery (default fixture — offline)
  --vault <path>       vault root (controlled/real; default: resolveVault ladder)
  --folder <rel>       convergence folder (real corpus; default Zettelkasten/knowledge-graph)
  --k <n>              retrieval depth (default 4 — the hit@4 bar)
  --model <m>          bge-m3 | nomic | <full model id> (default bge-m3)
  --blend semantic|lexical  semantic blend vs pure lexical (default semantic)
  --tier abstract|overview|full  render tier for tokens-per-render (default abstract)
  --hotness on|off     t12 used-ledger multiplier, UNSEEDED = production ledger (default off)
  --test-embedder      deterministic hashing embedder (offline; forced on fixture)
  --receipt <path>     JSON receipt (default output/retrieval-eval/receipt-<ts>.json)

NOTE (real/controlled + live embedder): a stale .knowledge-semantic/<model>.json
fingerprint makes the run REBUILD the cache INSIDE the vault submodule (dirty gitlink
noise, #1833-class) — restore or commit vault-side deliberately.`);
	process.exit(0);
}

const K = Number(args.k);
if (!Number.isInteger(K) || K < 1) {
	console.error(`--k must be an integer >= 1, got ${args.k}`);
	process.exit(2);
}
const CORPUS = args.corpus;
const MODEL_ID = MODELS[args.model] ?? args.model;
const SEMANTIC = args.blend !== "lexical";
const TIER = args.tier;
const HOTNESS = args.hotness === "on";
const MOCK = args["test-embedder"] || CORPUS === "fixture";
if (!["fixture", "controlled", "real"].includes(CORPUS)) {
	console.error(`--corpus must be fixture|controlled|real, got ${CORPUS}`);
	process.exit(2);
}
if (!["semantic", "lexical"].includes(args.blend)) {
	console.error(`--blend must be semantic|lexical, got ${args.blend}`);
	process.exit(2);
}
if (!["abstract", "overview", "full"].includes(TIER)) {
	console.error(`--tier must be abstract|overview|full, got ${TIER}`);
	process.exit(2);
}
if (!["on", "off"].includes(args.hotness)) {
	console.error(`--hotness must be on|off, got ${args.hotness}`);
	process.exit(2);
}

// ── imports (after help/validate so --help stays dependency-free) ──────────

const { retrieveRecords } = await import("../src/retrieve.ts");
const { computeMetrics, estimateTokens, firstHitRank } = await import("../src/eval/metrics.ts");

/** Query → tag tokens (mirrors the recall-eval-harness q2t: len 3–30, first 10
 *  — retrieve.ts's tag expectation. zh-only queries tokenize to [] and ride
 *  the semantic/body lanes, exactly like the recall-audit battery arms). */
const q2t = (q) =>
	q
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((t) => t.length >= 3 && t.length <= 30)
		.slice(0, 10);

/** Deterministic hashing embedder (recall-audit's makeTestEmbedder): L2-
 *  normalized bag-of-words hashed into `dim` buckets. Offline, deterministic. */
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

// ── corpus staging ──────────────────────────────────────────────────────────

function fixtureCard(id, title, body, extra = {}) {
	return [
		"---",
		`id: "${id}"`,
		"created: 2026-08-30",
		"tags: [zettel, eval-fixture]",
		'sources: ["eval-fixture"]',
		`source_id: "${id}"`,
		"record_type: pattern",
		"status: active",
		...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
		"---",
		`# ${title}`,
		"",
		body,
		"",
	].join("\n");
}

/** Inline fixture corpus — 4 graded targets + 1 distractor + 1 negative
 *  control. Distinctive tokens live in title / body / summary so the lexical
 *  and body lanes are all exercised; receipt shape is pinned by the suite. */
const FIXTURE_CARDS = [
	{ file: "marlin-buoy-telemetry.md", body: "the marlin buoy telemetry uplink sends calibration beacons every twelve hours", summary: "buoy telemetry uplink notes" },
	{ file: "kestrel-wing-loading.md", body: "unrelated prose about harbor freight tools and coffee grinding", summary: "wing loading math for kestrel drones" },
	{ file: "orbital-docking-checklist.md", body: "a checklist body with the distinctive token quokka-jettison only in the body text", summary: "docking sequence steps" },
	{ file: "hydraulic-lift-maintenance.md", body: "schedule and seal inspection notes for the workshop hydraulic lift", summary: "lift maintenance cadence" },
	{ file: "distractor-noise.md", body: "completely unrelated filler about papercraft and glitter", summary: "noise" },
];
const FIXTURE_BATTERY = [
	{ q: "marlin buoy telemetry calibration beacons", target: "marlin-buoy-telemetry" },
	{ q: "kestrel wing loading math", target: "kestrel-wing-loading" },
	{ q: "orbital docking quokka-jettison step", target: "orbital-docking-checklist" },
	{ q: "workshop hydraulic lift seal inspection", target: "hydraulic-lift-maintenance" },
	{ q: "quantum fondue reciprocating llama", negative: true },
];

let vaultPath = null;
let folder = null;
let battery = null;
let stagingNote = null;

if (CORPUS === "fixture") {
	vaultPath = mkdtempSync(join(tmpdir(), "kcard-retrieval-eval-"));
	folder = "Zettelkasten/eval-fixture";
	const dir = join(vaultPath, folder);
	mkdirSync(dir, { recursive: true });
	for (const c of FIXTURE_CARDS) {
		const stem = c.file.replace(/\.md$/, "");
		const title = stem.replace(/-/g, " ");
		writeFileSync(join(dir, `fixture-${c.file}`), fixtureCard(stem, title, c.body, { summary: `"${c.summary}"` }));
	}
	battery = FIXTURE_BATTERY;
	stagingNote = { tempVault: true, cards: FIXTURE_CARDS.length };
} else {
	const { resolveVault } = await import("../../s2-agent-ext-obsidian/extensions/obsidian.ts");
	vaultPath = args.vault ?? (await resolveVault(ROOT)).path;
	if (CORPUS === "real") {
		folder = args.folder;
		// the eval set's `expect` is the target substring (t07 hit@4 bar)
		battery = JSON.parse(readFileSync(join(ROOT, "scripts", "real-retrieval-eval.json"), "utf8")).queries.map((e) => ({ q: e.q, target: e.expect }));
	} else {
		// controlled: stage papers-docagent + distill into ONE clean folder (the
		// two domains share no vocabulary — cross-domain hits are visibly
		// spurious). Battery derived: query = H1 title, target = stem.
		const stageRoot = join(ROOT, "output", "controlled-corpus-vault");
		const stageFolder = "Zettelkasten/controlled";
		const dst = join(stageRoot, stageFolder);
		rmSync(stageRoot, { recursive: true, force: true });
		mkdirSync(dst, { recursive: true });
		const srcFolders = ["Zettelkasten/papers-docagent", "Zettelkasten/distill"];
		battery = [];
		let cards = 0;
		for (const f of srcFolders) {
			const src = join(vaultPath, f);
			if (!existsSync(src)) continue;
			for (const name of readdirSync(src).sort()) {
				if (!name.endsWith(".md")) continue;
				cpSync(join(src, name), join(dst, name));
				cards++;
				const raw = readFileSync(join(src, name), "utf8");
				const h1 = raw.match(/^#\s+(.+?)\s*$/m)?.[1] ?? name.replace(/\.md$/, "");
				battery.push({ q: h1, target: name.replace(/\.md$/, "") });
			}
		}
		// memory-snapshot is a distill subfolder (non-.md dir entries skipped above)
		vaultPath = stageRoot;
		folder = stageFolder;
		stagingNote = { stagedFrom: srcFolders, cards, batteryDerived: "h1-title" };
	}
}

if (!existsSync(join(vaultPath, folder))) {
	console.error(`corpus folder does not exist: ${join(vaultPath, folder)}`);
	process.exit(2);
}
const corpusFiles = readdirSync(join(vaultPath, folder)).filter((n) => n.endsWith(".md"));

// Corpus-coverage discipline (t04): a query whose target is ABSENT from the
// corpus is marked and scored separately — never a retrieval miss.
for (const e of battery) {
	if (e.negative || e.target == null) continue;
	e._absent = !corpusFiles.some((n) => n.toLowerCase().includes(e.target.toLowerCase()));
}

// ── run the battery through the REAL retrieveRecords ────────────────────────

let semanticUsedOnce = false;
let hotnessLedgerUsedOnce = false;
const perQuery = [];
const negatives = [];

try {
for (const e of battery) {
	const res = await retrieveRecords({
		vaultPath,
		folder,
		tags: q2t(e.q),
		queryText: SEMANTIC ? e.q : undefined,
		topK: K,
		bodyMatch: true,
		slugDom: true,
		semantic: SEMANTIC,
		...(SEMANTIC ? { semanticModel: MODEL_ID } : {}),
		tier: TIER,
		...(HOTNESS ? { hotness: true } : {}),
		includeTrace: true,
		...(MOCK ? { _testEmbedder: makeTestEmbedder() } : {}),
	});
	if (res.trace?.semanticUsed) semanticUsedOnce = true;
	if (res.trace?.hotnessLedgerUsed) hotnessLedgerUsedOnce = true;
	const rankKeys = res.cards.map((c) => `${c.id} :: ${c.path} :: ${c.title}`);
	if (e.negative) {
		negatives.push({ q: e.q, top1: rankKeys[0] ?? "(none)", retrieved: res.cards.length });
		continue;
	}
	const rank = firstHitRank(rankKeys, (key) => key.toLowerCase().includes(e.target.toLowerCase()));
	perQuery.push({
		q: e.q,
		target: e.target,
		rank: rank > 0 ? rank : "MISS",
		top1: rankKeys[0] ?? "(none)",
		tokensRendered: res.cards.reduce((s, c) => s + estimateTokens(c.detail ?? ""), 0),
		cardsReturned: res.cards.length,
		targetAbsent: Boolean(e._absent),
	});
}

const metrics = computeMetrics(
	perQuery.map((p) => ({ rank: p.rank === "MISS" ? 0 : p.rank, tokensRendered: p.tokensRendered, cardsReturned: p.cardsReturned, targetAbsent: p.targetAbsent })),
	K,
);

// ── receipt ─────────────────────────────────────────────────────────────────

const ranAt = new Date().toISOString();
const receipt = {
	meta: {
		ranAt,
		harness: "retrieval-eval.mjs (context-lifecycle t15)",
		corpus: CORPUS,
		vault: CORPUS === "fixture" ? "(temp)" : vaultPath,
		folder,
		k: K,
		model: args.model,
		modelId: MODEL_ID,
		blend: args.blend,
		tier: TIER,
		hotness: args.hotness,
		embedder: MOCK ? "test-hashing" : `live:${MODEL_ID}`,
		batteryQueries: battery.length,
		corpusCards: corpusFiles.length,
		staging: stagingNote,
	},
	metrics,
	trace: { semanticUsed: semanticUsedOnce, hotnessLedgerUsed: hotnessLedgerUsedOnce },
	perQuery,
	negatives,
};

const receiptPath = args.receipt ?? join(ROOT, "output", "retrieval-eval", `receipt-${ranAt.replace(/[:.]/g, "-")}.json`);
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

console.log("=== RETRIEVAL EVAL ===");
console.log(
	`corpus=${CORPUS} (${corpusFiles.length} cards) k=${K} model=${args.model} blend=${args.blend} tier=${TIER} hotness=${args.hotness} embedder=${receipt.meta.embedder}`,
);
console.log(
	`hit@1=${metrics.hit1}/${metrics.graded} hit@3=${metrics.hit3}/${metrics.graded} hit@${K}=${metrics.hitK}/${metrics.graded} MRR=${metrics.mrr}`,
);
console.log(`tokens/query=${metrics.tokensPerQuery} tokens/card=${metrics.tokensPerCard} absent=${metrics.absent} negatives=${negatives.length}`);
console.log(`semanticUsed=${semanticUsedOnce} hotnessLedgerUsed=${hotnessLedgerUsedOnce}`);
console.log(`receipt: ${receiptPath}`);
} finally {
	// fixture mode owns its temp vault — clean it up even on a mid-run crash
	if (CORPUS === "fixture") rmSync(vaultPath, { recursive: true, force: true });
}
