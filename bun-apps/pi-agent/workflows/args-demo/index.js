// args-demo — a workflow pack that uses optional manifest args + a real engine
// primitive (parallel()), to prove packs carry genuine workflow behaviour.
//
// `args` comes from manifest.json `args` (the default), overridable by --args.
// parallel() fans out one agent() per topic concurrently — the engine's
// deterministic concurrency primitive, not a renamed single-file script.
//
// See ../README.md and ../../../docs/workflow-cli.md (workflow packs).

export const meta = {
	name: "args-demo",
	description: "demo: optional manifest args (topics) + the parallel() primitive",
	phases: [{ title: "FanOut" }],
};

// Default topics come from the manifest; --args '{"topics":[...]}' overrides.
const topics = Array.isArray(args?.topics) ? args.topics : ["alpha", "beta"];

phase("FanOut");
const results = await parallel(
	topics.map(
		(t) => () =>
			agent(`Reply with a single word about: ${t}`, { label: `topic-${t}`, phase: "FanOut" }),
	),
);

return { topics, results };
