# 09 — RecallLedger: session cooldown, no_relevant records nothing

- **Phase:** P2 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-28 · **Claimed:** 2026-08-28 (session b1431b1f)

## Resolution (2026-08-28, PR follows this ticket)

`src/inject/recall-ledger.ts` — `RecallLedger` class, injector-side session state
only: `tick()` (decrement-then-expire, called by the wiring once per PARENT agent
turn before the pipeline consults), `isCooled`, `recordServed`, `cooledCount`/
`toJSON` for the `/knowledge-recall` status. Default cooldown 3 turns.
Pipeline integration (`buildAutoRecallBlock` via optional `deps.ledger`):

- Cooled cards filtered BEFORE the score floor and budget — a cooled top card
  demotes the runner-up to top instead of blanking the turn; all-cooled returns
  `gated:false, cooled:N` (not a gate miss).
- `recordServed` runs only when a block actually rendered, and only for
  post-budget KEPT cards — no_relevant / floor-miss / budget-dropped turns
  record nothing (the OpenViking poisoning fix, plus "retrieved ≠ served").
- Footer `# cooled: N` appended to the injected block when a ledger is attached;
  no ledger dep = byte-identical t08 behavior (backward-compat pin).
- Wiring: factory-scope `new RecallLedger(autoRecall.cooldownTurns)` — per-session
  by construction (fresh extension load per AgentSession, the same D9 property
  the child-guard relies on); in-memory only, durability deferred to t10.

Acceptance delivered: serve→suppress×2→eligible-again pinned at BOTH the
pipeline level (`__tests__/recall-ledger.test.ts`, 10 tests: expiry clock,
demotion, no_relevant-records-nothing, budget-drop-not-served, library purity —
identical retrieve options across turns, no-ledger back-compat) and the hook
level (`extension-contract.test.ts` four-turn session test over a real tmp vault
— the t08-deferred two-turn session test, delivered here as the ticket's
acceptance centerpiece). Gates: 722 tests pass, typecheck clean.

## Problem

Naive per-turn injection repeats the same cards every turn (token waste + attention
blindness). OpenViking's RecallLedger cools served URIs for N turns, with the subtle fix: a
"no_relevant" turn must NOT record anything, or never-served URIs get unfairly suppressed.

## Approach

1. Session-scoped ledger (Map: card id → turns-remaining, default 3) inside the injector
   state; decremented per agent turn.
2. Served cards are recorded ONLY when actually injected; a no-relevant-result turn records
   nothing (the OpenViking ledger-poisoning fix, verbatim).
3. Ledger consulted by the injector only — `retrieveRecords` stays pure (no session state in
   the library; keeps tests deterministic).
4. Exposed in the injected block footer (`# cooled: N`) for observability.

## Acceptance

- Deterministic multi-turn test: card served turn 1 → suppressed turns 2–3 → eligible turn 4;
  no_relevant turn records nothing (subsequent turns can still serve those cards).
- Injector unit tests from ticket 08 extended; no library-state leakage test
  (`retrieveRecords` called twice returns identical results).

## Verification

Canonical kcard gates; the ticket-08 scripted session test now asserts cooldown across
turns.
