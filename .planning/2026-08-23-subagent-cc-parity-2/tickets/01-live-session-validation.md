# Ticket 01 — live-session validation + live-agent memory measurement

Status: open · Phase 1 (gates tickets 02–04)

## Scope

De-fog the teams-parity effort in a real interactive session and measure what
N live in-process child sessions cost. Two deliverables:

1. **Live-TUI smoke** of teams-parity tickets 01–05 surfaces — the surfaces
   that shipped 2026-08-22..23 without ever running in a live session.
2. **Memory harness** spawning K = 1..6 named live agents (the
   `SUBAGENT_MAX_LIVE` LRU cap) and sampling `process.memoryUsage()` before/
   after each, reporting per-session marginal cost and the LRU eviction delta.

## Smoke script (manual, in a real terminal)

Run `./s2-agent.sh` from the repo root. Record pass/fail per step in the
`## Smoke log` section below (or in the PR description if the ticket closes
before the log is filled):

1. Ask the model to `spawn_subagent` with `name: "smoke-a"` and a trivial
   read-only task. Observe the tool render and that the run completes.
2. "send smoke-a a follow-up asking what it just did" — `send_message` routes
   by name; the reply surfaces in the parent.
3. `/subagents` — the roster row for smoke-a shows live/completed state.
4. Spawn a second named child `smoke-b`, then "ask smoke-a to send smoke-b a
   message" — observe the parent-brokered relay (teams-parity ticket 05) in
   `/subagents`.
5. "ask smoke-b to request plan approval for X" — observe the parent-side
   decision prompt and the DENY-on-timeout path.
6. `list_subagent_runs list` — the live roster section renders.

Any failure is either fixed in this ticket (if small) or becomes a blocking
fog entry in map.md.

## Memory harness

- New `bun-apps/s2-agent-ext-subagent/tests/memory-live-agents.test.ts`,
  guarded `test.skipIf(!process.env.S2_MEM_PROBE)` so CI never pays for it.
  Run: `S2_MEM_PROBE=1 bun test tests/memory-live-agents.test.ts`.
- Uses the real live-agent open path via `persistent-agent.ts`'s injectable
  runner seams (same pattern as `tests/named-live-agent.test.ts`) with a fake
  transport (zero API spend — measures session-object overhead only; say so
  in the log).
- Samples `process.memoryUsage().rss` + `external` at K=0..6 and after forced
  LRU eviction; prints a table. Assert only structural facts (loose monotonic
  bound, registry length cap) so it cannot flake on GC — the NUMBERS are
  logged, not asserted.

## Files

- New: `bun-apps/s2-agent-ext-subagent/tests/memory-live-agents.test.ts`
- Maybe: a small test-helper export from `src/persistent-agent.ts` if a seam
  is missing
- map.md Fog-of-war resolution + spec.md §3 (memory evidence) — same PR

## Risks

- TUI-only behavior (viewer rendering) cannot be asserted headless — the smoke
  log is manual evidence by design; do not automate it into theater.
- Memory numbers vary by model/transport; the fake transport bounds what is
  being claimed.

## Verification

- `bun test tests/memory-live-agents.test.ts` passes WITHOUT the env (skip
  path asserted) and prints the table WITH it.
- Canonical gates stay green: `( cd bun-apps/s2-agent-ext-subagent && bun run
  check && bun run typecheck && bun test )` — and, per the learned systemic
  gap (teams-parity fog), run the full gate list for s2-agent-core-runtime and
  s2-agent-ext-ultracode too, regardless of diff scope.
- Smoke log filled; findings recorded in map.md + spec.md.
