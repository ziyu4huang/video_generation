/**
 * CC-parity workflow sample B3 — Claude Code workflows doc
 * (code.claude.com/docs/en/workflows), example prompt: "Migrate many files in
 * parallel" — the pattern arc-12 descoped (D3/D6: the BATCH `subagents` tool
 * forbids write-capable fan-out children, and rightly so: they share one tree).
 *
 * The capability exists at THIS layer: `agent()` accepts
 * `isolation: "worktree"` (workflow-runtime.ts) — each child gets its own
 * worktree under `<repoRoot>/.pi/worktrees/` on its own branch, writes there,
 * and the parent tree is never touched. That is exactly the doc's shape:
 * parallel ISOLATED writers, parent integrates.
 *
 * Requires: base repo with ≥1 commit (git worktree add needs HEAD). On a
 * non-repo the runtime logs `isolation ignored` and the child runs in the MAIN
 * tree — the sample asserts the count, not the writes; use a repo.
 *
 * Unit-gated by tests/cc-parity-migrate.test.ts (real WorkflowManager, a
 * recording runner that performs the writes — no LLM in the gate).
 */
export const meta = {
	name: "cc-parity-migrate-in-parallel",
	description: "Migrate many files in parallel: one worktree-isolated writer per file, integration report over per-file outcomes.",
	phases: [
		{ title: "Migrate", detail: "one isolated writer per file" },
		{ title: "Integrate", detail: "aggregate per-file outcomes" },
	],
}

let A = args
if (typeof A === "string") {
	try { A = JSON.parse(A) } catch { A = {} }
}
A = (typeof A === "object" && A !== null) ? A : {}
const FILES = Array.isArray(A.files) ? A.files : []
if (FILES.length === 0) throw new Error("migrate-in-parallel: pass args.files (array of path strings)")

phase("Migrate")
const results = await parallel(
	FILES.map((f) => () =>
		agent(
			`MIGRATE the file ${f}: apply the approved migration to it in place, then reply with exactly one line "MIGRATED ${f}: <what changed>".`,
			{
				label: `migrate:${f}`,
				phase: "Migrate",
				// THE pattern: an isolated writable copy per child — the one thing
				// the batch tool cannot offer and the workflow layer can.
				isolation: "worktree",
			},
		)),
)

phase("Integrate")
const migrated = results.filter(Boolean)
const report = await agent(
	`INTEGRATE these per-file migration outcomes into one paragraph, listing any file that needs a follow-up:\n${results
		.map((r, i) => `${FILES[i]}: ${r ?? "STOPPED (no outcome)"}`)
		.join("\n")}`,
	{ label: "integrate", phase: "Integrate" },
)
log(`migrate: ${migrated.length}/${FILES.length} files migrated in isolated worktrees`)
return { files: FILES.length, migrated: migrated.length, report }
