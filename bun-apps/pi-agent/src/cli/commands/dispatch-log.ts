/**
 * `dispatch-log` — unified dispatch records for pipeline v2 (spec §3).
 * Every dispatch (workflow-driven or manual subagent) normalizes into one
 * schema, queryable by effort/tier/outcome. Feeds devops_retrospect and the
 * wayfind entry consult; replaces the single 2026-08-16 budget baseline with
 * accumulated history.
 *
 * Sources:
 *   manual   — ~/.pi/subagents/runs/<id>.json (SubagentRunRecord)
 *   workflow — per-run PersistedRunState via createRunPersistence (workflow ext)
 * Normalize functions are exported pure; live reads only in run().
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentRunRecord } from "@repo/pi-agent-ext-subagent";
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
 * done->green, failed->red, budget|timedout|turns->budget-dead, aborted->skipped. */
export function normalizeSubagentRecord(
	rec: SubagentRunRecord,
	effort: string,
	tier: string,
): DispatchRecord {
	const outcome =
		rec.status === "done" ? "green"
		: rec.status === "failed" ? "red"
		: rec.status === "budget" || rec.status === "timedout" || rec.status === "turns" ? "budget-dead"
		: "skipped";
	return {
		effort,
		tier,
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

/** Human-readable table + a death-rate summary line. */
export function renderDispatchLog(records: DispatchRecord[], filter: DispatchFilter): string {
	const rows = records.filter(
		(r) =>
			(!filter.effort || r.effort === filter.effort) &&
			(!filter.tier || r.tier === filter.tier) &&
			(!filter.outcome || r.outcome === filter.outcome),
	);
	const death = rows.filter((r) => r.outcome === "budget-dead" || r.outcome === "red").length;
	const pct = rows.length === 0 ? 0 : Math.round((death / rows.length) * 100);
	const lines = rows.map(
		(r) =>
			`${r.ts}  ${r.effort} ${r.tier} #${r.ticket} ${r.engine} ${r.outcome} ${Math.round(r.tokenBudget / 1000)}k ${r.commit ?? "—"}`,
	);
	return [...lines, ``, `${rows.length} dispatch(es), ${pct}% death rate (red + budget-dead)`].join("\n");
}

function loadManualRecords(effort: string, tier: string): DispatchRecord[] {
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
			out.push(normalizeSubagentRecord(JSON.parse(readFileSync(join(dir, f), "utf8")) as SubagentRunRecord, effort, tier));
		} catch {
			// malformed record — skip
		}
	}
	return out;
}

async function run(repoRoot: string, parsed: import("../args.ts").ParsedArgs): Promise<void> {
	const effort = parsed.effort ?? "";
	const tier = parsed.tier ?? "T?";
	const outcome = parsed.outcome;
	const records = loadManualRecords(effort, tier);
	console.log(renderDispatchLog(records, {
			effort: effort || undefined,
			tier: parsed.tier, // pass through when explicitly set
			outcome,
		}));
	console.log(`(workflow-side records: run the workflow Report phase or 'workflow journal' — normalizeWorkflowRun is wired there)`);
	process.exitCode = records.length === 0 && effort ? 1 : 0;
}

export const dispatchLogCommand = {
	name: "dispatch-log",
	summary: "query unified dispatch records (manual + workflow)",
	details: `Usage:
  pi-agent cli dispatch-log [--effort <name>] [--tier T2] [--outcome budget-dead]

Prints normalized dispatch records from the manual subagent archive
(~/.pi/subagents/runs) plus the workflow journal summary, with a
death-rate line. Exits 0 with records, 1 when --effort is set and no records match.`,
	run: async (parsed: import("../args.ts").ParsedArgs) => {
		await run(join(import.meta.dir, "../../../../.."), parsed);
	},
};
