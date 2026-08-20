/**
 * `dispatch-log` — unified dispatch records for pipeline v2 (spec §3).
 * Every dispatch (workflow-driven or manual subagent) normalizes into one
 * schema, queryable by effort/tier/outcome. Feeds devops_retrospect and the
 * wayfind entry consult; replaces the single 2026-08-16 budget baseline with
 * accumulated history.
 *
 * Sources:
 *   manual   — ~/.pi/subagents/runs/<id>.json (SubagentRunRecord) — LIVE
 *   workflow — per-run PersistedRunState via createRunPersistence (workflow ext)
 *              — NOT YET WIRED (future ticket; see the effort ledger)
 * Normalize functions are exported pure; live reads only in run().
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentRunRecord } from "@repo/pi-agent-core-runtime";
import type { PersistedRunState } from "@repo/pi-agent-ext-workflow";

export interface DispatchRecord {
	effort: string;
	tier: string;
	ticket: string;
	engine: "workflow" | "manual";
	tokenBudget: number;
	maxTurns: number;
	outcome: "green" | "red" | "budget-dead" | "skipped";
	commit: string | null;
	ts: string;
}

/** Manual subagent run -> DispatchRecord. Status mapping:
 * done->green, failed->red, budget|timedout|turns->budget-dead, aborted->skipped.
 * The manual archive carries NO effort/tier attribution — records are stamped
 * "unknown" rather than fabricating the query's values onto them. */
export function normalizeSubagentRecord(rec: SubagentRunRecord): DispatchRecord {
	const outcome =
		rec.status === "done" ? "green"
		: rec.status === "failed" ? "red"
		: rec.status === "budget" || rec.status === "timedout" || rec.status === "turns" ? "budget-dead"
		: "skipped";
	return {
		effort: "unknown",
		tier: "unknown",
		ticket: rec.task?.match(/(?:ticket|task)\s*#?(\d+)/i)?.[1] ?? rec.id,
		engine: "manual",
		tokenBudget: rec.usage?.total ?? 0,
		maxTurns: 0,
		outcome,
		commit: null,
		ts: rec.startedAt ?? "",
	};
}

/** One workflow run -> one record per agent. Ticket parsed from the agent
 * label ("impl:01" / "verify:02" -> "01"); tokenBudget falls back to the
 * agent's actual token spend, then the run-level exec cap. */
export function normalizeWorkflowRun(
	state: PersistedRunState,
	effort: string,
	tier: string,
): DispatchRecord[] {
	return state.agents.map((a) => ({
		effort,
		tier,
		ticket: a.label.match(/(\d+)/)?.[1] ?? String(a.id),
		engine: "workflow" as const,
		tokenBudget: a.tokens ?? state.exec?.tokenBudget ?? 0,
		maxTurns: 0,
		outcome:
			a.status === "done" ? ("green" as const)
			: a.status === "error" ? ("red" as const)
			: ("skipped" as const),
		commit: null,
		ts: state.runId,
	}));
}

export interface DispatchFilter {
	effort?: string;
	tier?: string;
	outcome?: string;
}

/** Filter predicate shared by the renderer and the exit-code logic. */
export function matchesDispatchFilter(r: DispatchRecord, filter: DispatchFilter): boolean {
	return (
		(!filter.effort || r.effort === filter.effort) &&
		(!filter.tier || r.tier === filter.tier) &&
		(!filter.outcome || r.outcome === filter.outcome)
	);
}

/** Human-readable table + a death-rate summary line. */
export function renderDispatchLog(records: DispatchRecord[], filter: DispatchFilter): string {
	const rows = records.filter((r) => matchesDispatchFilter(r, filter));
	const death = rows.filter((r) => r.outcome === "budget-dead" || r.outcome === "red").length;
	const pct = rows.length === 0 ? 0 : Math.round((death / rows.length) * 100);
	const lines = rows.map(
		(r) =>
			`${r.ts}  ${r.effort} ${r.tier} #${r.ticket} ${r.engine} ${r.outcome} ${Math.round(r.tokenBudget / 1000)}k ${r.commit ?? "—"}`,
	);
	return [...lines, ``, `${rows.length} dispatch(es), ${pct}% death rate (red + budget-dead)`].join("\n");
}

function loadManualRecords(): DispatchRecord[] {
	const dir = join(process.env.HOME ?? "~", ".pi/subagents/runs");
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 200);
	} catch {
		return [];
	}
	const out: DispatchRecord[] = [];
	for (const f of files) {
		try {
			out.push(normalizeSubagentRecord(JSON.parse(readFileSync(join(dir, f), "utf8")) as SubagentRunRecord));
		} catch {
			// malformed record — skip
		}
	}
	return out;
}

async function run(repoRoot: string, parsed: import("../args.ts").ParsedArgs): Promise<void> {
	const effort = parsed.effort;
	const outcome = parsed.outcome;
	const records = loadManualRecords();
	const filter: DispatchFilter = {
		effort: effort || undefined,
		tier: parsed.tier, // pass through when explicitly set
		outcome,
	};
	console.log(renderDispatchLog(records, filter));
	if (effort) {
		// Manual records carry no effort attribution, so an --effort query can
		// only ever match workflow-side records (not yet wired — future ticket).
		console.log(
			"(manual archive has no effort attribution — filtering by effort covers workflow records only (not yet wired))",
		);
		const matched = records.filter((r) => matchesDispatchFilter(r, filter)).length;
		process.exitCode = matched === 0 ? 1 : 0;
	}
}

export const dispatchLogCommand = {
	name: "dispatch-log",
	summary: "query unified dispatch records (manual + workflow)",
	details: `Usage:
  pi-agent cli dispatch-log [--effort <name>] [--tier T2] [--outcome budget-dead]

Prints normalized dispatch records from the manual subagent archive
(~/.pi/subagents/runs), with a death-rate line. The manual archive has no
effort/tier attribution (records show "unknown"), so --effort/--tier
filters match workflow records only — workflow-side wiring is future
work (see the effort ledger). Exits 0 with records, 1 when --effort is
set and no records match.`,
	run: async (parsed: import("../args.ts").ParsedArgs) => {
		await run(join(import.meta.dir, "../../../../.."), parsed);
	},
};
