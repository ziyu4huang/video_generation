# Ticket 05 — Spike: what does task-panel/workflow-ui actually need from `ActivityRow`?

> Wave 2 · spec §3 · status: closed · **time-boxed: one session (~half day)**

## Goal

Spike question: can `task-panel` / `workflow-ui` hydrate `agents → RunView → renderRunRow`
cheaply and faithfully, making `ActivityRow` production usage retireable (test-fixture-only)?

Today the navigator agents view hand-builds an `ActivityRow` per agent
(`workflow-ui.ts:431–441`: status cast, actor, model, live elapsed `Date.now() - startedAt`,
tokens, `summarizeLatestAction(history)`) and renders via `renderActivityRow`. The RunView stack
(`core-runtime/agent-row-display.ts`) already encodes glyph + elapsed-freeze + model segment +
usage. The spike measures the delta: elapsed-freeze semantics, `latestAction`, model fallback
segment, snapshot-only sourcing, hydration cost.

## Acceptance criteria

- **Findings, not code**: a written conclusion in this effort dir (ticket Resolution or a
  findings note) covering (a) field-by-field ActivityRow↔RunView delta, (b) hydration cost,
  (c) recommendation — retire vs keep-and-document.
- **User decision gate**: outcome reported to the user **before any retirement work is planned
  or executed**. This ticket delivers findings + recommendation only; retirement would be a
  follow-up effort.
- If the answer is "keep": the why is documented in `bun-apps/pi-agent-ext-workflow/CONTEXT.md`
  (or its docs equivalent) and the ticket closes.
- If the spike overruns the time-box: stop, record partial findings, close — no scope extension.
- No production code changes land from this ticket (a scratch prototype branch is fine; it is
  not merged).

## Files

- Read-only: `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts`, `task-panel.ts`,
  `bun-apps/pi-agent-ext-core-runtime/src/agent-row-display.ts` (+ RunView projection)
- Write: this effort dir (findings/Resolution); possibly workflow `CONTEXT.md` if outcome = keep

## Resolution (2026-08-16)

**Premise DISPROVEN**: there are **4 production ActivityRow sites**, not 1 — workflow-ui.ts:396-404 (navigator); task-panel.ts:360-368 (per-phase); subagent-viewer.ts:476-481 (running, hydrated from an already-built RunView — adapter duplication); subagent-viewer.ts:525-536 (completed).

Hydration is ~70% cheap today via a ~20-line/site synthetic-RunRecord adapter, but **faithful** retirement requires:

- `endedAt` on `WorkflowAgentSnapshot` (agentProjection drops it, run-persistence.ts:133; ~10-20 lines + tests),
- `renderRunRow` tokens-segment + injectable badge/detail (signature change),
- latest-action summarizer unification.

Full migrate ≈ **150-250 lines**.

**USER DECISION (2026-08-16): KEEP ActivityRow** as the shared generic row contract; document why (done — workflow `CONTEXT.md`); **no retirement work**. Future options recorded: S3-only swap (cheap, kills one adapter duplication); full retirement shape above if `renderRunRow` ever gains tokens+badge.

Confidence: HIGH on sites/deltas; MEDIUM on migration size.
