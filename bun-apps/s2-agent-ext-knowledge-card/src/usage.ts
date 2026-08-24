/**
 * src/usage.ts — the RecallLedger feed for hotness decay (kcard-parity
 * ticket 08, D37).
 *
 * The SurrealDB `usage` table (defined-but-empty since ticket 02's D12 —
 * this module is its writer/reader) is an APPEND-ONLY event log: one row per
 * card access, never updated in place. Aggregates (`active_count`,
 * `last_used_at`) are REPLAYED from the log on read, so usage data survives
 * index rebuilds (D12: usage has no md counterpart; md stays canonical for
 * CONTENT, the ledger is canonical for USAGE).
 *
 * Writers (D37): explicit `zk_card` reads (kind "zk_card") and — downstream,
 * context-lifecycle's ticket 08 — the auto-recall injector (kind
 * "auto_recall"). Retrieval itself NEVER writes (read-only ranking surface;
 * ranking on writes would feed back into its own input).
 *
 * Row shape (SCHEMALESS):
 *   usage:{rand} { stem: string, kind: string, at: datetime, at_ms: number }
 *
 * `at_ms` (epoch ms) exists because `math::max` aggregates reliably on
 * numbers — string max over ISO datetimes would depend on uniform formatting.
 *
 * Library only — no ExtensionAPI.
 */
import type { SurrealClient } from "@repo/s2-agent-core-interface";

/** Usage-event kinds (D37, amended by the ticket 10 reconciliation: the
 *  production retrieve boundary — zk_ask / knowledge_query / zk-query CLI /
 *  the zk.retrieve host-fn — echoes the SERVED leaf cards into the ledger;
 *  bare library callers and the eval harness never write). */
export type UsageKind = "zk_card" | "auto_recall" | "retrieve";

/** One replayed aggregate per stem. */
export interface UsageAggregate {
	/** Replayed event count — the hotness `active_count`. */
	activeCount: number;
	/** Max event ts (epoch ms) — the hotness decay clock (D37: last USE). */
	lastUsedAtMs: number | null;
}

/** Append one usage event. Fire-and-forget at call sites (a failed write
 *  must never fail the read that triggered it). */
export async function recordUsage(
	client: SurrealClient,
	stem: string,
	kind: UsageKind,
	at: Date = new Date(),
): Promise<void> {
	const atMs = at.getTime();
	await client.query(
		"CREATE usage SET stem = $stem, kind = $kind, at = <datetime> $at, at_ms = $atMs;",
		{ stem, kind, at: at.toISOString(), atMs },
	);
}

/** Append one event per stem in a SINGLE `/sql` batch — the retrieve
 *  boundary's echo path (one served top-K = one round trip, not topK).
 *  Same fire-and-forget contract as recordUsage. Reviewer F6 note: the
 *  client retries 5xx/429/connection failures — a batch applied
 *  server-side but answered retryable gets duplicated, inflating
 *  `active_count` (pre-existing class for single recordUsage; accepted —
 *  a deterministic record id would close it if the ledger ever needs
 *  exactness). */
export async function recordUsageBatch(
	client: SurrealClient,
	stems: readonly string[],
	kind: UsageKind,
	at: Date = new Date(),
): Promise<void> {
	if (stems.length === 0) return;
	const atMs = at.getTime();
	const vars: Record<string, string | number> = {
		kind,
		at: at.toISOString(),
		atMs,
	};
	// One CREATE per stem with a numbered param — batch-stemmed into one
	// query body, well inside the /sql 1 MiB body cap at any realistic topK.
	const body = stems
		.map((s, i) => {
			vars[`s${i}`] = s;
			return `CREATE usage SET stem = $s${i}, kind = $kind, at = <datetime> $at, at_ms = $atMs;`;
		})
		.join("\n");
	await client.query(body, vars);
}

/** Replay aggregates for the given stems (one GROUP BY query). Stems with no
 *  events are simply absent from the map — callers treat missing as
 *  activeCount 0 / never-used (hotness 0.0). */
export async function usageAggregates(
	client: SurrealClient,
	stems: readonly string[],
): Promise<Map<string, UsageAggregate>> {
	const out = new Map<string, UsageAggregate>();
	if (stems.length === 0) return out;
	const rows = await client.query<Array<{ stem: string; n: number; last_ms: number | null }>>(
		"SELECT stem, count() AS n, math::max(at_ms) AS last_ms FROM usage WHERE stem IN $stems GROUP BY stem;",
		{ stems: [...stems].sort() },
	);
	for (const r of rows ?? []) {
		if (typeof r?.stem !== "string") continue;
		out.set(r.stem, {
			activeCount: typeof r.n === "number" ? r.n : 0,
			lastUsedAtMs: typeof r.last_ms === "number" ? r.last_ms : null,
		});
	}
	return out;
}
