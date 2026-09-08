/**
 * audit-ext-packages — self-arc-17 t01: the self-develop arc audits ITSELF
 * with its own ultracode runtime (real glm-5.3 children via samples/run.ts).
 *
 * Shape (CC-parity B4, generalized): bounded parallel() batches of auditors,
 * one agent per s2-agent-ext-* package, each running that package's three
 * gates via Bash and returning a schema'd verdict; one synthesizer ranks
 * real issues vs noise. READ-ONLY-OR-GATES is enforced by prompt: audit
 * children never modify source — fixes belong to the arc executor.
 *
 * Run (repo root, real children):
 *   PI_MODEL=zai/glm-5.3 bun bun-apps/s2-agent-ext-ultracode/samples/run.ts \
 *     bun-apps/s2-agent-ext-ultracode/samples/audit-ext-packages.js \
 *     '{"packages":["s2-agent-ext-archify", ...]}'
 *
 * NOTE: no process/Date/import in workflow scripts; paths ride args; the
 * default package list below is the 26 ext packages as of 2026-09-09.
 */
export const meta = {
	name: "audit-ext-packages",
	description:
		"Self-develop arc closer: fan out one read-only auditor per s2-agent-ext-* package (check/typecheck/test gates), synthesize real issues vs noise vs improvement room.",
	phases: [
		{ title: "Audit", detail: "bounded parallel batches, one auditor per package" },
		{ title: "Synthesize", detail: "rank real issues vs noise; name improvement room" },
	],
}

let A = args
if (typeof A === "string") {
	try { A = JSON.parse(A) } catch { A = {} }
}
A = (typeof A === "object" && A !== null) ? A : {}

const PACKAGES = Array.isArray(A.packages) && A.packages.length > 0 ? A.packages : [
	"s2-agent-ext-archify", "s2-agent-ext-btw", "s2-agent-ext-compact", "s2-agent-ext-devops",
	"s2-agent-ext-file2md", "s2-agent-ext-flux2", "s2-agent-ext-hermes-memory", "s2-agent-ext-hyperframes",
	"s2-agent-ext-knowledge-card", "s2-agent-ext-krea2", "s2-agent-ext-ltx", "s2-agent-ext-movie-director",
	"s2-agent-ext-obsidian", "s2-agent-ext-power-tool", "s2-agent-ext-prompt-history", "s2-agent-ext-research-tool",
	"s2-agent-ext-subagent", "s2-agent-ext-superpowers", "s2-agent-ext-sv-analyzer", "s2-agent-ext-task",
	"s2-agent-ext-tool-gate", "s2-agent-ext-ultracode", "s2-agent-ext-wayfind", "s2-agent-ext-web-access",
	"s2-agent-ext-webui", "s2-agent-ext-zai-mcp",
]
const CONCURRENCY = Math.max(1, Math.min(8, Number(A.concurrency) || 7))

const AUDIT_SCHEMA = {
	type: "object",
	properties: {
		package: { type: "string" },
		checkPass: { type: "boolean" },
		typecheckPass: { type: "boolean" },
		testPass: { type: "boolean" },
		failures: { type: "array", items: { type: "string" } },
		warnings: { type: "array", items: { type: "string" } },
		improvementNotes: { type: "array", items: { type: "string" } },
	},
	required: ["package", "checkPass", "typecheckPass", "testPass", "failures", "warnings", "improvementNotes"],
}

const SYNTH_SCHEMA = {
	type: "object",
	properties: {
		realIssues: { type: "array", items: { type: "string" } },
		likelyNoise: { type: "array", items: { type: "string" } },
		improvementRoom: { type: "array", items: { type: "string" } },
		summary: { type: "string" },
	},
	required: ["realIssues", "likelyNoise", "improvementRoom", "summary"],
}

const auditOne = (pkg) =>
	agent(
		`You are a READ-ONLY auditor for the bun package bun-apps/${pkg} (repo root is the cwd). RULES: run ONLY the three gate commands below; NEVER edit, write, or create any file (no source changes, no fixes — observations only); if a command does not exist in that package, mark it pass=true with a note.

Run these in order, capturing the EXIT lines:
1. Bash("cd bun-apps/${pkg} && bun run check 2>&1 | tail -15; echo GATE_CHECK_EXIT=${"$"}{?}") — biome lint/format gate. NOTE: $? after a pipe reflects the pipe tail in some shells; prefer: cd bun-apps/${pkg} && (bun run check > /tmp/audit-${pkg}-check.log 2>&1; echo GATE_CHECK_EXIT=$?)
2. cd bun-apps/${pkg} && (bun x tsc --noEmit > /tmp/audit-${pkg}-tsc.log 2>&1; echo GATE_TSC_EXIT=$?)
3. cd bun-apps/${pkg} && (bun test > /tmp/audit-${pkg}-test.log 2>&1; echo GATE_TEST_EXIT=$?)
Inspect each /tmp/audit-${pkg}-*.log tail (tail -40) for the actual failure/warning lines.

Return the schema object: package="${pkg}"; checkPass/typecheckPass/testPass from the EXIT codes (0 = pass); failures = the meaningful failing lines (test names, lint rule ids, TS errors — cap 8, each ≤160 chars); warnings = non-blocking warnings worth knowing (cap 5); improvementNotes = up to 3 concrete improvement observations (tests missing, dead code, flaky patterns) — observations only, you implement nothing.`,
		{ label: `audit:${pkg}`, phase: "Audit", schema: AUDIT_SCHEMA, timeoutMs: 600_000 },
	)

phase("Audit")
// Bounded batches (CONCURRENCY wide) — deterministic order preserved.
const results = []
for (let i = 0; i < PACKAGES.length; i += CONCURRENCY) {
	const batch = PACKAGES.slice(i, i + CONCURRENCY)
	log(`audit batch ${Math.floor(i / CONCURRENCY) + 1}: ${batch.length} package(s)`)
	const out = await parallel(batch.map((p) => () => auditOne(p)))
	for (const r of out) if (r && r.package) results.push(r)
}
const reds = results.filter((r) => !r.checkPass || !r.typecheckPass || !r.testPass)
log(`audit: ${results.length}/${PACKAGES.length} audited, ${reds.length} package(s) with at least one red gate`)

phase("Synthesize")
const synthesis = await agent(
	`You are the synthesis auditor for a 26-package monorepo gate sweep. Per-package verdicts (JSON):\n${JSON.stringify(results)}\n\nClassify HONESTLY: realIssues = gate failures that look like genuine breakage (recent-merge regressions, type errors, failing tests) — cite package + gate + the exact failure line; likelyNoise = flakes, environment-shape failures, pre-existing accepted warnings; improvementRoom = the best concrete improvement observations across packages (cap 8, ranked). summary ≤ 400 chars.`,
	{ label: "synthesize", phase: "Synthesize", schema: SYNTH_SCHEMA, timeoutMs: 300_000 },
)

return {
	packages: PACKAGES.length,
	audited: results.length,
	redPackages: reds.map((r) => r.package),
	verdicts: results,
	synthesis,
}
