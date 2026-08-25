# Ticket 05 — /cost-style session accounting

Status: pending

## Why

CC's `/cost` + `/status` show cumulative session spend, duration, and turn
count. Nothing in s2-agent computes money or wall time at all (grep clean
2026-08-25: no totalCost/cumulative/sessionCost outside ext-compact's
offline A/B harness); the turn counter already exists inside pathology's
accumulator, and `after_provider_response` is a known SDK event
(runner-hooks KNOWN_EVENTS).

## Scope

1. **Accumulator**: hook `after_provider_response` (and provider-error
   paths where usage is still reported) into a session-keyed store
   (mirror pathology's accumulator shape: bounded, reset at session_start,
   deleted at session_shutdown, per-sessionId buckets). Sum usage tokens
   (input/cached/output separately) + wall-clock session duration + turns.
2. **Pricing**: model→USD via the models store's pricing fields where
   present (check `s2-agent` models-store for per-model pricing; if absent,
   render tokens-only and say so — never invent numbers). Cache-read
   discount applied when the provider reports cached tokens.
3. **Surfaces**: (a) a `/cost`-style slash command (or extend `/status`
   equivalent) printing the summary line; (b) `inspect_agent` gains a
   `cost` block (cumulative + per-turn average); keep the tool's
   self_test deterministic (canned numbers).
4. **Subagent isolation**: in-process children must not double-count into
   the parent's ledger — key by sessionId like pathology's accumulator and
   verify with the existing child-session test shape.
5. Tests: usage summation (with + without cached fields), reset/shutdown
   semantics, child isolation, missing-pricing rendering.

Not in scope: cross-session totals (agent-trends territory, ticket 07
adjacent); budget enforcement (ultracode owns caps); API-cost of
extensions' schema tokens (schema-cost already estimates that).

## Done-when

- [ ] `/cost`-equivalent shows cumulative tokens + USD (or honest
      tokens-only) + duration + turns for a live session (manual receipt).
- [ ] inspect_agent carries the block; children isolated (tests).
- [ ] Canonical gates green; spec.md §1 /cost row updated; PR merged CLEAN.
