// dispatch-log.test.ts
import { describe, expect, test } from "bun:test";
import {
	normalizeSubagentRecord,
	normalizeWorkflowRun,
	renderDispatchLog,
	matchesDispatchFilter,
	type DispatchRecord,
} from "./dispatch-log.ts";

// Typed fixture helpers with sensible defaults for real type shapes
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

function mkPersistedRunState(overrides: Partial<import("@repo/s2-agent-ext-workflow").PersistedRunState>): import("@repo/s2-agent-ext-workflow").PersistedRunState {
	return {
		runId: "wf_test",
		workflowName: "test-workflow",
		script: "test.js",
		status: "completed",
		phases: [],
		startedAt: "2026-08-20T10:00:00Z",
		updatedAt: "2026-08-20T10:00:00Z",
		agents: [],
		logs: [],
		exec: { tokenBudget: 500000 },
		...overrides,
	};
}

describe("normalizeSubagentRecord", () => {
	test("done -> green", () => {
		const r = normalizeSubagentRecord(
			mkSubagentRecord({ status: "done", usage: { total: 180000, input: 90000, output: 90000, cacheRead: 0, cacheWrite: 0, cost: 0 }, task: "impl ticket 02" }),
		);
		expect(r.engine).toBe("manual");
		expect(r.outcome).toBe("green");
		expect(r.tokenBudget).toBe(180000);
	});
	test("manual records carry unknown effort/tier (no fabricated attribution)", () => {
		const r = normalizeSubagentRecord(mkSubagentRecord({ status: "done" }));
		expect(r.effort).toBe("unknown");
		expect(r.tier).toBe("unknown");
	});
	test("budget -> budget-dead, timedout -> budget-dead, failed -> red, turns -> budget-dead", () => {
		expect(normalizeSubagentRecord(mkSubagentRecord({ id: "r2", status: "budget" })).outcome).toBe("budget-dead");
		expect(normalizeSubagentRecord(mkSubagentRecord({ id: "r3", status: "timedout" })).outcome).toBe("budget-dead");
		expect(normalizeSubagentRecord(mkSubagentRecord({ id: "r4", status: "failed" })).outcome).toBe("red");
		expect(normalizeSubagentRecord(mkSubagentRecord({ id: "r5", status: "turns" })).outcome).toBe("budget-dead");
	});
});

describe("normalizeWorkflowRun", () => {
	test("maps agent statuses into records", () => {
		type PAS = { id: number; label: string; prompt: string; status: "done" | "error" | "queued" | "running" | "skipped"; tokens?: number };
		const rs = normalizeWorkflowRun(
			mkPersistedRunState({
				runId: "wf_1",
				workflowName: "execute-plan",
				exec: { tokenBudget: 500000 },
				agents: [
					{ id: 1, label: "impl:01", prompt: "p", status: "done", tokens: 210000 } as PAS,
					{ id: 2, label: "verify:01", prompt: "p", status: "error", tokens: 30000 } as PAS,
					{ id: 3, label: "impl:02", prompt: "p", status: "skipped" } as PAS,
				],
			}),
			"demo-effort",
			"T3",
		);
		expect(rs).toHaveLength(3);
		expect(rs[0]).toMatchObject({ engine: "workflow", ticket: "01", outcome: "green", tokenBudget: 210000 });
		expect(rs[1].outcome).toBe("red");
		expect(rs[2].outcome).toBe("skipped");
	});
});

describe("renderDispatchLog", () => {
	test("filters by outcome and counts death rate", () => {
		const records: DispatchRecord[] = [
			{ effort: "e", tier: "T2", ticket: "01", engine: "workflow", tokenBudget: 200000, maxTurns: 8, outcome: "green", commit: "abc1234", ts: "2026-08-20T10:00:00Z" },
			{ effort: "e", tier: "T2", ticket: "02", engine: "workflow", tokenBudget: 150000, maxTurns: 8, outcome: "budget-dead", commit: null, ts: "2026-08-20T11:00:00Z" },
		];
		const out = renderDispatchLog(records, {});
		expect(out).toContain("green");
		expect(out).toContain("budget-dead");
		expect(out).toContain("50%"); // death rate line
	});
});

describe("honest effort filtering (manual archive has no attribution)", () => {
	const manual: DispatchRecord[] = [
		{ effort: "unknown", tier: "unknown", ticket: "01", engine: "manual", tokenBudget: 90000, maxTurns: 0, outcome: "green", commit: null, ts: "2026-08-20T10:00:00Z" },
		{ effort: "unknown", tier: "unknown", ticket: "02", engine: "manual", tokenBudget: 80000, maxTurns: 0, outcome: "budget-dead", commit: null, ts: "2026-08-20T11:00:00Z" },
	];

	test("--effort query over manual-only records yields zero rows", () => {
		const out = renderDispatchLog(manual, { effort: "nonexistent-effort" });
		expect(out).toContain("0 dispatch(es)");
		expect(manual.filter((r) => matchesDispatchFilter(r, { effort: "nonexistent-effort" }))).toHaveLength(0);
	});
	test("any --effort value excludes manual records (unknown never matches)", () => {
		// Even a real effort name cannot match manual records — this is what
		// makes the exit-1 path honest instead of fabricated.
		for (const effort of ["nonexistent-effort", "2026-08-20-develop-pipeline-v2"]) {
			expect(manual.some((r) => matchesDispatchFilter(r, { effort }))).toBe(false);
		}
	});
	test("no filter shows all manual records with unknown labels", () => {
		const out = renderDispatchLog(manual, {});
		expect(out).toContain("unknown");
		expect(out).toContain("2 dispatch(es)");
	});
});
