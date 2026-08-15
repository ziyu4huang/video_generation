---
type: task
status: closed
blocked by: 01
findings: H2
resolved: 2026-08-07 — shipped in #1053 (seam-contract self-only-seam guard via findSelfOnlySeams)
---

# 02 — Harden the seam-contract "NO DEAD KEYS" test (self-reference loophole)

## Problem

The test that should catch orphan coordination seams green-checks them, because a key counts as "referenced" if *any* `.ts` mentions it — including the publisher's own self-check. So the H1 orphan (`__piWayfindActive`) is green-lit, and any future one-sided seam would be too.

## Evidence

- `bun-apps/tests/seam-contract.test.ts:52-60` (`SEAM_KEYS`) + the dead-key check (~`:95`): `SEAM_KEYS.filter((k) => !refs.has(k))`.
- `__piWayfindActive` satisfies "referenced" purely from `wayfind/src/coordination.ts:21` (publish) + `:46` (self-read).

## Approach

For function-valued `__pi*Active` seams, strengthen "live" to require **≥2 distinct packages** reference the key (publisher + consumer). Either:
- Maintain an explicit `PUBLISHER → CONSUMERS` map per key and assert the consumer set is non-empty; or
- Group `refs` by source package and require `new Set(refs.map(r => r.pkg)).size >= 2`.

Object-valued `__piPlan*` keys already get a shape guard; add the analogous "has a real cross-package reader" guard for the function keys.

## Acceptance

- [ ] The test fails on the *current* `__piWayfindActive` state (proving it can catch the orphan) — then passes once ticket 01 lands (implement adds a consumer; delete removes the key from `SEAM_KEYS`).
- [ ] A seeded one-sided seam (publisher + self-read only) is rejected by the test.

## Notes

Blocked by **01**: the expected final state (consumer added vs key removed) depends on the decision.
