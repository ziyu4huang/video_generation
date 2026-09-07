# Ticket 01 — Suite A: subagent CC-parity samples

Status: open · Phase 1 · Package: `bun-apps/s2-agent-ext-subagent`

## Goal

Four committed unit-level samples proving s2-agent parity for Claude Code's
sub-agents doc "Common patterns" (code.claude.com/docs/en/sub-agents):
isolate high-volume operations, run parallel research, chain subagents, and the
canonical code-reviewer example.

## Context

- Harness exists: `fakeSpawn(impl)` at `tests/subagent-tool.test.ts:49`;
  result builders `ok`/`failed`/`timedout`/`budgetAbort`/`turnsAbort` in
  `tests/_spawn-result.ts`. Reuse both — do not invent a second harness.
- Batch tool (`subagents`/list fan-out) children are ALWAYS read-only
  (edit/write/bash excluded; recon notice asserted at subagent-tool.test.ts:113).
  Design every task read-only.
- New file(s): `tests/cc-parity-subagent.test.ts` (or split per pattern if >~400
  lines). Fixtures under `tests/fixtures/cc-parity/` (planted-bug source file,
  3–5 small "research corpus" text files). All committed.

## Work

- **A1 context-isolation** (pattern: "Isolate high-volume operations"): child
  (`fakeSpawn`) produces a verbose body (~200 lines) ending with a compact marker
  line `SUMMARY: <token>`. Assert the PARENT-facing tool result surface is compact
  (carries the marker, NOT the verbose body), while the verbose body remains
  recoverable from the child's run record (persistence/run-view seam). Name the
  test after the pattern.
- **A2 parallel-research** (pattern: "Run parallel research"): batch fan-out of
  3 read-only research tasks over the seeded corpus; per-task `fakeSpawn` returns
  a distinct finding. Assert all positional results return in order, the batch
  read-only recon notice is present, and child options exclude edit/write/bash.
- **A3 chaining** (pattern: "Chain subagents"): spawn #1 returns a marker token;
  drive the parent seam that embeds #1's result into #2's task string; assert
  spawn #2's received task contains the token and #2's result returns. Unit sample
  proves the RESULT-PLUMBING seam honestly (the model-driven chaining behavior is
  proven live in ticket 04 — state this in a comment).
- **A4 code-reviewer** (canonical example): seed `fixtures/cc-parity/planted-bug.ts`
  with one obvious defect (e.g. off-by-one); define a read-only reviewer agent
  (tools exclude Edit/Write — the agent-def/preset seam used by presets +
  agent-type-catalog tests); reviewer `fakeSpawn` returns findings naming the
  planted line. Assert: findings returned, reviewer toolset excludes Edit/Write,
  fixture file bytes identical before/after (sha256 compare, belt-and-braces).

## Gates

`( cd bun-apps/s2-agent-ext-subagent && bun run check && bun run typecheck && bun test )`
— plus any repo-wide gates local_ci picks up. Schema-cost +0 (no tool-description
change). No new runnable scripts → no scripts-dir-contract delta.

## Done when

All four samples green and named after their CC patterns; fixtures committed;
9-scenario sweep untouched and green; map ticket checked.
