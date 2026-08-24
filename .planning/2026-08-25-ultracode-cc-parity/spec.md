# Spec — ultracode CC-parity

Target behavior, stated as the model-facing contract. Source of truth for what
"claude-code ultracode behavior" means in this effort (user directive
2026-08-25: "make bun-apps/s2-agent-ext-ultracode/ make claude-code-ultracode
behavior").

## The CC ultracode semantics being replicated

When ultracode is armed (session `/ultracode` / `/effort high|ultra`, or the
`ultracode`/`workflow` keyword on a message):

1. **Author by default, with a solo carve-out.** Every substantive task gets a
   workflow by default; solo turns are conversation or trivial mechanical
   edits. Framing: coverage and correctness are the goal — token thrift is not
   the constraint (bounded only by the user's explicit budget directive).
2. **Scale to the request.** "Find any bugs" → a few finders + single-vote
   verify. "Thoroughly audit / be comprehensive" → wider finder pool, 3–5-vote
   adversarial verify, judge panel / synthesis. The ladder maps request
   intensity to fan-out breadth + verification votes, not just adjectives.
3. **Quality patterns inline.** The armed guidance names `verify()`,
   `judgePanel()`, `loopUntilDry()`, `completenessCheck()` (and after t02,
   `synthesize()`) directly — the model does not need a `workflow_help` detour
   to discover them on an armed turn.
4. **Multi-phase sequencing.** Multi-phase work runs several workflows in
   sequence — one per phase — reading each result before authoring the next;
   the main loop stays between phases.
5. **No silent caps.** When the runtime clamps a run's concurrency, agent
   total, or maxAgents, the run's log says so.

## Non-goals

- Baseline (non-armed) guidance stays "use workflow only when the user
  explicitly asks" (map D2).
- Forced-prompt mechanics (`workflow-editor.ts` buildForcedWorkflowPrompt) stay
  byte-stable (map D3).
- Multi-modal sweep pattern (map D4). Runtime primitives beyond `synthesize()`
  (map D1).

## Verification contract

- Unit tests pin the directive strings and the armed addendum bullets
  (effort-command, workflow-tool guideline builders).
- t02: stdlib behavior test for `synthesize()` (null-filtering, big-tier
  default, compact result shape).
- t03: clamp logging observable in the run log; one `samples/smoke-e2e.ts`
  real-model run receipt recorded in the ticket.
