// sample — full-surface workflow-pack regression fixture.
//
// echo (single agent()) and args-demo (parallel()) leave pipeline(), phase(),
// and log() uncovered. This pack fills that gap and declares every manifest
// field (kind/engine/args/model/thinking/howToRun), so it doubles as a
// regression target: any change to the manifest schema or the resolver/runner
// that breaks this pack shows up in `bun test`. Hermetic — no bash, no writes,
// no network — just agent() calls over in-memory items.
//
// See ../README.md and ../../../docs/workflow-cli.md (workflow packs).

export const meta = {
	name: "sample",
	description: "regression fixture: full-surface manifest + pipeline()/phase()/log()",
	phases: [{ title: "FanOut" }, { title: "Summarise" }],
};

// Default items come from the manifest `args`; --args '{"items":[...]}' overrides.
const items = Array.isArray(args?.items) ? args.items : ["alpha", "beta", "gamma"];

phase("FanOut");
log(`sample: fanning out over ${items.length} item(s) — ${items.join(", ")}`);

// pipeline() processes each item in sequence (unlike parallel(), which is
// concurrent); each stage calls agent() once, so agentCount === items.length
// in a live run. Mirrors knowledge-distill's `await pipeline(SOURCES, fn)`.
const notes = await pipeline(items, async (it) =>
	agent(`Reply with a single word about: ${it}`, { label: `item-${it}`, phase: "FanOut" }),
);

phase("Summarise");
log(`sample: collected ${notes.length} note(s); done`);

return { items, notes };
