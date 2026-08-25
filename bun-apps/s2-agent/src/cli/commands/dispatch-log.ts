/**
 * `dispatch-log` — the manual dispatch archive, queryable (pipeline v2 spec §3).
 * Reads ~/.pi/subagents/runs/<id>.json (SubagentRunRecord), normalizes into one
 * schema, prints rows + a death-rate summary.
 *
 * Scope (round-2 ticket 10): the charted "workflow" source was NEVER wired and
 * its producer (the cli workflow namespace) died in ticket 02 — the manual
 * archive is the one source, so the engine column and the workflow union half
 * are gone. Records carry no effort/tier attribution (they were stamped
 * "unknown" — now simply absent), so the query surface is `--outcome` only and
 * the command is report-only (always exits 0). Normalize functions are
 * exported pure; live reads only in run().
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentRunRecord } from "@repo/s2-agent-core-runtime";

export interface DispatchRecord {
	ticket: string;
	tokenBudget: number;
	outcome: "green" | "red" | "budget-dead" | "skipped";
	commit: string | null;
	ts: string;
}

/** Manual subagent run -> DispatchRecord. Status mapping:
 * done->green, failed->red, budget|timedout|turns->budget-dead, aborted->skipped.
 * The ticket id comes from the task text — never fabricated. */
export function normalizeSubagentRecord(rec: SubagentRunRecord): DispatchRecord {
	const outcome =
		rec.status === "done" ? "green"
		: rec.status === "failed" ? "red"
		: rec.status === "budget" || rec.status === "timedout" || rec.status === "turns" ? "budget-dead"
		: "skipped";
	return {
		ticket: rec.task?.match(/(?:ticket|task)\s*#?(\d+)/i)?.[1] ?? rec.id,
		tokenBudget: rec.usage?.total ?? 0,
		outcome,
		commit: null,
		ts: rec.startedAt ?? "",
	};
}

export interface DispatchFilter {
	outcome?: string;
}

/** Filter predicate shared by the renderer. */
export function matchesDispatchFilter(r: DispatchRecord, filter: DispatchFilter): boolean {
	return !filter.outcome || r.outcome === filter.outcome;
}

/** Human-readable table + a death-rate summary line. */
export function renderDispatchLog(records: DispatchRecord[], filter: DispatchFilter): string {
	const rows = records.filter((r) => matchesDispatchFilter(r, filter));
	const death = rows.filter((r) => r.outcome === "budget-dead" || r.outcome === "red").length;
	const pct = rows.length === 0 ? 0 : Math.round((death / rows.length) * 100);
	const lines = rows.map(
		(r) => `${r.ts} #${r.ticket} ${r.outcome} ${Math.round(r.tokenBudget / 1000)}k ${r.commit ?? "—"}`,
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

async function run(parsed: import("../args.ts").ParsedArgs): Promise<void> {
	console.log(renderDispatchLog(loadManualRecords(), { outcome: parsed.outcome }));
}

export const dispatchLogCommand = {
	name: "dispatch-log",
	summary: "query the manual dispatch archive (subagent runs)",
	details: `Usage:
  s2-agent cli dispatch-log [--outcome budget-dead]

Prints normalized records from the manual subagent archive
(~/.pi/subagents/runs) with a death-rate summary line. Report-only: exits 0.`,
	run: async (parsed: import("../args.ts").ParsedArgs) => {
		await run(parsed);
	},
};
