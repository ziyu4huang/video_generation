---
type: grilling
status: open
blocked by: 02, 01
---

# 04 — Dedup identity + merge rule for evolving entries

## Question

The audit ([01](01-audit-the-failure-store.md)) proves the pattern: a single lesson (`await_pr_merge`) recorded **7×** as understanding evolved — including **2 verbatim duplicates** of one incident and **2 redundant resolution entries**. Decide the dedup design:

- **Identity key**: what makes two entries "the same lesson"? Semantic-family (the whole `await_pr_merge` cluster) vs category+keyword vs an explicit topic tag? How is the family boundary drawn?
- **Merge rule**: when duplicates collapse, which content wins — richest, latest, or a synthesized merge? Is the older entry *superseded* (linked) or *hard-deleted* (per REJECTED.md's destructive-consolidation decision, PR #961)?
- **Automation**: dedup on-write (reject near-duplicates at `add()` time), periodic (consolidation pass), or manual via the existing `pi-memory-bulk-dedup` skill? All three?
- **Scope of dedup**: within the failure target only, or cross-target (the same lesson sometimes lands in both `failure` and `memory`)?

Blocked by [02](02-taxonomy-and-purpose-what-belongs.md) — you can't canonicalize what you haven't decided *belongs*.

## Context

- `pi-memory-bulk-dedup` skill already exists for manual bulk dedup of the `.md` source-of-truth — it may already encode a merge rule to reuse or supersede.
- `REJECTED.md` killed **lineage-preserving consolidation** (doubles storage, graph rots) in favor of **destructive consolidation** — the dedup rule must follow that (no lineage links; merged entry is the new truth).
- `merge-union.ts` exists in `src/` — likely the existing merge primitive; check whether it already does semantic union or just text-level.

## Recommendation seed

Lean: **identity = explicit topic tag** (e.g. `topic: await_pr_merge`) assigned at write time; **merge = destructive** (keep richest synthesized entry, hard-delete dupes) per REJECTED.md; **automation = on-write reject + manual bulk skill for the backlog**. Put the cut to the user.
