type: research

## Question

Does the force-response-language prototype wrap **interact** with SIBLING
patches (`subagent-model-floor` and others in `PATCH_TABLE`) that also touch
`AgentSession.prototype` / `prepareNextTurnWithContext` /
`_installAgentNextTurnRefresh`?

**Context (chart-time):**
- `PATCH_TABLE` is applied in order via `resolvePatchPlan`; each patch is
  env-gated. force-response-language wraps `_installAgentNextTurnRefresh` (then
  the per-turn `prepareNextTurnWithContext` fn).
- If another patch wraps the SAME method, the wraps **CHAIN** — order determines
  which runs first and whether the block survives the chain.
- The "re-install re-wraps the original" guard only fires on
  `_installAgentNextTurnRefresh` re-runs, NOT on a sibling patch that
  independently re-assigns `prepareNextTurnWithContext` WITHOUT preserving the
  `WRAP_TAG` — in which case the force block could be silently dropped.

Resolve by enumerating every `PATCH_TABLE` entry and checking which prototype
methods each touches (read each patch's wrap target). Pay special attention to
`subagent-model-floor`.

**Outcome:** "no overlapping method (closed)" or "patch X overlaps method Y →
interaction → graduate a fix (preserve tag / enforce order) or mitigate ticket."
