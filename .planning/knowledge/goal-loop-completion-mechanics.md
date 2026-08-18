# Goal-loop completion mechanics (continuation sessions)

- **discovered**: 2026-08-18, repo pi-agent-ext-task/src/goal/ (goal-complete-tool.ts, hooks.ts:373-390, prompts.ts)
- **fact**: The `goal_complete` tool is registered only in the session that created the goal. Automatic continuation prompts injected into a session WITHOUT that tool cannot close the goal by tool call — there is no sanctioned completion signal available to the continued agent.
- **designed exit**: the no-tool-progress auto-pause — 3 consecutive continuations with ZERO tool activity → goal auto-pauses (hooks.ts:373-390; the pause message itself notes "agent may lack the goal_complete tool"; the user then runs `/goal clear` to drop or `/goal resume` to continue).
- **failure mode observed**: re-verifying an already-complete goal every continuation round. Each verification dispatch counts as tool progress and DEFEATS the auto-pause — the 2026-08-18 budget-rebalance goal burned ~10 extra rounds this way (rounds 5-14) before the pattern was identified.
- **correct behavior** once work is verifiably shipped and no goal_complete tool exists: write durable knowledge artifacts ONCE (this dir / effort maps / ADRs), then reply narration-only with no tool calls and let auto-pause fire.
- **evidence**: session transcript rounds 5-14 (repeated zero-drift verification); hooks.ts auto-pause guard shipped in #1625.

## The stuck/auto-pause oscillation trap (observed 2026-08-18, ~5 continuation rounds)

Two harness guards with opposite incentives can deadlock a completed goal:
- **STUCK detector**: fires after 2 narration-only iterations ("no tool calls … abandon the angle, execute something now").
- **Goal auto-pause**: fires after 3 continuations with zero tool progress.

The stuck detector always fires FIRST — the agent is forced into tool activity every ≤2 rounds, so auto-pause can never accumulate its 3 quiet rounds. A completed goal lacking `goal_complete` therefore oscillates: forced action → re-verification or invented work → repeat. Observed cost: ~5 extra rounds after the work was verifiably done.

**Escape pattern**: treat each stuck-forced action as a *converging* series, not a fixed loop — spend each forced round on one genuinely new, monotonically-shrinking artifact (unaudited corner → knowledge amendment → hygiene), never on repeat verification of locked state. The action backlog genuinely reaches zero; from then on the stuck prompt's "abandon the angle" instruction is satisfied by changing the REPLY angle (shorter terminal declarations) rather than emitting tool calls, letting auto-pause finally fire.
