/**
 * execute-t1.js — pipeline v2 T1 template (spec §2): one impl agent + one
 * verify agent, no phase overhead. Workflow SCRIPT: agent/phase/log are
 * runtime-injected globals — do not import them, do not run with `bun`
 * directly. Feed through samples/run.ts or the `workflow` tool.
 *
 *   bun bun-apps/s2-agent-ext-workflow/samples/run.ts \
 *     bun-apps/s2-agent-ext-workflow/samples/execute-t1.js
 *
 * args: { task: "what to implement", runCmd: "gate command", expected: "what green looks like",
 *         commitHint: "files touched" }
 */
export const meta = {
	name: "execute-t1",
	description: "T1 execution: 1 impl + 1 verify, gate-checked",
	phases: [{ title: "Execute" }],
};

phase("Execute");

// Args validation — missing args stops before any agent dispatch.
const a = args ?? {};
if (!a.task) {
	log("execute-t1: args JSON requires task/runCmd/expected/commitHint");
	return { ok: false, stage: "args", note: "args JSON requires task/runCmd/expected/commitHint" };
}

// Gate first — red stops entry, fog flows left (spec §4). Uses the shell.run
// host-fn (registered by s2-agent-ext-workflow) instead of Bun.spawnSync,
// which is not available inside the workflow VM context.
const gate = await call("shell.run", {
	cmd: ["bun", "bun-apps/s2-agent/src/cli.ts", "pipeline-gate", "--tier", "T1"],
});
if (gate.exitCode !== 0) {
	log(`pipeline-gate RED — refusing to dispatch:\n${gate.stdout}`);
	return { ok: false, stage: "gate", gateText: gate.stdout };
}
log(`gate green:\n${String(gate.stdout).trim().split("\n")[0]}`);

const brief = [
	`Mission (bounded, T1): ${a.task}`,
	`Run: ${a.runCmd}`,
	`Expected: ${a.expected}`,
	`Scope: ${a.commitHint}. Do not touch anything else.`,
	`Finish with: run the gate command, commit what is green with a clear message,`,
	`and return a final report (mandatory, even on budget death):`,
	`{ status, commit, gateOutput, notes }.`,
].join("\n");

const impl = await agent(brief, { label: "impl", tokenBudget: 260_000 });

const verify = await agent(
	[
		"Read-only verify child. Re-run the gate command and sanity-grep the diff.",
		`Impl report:\n${String(impl)}`,
		"Return a verdict: { verdict: 'green' | 'red', evidence }. Never edit files.",
	].join("\n"),
	{ label: "verify" },
);

log(`verify verdict: ${String(verify).trim().slice(0, 200)}`);

return { ok: true, stage: "done", impl, verify: String(verify).trim() };
