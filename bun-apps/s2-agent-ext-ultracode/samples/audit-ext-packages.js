/**
 * audit-ext-packages — self-arc-17 t01, gate-fidelity rework (self-arc-18 t01).
 *
 * Shape (CC-parity B4, generalized): bounded parallel() batches of auditors,
 * one agent per s2-agent-ext-* package, each returning a schema'd verdict;
 * one synthesizer ranks real issues vs env-drift vs noise.
 *
 * Gate fidelity (why the rework): the arc-17 version hard-coded bare
 * `bun test` / bare `tsc` for every package and had no install
 * preflight. Measured consequence (2026-09-09 receipts): hyperframes was
 * failed for 49 vendored test files its own script never runs (bare `bun
 * test` sweeps node_modules), and file2md's stale workspace install read as
 * 30 fake reds until `bun install` restored it. Now every gate command is
 * DERIVED from the package's own package.json scripts (provenance recorded
 * per gate in the schema), absent gates are recorded — never substituted —
 * and a preflight installs the workspace and scans @repo symlinks (arc-17
 * D8 as code) before any package is measured, with `env-drift` a distinct
 * verdict from red.
 *
 * READ-ONLY-OR-GATES is enforced by prompt: audit children never modify
 * source — the preflight child installs, and only installs; fixes belong to
 * the arc executor.
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
		"Self-develop loop gate sweep: fan out one read-only auditor per s2-agent-ext-* package (gates derived from each package.json's own scripts, per-gate provenance), after an install preflight; synthesize real issues vs env-drift vs improvement room.",
	phases: [
		{ title: "Preflight", detail: "workspace install + @repo symlink scan before anything is measured" },
		{ title: "Audit", detail: "bounded parallel batches, one auditor per package, script-derived gates" },
		{ title: "Synthesize", detail: "rank real issues vs env-drift vs noise; name improvement room" },
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

const PREFLIGHT_SCHEMA = {
	type: "object",
	properties: {
		frozenLockfileExit: { type: "number" },
		plainInstallExit: { type: "number" },
		lockfileDrift: { type: "boolean" },
		danglingSymlinks: { type: "array", items: { type: "string" } },
		notes: { type: "array", items: { type: "string" } },
	},
	required: ["frozenLockfileExit", "plainInstallExit", "lockfileDrift", "danglingSymlinks", "notes"],
}

const AUDIT_SCHEMA = {
	type: "object",
	properties: {
		package: { type: "string" },
		commands: {
			type: "object",
			properties: {
				check: { type: "string" },
				typecheck: { type: "string" },
				test: { type: "string" },
			},
			required: ["check", "typecheck", "test"],
		},
		checkPass: { type: "boolean" },
		typecheckPass: { type: "boolean" },
		testPass: { type: "boolean" },
		absentGates: { type: "array", items: { type: "string" } },
		envDrift: { type: "boolean" },
		failures: { type: "array", items: { type: "string" } },
		warnings: { type: "array", items: { type: "string" } },
		improvementNotes: { type: "array", items: { type: "string" } },
	},
	required: ["package", "commands", "checkPass", "typecheckPass", "testPass", "absentGates", "envDrift", "failures", "warnings", "improvementNotes"],
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

phase("Preflight")
const preflight = await agent(
	`You are the INSTALL PREFLIGHT for the bun workspace at bun-apps/ (repo root is the cwd). Unlike the auditors, installing IS your job — but ONLY that: never edit, write, or create any file outside what the install itself writes. Run exactly:
1. cd bun-apps && (bun install --frozen-lockfile > /tmp/audit-preflight-frozen.log 2>&1; echo FROZEN_EXIT=$?)
2. If FROZEN_EXIT was not 0, retry unlocked: cd bun-apps && (bun install > /tmp/audit-preflight-plain.log 2>&1; echo PLAIN_EXIT=$?) — if step 1 passed, record PLAIN_EXIT as -1 (skipped), and put the tail -15 of /tmp/audit-preflight-frozen.log in notes so the receipt says WHY the frozen install failed.
3. Symlink health scan: cd bun-apps && for d in s2-agent-ext-*/node_modules/@repo; do [ -d "$d" ] || continue; for l in "$d"/*; do [ -e "$l" ] || echo "DANGLING:$l"; done; done; echo SYMLINK_SCAN_DONE
Do NOT hand-repair dangling symlinks — report them (the executor repairs per arc-17 D8).
Return the schema object: frozenLockfileExit / plainInstallExit from the EXIT echoes (plainInstallExit = -1 when step 2 was skipped); lockfileDrift = true only when the frozen install failed and the plain install succeeded; danglingSymlinks = the DANGLING: lines with the prefix stripped; notes = anything else worth knowing (cap 5).`,
	{ label: "preflight:install", phase: "Preflight", schema: PREFLIGHT_SCHEMA, timeoutMs: 300_000 },
)
if (!preflight) throw new Error("preflight agent returned null — install unverified; refusing to audit unmeasured environments")
log(`preflight: frozenExit=${preflight.frozenLockfileExit} plainExit=${preflight.plainInstallExit} lockfileDrift=${preflight.lockfileDrift} dangling=${(preflight.danglingSymlinks ?? []).length}`)

const auditOne = (pkg) =>
	agent(
		`You are a READ-ONLY auditor for the bun package bun-apps/${pkg} (repo root is the cwd). RULES: run ONLY the gate commands you derive in step 0; NEVER edit, write, or create any file (no source changes, no fixes — observations only); an absent gate is recorded "absent" and never silently skipped and never substituted with a bare command.

Step 0 — derive the gates from the package's OWN scripts:
Bash("cat bun-apps/${pkg}/package.json") — read scripts.check, scripts.typecheck, scripts.test verbatim.
- A gate present in scripts runs as exactly: cd bun-apps/${pkg} && (bun run <gate> > /tmp/audit-${pkg}-<gate>.log 2>&1; echo GATE_<GATE>_EXIT=$?) — e.g. a package whose scripts.test is "bun test tests/" runs (bun run test), NOT the raw string.
- A gate absent from scripts: run NOTHING for it; commands.<gate> = "absent"; add the gate name to absentGates. NEVER run bare "bun test" or bare "bun x tsc" as a substitute — bare runs sweep node_modules and produce fake reds (measured self-arc-17: hyperframes 31 vendored-test fails it does not own).

Run the derived commands in order (check, typecheck, test), capturing the GATE_*_EXIT lines. NOTE: $? after a pipe reflects the pipe tail in some shells — keep the (… ; echo $?) form above, which avoids it.
Inspect each /tmp/audit-${pkg}-*.log tail (tail -40) for the actual failure/warning lines.

Return the schema object: package="${pkg}"; commands.check / commands.typecheck / commands.test = the VERBATIM script strings from package.json (e.g. "biome check .", "tsc --noEmit", "bun test --isolate"), or "absent"; checkPass/typecheckPass/testPass from the EXIT codes (0 = pass; an absent gate passes=true via absentGates); absentGates = names of gates with no script; envDrift = true ONLY when a failing gate's failures are primarily module-resolution errors ("Cannot find package", missing files under node_modules) — put the exact error line in warnings; failures = the meaningful failing lines (test names, lint rule ids, TS errors — cap 8, each ≤160 chars); warnings = non-blocking warnings worth knowing (cap 5); improvementNotes = up to 3 concrete improvement observations (tests missing, dead code, flaky patterns) — observations only, you implement nothing.`,
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
// env-drift is a distinct verdict: a stale install fails gates without being
// a real red, so it is excluded here (the raw per-gate detail stays in
// verdicts; the synthesizer re-escalates drift that persists beyond module
// resolution).
const reds = results.filter((r) => !r.envDrift && (!r.checkPass || !r.typecheckPass || !r.testPass))
const envDriftPackages = results.filter((r) => r.envDrift).map((r) => r.package)
const absentGates = results.flatMap((r) => (Array.isArray(r.absentGates) ? r.absentGates : []).map((g) => `${r.package}:${g}`))
log(`audit: ${results.length}/${PACKAGES.length} audited, ${reds.length} red, ${envDriftPackages.length} env-drift, ${absentGates.length} absent gate(s)`)

phase("Synthesize")
const synthesis = await agent(
	`You are the synthesis auditor for a 26-package monorepo gate sweep. Install preflight receipt (JSON):\n${JSON.stringify(preflight)}\n\nPer-package verdicts (JSON):\n${JSON.stringify(results)}\n\nClassify HONESTLY: realIssues = gate failures that look like genuine breakage (recent-merge regressions, type errors, failing tests) — cite package + gate + the exact failure line. envDrift=true verdicts and module-resolution failures are environment drift, NOT realIssues — name them in likelyNoise unless the failure persists beyond module resolution. absentGates entries are improvementRoom candidates (missing gate declarations), not failures. likelyNoise = flakes, environment-shape failures, pre-existing accepted warnings. improvementRoom = the best concrete improvement observations across packages (cap 8, ranked). summary ≤ 400 chars.`,
	{ label: "synthesize", phase: "Synthesize", schema: SYNTH_SCHEMA, timeoutMs: 300_000 },
)

return {
	packages: PACKAGES.length,
	audited: results.length,
	preflight,
	redPackages: reds.map((r) => r.package),
	envDriftPackages,
	absentGates,
	verdicts: results,
	synthesis,
}
