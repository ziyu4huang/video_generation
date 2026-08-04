---
id: 1994f3af-5b66-40b1-8e76-a758f2261290
created: 2026-08-01
last: 2026-08-01
---
pi-agent-ext-superpowers code facts for testing boundary changes: (1) `piBoundaryOverrides()` is NOT exported, but `getBootstrapContent()` IS exported and `bootstrap.test.ts` already asserts on its content — that's the test home for boundary-text assertions. (2) There's an existing test locking the routing/redirect section of `getBootstrapContent()` to < 2000 chars — any boundary text edit must stay concise. (3) Ext tests run via `bun run test` (CI matrix at `ci.yml:111`). (4) Repo-lint pattern: self-contained `bun test` files run in the existing matrix; repo-root `scripts/check-*.sh` for shell lints. (5) ADR-0007 (2026-08-02): supersedes ADR-0005's 'when an effort is active' clause — the no-upstream-path rule is now UNCONDITIONAL.
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
§
---
id: f3a75582-9503-4cab-a672-baa3b2e2caf7
created: 2026-08-03
last: 2026-08-03
---
zkSpawn (pi-agent-ext-knowledge-card) — internal private spawn seam, NOT a tool. Two config gotchas that took source-tracing to derive:
1. settings.json does NOT feed zkSpawn: `obsidian.subagentModel` and session `defaultModel` are IGNORED. Model = resolveDistillModel = `params.model ?? KC_SUBAGENT_MODEL ?? "google/gemma-4-12b-qat"` (LOCAL LM Studio, keeps kcard LLM spend off cloud). To change the zk_* subagent model set KC_SUBAGENT_MODEL env or the tool's `model` arg.
2. OB_SUBAGENT_TIMEOUT_MS is STALE for the migrated zk_* path: in-process zkSpawn call sites (knowledge-card.ts:828 zk_card, :975 zk_ask) pass no timeoutMs; spawnSubagent (spawn-subagent.ts:228) only arms a timer when timeoutMs truthy → zk_* subagents run with NO timeout gate today. That env is still honored by pi-obsidian's separate obsidian_distill/garden child-process tools.
Trigger: zkSpawn fires only on zk_card (any action) + zk_ask (LLM tools). zk_ingest + knowledge_query are deterministic, never spawn. Documented in PRD.md "## `zk_spawn` — internal subagent spawn seam" (bun-apps/pi-agent-ext-knowledge-card/PRD.md).
§
---
id: 78d07b03-40e7-44db-abd1-c751830974c1
created: 2026-08-03
last: 2026-08-03
---
pi-tui overlay `Component.invalidate()` is a TUI→component cache-bust notification ("Called when theme changes or when component needs to re-render from scratch", per the Component interface in pi-tui/dist/tui.d.ts). It must NOT request a render or re-enter `tui.invalidate()`.

Why: `TUI.invalidate()` (pi-tui tui.js ~428) synchronously iterates `this.overlayStack` and calls every `overlay.component.invalidate()` with NO guard. If an overlay's `invalidate()` calls its `invalidateFn` (which editors wire to `() => this.tui.invalidate()`), it re-enters `tui.invalidate()` → infinite recursion → `RangeError: Maximum call stack size exceeded`. This fires on ANY `tui.invalidate()` while the overlay is up (e.g. a tool-result `updateDisplay`), not just keypresses.

Correct pattern (see pi-agent-ext-core-task StatusPanelOverlay, pi-agent-ext-picker MenuOverlay):
- `setInvalidate(fn)`: store fn. The COMPONENT calls `fn()` from its OWN state-change methods (`move()`, `setQuery()`) to request a render.
- `invalidate()`: make it a NO-OP (or bust local caches only) for stateless overlays. The actual render is driven by the input loop's post-`handleInput` `tui.requestRender()` (tui.js ~628), and `requestRender()` is the throttled/guarded scheduler — `tui.invalidate()` in 0.83.x does NOT schedule a render, it only propagates cache-bust.

Test blind spot to avoid: tests that mock `tui.invalidate` as `mock(() => {})` (no-op) never simulate the propagation, so the recursion is invisible. Regression tests must mirror real propagation: `tuiInvalidate = () => overlay.invalidate()` and assert `tuiInvalidate()` / `move()` don't throw.
§
---
id: c9ce171b-0a50-4cc0-94c2-2806744f2fce
created: 2026-08-03
last: 2026-08-03
---
For a finished feature worktree whose branch is merged, two cleanups:
  A) keep worktree, retarget to main's tip: `git checkout --detach <sha> && git branch -D <feature-branch>` (executed 2026-08-03 on video_generation__memory worktree after PR #1022 merged)
  B) remove the worktree entirely: `git worktree remove <path>`

`git checkout main` in a non-primary worktree FAILS with "fatal: 'main' is already used by worktree at ..." — this is expected, not an error. To sync main: `git -C /Users/huangziyu/proj/video_generation pull --ff-only`. To delete the merged local branch in a non-primary worktree: `git switch --detach origin/main && git branch -D <branch>` (cannot checkout main, so detach first).