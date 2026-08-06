---
type: grilling
status: closed
claimed: agent (2026-08-05)
closed: 2026-08-05 (grilled this session)
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

## Resolution — ANSWERED (2026-08-05)

**Decision — decay, aging & supersede policy.**

**Aging mechanism: REUSE EXISTING (no new work).** The v0.3 "Memory Aging" mechanism is already live in code (the roadmap checkboxes are stale): `memory-format.ts` stamps every entry `<!-- created=DATE, last=DATE -->`; `add()` sets both, `replace()` preserves `created`/updates `last`; `staleness.ts` provides a 30d audit over `last`-edited. Two dimensions tracked (`.md` `last=` last-edited + SQLite `last_referenced` last-surfaced). → No new metadata, no encode/decode to build.

**D1 — Action: compress to a one-line canonical fact.** Resolved/stale entries compress to a ONE-LINE canonical fact (the same shape as 02's graduated entries, minus the skill — no separate archive file, per REJECTED.md's rejection of lineage-preserving patterns). Entries the consolidation judges FULLY OBSOLETE are hard-deleted (REJECTED.md destructive). Priority per REJECTED.md: **resolved (superseded) FIRST; stale-unreferenced lower; active NEVER trimmed.**

**D2 — Trigger: agent-driven.** The staleness AUDIT surfaces resolved/stale candidates; the consolidation pass or `pi-memory-bulk-dedup` skill EXECUTES the compression. No auto-eviction on threshold — consistent with 04 (warn-don't-block; execution stays agent-driven) and REJECTED.md ("destructive consolidation must not silently drop a unique lesson"). A human/agent eye passes over every compression.

**How this fits with 02/04 (the full model):**
- *Procedural + recurring* (02/04) → synthesized canonical fact + skill (graduation).
- *Non-procedural + resolved/stale* (05) → compressed one-line canonical fact; fully-obsolete hard-deleted.
- *Active/unique* → untouched (TRIM never touches active).
- All three share the "one canonical fact" shape + destructive + superseded-first.

**NOT decided here (build details):** "resolved" detection (currently a fuzzy text marker — formalize at build, or keep text); the one-line compression template (follows 02's shape); the failure-target staleness threshold (30d default exists, configurable); DB↔.md sync of compressed entries (follows bulk-dedup's `.md`-first approach).

**Map effects:** the "Decay ↔ v0.3 Memory Aging" fog patch is RESOLVED (mechanism already exists; 05 decided the action) — cleared from Not-yet-specified. [06](06-migration-and-cutover-plan.md) is now UNBLOCKED (last ticket): its backlog canonicalization includes compressing the `await_pr_merge` RESOLVED entry per this policy.
