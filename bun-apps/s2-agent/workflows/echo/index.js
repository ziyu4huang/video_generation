// echo — the simplest workflow pack.
//
// Proves the full path: a folder with manifest.json + an entry script, run via
// `workflow run echo` through the s2-agent-ext-workflow engine. One agent()
// call; returns its `args` so a run is observable in the receipt.
//
// See ../README.md and ../../../docs/workflow-cli.md (workflow packs).

export const meta = {
	name: "echo",
	description: "smoke: one agent call that echoes the args it received",
	phases: [{ title: "Echo" }],
};

// Interpolate `args` into the prompt text so the agent actually sees them —
// the `args` global exists in the workflow scope and is returned below, but
// only strings passed in the prompt reach the agent's view.
const argsJson = JSON.stringify(args) ?? "none";
const reply = await agent(`Echo back, briefly, the args object you received: ${argsJson}`, {
	label: "echo-1",
	phase: "Echo",
});

return { echoed: reply, args };
