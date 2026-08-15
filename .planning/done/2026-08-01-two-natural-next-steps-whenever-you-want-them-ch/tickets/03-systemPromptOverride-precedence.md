type: research

## Question

Does the per-turn block **WIN** over `_systemPromptOverride`, and does any
LATER pipeline step reset `context.systemPrompt` after the wrap (losing the
block for that turn)?

**Context (chart-time):**
- `prepareNextTurnWithContext` sets
  `context.systemPrompt = _systemPromptOverride ?? _baseSystemPrompt`; the wrap
  PREPENDS the block to that result (`${block}\n\n${ctx.systemPrompt}`).
- The "prepends the block" + "forwards turn + signal" unit tests are GREEN — so
  the prepend itself works, and an override coexists (block on top).

**Open question:** is there a LATER step (after `prepareNextTurnWithContext`
returns) in the REAL pipeline that re-assigns `context.systemPrompt`
(compaction, `resource-extend`, tool-set change → `_rebuildSystemPrompt`),
dropping the prepended block for that turn? The unit tests can't see this — they
stub the pipeline at the single function.

Resolve by tracing the post-`prepareNextTurnWithContext` path in
`agent-session.js` for any `systemPrompt` reassignment, and checking whether the
override / rebuild paths re-read the base prompt (without the block).

**Outcome:** "no later reset (closed)" or "step X resets on event Y → block
lost → graduate a fix/mitigate ticket."
