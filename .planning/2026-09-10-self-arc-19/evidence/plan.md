Plan complete. `.planning/2026-09-10-self-arc-19/` now holds `map.md` + 6 tickets, currently untracked (rides the single implementation PR per constraint).

**Budget**: 9 tool calls (~12 read-budget respected) — 2 mandated inputs, 5 artifact reads, 2 recon greps, then write.

**Execution order line** (in map `## Tickets`): **t01 ledger → t02 pointer → t03 reviewer twin → t04 permanence → t05 decision → t06 closeout**, with t04-before-t05 dependency (decision doc reads the arc-17 JSON from its committed evidence copy) and all of t01–t05 on ONE PR.

**Key design calls, each grounded in a measured fact:**

1. **Grandfathering, not erasure** — recon found the six duplicate-number folders (arc-13/14/15 ×2) are ALL `status: done`: shipped efforts, not deletable renumber residue. The ledger encodes them as `grandfathered: true` with notes naming their collision partners; uniqueness + "no NEW grandfathered entries" is enforced going forward.
2. **Red-bar as two layers** (D3): a permanent fixture (`tests/fixtures/arc-ledger-duplicate/`) whose rejection is asserted in CI forever, plus the two-commit ritual (fixture lands before the uniqueness rule; the red run is receipted into `evidence/`) — a guard never seen red is a guard never seen work.
3. **Parallel-session teeth**: in-tree uniqueness alone could NOT have caught dual-arc-18 (both trees internally unique) — the guard cross-checks `origin/main`'s ledger, skipping loudly when unreachable.
4. **Pointer tooling stays split** (D4): `repoint-next-goal.ts` is a new write-path runnable reusing `validateNextGoalFile`/`doctorNextGoal`; the validator's pure exit-code contract is untouched. Newest-filename-wins dedupe handles the exact live case where the pointer target IS the stale duplicate.
5. **arc-review.ts mirrors arc-plan.ts** structurally (double-pinned `zai/glm-5.3`, plan-style receipt, exit 1) — with the honest unknowns flagged in Fog of war (spawnSubagent `name` support, reviewer-typed registry def) and the harvest fallback (PR #2170) as verify-only.

**Learnings applied**: #2 (label ≠ content) — twice: the queue's own LATEST pointer was the charter's evidence, and t02's step 0 reads the LATEST artifact's actual form (symlink vs file) before writing; also #6-adjacent caution in t03 (verify the spawn spec rather than assume a `name` field).

**Fog of war** records what execution must resolve, not what planning guessed: LATEST form, `name` field, origin/main reachability in tests, and the 19-package taxonomy (t05 lets the committed JSON pick the classes).