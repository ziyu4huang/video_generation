# 02 — Formalize the status-widget cross-extension contract

---
type: grilling
blocked by: 01   # ship ADR-0004 first — formalize the landed seam state
claimed: wayfinder-session
status: closed
---

## Question

wayfind ADR-0004 admits the **contract-drift surface is small but real**: the global key `__piCoreTaskStatusWidget` and the `StatusSection` shape (`{ addSection, setUICtx, update }`) are core-task's *internal implementation detail, not a published API*. A grep for tests guarding that contract returns **nothing** — if core-task renames the key or reshapes the section, wayfind's status silently stops rendering. How do we formalize this one seam so the drift is caught, not silent?

## What to build

A grilled decision on the formalization mechanism for the status-widget seam *only* (the generalization to all `__pi*` keys is ticket 03, blocked by this). Candidate mechanisms to grill:
- a **contract test** in wayfind (or core-task) asserting the global key string + the minimal `{ addSection }` shape exists;
- a **shared types module** both packages import (note: types alone don't catch the runtime global rename);
- **accept-and-document** with a sharper ADR + a single source-of-truth constant (no test).

The decision must respect the jiti constraint: the seam is `globalThis`-based and existence-checked, never `instanceof`. Prefer the lightest mechanism that turns a *silent* drift into a *loud* one.

## Acceptance
- [x] A chosen mechanism is recorded as a resolution (with rationale for rejecting the others).
- [x] If the mechanism is a test: it exists and fails loudly on a simulated rename/reshape.
- [x] The resolution notes what ticket 03 should generalize from this pattern.

## Resolution

**Mechanism: a repo-level source-analysis contract test** — `bun-apps/tests/seam-contract.test.ts` (run via `bun run test:seam`, wired into `regression gates` as an always-runs blocking step). Three grilled sub-decisions, all confirmed against the recommendation:

1. **Mechanism class = contract test** (not shared types module, not accept-and-document).
   - *Shared types module* ❌ — the key is a runtime **value**; a types-only module is erased at compile time and **cannot** catch a global-key rename (the actual drift vector). Leaves the drift silent.
   - *Accept-and-document* ❌ — CI stays green on drift; only a human reading the ADR notices. Fails “turn silent into loud.”
   - *Import-based test* ❌ — stronger than text, but needs core-task to export the symbol + a test-time workspace devDep; rejected for the lighter text-assert path.
2. **Location = repo-level (`regression gates`)**, not per-package. A 3-package invariant has no single owner; `regression gates` already houses exactly this category (the import-hygiene guard `test:deps` lives there precisely because “per-package tests miss it; `bun-apps/tests/` is outside every matrix entry”). Per-package (core-task) would path-couple to sibling source; per-consumer-duplicated can’t catch inter-consumer drift.
3. **Observation = static source analysis (text + brace-counted block extraction), no runtime import.** Matches the `dep-guard.test.ts` idiom exactly; respects ADR-0004’s decoupling + the jiti constraint (zero runtime edges added).

**Fact correction to the ticket premise:** the repo already had tests (core-task asserts it wrote the global; power-tool mocks its read). The real gap was the key string duplicated in **3 independent sites** (core-task const, wayfind const, power-tool inline literal) with no cross-link — each side’s tests mock its own literal → a core-task rename compiles clean, stays green, breaks consumers only in production.

**Deliverable:** `bun-apps/tests/seam-contract.test.ts` (+ `test:seam` script + `regression gates` step). Two invariants + a grounding check:
- KEY AGREEMENT — `__piCoreTaskStatusWidget` present identically in all 3 production sources.
- SHAPE — every method a consumer declares on its structural view ⊆ the publisher class’s public methods.
- grounding — asserts extraction found non-empty sets (no vacuous pass if a refactor shifts indentation/syntax).

**Verified fails-loud (acceptance #2):** simulated a key rename in the publisher → KEY AGREEMENT fails (`publisher does not reference __piCoreTaskStatusWidget`); simulated renaming `addSection` → SHAPE fails (`wayfind declares addSection … CoreTaskStatusWidget no longer defines it`). Baseline + post-restore: 3 pass / 0 fail.

**What ticket 03 generalizes (acceptance #3):** the `SEAM` object pins one seam today; promote it to `SEAMS: SeamSpec[]` and iterate both invariants per entry to cover the full `__pi*` set (`__piWayfindActive`, `__piGoalActive`, `__piPlanIncomplete`, `__piPlanSummary`, `__piPlanPhases`, `__piWayfindGrill`, `__piKickHeartbeat`). The extractors are already seam-agnostic. This also **resolves map fog #1** (shared module vs inline tests) → **no shared module; a repo-level source-analysis guard.**
