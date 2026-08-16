/**
 * src/loop.ts — the deterministic knowledge-card CONVERGENCE LOOP core.
 *
 * The trusted orchestration primitive both the `kcard-loop` CLI (Phase 2) and
 * the `kcard-converge-loop` saved workflow (Phase 3) wrap. It chains the
 * existing src library functions directly — NO LLM, NO subagent, NO shell-out,
 * NO `resolveVault` (the vault path is passed in):
 *
 *   Phase A (ingest):   collectInputFiles → adapt per family → ingestRecords
 *   Phase B (heal):     graphHealth → healGraph, looped until the health
 *                       signature is stable (loopUntilDry-equivalent)
 *   Phase C (probe):    probeRecall — retrieveRecords over a probe set
 *
 * Design invariants respected (do NOT break — see docs/ARCHITECTURE.md +
 * docs/kg-improvement-plan.md):
 *   - atomic-zettel (no chunking — the graph IS the structure signal)
 *   - deterministic sink (re-ingest is byte-stable; idempotent)
 *   - retrieval defaults unchanged (lexical + graph; IDF/semantic stay opt-in)
 *
 * The "dry" signal for the heal loop is the graph-health signature tuple
 * (deadLinks:mocMissing:mocStale:orphans) — identical to the `loopUntilDry`
 * primitive the workflow runtime injects (key on a stable signature, stop after
 * `consecutiveEmpty` no-progress rounds or `maxRounds`).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ingestRecords } from "./ingest.ts";
import {
	collectInputFiles,
	parseKnowledgeJsonl,
	adaptAutoMemoryMarkdown,
	adaptHermesMarkdown,
	adaptGenericMarkdown,
} from "./adapters.ts";
import type { KnowledgeRecord, SourceFamily } from "./types.ts";
import {
	graphHealth,
	healGraph,
	retrieveRecords,
	type GraphHealthResult,
} from "./retrieve.ts";
import { type LinkWeighting } from "@repo/pi-agent-core-interface";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One source to converge. `path` is a file or directory (expanded per family). */
export interface SourceInput {
	path: string;
	family: SourceFamily;
	/** Provenance label (default `<family>:<basename>`). */
	label?: string;
}

/** A probe query for recall verification. `expect` is a substring matched
 *  case-insensitively against each returned card's path or title. */
export interface ProbeQuery {
	q: string;
	expect: string;
}

export interface ConvergeOptions {
	sources: SourceInput[];
	/** Absolute vault path (the convergence sink). */
	vaultPath: string;
	/** Convergence folder (default Zettelkasten/knowledge-graph). */
	folder?: string;
	/** MOC note path, vault-relative (default Tags/Knowledge Graph.md). */
	mocPath?: string;
	/** Optional recall probe set run after healing. */
	probeQueries?: ProbeQuery[];
	/** top-K for the probe (default 4 — hit-rate@4, the settled metric). */
	probeTopK?: number;
	/** Max heal rounds (default 8). */
	maxRounds?: number;
	/** Consecutive no-progress rounds before stopping (default 2). */
	consecutiveEmpty?: number;
	/** Cross-link / retrieval ranking weight (default "count"; "idf" opt-in). */
	linkWeighting?: LinkWeighting;
	/** Wiki-aware upsert at ingest (default false). */
	wikiAware?: boolean;
	/** Max cross-link neighbours per card (default 20 — cohesive-batch fix). */
	maxLinks?: number;
	/** Cooperative cancellation. */
	signal?: AbortSignal;
}

export interface ConvergeReceipt {
	sourcesIngested: number;
	created: number;
	updated: number;
	unchanged: number;
	deadLinksBefore: number;
	deadLinksAfter: number;
	mocMissingBefore: boolean;
	mocMissingAfter: boolean;
	/** # of heal rounds actually performed (0 if the graph was already healthy). */
	rounds: number;
	/** true iff the final graph is healthy (regardless of rounds used). */
	converged: boolean;
	/** true iff maxRounds was hit WITHOUT reaching health. */
	truncated: boolean;
	probeHitRate?: number;
	probeHits?: number;
	probeTotal?: number;
	/** Final health snapshot. */
	health: GraphHealthResult;
}

export interface ProbeRecallOptions {
	vaultPath: string;
	folder?: string;
	queries: ProbeQuery[];
	/** top-K per query (default 4). */
	topK?: number;
	linkWeighting?: LinkWeighting;
}

export interface ProbeRecallResult {
	hits: number;
	total: number;
	hitRate: number;
	/** Per-query detail (which expect matched / didn't). */
	detail: Array<{ q: string; expect: string; hit: boolean; matchedPath?: string }>;
}

export interface HealthGateResult {
	ok: boolean;
	reasons: string[];
	health: GraphHealthResult;
}

// ---------------------------------------------------------------------------
// Health gate — wraps graphHealth with a human-readable reasons list
// ---------------------------------------------------------------------------

export async function healthGate(opts: {
	vaultPath: string;
	folder?: string;
	mocPath?: string;
}): Promise<HealthGateResult> {
	const health = await graphHealth({
		vaultPath: opts.vaultPath,
		folder: opts.folder ?? "Zettelkasten/knowledge-graph",
		mocPath: opts.mocPath,
	});
	const reasons: string[] = [];
	if (health.mocMissing) reasons.push("mocMissing");
	if (health.mocStale) reasons.push("mocStale");
	if (health.deadLinks.length > 0) reasons.push(`${health.deadLinks.length} dead link(s)`);
	if (health.orphans.length > 0) reasons.push(`${health.orphans.length} orphan(s)`);
	return { ok: health.ok, reasons, health };
}

// ---------------------------------------------------------------------------
// Probe recall — verify the graph actually answers expected queries
// ---------------------------------------------------------------------------

export async function probeRecall(opts: ProbeRecallOptions): Promise<ProbeRecallResult> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const topK = opts.topK ?? 4;
	const linkWeighting = opts.linkWeighting ?? "count";

	let hits = 0;
	const detail: ProbeRecallResult["detail"] = [];

	for (const query of opts.queries) {
		if (!query || !query.expect) {
			detail.push({ q: query?.q ?? "", expect: query?.expect ?? "", hit: false });
			continue;
		}
		// Tokenise the natural-language query into tags the same way
		// knowledge_query does (lexical seed). bodyMatch + slugDom carry the
		// recall signal lexical tag-only matching misses (the 0.48→0.84 path).
		const tags = tokenizeQuery(query.q);
		const result = await retrieveRecords({
			vaultPath: opts.vaultPath,
			folder,
			tags,
			topK,
			linkWeighting,
			bodyMatch: true,
			slugDom: true,
			queryText: query.q,
		});
		const needle = query.expect.toLowerCase();
		const matched = result.cards.find(
			(c) =>
				(c.path ?? "").toLowerCase().includes(needle) ||
				(c.title ?? "").toLowerCase().includes(needle),
		);
		const hit = Boolean(matched);
		if (hit) hits++;
		detail.push({ q: query.q, expect: query.expect, hit, matchedPath: matched?.path });
	}

	const total = opts.queries.length;
	return { hits, total, hitRate: total > 0 ? hits / total : 0, detail };
}

// ---------------------------------------------------------------------------
// The convergence loop
// ---------------------------------------------------------------------------

export async function runConvergenceLoop(
	opts: ConvergeOptions,
): Promise<ConvergeReceipt> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const mocPath = opts.mocPath ?? "Tags/Knowledge Graph.md";
	const maxRounds = opts.maxRounds ?? 8;
	const consecutiveEmptyTarget = opts.consecutiveEmpty ?? 2;

	// ── Phase A: ingest each source (sequential; parallelism is the workflow's
	//    job in Phase 3 — the library is in-process). ────────────────────────
	let created = 0;
	let updated = 0;
	let unchanged = 0;
	let sourcesIngested = 0;

	for (const src of opts.sources) {
		if (opts.signal?.aborted) break;
		const collected = collectInputFiles([src.path], {
			source: src.family,
			cwd: process.cwd(),
		});
		if (collected.files.length === 0) continue;

		const records: KnowledgeRecord[] = [];
		for (const abs of collected.files) {
			let content: string;
			try {
				content = readFileSync(abs, "utf8");
			} catch {
				continue;
			}
			if (src.family === "hermes") {
				records.push(...adaptHermesMarkdown(content));
			} else if (src.family === "auto-memory") {
				const r = adaptAutoMemoryMarkdown(content);
				if (r) records.push(r);
			} else if (src.family === "generic") {
				const r = adaptGenericMarkdown(content, abs);
				if (r) records.push(r);
			} else {
				records.push(...parseKnowledgeJsonl(content).records);
			}
		}
		if (records.length === 0) continue;

		const firstBase = basename(collected.files[0]!).replace(/\.(knowledge\.jsonl|md)$/, "");
		const sourceLabel = src.label ?? `${src.family}:${firstBase}`;
		const summary = await ingestRecords(records, {
			vaultPath: opts.vaultPath,
			source: src.family,
			sourceLabel,
			folder,
			mocPath,
			maxLinks: opts.maxLinks ?? 20,
			linkWeighting: opts.linkWeighting ?? "count",
			wikiAware: opts.wikiAware ?? false,
		});
		created += summary.created;
		updated += summary.updated;
		unchanged += summary.unchanged;
		sourcesIngested++;
	}

	// ── Phase B: heal until the health signature is stable ──────────────────
	const firstHealth = await graphHealth({ vaultPath: opts.vaultPath, folder, mocPath });
	const deadLinksBefore = firstHealth.deadLinks.length;
	const mocMissingBefore = firstHealth.mocMissing;

	let health = firstHealth;
	let rounds = 0;
	let consecutiveDry = 0;
	let prevSig: string | null = null;

	while (!health.ok && rounds < maxRounds) {
		if (opts.signal?.aborted) break;
		await healGraph({ vaultPath: opts.vaultPath, folder, mocPath });
		rounds++;
		const after = await graphHealth({ vaultPath: opts.vaultPath, folder, mocPath });
		const sig = healthSignature(after);
		// "dry" = signature unchanged since last round → no progress
		if (sig === prevSig) consecutiveDry++;
		else consecutiveDry = 0;
		prevSig = sig;
		health = after;
		if (consecutiveDry >= consecutiveEmptyTarget) break; // stuck — stop early
	}

	const truncated = !health.ok && rounds >= maxRounds && !opts.signal?.aborted;

	// ── Phase C: optional recall probe ──────────────────────────────────────
	let probeHitRate: number | undefined;
	let probeHits: number | undefined;
	let probeTotal: number | undefined;
	if (opts.probeQueries && opts.probeQueries.length > 0) {
		const probe = await probeRecall({
			vaultPath: opts.vaultPath,
			folder,
			queries: opts.probeQueries,
			topK: opts.probeTopK,
			linkWeighting: opts.linkWeighting,
		});
		probeHitRate = probe.hitRate;
		probeHits = probe.hits;
		probeTotal = probe.total;
	}

	return {
		sourcesIngested,
		created,
		updated,
		unchanged,
		deadLinksBefore,
		deadLinksAfter: health.deadLinks.length,
		mocMissingBefore,
		mocMissingAfter: health.mocMissing,
		rounds,
		converged: health.ok,
		truncated,
		probeHitRate,
		probeHits,
		probeTotal,
		health,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable signature for the heal loop's "dry" check (mirrors loopUntilDry key). */
function healthSignature(h: GraphHealthResult): string {
	return `${h.deadLinks.length}:${h.mocMissing ? 1 : 0}:${h.mocStale ? 1 : 0}:${h.orphans.length}`;
}

/** Tokenise a natural-language query into tag tokens (mirrors knowledge_query). */
function tokenizeQuery(q: string): string[] {
	return (q ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((t) => t.length >= 2 && t.length <= 30)
		.slice(0, 12);
}
