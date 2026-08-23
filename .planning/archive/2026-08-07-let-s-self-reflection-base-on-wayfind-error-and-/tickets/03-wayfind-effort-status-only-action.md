---
type: task
blocking: []
status: closed
---

## Question
Subagents reading whole `map.md` files verbatim exhaust token budgets — failure memory #455 (3×: 100k, 110k, then timeout). The interactive `/wayfind status` command is **unavailable to subagents** (no slash commands in agent context). There is no budget-bounded, agent-callable low-res view.

## What to build
- Add a `status` action to the `wayfind_effort` tool (`src/effort-tool.ts`). It returns a **low-res** view of an effort: effort-level status + per-ticket `{ id, title, status, blocking }` — **no verbatim decision bodies / notes**.
- Keep existing actions intact; this is additive.
- Add tests for the new action (correct shape, no full-body leak, missing-effort handling).
- Add a one-line nudge in the tool description / relevant skill text that agents should prefer `status` over reading whole map/ticket files for inventory.

## Acceptance
- `wayfind_effort` `status` action exists, returns budget-bounded low-res output (no full decision bodies), and is tested.
- `bun test` + `bun run typecheck` green in `pi-agent-ext-wayfind`.

## Resolution
Fixed in `09e3c166`: extended the `wayfind_effort` tool with a `status` action returning effort-level status plus a budget-bounded per-ticket `{ id, title, status, blocking }` inventory (no verbatim decision bodies); added tests for shape, no-body-leak, and missing-effort handling.
