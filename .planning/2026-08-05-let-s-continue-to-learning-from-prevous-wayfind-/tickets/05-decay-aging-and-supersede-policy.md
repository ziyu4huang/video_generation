---
type: grilling
status: open
blocked by: 01
---

# 05 — Decay, aging & supersede policy for the failure store

## Question

Resolved/obsolete entries linger at full size: the `await_pr_merge` family includes entries explicitly marked **RESOLVED** (by PR #1030) that still occupy budget verbatim. Decide the decay policy:

- **Aging metadata**: adopt `created_at` / `last_referenced` (the roadmap v0.3 "Memory Aging" mechanism — HTML-comment metadata, backward-compatible) for the failure target? Or reuse it if v0.3 lands first?
- **Resolved → compressed**: when an entry is marked resolved/superseded, does it (a) compress to a one-line pointer, (b) move to an archive file, or (c) get hard-deleted after a grace period?
- **Staleness eviction**: do entries unreferenced for N days auto-decay (consolidation removes them), and is that N configurable?
- **Tie to consolidation**: the existing auto-consolidation (one-shot child merge) — should it *preferentially* retire resolved/stale entries (per REJECTED.md overflow priority: "offload superseded FIRST; TRIM never touches active")?

## Context

- `staleness.ts` already exists in `src/` — there may be a staleness primitive to build on; check what it currently tracks.
- `REJECTED.md` overflow priority is explicit: **superseded first, active never trimmed**. Decay policy must respect this.
- Roadmap v0.3 "Memory Aging" Epic 3 is adjacent and unchecked — this ticket may either *depend on* or *feed* that work (fog on the map).

## Recommendation seed

Lean: **adopt the v0.3 aging metadata** for failures (reuse, don't fork); **resolved → compress to a one-line pointer** (not hard-delete — resolutions are useful historical context, just not at full size); **consolidation retires superseded-first** per REJECTED.md. Put the cut to the user.
