/**
 * execute-plan.js — pipeline v2 T2/T3 main template (spec §2). Replaces the
 * executing-plans ticket-by-ticket dispatch: driver keeps judgement, this
 * script owns the deterministic fan-out. Workflow SCRIPT — runtime-injected
 * globals; feed through samples/run.ts or the `workflow` tool.
 *
 *   bun bun-apps/pi-agent-ext-workflow/samples/run.ts \
 *     bun-apps/pi-agent-ext-workflow/samples/execute-plan.js
 *
 * args: { effort: "2026-08-20-x", tickets: [{ id: "01", title: "...", runCmd: "...",
 *         expected: "...", brief: "self-contained mission text" }] }
 */
export const meta = {
	name: "execute-plan",
	description: "T2/T3 execution: gate -> pipelined impl+verify -> janitor -> ledger report",
	phases: [
		{ title: "Gate" },
		{ title: "Execute" },
		{ title: "Janitor" },
		{ title: "Report" },
	],
};

phase("Gate");

// Args validation — missing args stops before any agent dispatch.
const a = args ?? {};
if (!a.effort || !Array.isArray(a.tickets)) {
	log("execute-plan: args JSON requires effort (string) and tickets (array)");
	return { ok: false, stage: "args", note: "args JSON requires effort (string) and tickets (array)" };
}

// Uses the shell.run host-fn (registered by pi-agent-ext-workflow) instead of
// Bun.spawnSync, which is not available inside the workflow VM context.
const gate = await call("shell.run", {
	cmd: ["bun", "bun-apps/pi-agent/src/cli.ts", "pipeline-gate", "--effort", a.effort],
});
if (gate.exitCode !== 0) {
	log(`pipeline-gate RED — fog flows left:\n${gate.stdout}`);
	return { ok: false, stage: "gate", gateText: gate.stdout };
}
log(`gate green for ${a.effort}`);

phase("Execute");
// One ticket flows impl -> verify independently; no barrier between tickets.
// pipeline signature: (items, ...stages) where each stage receives (prev, original, index)
const results = await pipeline(
	a.tickets,
	(t) =>
		agent(
			[
				`Mission (bounded, one ticket): ${t.id} — ${t.title}`,
				t.brief,
				`Run: ${t.runCmd}`,
				`Expected: ${t.expected}`,
				`Evidence-base caps: aim for few, full turns (turn count dominates cost).`,
				`Finish with: run the gate, commit what is green, return a final report`,
				`{ status, commit, gateOutput, notes } — mandatory even on budget death.`,
			].join("\n"),
			{ label: `impl:${t.id}`, phase: "Execute", tokenBudget: 260_000 },
		),
	(implReport, t) =>
		agent(
			[
				"Read-only verify child. Re-run the ticket's gate command and",
				"sanity-grep the diff vs the mission brief.",
				`Ticket ${t.id}. Impl report:\n${String(implReport)}`,
				"Return { verdict: 'green'|'red', evidence }. Never edit files.",
			].join("\n"),
			{ label: `verify:${t.id}`, phase: "Execute" },
		).then((verdict) => ({ ticket: t.id, implReport: String(implReport), verdict: String(verdict) })),
);

phase("Janitor");
// Sweep budget-dead children: report status, re-run gates, flag what is green
// but uncommitted. (Agents that died return null — pipeline drops them; the
// janitor agent below inspects git state rather than trusting reports.)
const janitor = await agent(
	[
		"Read-only janitor sweep. Run 'git status' and 'git log --oneline -10'.",
		"For every hunk that is green (passes its ticket gate) but uncommitted, list it.",
		"Return { recoverable: [{ticket, files, gate}], clean: bool }. Never edit files.",
	].join("\n"),
	{ label: "janitor", phase: "Janitor" },
);

phase("Report");
const rows = results
	.filter(Boolean)
	.map((r) => {
		const outcome = /green/i.test(r.verdict) ? "green" : "red";
		const sha = (r.implReport.match(/\b[0-9a-f]{7,40}\b/) ?? ["—"])[0];
		return `| ${r.ticket} | ${outcome} | ${sha} |`;
	});
const ledger = ["| ticket | outcome | sha |", "|---|---|---|", ...rows].join("\n");
log(`dispatch ledger:\n${ledger}\njanitor: ${String(janitor).trim().slice(0, 300)}`);

return { ok: true, stage: "done", ledger, janitor: String(janitor) };
