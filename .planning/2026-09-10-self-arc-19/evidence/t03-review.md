All verification complete. Here's my review.

---

# Review: PR #2250 — self-arc-19 (loop-integrity arc)

## Claims verified against the actual diff

**t01 — arc ledger + red-bar guard ✅**
- `.planning/arc-ledger.json` has exactly 20 entries: numbers 3–12 (10), 13×2, 14×2, 15×2 (three duplicate pairs, all `grandfathered:true` with collision-partner notes), 16–18, and arc-19 `active` with `branch: self-arc-19-loop-integrity`. Cross-checked 1:1 against the 20 real `.planning/*self-arc-*` dirs — completeness holds both directions on this machine.
- Red-bar is genuine, not narrative: `git show deef998f:bun-apps/s2-agent-ext-wayfind/src/arc-ledger.ts | grep -c "duplicate-number"` → **0** (rule absent in commit A), while commit A's test file already contains the permanent canary (`tests/fixtures/arc-ledger-duplicate/` claims #7 twice, non-grandfathered). Receipt `evidence/t01-red-bar.txt` shows the actual RED (`Expected: false / Received: true`). Commit order A (deef998f) → B (8d59c395) confirmed via `git log`. Today: `bun test tests/arc-ledger.test.ts` → 13 pass / 0 fail.
- Nice touch I verified matters: agreement is checked against the raw `status:` line, not the parsed enum — the ledger uses "done" which is outside model.ts's closed EffortStatus set; an enum check would silently pass undefined.

**t02 — repoint-next-goal.ts ✅**
- Failure ordering is correct: validation + supersedes problems are collected and `return result` fires **before** the first `unlinkSync` (`repoint-next-goal.ts:186-204` precede `:206-213`). A failed repoint deletes nothing.
- Dedupe: `NEXT_GOAL_FILENAME_RE = /^next-goal-(\d{8})-(\d{6})\.md$/` (validate-next-goal.ts:24) is fixed-width, so the lexicographic `.sort()` in `byteDuplicateGroups` is genuinely chronological; newest-of-group kept. Target-inside-a-deletion-group is handled twice — retarget detection via `staleTwin`, plus the belt-and-suspenders `if (d.file === plan.resolvedTarget) continue` guard — and the CLI derives `outputDir = dirname(resolve(target))`, so path-form mismatch can't strand LATEST on a deleted file.
- LATEST: relative symlink via tmp+rename; regular-file→symlink switch is reported, never silent. Tests: 7/7 focused; full devops gate `bun run test` → **1169 pass / 0 fail**.

**t03 — arc-review.ts model pin ✅**
- Traced the full resolution chain: `model: "zai/glm-5.3"` → `resolveSpawnModelInputs` (explicit model wins verbatim, spawn-subagent.ts:339-341) → `resolveModel` splits on first `/` → `registry.find("zai", "glm-5.3")` (agent.ts:325-335) — **exact provider+id match only**. No substring/prefix path exists anywhere in the chain, so the pin cannot resolve to glm-5.3-flash. Mirrors arc-plan.ts's double-pin comment verbatim; receipt records `requestedModel`. Subagent package: `bun run test` → **813 tests, 0 fail**.

**t04/t05 — evidence + decision doc ✅**
- arc-17 map citation now points at committed `evidence/self-arc17-audit-result.json` (migrated-from-output noted); arc-18 map flipped `active→done` (the lost-in-merge flip, commit faacd1a7). CONVENTIONS.md gains the ledger block retiring the "max folder is N" eyeball check.
- Decision doc: 26 ext packages on disk ↔ exactly 26 data rows. One row per package, confirmed by count.

**Gates I ran:** wayfind `check`/`typecheck`/`bun test` all green (530 pass); devops `check` + full `bun run test` green (1169 pass); subagent `bun run test` green (813 pass). (Note: devops has no `typecheck` script — pre-existing, and the decision doc's own devops row queues the gate split as a follow-up arc. Not this PR's regression.)

## Findings

**Blockers:** none.

**Should-fix:** none.

**Nits** (all recorded as deliberate or theoretical — no action required for merge):
1. `bun-apps/s2-agent-ext-devops/src/repoint-next-goal.ts:239-244` — when LATEST was a regular content file, the form-switch note is pushed into `problems[]` while `ok` stays `true`. A "non-empty problems but ok" contract wrinkle for JSON consumers; in-code comment marks it deliberate.
2. `repoint-next-goal.ts:110` — dedupe compares utf8-decoded strings, not raw bytes; two files differing only in invalid-utf8 sequences would collide as "identical". Text-only md artifacts make this theoretical.
3. `repoint-next-goal.ts:170-174` — a `supersedes:` value whose filename doesn't match the next-goal regex (unparseable `predTs`) silently skips the ordering check rather than failing.

## Verdict

Every arc claim survived contact with the actual artifacts — the red-bar was verified against commit A's real source, not the receipt alone; the ledger, guard, write-path tooling, and model pin all check out with green gates I ran myself. Three theoretical nits, none merge-blocking.

VERDICT: APPROVE