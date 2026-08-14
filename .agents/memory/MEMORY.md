---
id: bc077ee1-6429-4f14-a819-7e3f3a041dc7
created: 2026-08-08
last: 2026-08-08
---
hermes-memory structural facts (2026-08-02): Numeric isolation — project block leak fix (PR #1009): Ticket #04's premise ("raw memworth counters leak into the prompt") was partially true. Verified gap: formatProjectBlock (memory-store.ts:1291) joined raw this.memoryEntries (frontmatter intact, leaking id/created/memworth/pin etc.), while sibling paths (memory/user snapshot, failure block) already used stripMetadata. Fix: made formatProjectBlock consistent by calling stripMetadata before rendering, and added a MEMORY_POLICY_PROMPT rule: "Never edit memory sources directly — always use the validated tool envelope." Session-row lifecycle vs capture point: the `sessions` DB row is created ONLY by DEFERRED backfill (`scheduleSessionBackfill` → `setTimeout(0)`, session-backfill.ts) and live-indexing on `message_end` (index.ts `scheduleLiveSessionIndex`) — NOT synchronously at `session_start`. So any per-session data captured at `session_start` CANNOT FK-reference `sessions(id)` (row absent) and cannot upsert columns onto `sessions` (NOT NULL project/cwd + absent row). PR #1012 (per-session assembly log / prompt-provenance) therefore uses FK-free `session_assembly(session_id, md_id)` + `session_assembly_meta(session_id, hash)` tables; session_id is a plain join key, joined to `sessions` via LEFT JOIN. General rule: future hermes features that capture at session_start should store in FK-free tables keyed by session_id, not on the sessions row.
§
---
id: 30c70882-bdce-44fe-827d-6eacd4504b9d
created: 2026-08-08
last: 2026-08-14
---
Subagent reliability limits (refined 2026-08-13, proven across ticket-03 SDD): Subagent token budget caps at ~1.2M tokens — multi-package TDD tasks (implement + runtime-verify + commit + report) exceed it; both T3 and T5 implementers aborted at ~1.21M with code essentially complete but uncommitted. Full-suite test runs across 3 packages inside ONE subagent cause wall-clock timeouts (exit 124) even at 25-min budget; single-package suites run fine. Proven mitigations: (1) split tasks so no dispatch touches more than 1–2 packages; (2) verify via targeted tests only (changed-file tests + tsc), never combined full suites; (3) split diff-review (read-only, via subagents batch without bash) from test execution; (4) on abort, investigate git state first (dirty tree? partial commit?), then SALVAGE complete+compiling code (targeted verify + commit) or finish remaining pieces in a small follow-up dispatch — do not re-dispatch from scratch. Lean read-only tasks timing out with EMPTY output after ~30 min = infra degradation (slow API/load), not task size — run a low-cost sanity dispatch before investing more. Watchdog commit-scope warnings fired as false positives on legitimate multi-file salvage commits — verify the file set against the task plan rather than auto-blocking. Avoid git add -A in subagents (sweeps unrelated changes); append-only edits to planning files are reliable. Background workflows handle 200k+ tokens; subagents cap at ~1.2M.
§
---
id: b5f28240-a07b-497e-9479-5a33d45b816f
created: 2026-08-08
last: 2026-08-08
---
§
---
id: c4963794-22eb-4d36-9e0e-955a0375d6e1
created: 2026-08-08
last: 2026-08-08
---
Planning hygiene (.planning/): keep as a high-quality knowledge source — update efforts during development (cross-effort reconciliation, close tickets with resolutions, mark superseded). Standing practice documented in .planning/CONVENTIONS.md. Add ## Cross-effort links section to map.md with keys: Supersedes (this effort replaces), Absorbed-by (this effort was replaced by), Prior-art (earlier decision to reference), Covered-by (already addressed by other effort) — avoids duplicate/overlapping decisions.
§
---
id: e5be7513-7954-4213-89fe-be144332e353
created: 2026-08-08
last: 2026-08-08
---
DevOps extension hardening (2026-08-08, branch feat/devops-self-reflection, commit 9bce440f): Session friction analysis revealed devops tools existed (await_pr_merge, sync_repo, pr_status, local_ci — PURE + injectable + 91 tests) but were NOT USED — housekeeping ran on raw bash instead. Hardening added 4 deliverables: (A) devops_retrospect — advisory post-run retrospective (read-only, surfaces anomalies like force-push/scope drift/worktree blocks, no aborted field), (B) prepare_branch — worktree-aware branch prep (handles 'main already checked out' by branching off origin/main directly), (C) post-merge verify — validates squash commit contents match expected file set, (D) adoption/routing skill — routes agent to devops tools instead of raw bash. Pattern: PURE recipe + injected spawn/client seams + throw-free (aborted+warnings) + commands[] + dryRun + types-with-recipe + bun:test inline fakes + no build step. Skill discovery: manifest registers DIRECTORIES in skills[] array, then automatic intra-directory discovery of */SKILL.md. 179 pass total (144 baseline + 32 new + 3 integration). Committed + amended.
§
---
id: 4a9259d6-c6c9-4550-99b5-0fb124265731
created: 2026-08-08
last: 2026-08-08
---
Unification of knowledge-pipeline efforts (2026-08-08, commit caff462f on feat/hermes-memory-backend-ab): Five prior knowledge-pipeline .planning/ efforts merged into one canonical .planning/2026-08-08-knowledge-pipeline/. Old effort maps annotated with SUPERSEDED-BY cross-links. Tickets 01-05 preserved with git-mv (100% similarity, history kept), tickets 06-10 created during unification, ticket 11 spawned from 06's fork 3. Foundation map.md (the wayfinder effort itself) auto-merged cleanly during rebase — #1085 frontmatter and superseded annotation were in disjoint regions.
§
---
id: 222647fe-1cab-4117-8541-8b77b1ba4e08
created: 2026-08-08
last: 2026-08-08
---
Devops tool adoption gap (2026-08-08): Session friction had two root causes: (1) Tools already existed in pi-agent-ext-devops (await_pr_merge, sync_repo, pr_status, local_ci) but weren't used — raw bash was run instead. (2) Missing tools needed: worktree-aware branch preparation (prepare_branch), post-merge verification, and a routing skill to guide agents to use devops tools over raw bash. The devops extension was built to replace brittle raw-bash git/gh workflows with structured JSON outputs, but agents need routing/adoption mechanisms to actually invoke them. Solution: add self-reflection (devops_retrospect advisory), fill tool gaps, and add an adoption/routing skill.
§
---
id: 703a2e84-8a85-4071-a2c0-18c16e31703b
created: 2026-08-08
last: 2026-08-08
---
DevOps extension pattern — PURE + injectable + tested (2026-08-08, reinforced): All devops tools follow the Recipe<T> pattern with `aborted`/`warnings`/`dryRun`/`commands[]` fields, throw-free (aborted+warnings vs exceptions), use injected seams (spawn, gh client) for testability, and have full bun:test coverage with inline fakes. No build step (`bun run check` = tsc). This pattern was used for the new devops_retrospect, prepare_branch, and verify_post_merge tools. The pattern keeps tools testable, auditable (commands[]), and safe (dryRun mode).
§
---
id: 22d0fc70-8dc9-43a2-8a54-89ec56319a03
created: 2026-08-08
last: 2026-08-08
---
User preference for advisory vs blocking gates (2026-08-08): When scoping devops hardening, user chose `devops_retrospect` as an ADVISORY post-run retrospective rather than `verify_scope` as a blocking gate. Scope drift and other anomalies are surfaced in the retrospective but don't block operations. This reflects a preference for lightweight checks with feedback over hard-blocking validation in the devops workflow.
§
---
id: 969574fd-5755-4808-be7a-d07c5cb849d2
created: 2026-08-08
last: 2026-08-08
---
Coherent development rounds pattern (2026-08-08, proven on devops hardening): When building multiple tools that touch shared files, split into coherent rounds to avoid conflicts. Round 1: self-contained modules (retrospect-recipe, prepare-recipe, verify-recipe + tests) with no shared-file edits. Round 2: integration (extensions/devops.ts registration, routing skill, manifest testGate) in one commit. Pre-check before Round 2: run `bun test` to verify Round 1's 176 pass baseline. Post-Round 2: full suite (179 pass) + `tsc` clean. This pattern prevented integration conflicts and made review tractable.
§
---
id: 6703200a-9d0a-4662-aeb4-8b550a248875
created: 2026-08-09
last: 2026-08-09
---
Knowledge-pipeline vector/search backend DECISION (Round 2 grill, refines Ticket 04, 2026-08-09): SurrealDB is the PRIMARY backend for the knowledge pipeline, carrying BOTH the CRUD store AND the vector index (HNSW, 768-dim, cosine). Verified SurrealDB v3.2.3 resident @127.0.0.1:8000 — DDL: DEFINE INDEX <name> ON <table> FIELDS vec HNSW DIMENSION 768 DIST COSINE TYPE F32; KNN: SELECT id FROM <table> WHERE vec <|10,100|> [<768 floats>]; (v3 REMOVED the old <|k|> operator — use 2-arg <|k,EF|>); HNSW p95 ~13ms wall / ~2ms server-side @1k 768-dim vectors; DISKANN also works. SQLite is the FALLBACK backend for NON-vector CRUD + FTS5 only (existing surreal->sqlite backend-factory.ts). SQLite does NOT carry vectors. SUPERSEDES Ticket 04's sqlite-vec FALLBACK (sqlite-vec dropped — not loadable in Bun). Embed model unchanged: text-embedding-nomic-embed-text-v1.5 (768-dim) via LM Studio. Recorded in pi-agent-ext-hermes-memory PRD.md + .planning/2026-08-08-knowledge-pipeline/tickets/04 + map.md. OPEN: nomic fastest but bge-m3 higher recall@1 (0.909 vs 0.864) — model pick may revisit.