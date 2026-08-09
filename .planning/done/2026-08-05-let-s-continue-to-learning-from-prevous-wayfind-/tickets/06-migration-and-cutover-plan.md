---
type: grilling
status: closed
claimed: agent (2026-08-05)
closed: 2026-08-05 (grilled this session)
blocked by: 04, 05
---

# 06 — Migration & cutover plan: get the existing 94%-full store to the new model

## Question

Once the model decisions land ([04](04-dedup-identity-and-merge-rule.md) dedup, [05](05-decay-aging-and-supersede-policy.md) decay) — [03](03-errorslog-rotation-candidate.md) (errors.log) was **dropped as unfounded** — the existing **~94%-full** store must move to the new shape. Decide the cutover design (as *spec*, not execution):

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

## Resolution — ANSWERED (2026-08-05)

**Decision — migration & cutover plan (final ticket → spec complete).**

**Rollout: feature-flag.** `config.failureModel: "legacy" | "v1"`, default `"legacy"`, opt into `"v1"` — mirrors the existing `memoryMode` flag exactly. ⚠️ **Build footgun** (from failure memory): adding the field requires updating BOTH `types.ts` AND `config.ts` `loadConfig` selective copy, or config-file values are silently dropped.

**Backlog canonicalization: deterministic longest-wins.** The one-time migration collapses the existing 94%-full store via pure fs §-entry read/write (mirror `project-memory-migration.ts`'s pattern + result struct), **longest-wins** (most-current/resolved entry = canonical — e.g. the #1030 resolution for the `await_pr_merge` family). No LLM for the migration → **auditable diff** (the REJECTED.md "must not silently drop a unique lesson" concern is verifiable). Verbatim dupes (#1028 pair) collapse; the resolved entry compresses per 05; the procedure → skill (land-pr). Dry-run + backup + FTS-orphan-check (bulk-dedup skill pattern); agent confirms before the destructive commit.

**Ongoing: synthesis (per 04).** Future recurrence uses the consolidation-child synthesized fact + skill graduation — the deterministic path is for the one-time backlog only.

**Backward compatibility: graceful (determined).** `created`/`last` metadata already exists on all entries (05); topic-keys are assigned going forward (write-gate) + retroactively during canonicalization. Legacy entries without a topic-key simply don't graduate until they recur — no forced migration, no data loss.

**Verification: dry-run + diff + backup + FTS-orphan-check** (bulk-dedup skill pattern); `.md`-first (the .md is source-of-truth; DB re-hydrates). Agent confirms the diff before commit.

**SPEC COMPLETE.** All six tickets closed. The decided spec = [02](02-taxonomy-and-purpose-what-belongs.md) (taxonomy: first-capture + recurrence→skill + canonical fact) + [04](04-dedup-identity-and-merge-rule.md) (dedup: hybrid near-dup/topic-key, tiered merge, write-gate graduation) + [05](05-decay-aging-and-supersede-policy.md) (decay: reuse aging, compress-to-fact, agent-driven) + 06 (migration: feature-flag + deterministic backlog + synthesis ongoing). Ready to hand off to a build.
