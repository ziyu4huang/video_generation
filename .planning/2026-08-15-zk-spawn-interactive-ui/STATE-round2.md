# zk-spawn round-2 state — branch `devops-sync-reporting` (rebased to origin/main eac1151e, ZERO commits yet)

Round-2 session hit token budget MID-implementation. Read `.planning/devops-sync-reporting/STATE-zk-spawn.md` (round-1 ground truth) PLUS this file first. Nothing committed; nothing pushed. Working tree has PARTIAL commit-1 edits applied (list below).

## Git state

- Branch `devops-sync-reporting`, ff'd to origin/main `eac1151e`. No own commits.
- Ambient dirty (NEVER touch/commit): `.agents/memory/MEMORY.md`, `vaults_root/study-news`.
- Untracked: `.planning/devops-sync-reporting/` (must end up tracked in commit 4), `bun-apps/pi-agent-ext-devops/tsconfig.probe.json` (DELETE, never commit).
- Stage ONLY explicit paths. DO NOT MERGE the PR.

## ALREADY APPLIED (uncommitted edits — verified by successful edit calls)

1. `src/gh.ts`:
   - `SubmoduleStatus.flag` retyped `" " | "+" | "-" | "U"`; `parseSubmoduleStatus` keeps flag VERBATIM (dropped `.trim()`, comment explains why); JSDoc updated (matchesRecordedGitlink wording).
   - `createBranchClient` += `logSubjects(from, to, limit)`: `git log --format=%s -n <limit> from..to`, exit!==0 → [], splits \n, strips \r, filters empty.
2. `src/branch-recipe.ts`: `BranchClient` interface += `logSubjects(from: string, to: string, limit: number): Promise<string[]>` (after aheadBehind).
3. `src/sync-recipe.ts` (ALL of commit-1's src side DONE):
   - `SyncClient` Pick += `"logSubjects"`.
   - `SyncAdvanced` += `count: number; subjects: string[]`.
   - `SyncSubmodule` → `{ worktree, path, sha, flag: " "|"+"|"-"|"U", matchesRecordedGitlink: boolean }` (clean dropped).
   - New `SyncCaller` (`{worktree, branch: string|null, detached, behindDefault: number|null}`) + `SyncVerification` (`{branch, local, remote, ok}`) interfaces; `SyncOutcome` += `caller?`, `verification?`.
   - `SYNC_ABORT_REASONS` exported (see list below) + `SyncAbortReason` type; `SyncAbort.reason` typed; stale JSDoc fixed.
   - `runSync`: `let caller/verification` before `outcome()` closure; closure carries both.
   - Helper `callerPostState()` (after signal check): currentBranch → detached if ""/"HEAD"; behindDefault = detached?null:aheadBehind(`origin/${D}`, branch).behind; warn `calling worktree ${repoRoot} is ${N} commit(s) behind ${D} — full mode advances the default branch only in the worktree that holds it.` when >0.
   - Helper `advancedCommits(from,to)`: dry||!from||!to → {0,[]}; count = aheadBehind(from,to).ahead; subjects = logSubjects(from,to,15); if count>subjects.length push `... and ${count-subjects.length} more`.
   - Helper `submoduleOps(dir)`: 3 steps [fetch/update/sync] warn-on-fail; then status (warn+return on fail); rows → submodules.push({worktree: dir, ...flag, matchesRecordedGitlink: flag===" "}).
   - Full mode: after advance → count/subjects in advanced.push; verification ALWAYS (localD=revParse(D)??""; warn on mismatch only when !dry); `await submoduleOps(repoRoot); if (advanceTarget !== repoRoot) await submoduleOps(advanceTarget);` then `caller = await callerPostState()`.
   - Rebase/pull: advanced.push with count/subjects (from→after HEAD); `caller = await callerPostState()`.
   - SYNC_ABORT_REASONS exact content: `aborted_before_start, dirty_tree, no_origin_ref, checkout_failed, preserve_failed, divergent, reset_failed, detached_head, rebase_failed, merge_failed` (ACTUAL emissions; spec's literal list was wrong — documented deviation for PR body).
4. `extensions/devops.ts`: import += `type SyncSubmodule`; formatSync rewritten — advanced line += `(N commit(s))` + subjects join " | "; verification line; submodules grouped per worktree (Map by worktree), off-gitlink rows rendered with flag semantics ("drifted from recorded gitlink"/"not initialized"/"merge conflict"); caller line; NO "not-clean".
5. `tests/sync-recipe.test.ts`:
   - fakeClient += `subjects?: string[]` param + `logSubjects: async () => s.subjects ?? []`.
   - Test (a) full-mode: aheadBehind keyed `${sha("a")}..${sha("b")}` {ahead:2}, subjects ["feat: one","feat: two"], advanced toEqual updated; submodules toEqual new shape (flag " ", "+", matchesRecordedGitlink).
   - advanced toEqual updated in: (b) OTHER-worktree test {count:0,subjects:[]}, force (d), dry (g), preserve (a) — all include count:0/subjects:[].
   - NEW describes appended at end: "caller post-state" (behind 2 + warning regex `calling worktree \/repo is 2 commit\(s\) behind main`; up-to-date; detached → branch null/behind null/no warning), "verification snapshot" (mismatch ok:false + warning; ok:true no warning; dryRun present ok:false no warning + rebase mode undefined), "advanced count/subjects" (20-commit cap → subjects len 16 + `... and 5 more`; 2-commit verbatim; dryRun 0/[] + logSubjects never called via wrapper client), "advanceTarget submodule ops" (8 submodule commands across both worktrees, entries tagged worktree OTHER only from OTHER-canned status `+sub-q/-sub-r`; submodule update failure at OTHER → not aborted, advanced kept, warning `submodule update failed at \/repo-main-wt`; status failure → warning, no rows).
   - `const OTHER = "/repo-main-wt"` already existed; warning regexes use `/repo-main-wt` literally.
6. `tests/gh.test.ts`: import += `parseSubmoduleStatus`; NEW describe "parseSubmoduleStatus" — 4 tests (all four flags verbatim; shell-quoted unescape `weird "path" x`; CRLF; garbage/blank skip).

## ABORTED / NOT APPLIED — redo from here

- **`tests/sync-cli.test.ts` — the edit call was ABORTED, nothing applied.** Re-apply BOTH changes:
  1. In `fakeClient`: after `aheadBehind: async () => ({ ahead: 0, behind: 0 }),` add `logSubjects: async () => [],` (required by widened SyncClient; `const base: SyncClient = {...}` literal won't typecheck otherwise).
  2. After the existing "clean run exits 0..." test, add a full-shape assertion test (exact text was drafted in the aborted call — rewrite from the mission spec: caller equals `{worktree: REPO, branch:"main", detached:false, behindDefault:0}`; verification `{branch:"main", local: sha("a"), remote: sha("b"), ok:false}` (fake revParse("main") stays sha("a") — quiet spawn never mutates it); `Array.isArray(outcome.submodules)`; advanced[0] has count+subjects, subjects []).
- `src/prepare-recipe.ts` (#6): add detached-head guard + head from/to + post-rebase aheadBehind (design below).
- `tests/prepare-recipe.test.ts`: fakeClient += `aheadBehind` stub; new tests (detached-head abort zero-spawn; head from/to on rebase).
- `src/pr-finish-cli.ts` (#7): recordingSpawn `git -C` form + post-merge sync hint.
- `tests/pr-finish-cli.test.ts`: hint assertion + `git -C` recording test (style: the existing options-forwarding echo-probe test; spawn `git` with `{cwd:"/tmp/x"}` via runCi passthrough and assert recorded command starts `git -C "/tmp/x"` — recorded commands come from `JSON.parse(res.stdout).commands`).
- tsconfig widening (#8-tsconfig) + ALL probe-inventory fixes (below).
- Delete `bun-apps/pi-agent-ext-devops/tsconfig.probe.json`.
- Commit/push/PR.

## Locked design decisions (do not re-derive)

- **#6 prepare**: `PrepareClient = Pick<BranchClient, "currentBranch"|"defaultBranch"|"worktreeList"|"revParse"|"aheadBehind">`. After the `signal.aborted` check and BEFORE the worktree guard: `if (!branch) return outcome({aborted:true, reason:"detached-head", message:"detached HEAD and no explicit --branch — refusing to guess a branch to mutate.", hint:"pass an explicit branch (or check one out) and re-run."})` (branch = opts.branch ?? current; current "" when detached). Add `"detached-head"` to the PrepareAbort reason union + JSDoc. Outcome += `head?: { from: string; to: string }` and `aheadBehind?: { ahead: number; behind: number }`: capture `revParse("HEAD")` as `headFrom` BEFORE step 3 (create) when create/rebase/forcePush any true (read-only, safe under dryRun); after successful rebase: `headTo = await client.revParse("HEAD")`, set `head = {from, to}` (set `to` only post-rebase; if rebase not run or failed, still set head with from only? — DECISION: set `head = {from, to}` when rebase ran ok; if only from known (no rebase), omit head OR set to=""? Keep it simple: only populate `head` when rebase ran (both ends) — matches mission "around rebase"). Post-rebase-vs-base: `await client.aheadBehind(base, branch)` → outcome.aheadBehind (also only when rebase ran; guard: revParse for from/to under dryRun is read-only and fine). formatPrepare in extensions/devops.ts: optional `head: a→b` line — minimal.
- **#7 pr-finish**: recordingSpawn: `commands.push(cmd === "git" && options?.cwd ? \`git -C "${options.cwd}" ${args.join(" ")}\` : [cmd, ...args].join(" "));` (keep forwarding options to the inner spawn). Post-mergeNow success (right after the `try { await gh.mergeNow(...) } catch { return abort(...) }` block): `warnings.push(\`merge advanced origin's default branch — other worktrees (possibly this one) may now be behind; run sync_repo (full mode) in each active worktree to catch up.\`)`. The existing dry-run `planned` hand-built strings (`git branch -D feature` etc.) may stay as-is (they're planned text, no cwd context).
- **#8-tsconfig**: new tsconfig.json — keep target/module/moduleResolution/strict/esModuleInterop/skipLibCheck/forceConsistentCasingInFileNames/resolveJsonModule/allowImportingTsExtensions; `lib: ["ES2022","DOM"]`; `types: ["bun","@repo/pi-agent-ext-core-interface"]`; DROP rootDir/declaration/sourceMap/outDir (check is `tsc --noEmit`, no build script uses them); include `["src/**/*.ts","tests/**/*.ts","scripts/**/*.ts","extensions/devops.ts"]`; exclude `["node_modules","dist"]`. package.json devDependencies += `"@repo/pi-agent-ext-core-interface": "workspace:*"`; then `( cd bun-apps && bun install )` (NEVER commit package-lock.json; bun-apps/bun.lock is canonical).
- **Probe error inventory to fix after widening** (from round-1 probe, groups):
  1. extensions/devops.ts `gating` ×10 → FIXED by types entry above (repo-canonical, 10 other packages do exactly this).
  2. scripts/deploy.ts `javascript-obfuscator` missing module → add `scripts/types-decl.d.ts` (or similar) with `declare module "javascript-obfuscator";` (dynamic import only, used under --obfuscate). `new Response(proc.stdout).text()` ×2 → fixed by lib DOM. Implicit-any `l` (line ~639) → annotate.
  3. scripts/lib/build-extensions.ts + codegen.ts TS6059 (import outside package: `../pi-agent/run-dir/manifest-types.ts`, `../pi-agent/scripts/generate-embedded-assets.ts`) → fixed by DROPPING rootDir (no rootDir ⇒ TS6059 can't fire). ACCEPT that pi-agent's files enter the program graph; re-run check; fix trivial errors there only if trivial, else note in report (they're covered by pi-agent's own typecheck).
  4. scripts/lib/deploy-target-guard.test.ts Response ×3 → DOM lib.
  5. tests/branch-recipe.test.ts(37) fake BranchClient missing methods → add `worktreeList/revParse/isClean/dirtyPaths/aheadBehind` (+ `logSubjects` — added to BranchClient this round!) stubs to its fake.
  6. tests/ci-recipe.test.ts(78), tests/recipe.test.ts(98,103) implicit-any params → annotate.
  7. tests/deploy-run.test.ts(35) wrong resolve() arg position → inspect & fix (env passed where ResolveOpts expected).
  8. tests/main-health-recipe.test.ts(57) + tests/pr-finish-cli.test.ts(100) CiOutcome fixtures missing `budgetMs/overBudget/slowest` → add; pr-finish-cli.test.ts(118) `runLocalCi` not imported → `import { runLocalCi } from "../src/ci-recipe.js"` (or type-only if only used as type — check line: it's `Parameters<typeof runLocalCi>[0]`, needs the VALUE import); (125,302) implicit-any opts/cmd/args/options → annotate.
  9. tests/sync-cli.test.ts(89) `expect(r.args.mode).toBe(m)` string vs SyncMode → type the loop array `const modes: SyncMode[] = [...]` or cast `m as SyncMode`.
  10. My OWN new code must stay clean (annotate fake params; no implicit any).
- SYNC_ABORT_REASONS content is FINAL (actual emissions, snake_case; prepare's hyphenated reasons are a SEPARATE union — do not merge). Deviation vs spec's literal list to be documented in PR body + report.

## Order of remaining work

1. Re-apply the two sync-cli.test.ts changes (text above).
2. #6 prepare-recipe.ts + tests/prepare-recipe.test.ts.
3. #7 pr-finish-cli.ts + tests/pr-finish-cli.test.ts.
4. MID-WAY test run: `( cd bun-apps/pi-agent-ext-devops && bun test )` (bun test alone first — tsc not yet widened; budget: ≤3 full check+test runs total, 0 used).
5. #8: tsconfig.json + package.json + bun install + delete tsconfig.probe.json + fix ALL tsc errors from inventory; `( cd bun-apps/pi-agent-ext-devops && bun run check && bun test )` green.
6. Commits (explicit-path staging only, English conventional):
   - c1 `feat(devops): sync reporting — caller post-state, verification snapshot, advanced counts, per-worktree submodule semantics` (src/gh.ts src/branch-recipe.ts src/sync-recipe.ts extensions/devops.ts tests/gh.test.ts tests/sync-recipe.test.ts tests/sync-cli.test.ts)
   - c2 `fix(devops): prepare_branch detached-head guard + head from/to reporting` (src/prepare-recipe.ts tests/prepare-recipe.test.ts + extensions/devops.ts formatPrepare if touched)
   - c3 `feat(devops): pr-finish post-merge sync hint + runnable git -C command recording` (src/pr-finish-cli.ts tests/pr-finish-cli.test.ts)
   - c4 `chore(devops): widen typecheck to tests/scripts/extensions; export SYNC_ABORT_REASONS` (tsconfig.json package.json bun-apps/bun.lock + whatever probe-fix files + `.planning/devops-sync-reporting/` — keep STATE file(s) tracked; may split planning into its own commit if cleaner).
7. Push, `gh pr create` (title: `sync reporting + submodule semantics + guards`; body lists #1-#7 + enum/tsconfig; note the abort-reason-list deviation). DO NOT MERGE.
8. Report: PR URL, commits, changed files one-line each, test counts (baseline 394 pass / 2 skip), deviations.

## Watch-outs (unchanged)

- entry.test.ts probes: after types-augmentation fix it must still pass (it asserts PI_*_PROBES exports; formatSync changes don't affect it).
- Never `git add -A/-u/commit -a`; never top-level cd; bun only; replies zh-TW; artifacts English.
