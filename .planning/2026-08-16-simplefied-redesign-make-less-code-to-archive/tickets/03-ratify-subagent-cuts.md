---
type: grilling
claimed: ratify-session 2026-08-16
blocking: 2
status: closed
---

## Question

Ratify the subagent cut list against ticket 02's verdicts: confirm CUT items (subprocess variant? retry-detector? scope-audit? runs-archive restructure?), confirm the tracking-substrate survival clause (restructure-yes/delete-no), and set the stage budget: cuts must exceed TUI-addition + workstream-C estimates so the package lands net-negative vs ticket-01 snapshot. Output: final cut list + acceptance numbers.

## Resolution

Ratified 2026-08-16 (grilling session). Four decisions:

1. **Subagent cut list — 4× KEEP, CUT = trivia only.** KEEP: `spawnSubagentSubprocess` (obsidian caller `src/lib/subagent.ts:308`), retry-loop-detector (guards dispatch, `subagent-tool.ts:36`), git-scope (6 importers), runs-tool vs viewer (different stores). CUT: `rm -rf dist/` (git-ignored stale build output) + fix dangling `{@link SubagentContextWidget}` jsdoc at `src/subagent-tool-render.ts:363`.
2. **Tracking-substrate survival clause — survives UNTOUCHED.** runs-tool + persistence + viewer; no restructure; optional ~30 LOC micro-dedup only if free during landing.
3. **Budget rule — TRIO-WIDE net-negative.** Counts src `.ts` + skills-dir files (md/js/cjs) across wayfind+superpowers+subagent vs the 2026-08-16 ticket-01 snapshot; re-run the ticket-01 census commands at closeout.
4. **Acceptance numbers (checked at ticket-09 closeout audit):** Δtrio ≤ −400; subagent Δsrc ≤ +800; superpowers Δ ≤ −1,200 (skills+src; contingent on ticket 04 ratifying verification-before-completion −241 + brainstorming companions −1,014); feature anchor ≥80% per package (superpowers 14→13 = 93% if verification-before-completion is cut).
