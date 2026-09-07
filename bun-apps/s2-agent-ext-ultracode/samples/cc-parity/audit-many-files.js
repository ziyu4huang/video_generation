/**
 * CC-parity workflow sample B1 — Claude Code workflows doc
 * (code.claude.com/docs/en/workflows), example prompt: "Audit many files for
 * the same issue".
 *
 * Shape: pipeline() over the file list — stage 1 fans out one audit agent per
 * file, stage 2 verifies/normalizes each verdict — then a summary of the
 * collected issues. Unit-gated by tests/cc-parity-workflows.test.ts (real
 * WorkflowManager, fake agent runner); runnable headlessly for real:
 *   bun bun-apps/s2-agent-ext-ultracode/samples/run.ts \
 *     bun-apps/s2-agent-ext-ultracode/samples/cc-parity/audit-many-files.js \
 *     '{"filenames":["samples/cc-parity/audit-corpus/notes.ts","samples/cc-parity/audit-corpus/planted-todo.ts","samples/cc-parity/audit-corpus/util.ts"]}'
 *
 * NOTE: the workflow runtime has no `process`/`Date`/`import` — helpers are
 * inlined and paths ride `args`.
 */
export const meta = {
	name: "cc-parity-audit-many-files",
	description:
		"Audit many files for the same issue: one agent per file (pipeline fan-out), per-file verdict verification, collected issue summary.",
	phases: [{ title: "Audit", detail: "one agent per file + verdict verify" }],
}

let A = args
if (typeof A === "string") {
	try { A = JSON.parse(A) } catch { A = {} }
}
A = (typeof A === "object" && A !== null) ? A : {}
const FILES = Array.isArray(A.filenames) ? A.filenames : []
if (FILES.length === 0) throw new Error("audit-many-files: pass args.filenames (array of paths)")

phase("Audit")
// Stage 1 fans out one audit agent per file; stage 2 verifies each verdict
// into a normalized record. A stopped/empty agent yields a null slot —
// counted, never silently dropped from the denominator.
const audited = await pipeline(
	FILES,
	(f) =>
		agent(
			`AUDIT the file ${f} for leftover TODO/FIXME markers. Reply with exactly CLEAN, or one line "ISSUE: <line> <snippet>". Do not paste the file.`,
			{ label: `audit:${f}`, phase: "Audit" },
		),
	(verdict, f) => {
		const v = String(verdict || "").trim()
		if (!v) return { file: f, issue: null, stopped: true }
		if (v === "CLEAN") return { file: f, issue: null }
		return { file: f, issue: v }
	},
)

const live = audited.filter(Boolean)
const issues = live.filter((r) => r.issue)
log(`audit: ${live.length}/${FILES.length} audited, ${issues.length} issue(s)`)
return { files: FILES.length, audited: live.length, stopped: FILES.length - live.length, issues }
