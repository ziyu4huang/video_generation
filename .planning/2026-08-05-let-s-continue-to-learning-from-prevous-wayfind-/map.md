# Wayfinder map: 2026-08-05-let-s-continue-to-learning-from-prevous-wayfind-

## Destination

A **decided design spec** for hermes-memory's *failure*-memory model — **dedup + decay + recurrence-to-skill graduation** so the 40K-char failure budget holds high-value lessons (raw `errorCapture` already self-limits via #854 and needs no separation) — ready to hand to a build. **Planning only**: the map resolves the decisions; no implementation lives in it.

## Notes

- **Domain**: `bun-apps/pi-agent-ext-hermes-memory`, scoped to its **failure** memory target (`~/.pi/agent/pi-hermes-memory/failures.md`, the package's own project store) + the `errorCapture` mechanism that feeds it (`src/config.ts`, default `true`, rate-limited per #854). The store is at **~94% of its 40K budget** as of charting.
- **Skills every session should consult**: `grilling` + `domain-modeling` (wayfinder defaults); `pi-memory-bulk-dedup` for the dedup ticket.
- **Essential reading before any ticket**: `bun-apps/pi-agent-ext-hermes-memory/REJECTED.md` (anti-regression ledger — grep it before proposing ANY mechanism; killed designs include bespoke `pi -p` subprocess, always-inject, FIFO/truncate, lineage-preserving consolidation, SurrealDB-default, grill-memory-as-separate-package). Also `CONTEXT.md` (domain language) and `docs/ROADMAP.md` v0.3 "Memory Aging" (adjacent mechanism).
- **Standing preferences** (grilled 2026-08-05):
  1. This is a **SPEC** effort — produce decisions, not code; the build is a handoff.
  2. **Respect REJECTED.md** — never re-propose a killed mechanism without addressing its "why killed".
  3. **Scope is the failure store ONLY** — the zk-vault side (knowledge-card / `zk_ingest` / obsidian) and the operational-hardening bugs (config `loadConfig` drift, ~30% CI flake, MEMORY.md dirtying worktrees) are explicitly **out of scope** (separate efforts).
- **Fact freshness**: charted on `wayfind/memory-ext-improvement` @ `origin/main` (0 behind) — current as of charting.
- **Conventions**: refer to tickets by **name**, never bare number.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [Audit the failure store](tickets/01-audit-the-failure-store.md) — RESOLVED (research): store is ~37K/40K; 0 raw `errorCapture` traces; bloat is **curated-but-recurring operational tool-quirks** (`await_pr_merge` family = 7 entries incl. 2 verbatim dupes + 2 redundant resolution entries). The real levers are **dedup + decay**, not the errors.log separation.
- [Taxonomy & purpose: what belongs](tickets/02-taxonomy-and-purpose-what-belongs.md) — RESOLVED (grilling): failure target is the inclusive **first-capture home** for any categorized lesson (write path unchanged); a lesson re-recorded **≥2× is procedural → graduates to a skill** (activates `constants.ts:145`); post-graduation the entries collapse to **one canonical FACT** cross-referenced to the skill (not a pointer, not hard-delete).
- [errors.log-rotation candidate](tickets/03-errorslog-rotation-candidate.md) — RESOLVED (grilling): **DROPPED** (rejected in REJECTED.md). Premise unfounded — `errorCapture` extracts lesson lines + 3-layer-dedups (#854), so raw traces never reach the budget; only ~1 failure entry exists. `errors.log` would be machinery for a non-problem.
- [Dedup identity + merge rule + graduation](tickets/04-dedup-identity-and-merge-rule.md) — RESOLVED (grilling): **hybrid identity** — near-dup (wording, existing) + **topic-key** (subject entity; tool name for tool-quirks) for evolving families. **Merge split by tier** — wording collapse = longest-wins (deterministic); topic-family graduation = synthesized fact (consolidation child) + procedure→skill; both destructive. **Trigger** = extend the write-time warning gate (warn on 2nd+ topic-key; agent-driven graduation). Three existing surfaces (write-gate / bulk-dedup / overflow-consolidation), each at its time.
- [Decay, aging & supersede policy](tickets/05-decay-aging-and-supersede-policy.md) — RESOLVED (grilling): aging metadata + staleness audit **already exist** (reuse; v0.3 roadmap stale). **Action** = compress resolved/stale to a one-line canonical fact (no archive file); fully-obsolete hard-deleted; resolved=superseded-first, active never trimmed. **Trigger** = agent-driven (audit surfaces; consolidation/bulk-dedup executes), no auto-eviction.
- [Migration & cutover plan](tickets/06-migration-and-cutover-plan.md) — RESOLVED (grilling): **feature-flag** `failureModel: legacy|v1` (mirrors `memoryMode`; ⚠ update types.ts AND loadConfig). **Backlog** = deterministic longest-wins (most-current/resolved = canonical; auditable diff; no LLM) via `project-memory-migration.ts` pattern + bulk-dedup dry-run/backup. **Ongoing** = consolidation-child synthesis (per 04). Graceful backward-compat (metadata exists; topic-keys assigned going forward). **SPEC COMPLETE — all 6 tickets closed.**

## Not yet specified

<!-- fog toward the destination; graduates as the frontier advances -->

_(none — all fog graduated or resolved: dedup-identity → 04; decay-mechanism → 05; the three errorCapture/errors.log patches were cleared when 03 dropped.)_

## Out of scope

<!-- ruled beyond the destination; closed, never graduates -->

- **The zk-vault side** — `pi-agent-ext-knowledge-card` / `zk_ingest` / `pi-agent-ext-obsidian` own a *separate* store (the Obsidian vault, via `.knowledge.jsonl` convergence). Their convergence/dedup/decay is its own effort. (Grilled 2026-08-05: user chose "focused: failure store".)
- **Operational hardening of hermes-memory** — config.ts `loadConfig` silently dropping `dbBackend` fields, the ~30% CI flake, MEMORY.md auto-write dirtying worktrees. Different effort (user chose "memory-model quality", not hardening).
- **Fresh v0.3 roadmap features** — `/memory-interview`, context fencing, project-memory polish. Not this effort.
- **Implementation** — form is a *decided spec*; the build (code, tests, migration execution) is a handoff, not part of the map.
