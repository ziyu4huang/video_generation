---
effort: 2026-09-06-learnings-hardening
created: 2026-09-06
last: 2026-09-06
status: executing
---

# Wayfinder map: 2026-09-06-learnings-hardening — turn loop learnings into code + agent-loadable knowledge

## Destination

A learning confirmed by the self-evolve loop must not live only in a report:
it hardens into (1) regression/source-pin TESTS that fail CI when a fix
regresses, (2) the repo's `learnings` skill log any session can read, and
(3) the `hard-problem` agentType — a committed `.pi/agents` definition bound
to zai/glm-5.3 with the learnings baked into its prompt — so subagents FULLY
UNDERSTAND the learnings without anyone re-explaining them. Receipts prove
the model binding end-to-end (`childModelIsGlm53`).

## Tickets

**Execution order:** 01 → 02 → 03 (single branch, stacked on
agents-manager-t02 / PR #2193 — the pins reference the agents-scenario
pacing that lands there).

| Ticket | Status | Summary |
|---|---|---|
| `01` (implicit, this map) | done | knowledge layer: `.pi/agents/hard-problem.md` (model zai/glm-5.3, operating learnings in the prompt) + 3 dated entries in the `learnings` skill (stale core cache F2, pty key pacing F1, hard-problem routing convention) |
| `02` | done | code layer: `tui-drive-hardening.test.ts` (pins TERM forcing, 64B chunk feed, DA/kitty handling, settle heuristic, F1 pacing, model policy), `hard-problem-def.test.ts` (def contract: parses, big-model binding, learnings markers, registry load), core-cache wiring source pin (`workspaceSrcDirs: resolveWorkspaceSrcDirs()`) |
| `03` | done | model layer: tui-drive seeds `hard-problem.md` into every scratch project, dispatch/parallel/viewer prompts route through `agentType: hard-problem`, receipts assert `childModelIsGlm53` (a `Task(` row showing glm-5.3, flash excluded BY NAME — it is a substring) |

## Decisions

- D1: the definition (not a skill) is the subagent knowledge carrier —
  agentType prompts are what spawned children actually load; the learnings
  skill is the human/session-readable log. Both updated on every new
  learning (recorded in the learnings entry).
- D2: flash exclusion in receipts must be BY NAME (`!row.includes("flash")`)
  — "glm-5.3" is a substring of "glm-5.3-flash".
- D3: stacked on PR #2193 (merge that first); the pins reference its pacing.

## Fog of war

- Where exactly the child's model surfaces on screen: live `Task(` rows
  carry RunView.modelSeg once onModelResolved fires (shortModel drops the
  provider prefix) — confirmed by the receipt snaps, adjust pins if the
  render changes.
