---
id: 5c57c1b7-1c75-4fa9-baf6-e486347cbff5
created: 2026-07-31
last: 2026-07-31
---
pi-agent-ext-subagent watchdog L1 planned architecture change (ticket 02, DO decided): generalize L1 from single hardcoded `typescript-language-server` into a multi-provider `L1Provider` registry. First addition: pyright for Python. Second lane planned (ticket 03, DO): biome as CLI-lint lane (`biome lint --reporter=json`) separate from the LSP registry — biome is a linter not a language server, CLI output is clean. Severity by-domain: correctness/suspicious/security → blocker; style/complexity → concern. Rationale: biome `recommended` rules catch unused vars/imports that tsserver misses (repo tsconfig has `strict` but NOT `noUnusedLocals`). biome is already CI gate per-ext — L1 addition is 'earlier to dirty tree' parallel to tsserver-vs-CI-tsc symmetry.
§
---
id: 9db26806-c620-4d66-a3b2-829b1e12c22e
created: 2026-07-30
last: 2026-07-30
---
[file2md] AB test outcome for PDF direct-text extraction (2026-07-30): MinerU (Python, torch) achieves best quality with LaTeX equations and figure extraction, but violates no-Python constraint. Bun-native extractors (mupdf, pdftotext) are pdftotext-class: faithful prose, degraded equations (linearized, non-LaTeX), figures completely lost. VLM-only has hallucinations (e.g., missed trailing V in softmax(QK^T/√d_k)V). Hybrid (mupdf + text-as-prior VLM on figure pages only) is the sweet spot for Bun-only constraints: fast text extraction, VLM reserved for figure description with prior suppressing hallucinations. Decision: implemented --extract vlm|text|hybrid with vlm as default, merged via PR #951.
§
---
id: 610e10c5-42de-4973-85b0-cb4e6fed9745
created: 2026-07-31
last: 2026-08-01
---
Superpowers planning-path ADR-0004: NEVER edit upstream-ported SKILL.md prose. Fidelity guard (`skills-fidelity.test.ts`) pins 14 ported skills byte-equal to fixtures. Routing achieved via (a) system-prompt to `.planning/<effort>/plan.md`, (b) `PI_PLANNING_EFFORT` + `scripts/sdd-workspace` for SDD, (c) symlink bridge `docs/superpowers/{plans,specs}/` → `.planning/{plans,specs}/`. Re-baseline fixtures ONLY for genuine upstream re-ports via `scripts/rebaseline-upstream-skills.ts`, NEVER for repo conventions.
§
---
id: ee245365-bdb0-4896-9981-60727baa42f0
created: 2026-07-31
last: 2026-08-01
---
hermes-memory model (PR #961): consolidation is DESTRUCTIVE (LLM merge = fresh entry, no lineage, .md + DB hard-deleted). Overflow priority: offload superseded FIRST (setSupersededContentProvider → purge content-key from .md → sync DB). TRIM never touches active. .md schema-free; DB↔.md bridge via content-key.
§
---
id: 2019684d-5f47-4491-b9ea-4997399b887c
created: 2026-07-31
last: 2026-08-01
---
pi-agent startup perf (2026-07-31): PR #973 rewrote backfillGraphEdges orphan-check from `NOT IN (SELECT VALUE in FROM tagged)` to `count(->tagged)=0` (10s timeout→17ms), dropping startup 10.6s→0.91s. PR #971 batched syncMarkdownMemories (317→3 round-trips) was orthogonal to startup. LESSON: async CPU profilers mis-attribute wait-time; always step-time actual ops + measure end-to-end.
§
---
id: 398824d5-f3bd-4c39-b027-08feb0866059
created: 2026-08-01
last: 2026-08-01
---
Git workflow (video_generation repo): Multi-worktree setup means `gh pr merge --squash --delete-branch` leaves LOCAL branches (main checked out elsewhere, local checkout fails). Cleanup: `git switch --detach origin/main && git branch -D <merged-branch>`. Use `sweep-merged-branches.sh` for automated cleanup. PR process: branch from origin/main → commit → push → auto-merge (squash) → if mergeState=BEHIND, rebase + force-push → CI passes → auto-merge → cleanup. Branch protection requires CI pass including administrators. `git cherry origin/main <branch>` checks if safe to force-delete (0 lines starting with `+` = merged).
§
---
id: f3b0e175-b5e6-4c80-bcec-95f3ddc64ff1
created: 2026-08-01
last: 2026-08-01
---
and the hardening SHIPPED 2026-08-02 (ADR-0006, commits 478b8f8a..de3466a): piBoundaryOverrides() is now UNCONDITIONAL — no-effort specs route to the flat `.planning/specs/<YYYY-MM-DD>-<topic>-design.md` and plans to `.planning/plans/`, effort-set → `.planning/<effort>/`. Key discovery during that effort: `docs/superpowers/{specs,plans}` are git-tracked SYMLINKS → `.planning/{specs,plans}` (flat layout, active home for standalone brainstorm specs through 2026-08-01), so the original "leak" was already partly mitigated at the filesystem level. TWO coexisting layouts: flat `.planning/{specs,plans}/` (standalone brainstorm/writing-plans output) and per-effort `.planning/<effort>/` (multi-ticket wayfind efforts). A repo lint `bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts` guards against literal leakage under `docs/superpowers/`/`.superpowers/` (skips the legit symlinks).
§
---
id: 1994f3af-5b66-40b1-8e76-a758f2261290
created: 2026-08-01
last: 2026-08-01
---
pi-agent-ext-superpowers code facts for testing boundary changes: (1) `piBoundaryOverrides()` is NOT exported, but `getBootstrapContent()` IS exported and `bootstrap.test.ts` already asserts on its content — that's the test home for boundary-text assertions. (2) There's an existing test locking the routing/redirect section of `getBootstrapContent()` to < 2000 chars — any boundary text edit must stay concise. (3) Ext tests run via `bun run test` (CI matrix at `ci.yml:111`). (4) Repo-lint pattern: self-contained `bun test` files run in the existing matrix; repo-root `scripts/check-*.sh` for shell lints. (5) ADR-0006 (2026-08-02): supersedes ADR-0005's 'when an effort is active' clause — the no-upstream-path rule is now UNCONDITIONAL.
§
---
id: 116c1d21-38b6-4f61-ab52-97cbe1799052
created: 2026-08-01
last: 2026-08-01
---
tool-gate savings-claim single-source-of-truth — RESOLVED (2026-08-02, commits fecade51 + 7ff58cdd, code-reviewed). CLAIMED_SAVED_TOK=8050 (qa/savings.ts) is THE gross single source; the NET claim is DERIVED (CLAIMED_NET_TOK = CLAIMED_SAVED_TOK − ENABLE_TOOL_OVERHEAD_TOK = 7807; prose ~7,800). Every prose mention (README/CONTEXT/tool-gate.ts header/PRD) cites ~8,050 gross / ~7,800 net + points to `bun run qa:savings` for live numbers. THREE guards: (1) DRIFT_BAND=0.2 (±20%) + pure withinDriftBand() + gross deviation-band test; (2) net-band + enable_tool-overhead-band tests; (3) PROSE-DRIFT test (qa/savings-prose-lock.test.ts) — fails CI if any `~N,NNN` figure in prose isn't in SANCTIONED_PROSE_TOK, closing the prose↔constant gap that once let 3 different gross numbers (7,900/7,940/8,050) coexist. ±20% width is deliberate (zai-mcp env swing ~1.1k ≈ 14% of claim; tighter flakes when zai loads). CONVENTION: never hardcode a competing savings figure in prose; cite CLAIMED_SAVED_TOK / CLAIMED_NET_TOK; refresh measured baselines (OFF ~18k / ON ~10k / measured net ~7,865) only via qa:savings.
§
---
id: 5c86201f-383c-4db6-a2ba-18e31ec00e57
created: 2026-08-02
last: 2026-08-02
---
Feature PRs ship code-only, planning artifacts stay as churn (2026-08-02, reinforced): PR #1005 (pin field), #1007 (dangling-ref sweep), #1009 (numeric isolation), and #1010 (await_pr_merge hardening) all shipped exactly the feature source + test files, leaving `.planning/` and MEMORY.md changes unstaged. This is the established convention — stage only the code files, leave planning/memory churn local. Verified across four consecutive PRs.
§
---
id: c3730717-abf2-44df-a291-22189f107c69
created: 2026-08-02
last: 2026-08-02
---
hermes-memory numeric isolation — project block leak (2026-08-02, PR #1009 fix): Ticket #04's premise ("raw memworth counters leak into the prompt") was partially true. Verified gap: formatProjectBlock (memory-store.ts:1291) joined raw this.memoryEntries (frontmatter intact, leaking id/created/memworth/pin etc.), while sibling paths (memory/user snapshot, failure block) already used stripMetadata. Fix: made formatProjectBlock consistent by calling stripMetadata before rendering, and added a MEMORY_POLICY_PROMPT rule: "Never edit memory sources directly — always use the validated tool envelope." Tests added for both gaps. The ticket's "prose bands" idea was moot — the design already strips memworth entirely, it was just inconsistent.
§
---
id: 505c14b4-ab04-4dda-88be-00004b3ae605
created: 2026-08-02
last: 2026-08-02
---
Spec→plan hardening (D1-D3, 2026-08-02): Specs must cite VERIFIED code sites (file:line) before writing the design. This prevents "spec-reality gaps" where the ticket's premise doesn't match actual code. Example: ticket #04 assumed raw memworth leaked into prompts, but D1 verification revealed only formatProjectBlock leaked (siblings already stripped), and the "prose bands" idea was moot. Another example: ticket #03's "body-reference parser" was a no-op because memory bodies are pure prose with no mdId/slug citations — the real rot was in structured lineage pointers (supersedes/parentIds). D1 = read code; D2 = write spec with verified sites; D3 = implement from grounded spec.
§
---
id: 5e62d162-5cb3-4e12-8d2f-296e6fc7fd39
created: 2026-08-02
last: 2026-08-02
---
hermes-memory session-row lifecycle vs capture point: the `sessions` DB row is created ONLY by DEFERRED backfill (`scheduleSessionBackfill` → `setTimeout(0)`, session-backfill.ts) and live-indexing on `message_end` (index.ts `scheduleLiveSessionIndex`) — NOT synchronously at `session_start`. So any per-session data captured at `session_start` CANNOT FK-reference `sessions(id)` (row absent) and cannot upsert columns onto `sessions` (NOT NULL project/cwd + absent row). PR #1012 (per-session assembly log / prompt-provenance) therefore uses FK-free `session_assembly(session_id, md_id)` + `session_assembly_meta(session_id, hash)` tables; session_id is a plain join key, joined to `sessions` via LEFT JOIN (project/cwd null until backfill indexes the session). General rule for future hermes features that capture at session_start: store in FK-free tables keyed by session_id, not on the sessions row.