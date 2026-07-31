---
type: research
claimed:
---
## Question

Which seams let the forced reply-language block be applied **per turn (no explicit
trigger)**, and is each cleanly patchable from an in-repo prototype patch in
`bun-apps/pi-agent/src/patches/`?

### Candidates to evaluate (from chart-time spike)

1. **`prepareNextTurnWithContext`** (`agent-session.js:262-281`) — sets
   `context.systemPrompt = _systemPromptOverride ?? _baseSystemPrompt` every turn.
   ⚠️ Caveat: it is assigned as an **own property on `this.agent`** inside a session
   init method, so a `AgentSession.prototype` wrap will be shadowed. Determine the
   robust wrap point (wrap the init method that assigns it? wrap `Agent.prototype`'s
   turn-prep? re-wrap post-construction?).
2. **`getSystemPromptOptions()`** (`agent-session.js:597` region; ctx-exposed at
   `types.d.ts:256,1200`) — already the target of the repo's
   `ext-context-get-all-tool-definitions`/`ext-context-get-system-prompt-options`
   patches. Confirm whether it is **called per turn** and whether the prompt string
   flows through its return value (so prepending there reaches the request).
3. **The request-build consumption of `turn.context.systemPrompt`** in the Agent
   turn loop — the true per-turn read site; a wrap here is the most certain.

### Resolve

For each candidate: is it per-turn? what is the **exact** prototype/method wrap
point, idempotency story (WeakSet, mirroring `force-response-language.ts`), and
does it preserve `_systemPromptOverride` precedence? Rank by robustness. Also note
any interaction with compaction (`agent-session.js:900,905` reassigns
`state.systemPrompt`) — does a per-turn injection survive compaction?

### Deliverable

A ranked shortlist of per-turn seams with concrete wrap points, idempotency, and
the override/compaction caveats — feeding ticket 04's A/B.

## Resolution (closed)

**Winner seam: `_installAgentNextTurnRefresh()`** — a **prototype method**
(`agent-session.js:261`) called in **every `AgentSession` constructor**
(`agent-session.js:156`, between `_installAgentToolHooks()` and `_buildRuntime()`).
It assigns the per-turn `this.agent.prepareNextTurnWithContext`, which stamps
`context.systemPrompt = _systemPromptOverride ?? _baseSystemPrompt` **every turn**
(`:273`).

**Wrap strategy (robust + idempotent):**
- Wrap `AgentSession.prototype._installAgentNextTurnRefresh` to call the original,
  then **post-wrap** `this.agent.prepareNextTurnWithContext` so its returned
  `context.systemPrompt` is prepended with the forced block (re-read `settings.json`
  fresh each turn).
- Idempotency: WeakSet on the `this.agent` instance (not the prototype) so a
  session that re-installs the refresh isn't double-wrapped; mirrors the existing
  `force-response-language.ts` WeakSet pattern.
- Graceful degrade: if `_installAgentNextTurnRefresh` is missing/renamed, the wrap
  returns false and the existing `_rebuildSystemPrompt` injection still holds
  (no regression).

**Override precedence + compaction — both safe:**
- `_systemPromptOverride` precedence is preserved: we prepend to the value the
  original already computed (`_systemPromptOverride ?? _baseSystemPrompt`), so a
  custom prompt still wins for the base; the forced block rides on top as it must.
- Compaction reassigns `state.systemPrompt` (`:900,:905`), but
  `prepareNextTurnWithContext` re-stamps `context.systemPrompt` from
  `_baseSystemPrompt` **every turn**, and our wrap re-prepends every turn → the
  forced block survives compaction automatically.

**Secondary seam `getSystemPromptOptions()`** is patchable (repo already hooks it)
but `prepareNextTurnWithContext` is the more certain per-turn read site.

**Verdict:** per-turn injection is **cleanly patchable** — Candidate A is viable
and universal. Feeds ticket 04.
