// dispatch-log.test.ts — pins the surviving seams after the round-2 ticket-10
// trim: the status→outcome mapping, ticket-id extraction, token-budget
// passthrough, and the outcome filter + death-rate render. Deleted WITH the
// dead surface (equivalence proofs in the ticket Outcome): normalizeWorkflowRun
// + its describe (tested the never-wired workflow source — producer died in
// round-2 ticket 02) and the "honest effort filtering" describe (tested the
// --effort dead path; the honesty property is now structural — no effort field
// exists to fabricate).
import { describe, expect, test } from "bun:test";
import {
	normalizeSubagentRecord,
	renderDispatchLog,
	matchesDispatchFilter,
	type DispatchRecord,
} from "./dispatch-log.ts";

// Typed fixture helper with sensible defaults for the real record shape.
function mkSubagentRecord(overrides: Partial<import("@repo/s2-agent-core-runtime").SubagentRunRecord>): import("@repo/s2-agent-core-runtime").SubagentRunRecord {
	return {
		id: "test-id",
		toolCallId: "tc-1",
		task: "test task",
		model: "gpt-4",
		cwd: "/tmp",
		status: "done",
		startedAt: "2026-08-20T10:00:00Z",
		elapsedMs: 1000,
		output: "done",
		usage: { total: 100000, input: 50000, output: 50000, cacheRead: 0, cacheWrite: 0, cost: 0 },
		...overrides,
	};
}

describe("normalizeSubagentRecord", () => {
	test("done -> green, tokens pass through, ticket parsed from task text", () => {
		const r = normalizeSubagentRecord(
			mkSubagentRecord({ status: "done", usage: { total: 180000, input: 90000, output: 90000, cacheRead: 0, cacheWrite: 0, cost: 0 }, task: "impl ticket 02" }),
		);
		expect(r.outcome).toBe("green");
		expect(r.tokenBudget).toBe(180000);
		expect(r.ticket).toBe("02");
	});
	test("task without a ticket number falls back to the run id", () => {
		const r = normalizeSubagentRecord(mkSubagentRecord({ id: "run-abc", task: "freeform task" }));
		expect(r.ticket).toBe("run-abc");
	});
	test("budget -> budget-dead, timedout -> budget-dead, failed -> red, turns -> budget-dead", () => {
		expect(normalizeSubagentRecord(mkSubagentRecord({ id: "r2", status: "budget" })).outcome).toBe("budget-dead");
		expect(normalizeSubagentRecord(mkSubagentRecord({ id: "r3", status: "timedout" })).outcome).toBe("budget-dead");
		expect(normalizeSubagentRecord(mkSubagentRecord({ id: "r4", status: "failed" })).outcome).toBe("red");
		expect(normalizeSubagentRecord(mkSubagentRecord({ id: "r5", status: "turns" })).outcome).toBe("budget-dead");
	});
});

describe("renderDispatchLog", () => {
	const records: DispatchRecord[] = [
		{ ticket: "01", tokenBudget: 200000, outcome: "green", commit: "abc1234", ts: "2026-08-20T10:00:00Z" },
		{ ticket: "02", tokenBudget: 150000, outcome: "budget-dead", commit: null, ts: "2026-08-20T11:00:00Z" },
	];

	test("renders all records with a death-rate line", () => {
		const out = renderDispatchLog(records, {});
		expect(out).toContain("green");
		expect(out).toContain("budget-dead");
		expect(out).toContain("50%"); // death rate line
		expect(out).toContain("2 dispatch(es)");
	});
	test("--outcome filter narrows rows and recalculates the rate", () => {
		expect(matchesDispatchFilter(records[0]!, { outcome: "budget-dead" })).toBe(false);
		const out = renderDispatchLog(records, { outcome: "budget-dead" });
		expect(out).toContain("1 dispatch(es)");
		expect(out).toContain("100%");
	});
	test("empty archive renders zero rows, 0% rate", () => {
		const out = renderDispatchLog([], {});
		expect(out).toContain("0 dispatch(es)");
		expect(out).toContain("0%");
	});
});
