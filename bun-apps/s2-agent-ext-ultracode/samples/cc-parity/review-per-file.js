/**
 * CC-parity workflow sample B4 — Claude Code workflows doc
 * (code.claude.com/docs/en/workflows), example prompt: "Review every changed
 * file and write one summary".
 *
 * Shape: parallel() reviewer per file, then ONE synthesizer agent consuming
 * every per-file finding — the synthesizer's prompt completeness is the
 * parity receipt (no finding left behind). Unit-gated by
 * tests/cc-parity-workflows.test.ts (fake runner records every prompt).
 */
export const meta = {
	name: "cc-parity-review-per-file",
	description: "Review every changed file and write one summary: reviewer per file, one synthesizer over all findings.",
	phases: [
		{ title: "Review", detail: "one reviewer per changed file" },
		{ title: "Synthesize", detail: "one summary over every finding" },
	],
}

let A = args
if (typeof A === "string") {
	try { A = JSON.parse(A) } catch { A = {} }
}
A = (typeof A === "object" && A !== null) ? A : {}
const FILES = Array.isArray(A.filenames) ? A.filenames : []
if (FILES.length === 0) throw new Error("review-per-file: pass args.filenames (array of paths)")

phase("Review")
const reviews = await parallel(
	FILES.map((f) => () =>
		agent(`REVIEW the file ${f}. Reply with exactly one line "REVIEW ${f}: <finding or clean>".`, {
			label: `review:${f}`,
			phase: "Review",
		})),
)
const findings = reviews.filter(Boolean)

phase("Synthesize")
const summary = await agent(
	`SYNTHESIZE these per-file review findings into ONE summary paragraph. Cover every finding.\n${findings.join("\n")}`,
	{ label: "synthesize", phase: "Synthesize" },
)
log(`review: ${findings.length}/${FILES.length} reviewed, synthesized`)
return { reviewed: findings.length, stopped: FILES.length - findings.length, summary }
