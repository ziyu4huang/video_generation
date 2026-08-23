---
effort: 2026-08-02-subagents-mid-flight-intervention
owner: agent
created: 2026-08-02
status: landed
merged: "#1013 (1f66d640)"
destination: Per-child mid-flight abort from the /subagents viewer (Frontier A reframe)
---

# Map — subagents mid-flight intervention (Frontier A) — LANDED

> **Landed in #1013 (squash 1f66d640).** 3 TDD tasks, 400/0 tests, tsc + biome
> clean. The fog reframed the ill-posed "parent-model live visibility" label
> into the tractable **intervention** lever (per-child user abort); live
> visibility was already shipped. See `spec.md` / `plan.md` for the resolved
> decisions (D0–D3).

## Destination (TBD pending decision)

The literal frontier label — **"parent-model live visibility / mid-flight
intervention"** — is **ill-posed** under the current synchronous dispatch model
(see Fog). The destination is whatever the reframing decision below resolves to.

## Background — what exists today (grounded in code)

**Dispatch is synchronous/blocking to the parent model.** `subagent.execute()`
(subagent-tool.ts) and `subagents.execute()` (subagents-tool.ts) both do
`await spawn(...)`; the parent LLM is suspended for the **entire** dispatch and
regains control only when the tool returns. The parent model can therefore
neither *see* live state nor *intervene* mid-flight — it is not executing.

**Live visibility is USER-facing only (already shipped):**
- `onUpdate` streams a 2-line header + ≤100-line activity trace to the TUI
  (`formatSubagentLive`, subagent-tool.ts); Ctrl-O expands it.
- The always-on progress widget (`subagent-progress-widget.ts`) + the
  `/subagents` Running section (`subagent-viewer.ts`) read the process-local
  `SubagentInFlightRegistry` singleton (`subagent-in-flight.ts`).

**An abort primitive exists — but only whole-turn / per-budget:**
- `externalSignal: AbortSignal` flows: parent tool-call `signal`
  → `spawnSubagent`'s `AbortController` (spawn-subagent.ts:223) → child
  `session.abort()` (agent.ts:530). Today that signal is the **whole-turn**
  interrupt (Esc/Ctrl-C) → aborts **every** in-flight child at once.
- `tokenBudget` / `spendBudget` / `timeoutMs` each abort a single child via
  `session.abort()` (agent.ts:522) — automatic, not user/model-directed.

**The gap:** the user watching the TUI can *see* one child failing/looping live
(the trace shows `⚠ error` lines), but the **only lever is Esc — which kills the
whole turn, not that one child.** There is no per-child abort, and no user/model
surface to trigger one. That is the tractable core of this frontier.

## Fog — why "parent-model live visibility" is ill-posed, and the reframings

The synchronous model means the parent LLM cannot act mid-dispatch. So the
literal ask splits into three candidate destinations with very different cost:

- **Reframe A — User mid-flight abort (per-child).** Wire a per-child
  `AbortController` into `InFlightSubagent`; expose an "abort this child"
  action in the `/subagents` Running section (+ optional keybind). The abort
  *infrastructure already exists* (signal → session.abort); we add per-child
  controllers + a user surface. Bounded, high-value, low-risk. The "live
  visibility" half is already shipped; this closes the missing *intervention*
  half. **Most tractable.**
- **Reframe B — Batch short-circuit / cancel-remaining.** A subset of A's abort
  infra: when a batch's decisive child finishes (or the user judges it),
  cancel the not-yet-decisive siblings. Smaller still, but only covers the
  batch tool.
- **Reframe C — True non-blocking dispatch (engine-level).** Make `subagents`
  async so the parent model keeps a turn and can poll/intervene mid-flight.
  Requires a fundamental engine change (async tool calls, model re-entering
  mid-tool-call). Large, foggy, high-risk — likely a separate multi-effort arc.

**Charting verdict:** the valuable + tractable core is **Reframe A** (user
mid-flight abort). "Parent-model" is a misnomer for "the human-in-the-loop
watching the parent's dispatch." C is real but is its own arc.

## Open decision (to resolve before spec)

Which destination? A / B / C / none-of-the-above. → see grilling.

## Notes

- The `/subagents` Running section + progress widget already render per-child
  rows keyed by the in-flight registry — an abort affordance slots in there.
- Per-child abort must NOT abort siblings: today the whole-turn signal fans out
  to all children; a per-child controller must be independent.
- A worktree-isolated child (agentDef.isolation === "worktree") aborts cleanly
  (session.abort + worktree teardown in the finally); a real-tree child aborts
  mid-edit — the abort action must surface that partial edits may remain.
- Durable-store Completed entries (PR #1008) are unaffected — abort happens in
  the in-flight (Running) phase, before any Completed reconstruction.
