**ID:** `ADR-wayfind-0006` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0006: Delete the `__piWayfindActive` coordination seam (option b)

Date: 2026-08-07
Status: Accepted

## Context

`pi-agent-ext-wayfind` published a process-singleton reader on `globalThis` under
`__piWayfindActive` (`() => boolean` — "is a grill/wayfinder session active?").
The documented contract — repeated across the wayfind README, `CONTEXT.md`,
comments, and skill prose — was that a "plan coordinator" reads this seam and
**yields** its plan injection / auto-continue during a live grill so the two
drivers never double-drive.

Reality check (the core-task-review #01 audit):

- **Zero consumers.** No package reads `__piWayfindActive` anywhere in
  production source. The only reader was wayfind's *own* self-check helper
  (`isWayfindActivePublished()`), exercised solely in wayfind's own tests.
- **The plan-coordinator yield is fiction in code.** No such plan coordinator
  existed when the seam was authored (ADR-0003: "designed, not built"), and even
  after `pi-agent-ext-core-task` was built as the plan coordinator, it never
  read `__piWayfindActive`. There is no `isExternalDriverActive()`, no
  "injection yielded" status string, and no before_agent_start / agent_end
  gating wired to this key.
- The seam was therefore **dead output** — published into the void, with a
  contract no consumer honors.

The still-consumed sibling `__piWayfindGrill` (read by `hermes-memory`'s
correction-detector) is **unrelated** and is retained.

## Decision

**Option (b): delete the seam and its entire publish surface**, and correct every
false doc/comment site to match reality. Do **not** implement any gating.

Removed:

- `WAYFIND_ACTIVE_KEY` constant (`src/constants.ts`).
- `publishWayfindActive` / `unpublishWayfindActive` / `isWayfindActivePublished`
  (`src/coordination.ts`).
- The now-unused `isAnyWayfindSessionActive` helper (`src/state.ts`) — its only
  remaining reference was the deleted publisher.
- Every `publishWayfindActive` / `unpublishWayfindActive` call site
  (`src/index.ts`, `src/commands.ts`); the grill-sibling logic
  (`publishWayfindGrill` / `unpublishWayfindGrill`) and surrounding control flow
  are preserved exactly.
- The `__piWayfindActive` entry from the cross-extension seam-contract guard's
  `SEAM_KEYS` (`bun-apps/tests/seam-contract.test.ts`).

All false-narrative doc/comment sites (wayfind README/CONTEXT/comments, the
`grill-me-with-docs` skill, `package.json`, ADR-0002/0003/0004) and the related
M9 `__piGoalActive` prose (`pi-agent-ext-core-task` CONTEXT/goal.ts/extensions)
were reworded: `__piGoalActive` is published by core-task and read only by the
in-package `/loop` subsystem (goal⇄loop mutual exclusion), surfaced display-only
by power-tool's `inspect_tui`; no plan coordinator or wayfind reads it.

## Options considered

- **(a) Implement the yield.** One-directional (wayfind publishes → plan
  coordinator yields) would be an *asymmetric* trap: the plan coordinator would
  yield to a grill, but a grill would NOT yield to an active `/goal` or `/loop`
  (the goal⇄loop mutex is already bidirectional within core-task, so adding a
  one-way wayfind guard creates a new fiction on the other axis). Making it
  genuinely bidirectional (grill ⇄ /goal ⇄ /loop all mutually yield) is a
  two-package scope change well beyond this ticket, and would gate
  user-initiated driver switches the system has always left to the user.
- **(b) Delete the seam and publish surface (chosen).** Removes dead output,
  collapses the fiction, and requires zero behavior change.

## Consequences

- **Zero behavior change.** The seam had no consumer, so deleting it changes no
  runtime behavior. grill⇄goal/loop mutual-exclusion remains **user-initiated**
  — run one driver at a time — which is how it has always actually operated.
- The latent double-drive possibility (a grill auto-continues while `/goal` /
  `/loop` also drive) is **accepted as user-initiated**. It may be revisited as
  a separate effort if it bites in practice; if so, it must be solved
  bidirectionally across all three drivers, not via a one-directional wayfind
  guard.
- The still-consumed `__piWayfindGrill` sibling is retained (hermes-memory
  depends on it).
- The cross-extension seam-contract guard (`bun-apps/tests/seam-contract.test.ts`)
  stays green: with both the `SEAM_KEYS` entry and the publish surface removed,
  `__piWayfindActive` is neither an orphan nor a dead key.

Refs: `.planning/2026-08-02-core-task-review/tickets/01-fix-coordination-fiction-yield.md`
