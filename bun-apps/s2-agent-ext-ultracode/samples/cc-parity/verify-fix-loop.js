/**
 * CC-parity workflow sample B2 — Claude Code workflows doc
 * (code.claude.com/docs/en/workflows), example prompt: "Keep fixing until a
 * check passes".
 *
 * Shape: bounded fixer→checker loop (maxAttempts). The bounded-failure
 * surface (passed:false, bounded:true) is as much a part of the contract as
 * the pass. Unit-gated by tests/cc-parity-workflows.test.ts with a STATEFUL
 * fake runner (checker flips to PASS after N fixer rounds) — both the
 * early-exit and the bound-stop paths are asserted.
 */
export const meta = {
	name: "cc-parity-verify-fix-loop",
	description: "Keep fixing until a check passes: bounded fixer→checker loop with an explicit max-attempts stop.",
	phases: [{ title: "Loop", detail: "fixer → checker, until PASS or maxAttempts" }],
}

let A = args
if (typeof A === "string") {
	try { A = JSON.parse(A) } catch { A = {} }
}
A = (typeof A === "object" && A !== null) ? A : {}
const MAX = Math.max(1, Math.min(5, Number(A.maxAttempts) || 3))

phase("Loop")
let passed = false
let rounds = 0
let lastCheck = ""
while (rounds < MAX && !passed) {
	rounds++
	const fix = await agent(
		`FIX round ${rounds}: patch the failing module so the checker passes. Reply exactly FIXED.`,
		{ label: `fixer:${rounds}`, phase: "Loop" },
	)
	lastCheck = String(
		await agent(
			`CHECK the module after fix round ${rounds}. Reply with exactly PASS or FAIL.`,
			{ label: `checker:${rounds}`, phase: "Loop" },
		),
	).trim()
	log(`round ${rounds}: fix=${String(fix || "").trim()} check=${lastCheck}`)
	passed = lastCheck === "PASS"
}
return { passed, rounds, bounded: !passed, maxAttempts: MAX }
