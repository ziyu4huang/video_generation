---
id: 37653b77-3e4d-40b0-bc9b-cca5d414122c
created: 2026-07-31
last: 2026-07-31
---
Wayfinder effort structure (.planning/<effort>/): map.md (destination, decisions, notes, frontier) + tickets/ subdirectory. Ticket types: research, grilling. Research tickets = AFK, chart-time execution. Grilling = live Q&A session. When research complete and frontier empties to grilling ticket, work that ticket → graduate to multiple do/defer/skip decision tickets. One decision per session. Gitignore policy: .planning/<effort>/ artifacts ARE committed (durable, shared). Only per-task transient scratch ignored (task_plan.md, progress.md, findings.md).
§
---
id: 14a927f4-93ad-4931-a077-95c7ca2f2d0f
created: 2026-07-31
last: 2026-08-01
---
.planning/ directory structure (.planning/<effort>/): map.md (destination, decisions, notes, frontier) + tickets/ subdirectory. Ticket types: research (AFK execution), grilling (live Q&A). When research complete, graduate to do/defer/skip decision tickets (one per session). Gitignore policy: .planning/<effort>/ artifacts ARE committed (durable, shared) — repo has 377+ tracked .planning files. Only per-task transient scratch files are ignored (task_plan.md, progress.md, findings.md).
§
---
id: 719668ec-2e4e-40c6-bce9-7432909d38ba
created: 2026-07-31
last: 2026-07-31
---
Git PR 工作流：開分支 → commit → push → 開 PR → 啟用 auto-merge (squash) → 等 CI 綠 → 若 mergeState=BEHIND 則 rebase + force-push → CI 重跑綠後自動合併 → 用 sweep-merged-branches.sh 清理本地分支。分支保護要求 up-to-date，管理員也無法繞過 in-flight checks。
§
---
id: d32379f8-230e-47fd-8b41-95e4fde2a222
created: 2026-07-31
last: 2026-08-01
---
pi-agent-ext-subagent watchdog: L1 = tsserver (TS/JS only via changedTsJsPaths), L2 = model-based review. Bugs fixed (2026-07-31): (1) L2 input-set — mixed TS/JS+Python changes → L2 only saw TS/JS; fixed to use all changedPaths. (2) L2 diff truncation at 200K chars without flag; fixed with smart per-file budget + truncation flag. (3) Zero-layer sentinel degraded state buried; fixed with dual sentinel escalation. Planned: L1 multi-provider registry (pyright first), biome CLI-lint lane (catches unused vars/imports tsserver misses, aligns with CI gate).
§
---
id: 5c57c1b7-1c75-4fa9-baf6-e486347cbff5
created: 2026-07-31
last: 2026-07-31
---
pi-agent-ext-subagent watchdog L1 planned architecture change (ticket 02, DO decided): generalize L1 from single hardcoded `typescript-language-server` into a multi-provider `L1Provider` registry. First addition: pyright for Python. Second lane planned (ticket 03, DO): biome as CLI-lint lane (`biome lint --reporter=json`) separate from the LSP registry — biome is a linter not a language server, CLI output is clean. Severity by-domain: correctness/suspicious/security → blocker; style/complexity → concern. Rationale: biome `recommended` rules catch unused vars/imports that tsserver misses (repo tsconfig has `strict` but NOT `noUnusedLocals`). biome is already CI gate per-ext — L1 addition is 'earlier to dirty tree' parallel to tsserver-vs-CI-tsc symmetry.
§
---
id: 6d9af113-ee22-4411-8236-10b257885101
created: 2026-07-30
last: 2026-08-01
---
file2md PDF extraction AB test (2026-07-30): MinerU (Python/torch) wins on quality (LaTeX + figures, ~3.5-7s/page) but violates no-Python constraint. Bun-native (mupdf, pdftotext) = pdftotext-class: faithful prose, degraded equations (linearized), figures lost. VLM-only hallucinates (e.g., missed trailing V). HYBRID = mupdf text-as-prior + VLM on figure pages only — suppresses hallucinations, fast for prose pages. Implemented --extract vlm|text|hybrid (vlm default), PR #951.
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
id: 76bf293e-128e-4ad5-a50a-c8ed7eff93cd
created: 2026-08-02 --> <!-- created=2026-08-01
last: 2026-08-01
---
[correction] superpowers spec location hard-code bug (discovered 2026-08-02): I suggested writing to `docs/superpowers/specs/` but user corrected me — all superpowers pi-extension docs should redirect to `.planning/`, not `docs/superpowers/`. The actual convention is defined by superpowers ADR-0005 + wayfind ADR-0005: unified `.planning/<effort>/` tree where wayfinder writes `map.md` + `tickets/` and superpowers writes `spec.md`/`plan.md`/`sdd`/`brainstorm/`. Root cause: the local brainstorming and writing-plans skills still hard-code `docs/superpowers/specs|plans/` as default (stale upstream default), but the injection layer (`piBoundaryOverrides` in superpowers.ts) correctly redirects to `.planning/<effort>/` only when `PI_PLANNING_EFFORT` is active. Our earlier brainstorm had no active effort, so the redirect didn't fire. Fix: ensure PI_PLANNING_EFFORT is set before using superpowers skills, or the skills themselves need upstream patches.
§
---
id: 6b0c4e9a-5078-45cd-9e52-26dc8ae80194
created: 2026-08-02 --> <!-- created=2026-08-01
last: 2026-08-01
---
[insight] tool-gate savings claim drift (discovered 2026-08-02): savings figures are duplicated/inconsistent across README.md (~7,900 and ~8,050), code header (~7,940), and CONTEXT.md. The `savings.ts` already exports `CLAIMED_SAVED_TOK = 8050` and computes `deviation: savedTok - claimed`, but NO test asserts deviation is within tolerance — that's the missing drift guard. Design: add DRIFT_BAND constant, update prose to point to `bun run qa:savings` for live numbers, add deviation-band test to CI.
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