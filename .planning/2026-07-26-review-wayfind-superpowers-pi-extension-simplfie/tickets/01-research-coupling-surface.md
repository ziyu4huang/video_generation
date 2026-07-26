---
type: research
status: closed
---

# 01 — Research: core-task coupling surface + blast radius

## Question

Enumerate EVERY coupling point between `pi-agent-ext-wayfind` and
`pi-agent-ext-core-task`, separate the ADR-0002 status-widget coupling from the
older plan-coordinator handoff contract, and fix the blast radius of removing the
`workspace:*` dependency — so the status-strategy decision (ticket 02) and the
scope decision (ticket 03) rest on facts, not guesses.

## Findings (charted 2026-07-26)

**Two distinct couplings — only one is ADR-0002:**

### (A) Status-widget coupling — ADR-0002, the reversal target

- `package.json`: `"@repo/pi-agent-ext-core-task": "workspace:*"` in
  `dependencies`. ← the dependency to remove.
- `src/index.ts:16`: `import { getSharedStatusWidget } from
  "@repo/pi-agent-ext-core-task/src/shared/status-widget.js"` — the **only**
  runtime (src) import of core-task in the whole package.
- Used at `index.ts:24-26`: `getSharedStatusWidget()` →
  `widget.addSection({ id: "wayfind", order: 2, render })`,
  `widget.setUICtx(ctx.ui)`, `widget.update()`. `src/overlay.ts` provides the
  `StatusSection` (one line, order 2; goal=0, todo=1, wayfind=2,
  plan-coordinator=3).
- The widget is a `globalThis`-backed singleton on
  `__piCoreTaskStatusWidget` (jiti constraint — see map Notes). Its methods
  (`addSection` / `setUICtx` / `update`) are **duck-typeable without importing
  the class**: existence-check on the global, not `instanceof` (core-task's own
  singleton guard already avoids `instanceof` for the same cross-loader reason).

### (B) Plan-coordinator handoff contract — OLDER than ADR-0002, STAYS

- `__piWayfindActive` seam (`src/index.ts` via `src/coordination.ts`): the plan
  coordinator reads it to yield injection/auto-continue during a live grill.
  ADR-0001/0003 territory, **not** ADR-0002.
- `tests/chain.test.ts:5`: `import { parsePlan } from
  "../../pi-agent-ext-core-task/src/plan/parse.ts"` — a **relative-path** import
  (resolves by filesystem, NOT via the package.json dep), test-only. Pins the
  grill→plan-seed handoff against the real parser.
- `tests/plan-seed-contract.test.ts`: standalone (imports neither the
  coordinator nor core-task at runtime); pins the seam string + seed shape.
- These survive removing the `workspace:*` dep **unchanged**.

### Blast radius of removing the dep (coupling A only)

- `src/index.ts`: drop the import (`:16`); replace the `getSharedStatusWidget()`
  call (`:24`) with the chosen strategy (ticket 02); update the header comment
  (`:8`) + the dispose note (`:49`).
- `src/overlay.ts`: comment-only (`:2-3`) — the `WayfindOverlay` class is
  self-contained (holds one line + a refresh callback).
- `package.json`: remove the `dependencies` entry.
- `docs/adr/0002`: supersede with a new ADR recording the reversal + rationale.
- **Tests unaffected**: `src/__tests__/overlay.test.ts` exercises `WayfindOverlay`
  in isolation; `tests/chain.test.ts` + `tests/plan-seed-contract.test.ts` use a
  relative-path / standalone approach (coupling B), not the widget.

➡️ The reversal is **small and well-bounded** once the status strategy is chosen.
The hard part is the decision (ticket 02), not the code.
