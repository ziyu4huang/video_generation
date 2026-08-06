---
type: grilling
status: closed
claimed: agent (2026-08-05)
closed: 2026-08-05 (grilled this session)
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

**Per [02](02-taxonomy-and-purpose-what-belongs.md) (CLOSED):** collapsed recurring entries now produce **ONE canonical FACT in failure + the procedure graduates to a skill** (recurrence ≥2 = procedural signal, per `constants.ts:145`). So the merge rule must yield that shape: a deduped standalone fact (failure) + a created/promoted skill (procedure), cross-referenced — NOT a pointer, NOT hard-delete, NOT duplication. The graduation trigger mechanism (auto on 2nd capture vs manual via consolidation vs on-write reject) is decided HERE.

## Resolution — ANSWERED (2026-08-05)

**Decision — dedup identity + merge rule + graduation trigger (the centerpiece of the spec).** Four sub-decisions, grilled in dependency order:

**D1 — Identity: hybrid (near-dup + topic-key).** Two tiers:
- *Wording-variants* → reuse the existing `near-dup.ts` containment detector (|new∩existing|/|new| ≥ 0.6). Already works; catches verbatim/near-verbatim re-captures (e.g. the #1028 pair).
- *Topic-families* (the actual bloat, e.g. `await_pr_merge` ×7) → a new **TOPIC-KEY**: the subject entity — **tool name for `tool-quirk`** (`await_pr_merge`, `gh pr`), **key-phrase otherwise**. Containment demonstrably misses evolving families (different incidents, low token overlap); the topic-key groups them AND is the signal 02's recurrence→graduation keys on.

**D2 — Merge rule: split by identity tier.**
- *Near-dup wording collapse* → **longest-wins, deterministic** (matches the `pi-memory-bulk-dedup` skill's existing "KEEP canonical (longest) entry" rule; no LLM).
- *Topic-family graduation* → a **synthesized canonical FACT** via the REJECTED.md-approved consolidation path (`spawnSubagent` one-shot child), with the **procedure → skill**. Lets the crisp current truth (the #1030 resolution) win over a verbose obsolete entry.
- Both tiers are **destructive** (consumed entries hard-deleted, no lineage) per REJECTED.md.

**D3 — Graduation trigger: extend the write-time warning gate.** When a write produces a 2nd+ entry sharing an existing topic-key, the existing warn-don't-block gate (same pattern as `near-dup.ts`) flags *"recurring topic → graduate to skill."* Graduation EXECUTION stays agent-driven (bulk-dedup skill / consolidation pass), NOT auto-run — no noisy auto-skill-creation.

**D4 — Automation surface (determined, not a separate decision):** all three existing surfaces, each at its natural time:
- *Write-time*: the extended warning gate (D3).
- *Backlog*: the `pi-memory-bulk-dedup` skill — extend to detect topic-FAMILIES (not just near-dups) and emit the graduation recommendation; keep its `.md`-first, longest-canonical, destructive approach.
- *Overflow*: the consolidation one-shot child retires **superseded-first** (REJECTED.md overflow priority) and can trigger graduation.

**NOT decided here (build details, not decisions):** topic-key extraction for non-`tool-quirk` categories (key-phrase heuristic — specifiable at build; tool-quirks use the tool name); the exact warning-message format + consolidation prompt for synthesized facts; how `memory_search` surfaces the cross-referenced skill (carried from 02).

**Map effects:** the "dedup identity key" fog patch is RESOLVED (cleared from Not-yet-specified). [05](05-decay-aging-and-supersede-policy.md) inherits the "one canonical fact" target shape; [06](06-migration-and-cutover-plan.md) now has the full dedup design to migrate toward.

## Context

- `pi-memory-bulk-dedup` skill already exists for manual bulk dedup of the `.md` source-of-truth — it may already encode a merge rule to reuse or supersede.
- `REJECTED.md` killed **lineage-preserving consolidation** (doubles storage, graph rots) in favor of **destructive consolidation** — the dedup rule must follow that (no lineage links; merged entry is the new truth).
- `merge-union.ts` exists in `src/` — likely the existing merge primitive; check whether it already does semantic union or just text-level.

## Recommendation seed

Lean: **identity = explicit topic tag** (e.g. `topic: await_pr_merge`) assigned at write time; **merge = destructive** (keep richest synthesized entry, hard-delete dupes) per REJECTED.md; **automation = on-write reject + manual bulk skill for the backlog**. Put the cut to the user.
