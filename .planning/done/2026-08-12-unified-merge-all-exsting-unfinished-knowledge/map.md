---
effort: 2026-08-12-unified-merge-all-exsting-unfinished-knowledge
created: 2026-08-12
last: 2026-08-12
status: complete
---

# Wayfinder map: 2026-08-12-unified-merge-all-exsting-unfinished-knowledge

## Destination

Reconcile the knowledge-pipeline **build-cluster** sprawl (7 efforts) into ONE clean canonical map — `2026-08-08-knowledge-pipeline` — so it is the single source of truth: archive the superseded, close the done-but-untracked, fix the stale canonical map, and decide the one live-or-superseded judgment call. When this map closes, `2026-08-08-knowledge-pipeline`'s open build tickets (03, 07, 13, 14 + the un-implemented 3-tier drift behind closed ticket 05) are the agreed handoff backlog, and the build continues *there*. **Cleanup first; build is out of scope here.**

## Notes

- **Canonical survivor:** `2026-08-08-knowledge-pipeline` (active, most advanced — spine + Phase-2 shipped). Everything else in the cluster either migrates its live tickets INTO it, or closes + archives to `.planning/done/`.
- **Scope — the 7 KP build-cluster efforts under reconciliation:**
  1. `2026-08-08-knowledge-pipeline` — canonical survivor. **Map is stale on TWO shipped tickets:** says "next build ticket is 10-impl" but 10-impl shipped (#1242 `1fcb4504`), AND 15-Phase1 shipped (#1168 `48df0b1a`) though `tickets/15` frontmatter still says `status: open`. Genuinely open: tickets **03, 07, 13, 14** (+ the un-implemented 3-tier drift behind closed 05).
  2. `2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or` — body says SUPERSEDED-BY, but front-matter still `status: active` (contradictory). 5 tickets migrated verbatim.
  3. `2026-08-01-continue-improve-the-pipeline-between-extension-` — tickets 05 & 06 physically OPEN (map claims "superseded, close as superseded" but never closed; canonical spine used a *different* ingest path `walkAndIngest`, so delivery is unconfirmed). **The one genuine judgment call.**
  4. `2026-08-11-knowledge-card-typecheck-gate` — `bun run typecheck` is GREEN but plan checkboxes are 1/6 checked. Done-but-untracked.
  5. `2026-07-30-file2md-for-pdf-…` — ABSORBED-BY canonical; ticket 04 is `re-opened` though functionally settled (hybrid verdict).
  6. `2026-07-28-hermes-surrealdb-graph-search` — shipped (758/758 green, no map.md, spec Status=Implemented), ABSORBED-BY canonical.
  7. `2026-08-04-tell-me-what-zk-spwan-…` — empty, never-resolved question stub.
- **Skills each session should consult:** wayfinder (`grilling`, `domain-modeling`), the repo's pipeline-routing + planning-artifact conventions (`CLAUDE.md`, `.pi/agent/AGENTS.md`).
- **Close/archive convention:** close = add `status: closed` + a resolution to the ticket + a one-line Decisions-so-far pointer on the owning map; archive = the `/wayfind done` move into `.planning/done/` (or, for non-map stub efforts, moving the dir there once confirmed done).
- **Fact-freshness caveat (proceed-aware):** branch `docs/post-10impl-skill-and-conventions` is 2 behind `origin/main`. The missing commit `#1245` is an *unrelated* webui ticket (`07-port-binding-auth-url`, under `2026-08-10-…-webui-from-scratch`), NOT a canonical knowledge-pipeline change — so no disposition here depends on it. (Verified in ticket 01.)

## Decisions so far

- [01 — Audit the KP build-cluster efforts](tickets/01-audit-kp-cluster-real-state.md) — code/git-verified true state of all 7 efforts. Key findings: (a) `2026-08-01` tickets 05 & 06 ARE delivered in code (file2md emit + knowledge-card sink + `ingestRecords` wired) → ticket 03 leans close-as-superseded, nothing to migrate; (b) canonical map is stale on TWO shipped tickets (10-impl #1242 + 15-Phase1 #1168), not one; (c) only 03/07/13/14 remain genuinely unimplemented; (d) zk_spawn = knowledge-card's in-process subagent-spawn wrapper, not a separate CLI. Per-effort disposition table in the ticket.
- 02 — canonical map de-staled (10-impl #1242 + 15-Phase1 #1168 marked shipped); open build set = {03,07,13,14}.
- 03 — 2026-08-01 tickets 05 & 06 closed as superseded (verified delivered in code; nothing migrated).
- 04 — 5 efforts archived to .planning/done/ (08-11-typecheck-gate, 07-28-surrealdb-graph, 08-08-obsidian-surealdb, 07-30-file2md-pdf, 08-04-zk-spwan).
- 05 — handoff confirmed; 2026-08-08-knowledge-pipeline is the single surviving live effort; next-build pick = HITL (open set {03,07,13,14}).

## Not yet specified

- **Migration mapping for live orphan tickets** (if ticket 03 finds `2026-08-01` tickets 05/06 were NOT delivered): which canonical `2026-08-08` ticket each maps to, or whether they're net-new. Graduates from tickets 01 + 03.
- **Re-ticket the 3-tier-drift impl:** closed canonical ticket 05 decided policy only; its full 3-tier impl (06b stubbed Tier-1) may warrant a fresh build ticket on the canonical map. Graduates from ticket 02.

## Out of scope

- **The broader hermes/memory efforts** (~15: proactive-consolidation, architecture-deepening, failure-lifecycle, dedup/conflict, numeric-isolation, pin-field, etc.) — scoped to KP build cluster only (user decision 2026-08-12).
- **`.planning/knowledge/` dormant skill-candidate staging** (+ the misplaced `upstream-provenance.md`) — separate concern (skill bridge), not the pipeline.
- **Actual BUILD/implementation** of canonical tickets 03/07/13/14/15 — that is the `2026-08-08-knowledge-pipeline` map's job; handed off via this effort's ticket 05.
- **Re-enabling remote CI / branch protection** — explicitly disabled by repo policy.
