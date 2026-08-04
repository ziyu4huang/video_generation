---
type: grilling
status: open
blocked by: 03, 04, 05
---

# 06 — Migration & cutover plan: get the existing 94%-full store to the new model

## Question

Once the model decisions land ([03](03-errorslog-rotation-candidate.md) errors.log, [04](04-dedup-identity-and-merge-rule.md) dedup, [05](05-decay-aging-and-supersede-policy.md) decay), the existing **~94%-full** store must move to the new shape. Decide the cutover design (as *spec*, not execution):

- **One-time canonicalization** of the backlog (collapse the `await_pr_merge` ×7 → canonical; compress resolved entries) — is it a scripted migration, a manual `pi-memory-bulk-dedup` pass, or a consolidation run?
- **Backward compatibility**: legacy entries without the new aging/topic metadata — degrade gracefully (the v0.3 "backward-compatible fallback for legacy entries" pattern) or require a migration?
- **Rollout**: feature-flag the new model (`config.failureModel: "legacy" | "v1"`), or hard cutover? Atomic-write + the existing proper-lockfile guarantee safety either way.
- **Verification**: how do we prove the migration lost no curated signal (the REJECTED.md concern — "destructive consolidation" must not silently drop a unique lesson)?

This ticket produces the migration section of the spec — the last piece before handoff to a build.

## Context

- `extension-root-migration.ts` and `project-memory-migration.ts` exist in `src/` — there's a migration pattern in the package to mirror.
- The store is `.md` source-of-truth + DB; both must migrate consistently (DB↔.md sync).
- REJECTED.md: atomic writes (temp+rename) for markdown; destructive consolidation is accepted.

## Recommendation seed

Lean: **one-time scripted canonicalization** (deterministic, not LLM-consolidation, so it's auditable) + **feature-flag** the new model + **backward-compatible fallback** for legacy entries + **a diff/dry-run** proving no unique signal is lost before the destructive apply. Put the cut to the user.
