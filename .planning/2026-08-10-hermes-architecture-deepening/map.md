---
status: active
last: 2026-08-16
---
# Hermes-memory architecture deepening

## Destination
Deepen `bun-apps/pi-agent-ext-hermes-memory`'s architecture: turn its shallow modules into deep ones, guided by the `improve-codebase-architecture` skill's 2026-08-10 scan. Scan report: `architecture-review-2026-08-10.md`. Candidate picked -> grilling -> spec -> plan -> execute.

## Notes
- Scan base: HEAD `e1aa0e33` on `feat/improve-codebase-arch`; target `bun-apps/pi-agent-ext-hermes-memory/src` (94 non-test files, ~21,728 LOC; tests 26,353 LOC, ratio 1.21).
- Coordinate with knowledge-pipeline Phase-2 (08-impl) -- several candidates touch in-flight files (sqlite-backend, schema, card-store, walk-and-ingest).
- Prior art: `2026-08-08-wayfind-architecture-deepening` (COMPLETE) shipped the same codec-unification pattern this scan re-found in hermes.

## Sequencing (2026-08-12 — from knowledge-pipeline self-reflection)

Candidates live in `architecture-review-2026-08-10.md`. Re-sequenced 2026-08-12 against the kp self-reflection:

- **Before kp ticket 13 (memory-card migration):** C1 (codec unification), C5 (Card-abstraction finish — PROMOTED from defer), C6 (NEW — dedup into MemoryRepository contract). These are the convergence moves 13 needs.
- **Rolling / independent of 13:** C2 (skills-command split), C3 (sqlite-backend split — IN-FLIGHT, coordinate with kp Phase-2), C4 (index.ts composition root).

Rationale: sequencing C1/C5/C6 before 13 keeps the memory-card migration mechanical + low-risk (as kp ticket 05 intends); deferring them makes 13 the integration flashpoint. Detail + refreshed candidate leverage in the review doc's `## Top recommendation`.

- 2026-08-15: C1 CLOSED — v1 was #1196 (`splitFencedYaml` leaf); residual `planning-parse.ts` hand-rolled copy rewired to the leaf + sole-source regression gate + planning golden round-trip (ticket 01). Next convergence prerequisite for kp ticket 13: C5.
- 2026-08-15: C5 re-scoped to C5-LITE — decisions in `tickets/02-c5-lite-card-abstraction.md`; closed (#1346 / 7a723437).
- 2026-08-15: C6 CLOSED — addMemory exact-dup dedup in the MemoryRepository contract; closed (#1349 / 3038c50a).
- 2026-08-15: ticket 04 opened (folded from archived dup-conflict effort) — near-dup threshold tuning 0.6 → 0.3–0.4.
- 2026-08-16: **simplify-&-robusten wave** landed (grilling round) — tickets 05–11. Sequencing: zk pain-point audit (05) GATES the wave → C3 sqlite-backend split (06) → kp21 drift impl (07, cross-link — work item stays on the kp map); direct backend tests (08) after C3; SurrealDB-down hardening (09), kp18 T5b (10, cross-link — late in wave), #1130 re-diagnosis (11) open/parallel. C4 (index.ts composition root) stays a rolling item — parallel anytime, no new ticket. Ticket 04 (threshold tune) stays the existing ticket — tiny PR, no new ticket.

## Decisions so far
- 2026-08-16 (wave sequencing): zk-audit gate (05) → C3 (06) → kp21 (07); C4 composition-root parallel anytime (rolling item); hermes-04 threshold tune = existing ticket 04, tiny PR.
- 2026-08-16 (robusten scope): kp21 drift + direct backend tests (sqlite + surreal) + SurrealDB-down hardening + kp18 T5b cosine fallback. Nothing else.
- 2026-08-16 (acceptance gate): deletion-test + invariants (e.g. "memories column list declared exactly once") — no raw-LOC gates.
- 2026-08-16: kp17 stays open on the kp map — explicitly NON-blocking for this wave.
- 2026-08-16 (Tier-1 drift design): per-file content hash in SQLite metadata (replaces the inert driftStub in walk-and-ingest.ts).
- 2026-08-16 (#1130): root-cause-first — stale "unregistered extension" theory; the extension IS statically registered now and test:seam is red for a fresh reason. → ticket 11.
- 2026-08-16 (C2 closure — ledger fix): skills-command split landed in code as #1185 (skill-rows/skill-batch-ops) + #1194 (skill-key-reducer); closed in code, recorded here.
- 2026-08-16: ticket 05 zk audit CLOSED (12 findings; dedup-poor not test-poor) — spawned 12 (dedup) + 13 (megafile split, blocked by 12); wave 06-11 UNBLOCKED.
- 2026-08-16: ticket 12 dedup DONE — card-format.ts single-source (K4-K7,K9; K8 skipped: divergent semantics documented); 432/0 gates; ticket 13 (megafile split) UNBLOCKED.
- 2026-08-16: ticket 13 wave 1/3 DONE — ingest engine-only (512 LOC), 4 new modules, cycle removed, 432/0 gates; waves 2-3 (K2 extension, K3 retrieve) remain.
- 2026-08-16: ticket 13 wave 2/3 DONE — extension task-builders+config extracted to src/ (shim-compat, zero test edits); wave 3 = retrieve.ts split.
- 2026-08-16: ticket 13 CLOSED — all 3 megafiles split (ingest 512, extension 1077 via shim, retrieve 770 + graph-health 348); optional K2b deferred to future effort.
- 2026-08-16: ticket 06 CLOSED — corruption-recovery extracted (backend 1090 + module 434), MEMORIES_COLUMNS single-sourced; wave body C3 done, kp21 (07) unblocked.
- 2026-08-16: ticket 07 CLOSED — kp21 dispositioned (T1 #1494 / T2 satisfied / T3 waived not-MVP).
