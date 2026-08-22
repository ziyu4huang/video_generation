# Ticket 08 — workflow-cron

status: closed 2026-08-23 (PR #1849 → main 0d0ff09e)

## Goal

`cron_create` / `cron_list` / `cron_delete` for workflows: 5-field cron, one-shot vs
recurring, 7-day recurring auto-expire, session-live firing (map D8).

## Steps

1. NEW `s2-agent-ext-ultracode/src/cron-scheduler.ts` — pure next-fire computation
   (incl. month/day-of-week OR semantics), one-shot vs recurring, expiry math.
2. NEW `src/cron-store.ts` — durable definitions under the ultracode state root
   (alongside run persistence); fire-records lease-claimed before dispatch so two
   concurrent live sessions never double-fire.
3. `extensions/ultracode.ts` — register the three tools; 30 s interval loop at
   `session_start` calling `WorkflowManager.startInBackground` per due definition;
   stopped at `session_shutdown`. Firing happens only while a session is live —
   documented limitation, no daemon.
4. CONTEXT.md terms: `cron schedule`, `one-shot`, `recurring (7-day expiry)`;
   `_Avoid_:` "timer", "heartbeat".

## Tests

- NEW `tests/cron-scheduler.test.ts` — cron math table (month/DOW OR, expiry,
  one-shot deletion), timezone-free (local time, matching pi convention).
- NEW `tests/cron-store.test.ts` — durable round-trip, lease-guarded claim.
- Tool tests with a fake manager.

## Acceptance

ultracode `bun run test` green; smoke: create one-shot schedule firing a trivial
workflow within the interval, lease prevents double-fire across two live sessions.

## Close-out notes (2026-08-23)

- Shipped as planned plus a `cron-loop.ts` module (tick logic separated from the
  interval so fake-manager tests drive ticks directly). Fire-records are the
  cross-session double-fire guard; recurring definitions auto-expire 7 days and
  fire-records past that horizon are GC'd at tick time (review finding 3).
- Review: REQUEST_CHANGES → 1 blocking fixed (synchronous `startInBackground`
  throw on an unparseable script used to wedge the definition behind its own
  live-pid claim; now recorded as failed + anchor moved, pinned by test) + 2
  non-blocking + 4 nits addressed → APPROVE.
- Live-LLM smoke NOT run (no live session; consistent with tickets 01-07). The
  lease test simulates two live sessions with two store instances over one
  state root.
- Drive-by in the same PR: fixed main's red ultracode `bun run check`
  (pre-existing biome errors from #1809) — see map fog items.
- `5/2` (step on a single value) is rejected, matching Vixie; steps need a
  span (`*/n` or `a-b/n`).
