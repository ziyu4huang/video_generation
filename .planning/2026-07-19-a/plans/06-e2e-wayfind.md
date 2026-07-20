---
tracer-bullet: 6
ticket: 09
status: done
depends on: [02]
cross-package: true
---

# 06 — E2E verify the plan⇄wayfind loop (syncChainState closes tickets)

## Why

Tracer-bullets 1-4 built the publisher (core-task parses writing-plans → publishes `__piPlan*`). TB6 verifies the **feedback half** of the loop actually composes: a completed plan phase → `__piPlanPhases` → wayfind `syncChainState` closes the originating `[NN-slug]` ticket. Verification-first before refining (TB5 / ticket 04).

## Finding — a real cross-package contract bug 🐛

**Status-token mismatch** (the bug TB6 existed to catch):
- **core-task publisher** (`parse.ts`): a `[x]` checkbox → `status: "completed"` (canonical — matches `TaskStatus` + the pi `todo` tool schema).
- **wayfind reader** (`chain.ts:63`): `p.status === "complete"` ← missing the `d`.

➡️ `syncChainState` would **never close any ticket** (status never equals `"complete"`). wayfind's own tests passed because they **mocked** `__piPlanPhases` with `status: "complete"` — matching their own reader, not the real publisher. Isolated mock tests cannot catch cross-package contract drift; this TB6 (real parser → real reader) did.

**Second potential mismatch — ruled out:** `ticketIds`. core-task's `TICKET_RE = /\[(\d{2}-[a-z0-9-]+)\]/g` captures the **stem** (`03-foo`); wayfind's `findTicketByRef` matches `${id}-${slug}` → **aligned**. No second bug.

## Fix

Align the reader to the canonical publisher token (`"completed"` — 3 authoritative sources vs wayfind's outlier `"complete"`):
- `src/chain.ts`: runtime check `=== "complete"` → `=== "completed"` (+ 2 JSDoc mentions).
- `tests/{commands,coordination,chain}.test.ts`: 7 mock sites `status: "complete"` → `"completed"` — so wayfind's tests now reflect the **real** publisher value (durable guard against this drift class).
- `README.md`: 2 prose mentions.

## E2E guard

Added a **true cross-package e2e** in `tests/chain.test.ts`: imports core-task's REAL `parsePlan` (not a hand mock), parses `### Task 1: [03-foo] Foo` + `[x]`, publishes the actual `phases` on `globalThis.__piPlanPhases`, calls `syncChainState`, asserts ticket `03` closes. This pins the seam against future drift that isolated mocks miss.

## Scope note (ticket 08)

The e2e uses **writing-plans** format (`### Task N:`) — the canonical plan format (ticket 02). wayfind's own forward bridge (`flattenTicketsToPlan`) still emits its legacy `### Phase N — [stem]` format, which core-task's parser does **not** match. Migrating wayfind's plan output to writing-plans = **ticket 08** (open). Until 08 lands, the loop is verified for hand-authored writing-plans docs (the canonical case), not for wayfind-generated `task_plan.md`.

## Verification

- `tests/chain.test.ts`: **8 pass** (incl. the new cross-package e2e).
- full `pi-agent-ext-wayfind` suite: **144 pass** (was 143), 0 fail.
- `bunx tsc --noEmit`: **exit 0** (cross-package test import is type-clean).
