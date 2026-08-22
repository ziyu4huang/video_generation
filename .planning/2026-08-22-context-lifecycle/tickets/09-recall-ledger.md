# 09 — RecallLedger: session cooldown, no_relevant records nothing

- **Phase:** P2 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open

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
