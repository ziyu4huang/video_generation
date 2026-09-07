/**
 * CC-parity workflow sample B5 — Claude Code workflows doc
 * (code.claude.com/docs/en/workflows), example prompt: "Research a topic
 * across many sources".
 *
 * Shape: reader fan-out over source docs; a reader that STOPS (empty output —
 * the runtime's recoverable-empty → null slot semantics) is dropped by the
 * doc's null-filtering idiom (.filter(Boolean)) and the synthesizer still
 * runs on the survivors. Unit-gated by tests/cc-parity-workflows.test.ts.
 */
export const meta = {
	name: "cc-parity-research-fanout",
	description: "Research a topic across many sources: reader fan-out, stopped readers drop to null, synthesis over survivors.",
	phases: [
		{ title: "Research", detail: "one reader per source" },
		{ title: "Synthesize", detail: "brief over surviving notes" },
	],
}

let A = args
if (typeof A === "string") {
	try { A = JSON.parse(A) } catch { A = {} }
}
A = (typeof A === "object" && A !== null) ? A : {}
const SOURCES = Array.isArray(A.sources) ? A.sources : []
if (SOURCES.length === 0) throw new Error("research-fanout: pass args.sources (array of paths)")

phase("Research")
const notes = await parallel(
	SOURCES.map((s) => () =>
		agent(`RESEARCH read ${s} and reply with exactly one line "NOTE ${s}: <the key fact>".`, {
			label: `read:${s}`,
			phase: "Research",
		})),
)
// The doc's null-for-stopped filtering: stopped/failed readers contribute
// nothing and never block the synthesis.
const survivors = notes.filter(Boolean)

phase("Synthesize")
const brief = await agent(`SYNTHESIZE these research notes into one brief paragraph:\n${survivors.join("\n")}`, {
	label: "synthesize",
	phase: "Synthesize",
})
log(`research: ${survivors.length}/${SOURCES.length} sources survived, brief written`)
return { sources: SOURCES.length, survivors: survivors.length, brief }
