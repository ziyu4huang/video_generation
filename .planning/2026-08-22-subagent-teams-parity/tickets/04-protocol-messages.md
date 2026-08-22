# Ticket 04 — protocol-messages

status: closed 2026-08-22 (PR #1829 → main 5e8eef5d; reviewer APPROVE-WITH-FIXES, both Majors + m1/m2 fixed pre-merge)

## Goal

shutdown_request/response and plan_approval_request/response as typed envelopes on
`send_message`.

## Steps

1. `send-message-tool.ts` — optional `type` union + `approve?` / `feedback?` on
   responses (schema only; one tool, matching CC).
2. NEW child-injected `request_plan_approval` tool — returns a Promise stored in the
   registry's pending-protocol map; parent notified via followUp;
   `plan_approval_response` resolves it. **Timeout defaults to DENY** (map D6).
   In-process path only; detach subprocess path refuses with a clear error.
3. `shutdown_request` parent→child: steer text + grace timer → `abort()`
   (two-stage, mirroring `BUDGET_WRAP_UP_MESSAGE` `agent-budget.ts:141`).
   Child→parent shutdown_request: notification only — parent approves via stop.
4. `list_subagent_runs` `stop` gains name-based lookup.
5. CONTEXT.md terms: `protocol message`, `plan approval`, `shutdown handshake`;
   `_Avoid_:` "kill", "cancel" (those are aborts).

Depends on: tickets 01 + 02.

## Tests

- NEW `tests/protocol-messages.test.ts` — approve/deny/timeout matrix; shutdown grace
  fires abort; detach-path refusal; steer-into-abort race (single AbortController per
  exchange).

## Acceptance

Subagent `bun run test` green; smoke: child plan approval round-trip with parent
approve and with timeout-deny.
