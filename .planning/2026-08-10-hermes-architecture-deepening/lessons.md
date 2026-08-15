# Lessons — subagent dispatch & git hygiene

Captured from the 2026-08-10 hermes-architecture-deepening sessions. These are recurring, repo-wide workflow lessons (not effort-specific). Persisted here because the pi memory tools were unavailable in those sessions (`memory_search` / `memory` / `skill_manage` are advertised in the policy block but not wired into the callable toolset — recurring across two sessions).

## 1. Big structural refactors time out as a single subagent dispatch
**Symptom:** a large multi-file refactor dispatched as one subagent task ran ~36 min and hit the wall.
**Lesson:** split structural work — research first (read-only: locate every site + exact snippets), then a tightly-scoped implementer, then a verify/ship dispatch. Never bundle "explore + design + implement + verify" into one dispatch.
**Do:** read-only research dispatch → scoped implementer dispatch → verify/ship dispatch.

## 2. Never `git reset --hard` / `git checkout -- <file>` / `git clean` near uncommitted work
**Symptom:** a `reset --hard` destroyed an uncommitted `python/embed-bench/backends/mlx_native.py` (the lazy `mlx_embeddings`-import mod); it had to be restored from dangling blob `83e9509b`.
**Lesson:** `mlx_native.py` is carried as a persistent uncommitted ` M` across sessions. Any hard git op obliterates it.
**Do:** preserve uncommitted files via `git stash push -- <path>` before branch switches. `--soft` / `--mixed` resets are safe (working tree untouched); never `--hard`.

## 3. The pi memory tools are not actually in the callable toolset (recurring)
**Symptom:** two consecutive sessions had `memory_search` / `memory` / `skill_manage` described in the injected memory-policy block but NOT registered as callable tools — durable lessons could not be recorded via the memory tool.
**Lesson:** subagents cannot use the memory tool, and the parent session is sometimes missing it too. Do not delegate memory writes to subagents, and do not assume the memory tool is available — verify first. Fallback: persist to a tracked repo file.
**Action:** worth a config check — the policy block advertises memory tools that are not registered.

## 4. Always verify a "merge" actually landed the intended content (#1181 phantom)
**Symptom:** PR #1181 appeared merged but its content did not land on main.
**Lesson:** "merged" status ≠ content on main. After every `gh pr merge --squash`, verify the changed lines actually exist on origin/main.
**Do:** post-merge proof, e.g. `git show origin/main:<file> | grep <expected>`, before declaring done. (Applied to #1201: confirmed `return splitMemoryEntries(raw);` present on all 4 files.)

## 5. `commitScope=[]` on a subagent flags the ENTIRE branch history (false positives)
**Symptom:** a read-only subagent with `commitScope=[]` reported a "13-path commit-scope violation", but forensics (`git diff origin/main..HEAD --stat`) showed ZERO commits above origin/main. The 13 paths were origin/main's historical commits (#1193/#1199/#1200).
**Lesson:** with `commitScope=[]` the guard scans the branch's full commit history, not just the subagent's run — noisy on any non-empty branch.
**Do:** pass a MEANINGFUL path-prefix scope for the change boundary (e.g. `["bun-apps/<pkg>/src/"]`), not `[]`. If `[]` does fire, verify with `git diff origin/main..HEAD --stat` before reacting.

---

## Known follow-ups (not lessons)
- **Date-aging test time-bomb** (pre-existing, red on origin/main as of 2026-08-10): `bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-store.test.ts` — `formatForSystemPrompt never emits memworth` (line ~2630) fails once the failure fixture `iso-fail-1` (`created: "2026-08-02"`) ages past `DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS = 7` (`src/constants.ts:37`), so `getActiveFailureEntries` drops it → empty failure block → `/numeric-iso lesson/` never reaches the prompt. Fails identically on main (99 pass / 1 fail). Fix: refresh the fixture date or make the test inject a fixed/relative date. Separate PR someday.
