# 03 — Generalize the `__pi*` seam-key formalization

---
type: grilling
blocked by: 02   # generalize the pattern ticket 02 settles on one seam
status: open
---

## Question

The coexistence contract spans a family of ~7 `globalThis` seam keys: `__piCoreTaskStatusWidget` (status), `__piWayfindActive` / `__piGoalActive` (yield coordination), `__piPlanIncomplete` / `__piPlanSummary` / `__piPlanPhases` (the coordinator's published reads), `__piWayfindGrill`, `__piKickHeartbeat`. They're **stringly-typed constants scattered across packages** (wayfind `constants.ts`, core-task `status-widget.ts`) with no shared contract module. Should the pattern settled in ticket 02 generalize across the whole `__pi*` family — and if so, where does the canonical contract live?

## What to build

A grilled decision on whether/how to generalize the status-widget formalization (ticket 02's output) to the entire `__pi*` seam family. Open sub-questions:
- Does the contract need a **single shared module** (and where — a new tiny package? a file both import via subpath?), or is **per-seam test coverage** enough?
- Which keys are *coordination* (wayfind↔core-task yield) vs *data* (the `__piPlan*` reads) — do they warrant different formalization?
- Is there a key that's actually safe to leave undocumented (low blast radius)?

This ticket also graduates the map's **Not yet specified** "shared contract module vs inline" fog once 02 picks a mechanism.

## Acceptance
- [ ] A decision on generalize-vs-leave-per-seam, with the chosen contract home (if any) named.
- [ ] Each `__pi*` key is classified: formalized / test-guarded / accepted-as-documented.
- [ ] If a shared module is chosen: its location and import discipline are specified (respecting the jiti/globalThis constraint).
