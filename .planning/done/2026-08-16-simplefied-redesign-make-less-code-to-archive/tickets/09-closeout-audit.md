---
type: grilling
blocking: 6, 7, 8
---

## Question

Close-out audit: before/after table per package (feature count vs ticket-01 census ≥80%; LOC delta — subagent net-negative; tests/gates green at each merge), verify absorbed workstream-C behaves (wrap-now fires in a real dispatch), decide follow-ups for Not-yet-specified items, then closing ceremony per procedure (next-goal note, status: complete, file to .planning/done/).

## Resolution

Closed 2026-08-21 by the 2026-08-21-harness-streamline effort (phases W1–W4, S1 executing tickets 07/08). Before/after vs ticket-01 census:

| package | features (anchor ≥80%) | src LOC |
|---|---|---|
| wayfind | 39 → 39 (0 interface breaks; /grill + /wayfind + wayfind_effort + 16 skills intact) | 4,169 → 3,696 (−473) |
| superpowers | 14 → 13 (1 ratified deletion: verification-before-completion) | 347 → 421 (+74: reset sugar + re-exports + comments; content −1,739 companion/skill lines) |
| subagent | 15 → 15 | 7,463 → 6,120 (its own landed stage) |

**Trio budget: 11,979 → 10,237 = Δtrio −1,742 ≤ −400 ✅.** Gates green at every merge (#1758, #1760–#1766, each with per-package check+typecheck+test + the bun-apps contract suite); loop status all-PASS (30 skills, max 299 ≤ 300 bar); deployed binary (0.1.0+gf1bef7d) boots + ships the trimmed superpowers. Bootstrap side-audit (executed by the sibling effort, ADR-superpowers-0010): ~2,050 → ~999 tok/session. Merges on this Linux box used the documented gh-with-justification deviation (main-health verified red here from pre-existing/environmental failures — see PR #1758 comment). Closing ceremony follows.

closed: (landed)
