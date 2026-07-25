## Question

Resolve the three biome regressions #827 introduced in `pi-agent-ext-subagent` so the package's `check` / `test` passes and main goes green. CI (run `30177484053`) fails the `pi-agent-ext-subagent` job on exactly these:

1. **`src/subagents-command.ts:27` — `lint/correctness/noUnusedVariables` (FIXABLE but *unsafe*).**
   `export type SubagentsViewerFactory<T> = (tui, theme, kb, done) => { ... }` declares `<T>` but never uses it in the factory body. Biome's offered fix (prefix `_T`) is unsafe: at the one known call site the generic *is* threaded —
   `custom: <T>(factory: SubagentsViewerFactory<T>) => Promise<T>`.
   **Decision:** does the generic carry real meaning (keep it, and restructure so `T` is actually used inside the factory signature), or is it vestigial (drop `<T>` entirely and type the call site concretely)? Read how `ui.custom` consumes the factory before deciding. This is the meatiest of the three — not a blind 1-line autofix.

2. **`tests/model-role-config.test.ts:31` — `lint/style/noNonNullAssertion`.**
   A `!` non-null assertion at line 31. **Decision:** rewrite to avoid it — optional-chain, a guard, or an `assert`?

3. **`src/model-role-config.ts` — formatter (tabs → spaces).**
   Trivial: `biome format --write`. Already fixed in isolation on branch `fix/subagent-model-role-lint` (commit `59a3f2f3`), which fixes **only** this sub-issue.

**Coordination note:** `fix/subagent-model-role-lint` exists (1 commit, checked out in no worktree, no PR open) and fixes only sub-issue #3. Since this ticket fixes all three in one PR, that branch is subsumed — decide: delete it, leave it, or cherry-pick its commit. Do **not** do this work in the `video_generation__core_task` worktree (it orphans post-#820); branch off `origin/main`.

type: grilling
blocked by: (none)
claimed: wayfinder-2026-07-26
closed: 2026-07-26 (resolved upstream)

## Resolution

**Resolved upstream — no code change on this map.** By the time work began, `origin/main` had advanced to `a3f3e58c` (#828) and CI was **green**: **#829** (`f7091230`, `style: fix biome indentation error in model-role-config.ts`) had fixed the one *blocking* #827 error — the `model-role-config.ts` formatter. #829 is the merged form of the `fix/subagent-model-role-lint` branch (`59a3f2f3`).

The other two #827 diagnostics are **non-blocking biome warnings** (`bun run check` exits 0; CI green): `subagents-command.ts:27` unused `<T>` and `tests/model-role-config.test.ts:31` `cfg!` (plus a `factory!` in another subagent test).

**Ruled out of scope** rather than fixed here: `pi-agent-ext-subagent` is under active migration (`feat/extract-subagent-package`, `refactor/subagents-tui-to-subagent-ext`, etc.). Touching it for zero blocking benefit risks colliding with that effort — left for the migration owner to clean up alongside the move.

**Lesson:** the "main is red, blocks all PRs" premise was stale — a fact-freshness miss (origin/main moved under the charting session).
