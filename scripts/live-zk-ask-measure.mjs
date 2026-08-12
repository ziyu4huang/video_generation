#!/usr/bin/env node
// @ts-nocheck
/**
 * live-zk-ask-measure.mjs — LIVE zk_ask retrieval-quality measurement.
 *
 * WHAT THIS MEASURES
 *   For each real query in scripts/real-retrieval-eval.json:
 *     - Shell out to a LIVE `zk-ask --retrieve-only --blend default --top-k 4`
 *       run (the flagship recall path: obsidian_search seed retrieval +
 *       graph expansion + score ranking, executed by an agent).
 *     - Parse the assembled context (the "Reference notes:" section the agent
 *       appends) for the surfaced note paths.
 *     - Record whether the expected card (the `expect` substring) surfaced.
 *
 * METRICS
 *   A.  hitRate@4Strict — the expected card appears in the FIRST 4 entries of
 *       the agent's Reference-notes list (its declared top-4 ranking). THIS is
 *       the apples-to-apples comparator to the tag-path baseline (0.48): both
 *       look at top-4 by their respective ranking. THE P7 gate metric.
 *   A2. hitRate@4Loose — the expected card appears ANYWHERE in the Reference
 *       notes list (the agent sometimes cites >4 despite --top-k 4; this counts
 *       a citation at any depth). Looser than strict.
 *   A'. hitRateAny — the expected card is mentioned anywhere in the run output
 *       (catches cards surfaced in prose/snippets but not formally cited).
 *       Lower bound on "zk_ask is aware of it"; hitRate@4Strict is strict recall.
 *   failureRate — runs that errored/timed out after retry (excluded from the
 *       hit-rate denominator; reported separately).
 *
 * P7 VERDICT GATE: hitRate@4Strict ≥ 0.5 → close the zk_ask branch (the 0.48
 * recall gap is a tag-path property); < 0.5 → open P7.
 *
 * OUTPUT: output/live-zk-ask-measurements/measure-<ts>.json (the receipt).
 *
 * HONEST DESIGN: each run drives a real agent (non-deterministic — can flake).
 * We retry once on failure/timeout and report hit-rate over SUCCESSFUL runs,
 * with the failure count surfaced separately. We do NOT cherry-pick. A
 * hitRate@4 < 0.5 is a genuine signal to open P7; ≥ 0.5 closes the zk_ask branch.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const CLI_DIR = join(REPO, "bun-apps/pi-agent");
const EVAL_FILE = join(REPO, "scripts/real-retrieval-eval.json");
const OUT_DIR = join(REPO, "output/live-zk-ask-measurements");

// Measurement knobs (flags that make the run honest + comparable).
const TOP_K = "4"; // hit-rate@4, matching the tag-path baseline's top-4
const BLEND = "default"; // lexical+graph (the vault-wide default, a DECISION)
const MODEL = process.env.ZK_ASK_MODEL ?? "lm-studio/google/gemma-4-26b-a4b-qat";
const THINKING = process.env.ZK_ASK_THINKING ?? "off"; // local model: no reasoning tax
const PER_QUERY_TIMEOUT_MS = Number(process.env.ZK_ASK_TIMEOUT_MS ?? 600_000); // 10 min/query
const MAX_QUERIES = process.env.ZK_ASK_MAX ? Number(process.env.ZK_ASK_MAX) : null;

// --- parsing helpers ---
const MD_PATH_RE = /([A-Za-z0-9_./\-]+\.md)/g;

function extractPaths(text) {
	const seen = new Set();
	const ordered = [];
	for (const m of text.matchAll(MD_PATH_RE)) {
		const p = m[1];
		if (!seen.has(p)) {
			seen.add(p);
			ordered.push(p);
		}
	}
	return ordered;
}

/** Paths from the "Reference notes:" section onward — the agent's declared selection. */
function referencePaths(text) {
	const idx = text.search(/Reference notes\s*[:：]/i);
	const tail = idx >= 0 ? text.slice(idx) : "";
	return extractPaths(tail);
}

function cardMatches(path, expect) {
	return path.toLowerCase().includes(expect.toLowerCase());
}

function runOne(query) {
	const args = [
		"run", "src/cli.ts", "cli", "zk-ask", "--retrieve-only",
		"--blend", BLEND,
		"--top-k", TOP_K,
		"--model", MODEL,
		"--thinking", THINKING,
		"-p",
		query,
	];
	let attempt = 0;
	let lastErr = null;
	// retry once on failure / timeout / no-footer
	for (attempt = 0; attempt < 2; attempt++) {
		const t0 = Date.now();
		const res = spawnSync("bun", args, {
			cwd: CLI_DIR,
			encoding: "utf8",
			timeout: PER_QUERY_TIMEOUT_MS,
			maxBuffer: 64 * 1024 * 1024,
		});
		const elapsed = (Date.now() - t0) / 1000;
		const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
		const timedOut = res.signal === "SIGTERM" || res.signal === "SIGKILL";
		const hasFooter = /---\s*zk-ask done\s*---/.test(out);
		if (!timedOut && res.status === 0 && hasFooter) {
			return { ok: true, attempt, elapsed, output: out, timedOut: false };
		}
		lastErr = timedOut
			? `timeout after ${PER_QUERY_TIMEOUT_MS / 1000}s`
			: `exit=${res.status} signal=${res.signal ?? "none"} footer=${hasFooter}`;
		// only retry if there's a chance (timeout or empty/missing-footer)
		if (!timedOut && res.status !== 0 && !hasFooter) {
			// hard error — but still retry once (cheap insurance)
		}
	}
	return { ok: false, attempt, elapsed: 0, output: "", timedOut: lastErr.startsWith("timeout"), error: lastErr };
}

async function main() {
	if (!existsSync(EVAL_FILE)) {
		console.error(`eval set not found: ${EVAL_FILE}`);
		process.exit(1);
	}
	const evalSet = JSON.parse(readFileSync(EVAL_FILE, "utf8"));
	let queries = evalSet.queries;
	if (MAX_QUERIES) queries = queries.slice(0, MAX_QUERIES);

	mkdirSync(OUT_DIR, { recursive: true });
	const rawLogDir = join(OUT_DIR, "_raw");
	mkdirSync(rawLogDir, { recursive: true });

	const results = [];
	let hit4Strict = 0, hit4Loose = 0, hitAny = 0, success = 0, failed = 0;
	const total = queries.length;

	console.log(`live zk_ask measure: ${total} queries | model=${MODEL} blend=${BLEND} top-k=${TOP_K} thinking=${THINKING} timeout=${PER_QUERY_TIMEOUT_MS / 1000}s`);
	console.log("baseline to beat: tag-path hitRate@4 = 0.48 | full-text proxy = 0.68");

	for (let i = 0; i < total; i++) {
		const item = queries[i];
		const tag = `[${i + 1}/${total}]`;
		process.stdout.write(`${tag} q="${item.q.slice(0, 60)}..." → `);
		const r = runOne(item.q);
		if (!r.ok) {
			failed++;
			console.log(`FAIL (${r.error})`);
			results.push({
				q: item.q, expect: item.expect, calloutCard: item.calloutCard,
				ok: false, error: r.error, attempts: r.attempt,
				referencePaths: [], allPaths: [], hit4Strict: false, hit4Loose: false, hitAny: false,
			});
			continue;
		}
		success++;
		const refs = referencePaths(r.output);
		const all = extractPaths(r.output);
		const h4Strict = refs.slice(0, 4).some((p) => cardMatches(p, item.expect));
		const h4Loose = refs.some((p) => cardMatches(p, item.expect));
		const hAny = all.some((p) => cardMatches(p, item.expect));
		if (h4Strict) hit4Strict++;
		if (h4Loose) hit4Loose++;
		if (hAny) hitAny++;
		const label = h4Strict ? "HIT@4(strict)" : (h4Loose ? "hit@4(loose)" : (hAny ? "hit-any" : "miss"));
		console.log(`${label} | ${r.elapsed.toFixed(0)}s${r.attempt > 0 ? " (retry)" : ""} | refs=${refs.length} | expect=${item.expect}`);

		// stash raw output for audit
		const slug = item.expect.replace(/[^a-z0-9]+/gi, "-");
		writeFileSync(join(rawLogDir, `${String(i + 1).padStart(2, "0")}-${slug}.txt`), r.output);

		results.push({
			q: item.q, expect: item.expect, calloutCard: item.calloutCard,
			ok: true, elapsed: r.elapsed, attempts: r.attempt,
			referencePaths: refs, allPaths: all,
			hit4Strict: h4Strict, hit4Loose: h4Loose, hitAny: hAny,
			top4Refs: refs.slice(0, 4).map((p) => p.replace(/^.*\//, "")),
		});
	}

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const receipt = {
		timestamp: new Date().toISOString(),
		model: MODEL,
		blend: BLEND,
		topK: Number(TOP_K),
		thinking: THINKING,
		perQueryTimeoutS: PER_QUERY_TIMEOUT_MS / 1000,
		totalQueries: total,
		successfulRuns: success,
		failedRuns: failed,
		baselineComparators: {
			tagPathHitRate4: 0.48,
			fullTextProxy: 0.68,
			source: "scripts/real-retrieval-measure.mjs (#356)",
		},
		metrics: {
			A_hitRate4Strict: {
				value: success ? hit4Strict / success : null,
				raw: `${hit4Strict}/${success}`,
				note: "expected card in the FIRST 4 of the agent's Reference-notes list (its declared top-4). Apples-to-apples with the tag-path 0.48 baseline. THE P7 gate metric.",
			},
			A2_hitRate4Loose: {
				value: success ? hit4Loose / success : null,
				raw: `${hit4Loose}/${success}`,
				note: "expected card ANYWHERE in the Reference-notes list (agent sometimes cites >4 despite --top-k 4). Looser than strict.",
			},
			Aprime_hitRateAny: {
				value: success ? hitAny / success : null,
				raw: `${hitAny}/${success}`,
				note: "expected card mentioned anywhere in the run output (catches prose/snippet surfacings not formally cited).",
			},
			failureRate: {
				value: failed / total,
				raw: `${failed}/${total}`,
				note: "runs that errored/timed out after retry (excluded from hit-rate denominator).",
			},
		},
		results,
	};

	const outPath = join(OUT_DIR, `measure-${ts}.json`);
	writeFileSync(outPath, JSON.stringify(receipt, null, 2));

	console.log("\n=== LIVE zk_ask MEASUREMENT (receipt) ===");
	console.log(JSON.stringify(receipt.metrics, null, 2));
	console.log(`\nreceipt: ${outPath}`);
	console.log(`successful: ${success}/${total} | failed: ${failed}/${total}`);
	const verdict = success
		? (receipt.metrics.A_hitRate4Strict.value >= 0.5
			? `→ hitRate@4Strict=${receipt.metrics.A_hitRate4Strict.value.toFixed(3)} ≥ 0.5 → CLOSE P7 zk_ask branch`
			: `→ hitRate@4Strict=${receipt.metrics.A_hitRate4Strict.value.toFixed(3)} < 0.5 → OPEN P7`)
		: "→ no successful runs (cannot settle)";
	console.log(verdict);
}

main().catch((e) => { console.error(e); process.exit(1); });
