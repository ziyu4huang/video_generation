# DevOps merge-chain UX — Ticket-Level Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan ticket-by-ticket. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the five operator-facing friction classes observed in real merge-chain sessions on 2026-09-07 (obscure e2e credential failure, undiagnosable truncated abort output, cross-worktree rebase refusal, docs-only PR over-scoping, silent post-merge skips) plus two hygiene gaps (stale worktrees, unpinned exit-code contract).

**Architecture:** All work stays inside `bun-apps/s2-agent-ext-devops` following its established split: pure decision logic in `src/*-recipe.ts` / small pure modules, I/O behind injectable seams (`SpawnFn`, `BranchClient`, env readers), CLIs (`src/*-cli.ts`) only parse argv + serialize JSON. Zero changes to s2-agent core or other packages.

**Tech Stack:** Bun + TypeScript, `bun test` hermetic unit tests (fake spawn / injected env — never operator `~/.pi` or rc files), package canonical gate = `bun run check && bun run typecheck && bun test`.

## Global Constraints

- Written artifacts English (code/comments/commits); conversation zh-TW.
- Tests hermetic per #2186: no reads of operator `~/.pi/agent/*`, no ambient env dependence — every env/rc consumer gets an injectable seam.
- Exit-code contract (merge-pr-after-ci): success (incl. `--dry-run`, `--help`) → 0; every abort → 1; usage error → 2.
- PRs via `prepare-feature-branch-cli` + `merge-pr-after-ci-cli`; each PR's canonical gate = the package's own `bun run check && bun run typecheck && bun test` plus `tests/merge-pr-after-ci-cli.test.ts` runs green (it is a workflow gate: "PR-finish decision tests").
- `.planning/` artifacts committed with every PR (standing rule).

---

## 目標與範圍

### Goals

1. **Fail fast on missing e2e credentials** — a credential/model preflight in `merge-pr-after-ci` BEFORE the ~2-minute local-CI run, with an actionable message naming the exact export line to add.
2. **Diagnosable CI failures** — full failing-gate logs persisted to `<repoRoot>/output/ci-logs/<label>-<ts>/` with the path embedded in the abort JSON.
3. **Cross-worktree rebase without touching the holder** — an explicit `--via-temp-branch` mode for `prepare-feature-branch-cli` that rebases a detached temp copy and force-pushes the PR head, guarded on PR-open + remote-head-match.
4. **Docs-only fast path** — `.agents/` (and only that) joins `MATRIX_IRRELEVANT_PREFIXES`; a one-file `MEMORY.md` chore PR stops running the 29-package matrix; structural gates unchanged.
5. **Visible post-merge skips** — the held-elsewhere branch skip surfaces as a structured outcome field, and `sweep-merged-branches` names the holding worktree path.
6. **Worktree hygiene** — a report/prune CLI over `git worktree list --porcelain` prunable entries.
7. **Pinned exit-code contract** — a table-driven test covering EVERY abort reason → exit code, so tickets 1–3 can extend the surface safely.

### Non-goals

- No changes to s2-agent core (`bun-apps/s2-agent/**`), pi patches, or the baked provider catalog. The ambiguity error itself (resolver behavior) is worked around by preflight + qualified pins, not fixed upstream.
- No re-enable of remote GitHub Actions CI; local CI remains the only gate.
- No change to preserve-list semantics (`DEFAULT_PRESERVE_PATHS`), the fail-closed dirty-tree rule, or the default-path triple worktree guard in `prepare-recipe`.
- No changes to the `verify-deploy-e2e` probe suite's lane-selection logic (it already falls back to `zai` when only `ZAI_API_KEY` is present — `tests/deploy-probe-e2e.test.ts:78-85`); the fix is ensuring the invoking shell has what those suites need BEFORE paying for the run.
- No new effort folder / wayfind tickets in this plan (see Open Questions).

---

## Ticket breakdown

### MC-7 — Exit-code contract test (table-driven) — do FIRST

**Size:** S · **Risk:** low (test-only; one exported const added)

**Scope:**
- Modify: `bun-apps/s2-agent-ext-devops/src/merge-pr-after-ci-cli.ts` — export `PR_FINISH_ABORT_REASONS` as a `const` tuple mirroring the `PREPARE_ABORT_REASONS` pattern in `prepare-recipe.ts:71-78`. Current reasons (verified against the `abort(...)` call sites): `dirty_tree`, `pr-status-failed`, `local_ci_failed`, `not-open`, `behind`, `not-clean`, `ci-assumption-unverifiable`, `ci-assumption-stale`, `missing-workflow-scope`, `merge-failed`.
- Test: `bun-apps/s2-agent-ext-devops/tests/merge-pr-after-ci-cli.test.ts` — new `describe("exit-code contract")`.

**Steps:**
- [ ] Export the reason tuple; add a test asserting every entry matches `/^[a-z-]+$/` (style pin) and that the tuple has no duplicates.
- [ ] Table-driven test: for each reason, a minimal fixture (reuse the file's existing fake `gh`/`client`/`runCi` seams) driving `runPrFinishCli` to that abort → assert `exitCode === 1` AND `JSON.parse(stdout).aborted.reason === reason`.
- [ ] Pin the non-abort edges: full happy-path merge → 0; `--dry-run` → 0; `--help` → 0; `--pr notanumber` → 2; unknown flag → 2.
- [ ] Add a guard test: every `aborted.reason` string literal in the source is a member of `PR_FINISH_ABORT_REASONS` (read the file in the test, regex `abort\("([a-z-]+)"` — the same drift-guard shape `PREPARE_ABORT_REASONS` documents).

**Test strategy:** pure — the file already stubs `runCi`/`gh`/`client` offline (68 existing tests prove the seams).

**Acceptance criteria:**
- `bun test tests/merge-pr-after-ci-cli.test.ts` green; the table covers all 10 reasons + 5 edge cases.
- Any future abort reason added without a table row fails the membership guard test.

---

### MC-1 — E2e credential/model preflight before local CI

**Size:** M · **Risk:** medium — a false positive blocks legitimate merges, so resolution sources must mirror what the gate itself accepts.

**Scope:**
- Create: `bun-apps/s2-agent-ext-devops/src/e2e-preflight.ts` — pure module:
  - `resolveRcApiKey(env, readRcLine, varName): string | undefined` — TS port of `scripts/check-deploy-e2e.sh`'s `resolve_gate_api_key` (grep `^\s*export\s+VAR=` across `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, last match wins, quote-strip). Ambient env wins over rc (same precedence as the bash gate).
  - `preflightE2eLane(env, readRcLine): { ok: true; notes: string[] } | { ok: false; message: string }`:
    1. At least ONE of `DEEPSEEK_API_KEY` / `ZAI_API_KEY` resolvable (ambient or rc). The deploy-probe suites select lane by exactly this ternary (`tests/deploy-probe-e2e.test.ts:78-85`, `tests/e2e-core-tool-roundtrip.test.ts:77-80`); with NEITHER resolvable the fallback lane is `deepseek` while unauthenticated → the resolver fuzzy-matches the bare id and dies with `Model "deepseek-v4-flash-vision-exp" is ambiguous across providers` (~2 min in, 9 red tests — the 2026-09-07 incident).
    2. If `VERIFY_E2E_MODEL` is SET → must parse as `provider/model-id` (reuse `resolveE2eModelPin` from `deploy-e2e-recipe.ts:314-331`); malformed → fail with that message (pin semantics per #2140).
    3. If `VERIFY_E2E_MODEL` unset → advisory note only (recommend `VERIFY_E2E_MODEL=deepseek/deepseek-v4-flash-vision-exp` for a deterministic budget lane) — never a block.
    4. `PI_AGENT_E2E_PROVIDER`/`PI_AGENT_E2E_MODEL` overrides acknowledged in notes when present.
- Modify: `bun-apps/s2-agent-ext-devops/src/merge-pr-after-ci-cli.ts` — run the preflight after the preflight dirty-tree check, BEFORE the local-CI gate, ONLY when `!assumeCiGreen` (the retry path already asserts a green sha). Failure → `abort("e2e-credentials-missing", …)` with the actionable message: which vars were sought, where (env + the four rc files), and the exact `export DEEPSEEK_API_KEY=…` / `export VERIFY_E2E_MODEL=deepseek/deepseek-v4-flash-vision-exp` lines to add, plus `--assume-ci-green <sha>` as the already-verified shortcut.
- Modify: usage text (`PR_FINISH_CLI_USAGE`) + CONTRACT header comment.
- Test: `bun-apps/s2-agent-ext-devops/tests/e2e-preflight.test.ts` (new) + contract-table row in `merge-pr-after-ci-cli.test.ts`.

**Steps:**
- [ ] Failing tests first: rc-grep parsing (quoted/unquoted/multiple rc files/last-wins), precedence (ambient > rc), the four scenario outcomes above.
- [ ] Implement `e2e-preflight.ts` pure fns; both rc-reader and env injected (hermetic #2186 — tests never read the operator's real `~/.zshrc`).
- [ ] Wire into `runPrFinishCli`; add `e2e-credentials-missing` to `PR_FINISH_ABORT_REASONS` + the MC-7 table.
- [ ] Contract: stdout JSON stays the only stdout; preflight notes go to `warnings[]` on the ok path.

**Acceptance criteria:**
- A shell with neither key resolvable aborts in <1s with `reason: "e2e-credentials-missing"` and a copy-pasteable fix, instead of a 2-minute ambiguous-model failure.
- A shell with `ZAI_API_KEY` in `~/.zshrc` (the historical operator shape) passes the preflight (the rc-grep mirrors the bash gate).
- `--assume-ci-green <sha>` path never runs the preflight.

---

### MC-2 — Persist full failing-gate logs to `output/ci-logs/`

**Size:** M · **Risk:** medium — touches the hot `runLocalCi` path; must not regress the JSON payload contract or the parallel-phase scheduling.

**Scope:**
- Modify: `bun-apps/s2-agent-ext-devops/src/ci-recipe.ts`:
  - Capture FULL stdout/stderr per spawn in memory (bounded at 1 MiB per stream; over → keep head 128 KiB + tail 512 KiB with a `[…truncated…]` marker) alongside the existing `tailOf` 40-line `detail` (inline JSON shape UNCHANGED — that is a guard).
  - New injectable option `failureLogWriter?: (step: string, content: string) => Promise<string | undefined>` — called ONLY for failed steps (`exitCode !== 0`, non-skipped); returns the written path. Default: absent → no writes (recipe stays fs-free; unit tests unchanged in behavior).
  - `CiOutcome` gains `logFiles?: Array<{ step: string; path: string }>` + `logDir?: string`.
- Create: `bun-apps/s2-agent-ext-devops/src/ci-log-writer.ts` — the live writer: `createCiLogWriter(repoRoot, label)` → mkdir `<repoRoot>/output/ci-logs/<label>-<yyyymmdd-hhmmss>/` (`output/` is gitignored — `.gitignore:60`), sanitize step names to `[a-z0-9.-]`, write `<step>.log` (stdout+stderr with stream headers, mirroring `failureDetail`'s two-block shape).
- Modify: `merge-pr-after-ci-cli.ts` — construct the writer with label `pr-<n>` and pass it into `runCi`; on `local_ci_failed` abort, embed `ciLogDir` inside `aborted` (`aborted: { …, ciLogDir }`) AND append the dir to the message. Also log the dir to stderr via the existing `log` sink.
- Modify: `local-ci-cli.ts` — same wiring, label = `local-<headRef>`; print `logDir` in its outcome.
- Test: `tests/ci-recipe.test.ts` (fake writer assertions: full content received, only failed steps, path collected), `tests/ci-log-writer.test.ts` (new: sanitize, dir naming, writes under tmpdir), `tests/merge-pr-after-ci-cli.test.ts` (abort JSON carries `ciLogDir`).

**Steps:**
- [ ] Failing test: a failing package test step with >40-line stderr → writer receives the FULL stream, `detail` stays the 40-line tail, `logFiles` records the path.
- [ ] Implement capture + writer seam in `ci-recipe.ts` (attach writer call sites at every `detailOf(r)` production site: typecheck/lint/test phases, gate pool, exclusive gates, deploy-e2e gate).
- [ ] Implement `ci-log-writer.ts`; wire both CLIs; extend the MC-7 abort fixture to assert `ciLogDir`.
- [ ] Manual verify once: force a red gate via a scratch branch, confirm the log file on disk and the path in the abort JSON.

**Acceptance criteria:**
- A red `local_ci_failed` abort JSON contains a readable absolute `ciLogDir`; the operator re-runs NOTHING to see the full failure (the 2026-09-07 double manual re-run becomes unnecessary).
- Green runs write no files; the inline JSON payload for passing rows is byte-identical to today.
- Writing failures are advisory (warning note), never flip `overall`.

---

### MC-3 — `prepare-feature-branch --via-temp-branch` (cross-worktree rebase)

**Size:** L · **Risk:** high — new mutating flow (temp worktree, force-push). Guards are the ticket.

**Scope:**
- Modify: `bun-apps/s2-agent-ext-devops/src/prepare-feature-branch-cli.ts` — new flag `--via-temp-branch` (requires `--branch <name>` AND `--pr <n>`; usage error otherwise). New flag `--pr <n>` feeds the guards.
- Modify: `bun-apps/s2-agent-ext-devops/src/prepare-recipe.ts` — new orchestration `runViaTempBranch(opts)` (separate function; `runPrepare` untouched):
  1. **Guards (abort before any mutation):**
     - `pr-not-open` — `gh.prStatus(pr).state === "OPEN"`.
     - `head-mismatch` — `rev-parse <remote>/<branch>` === PR `headRefOid` (the temp copy rebases exactly what the PR shows).
     - Calling worktree clean (reuse the dirty-tree discipline; preserve-listed hot files tolerated the same way).
     - `local-divergence` WARNING (not abort) when the LOCAL branch ref ≠ remote head (local-only commits exist — they will NOT be in the temp copy; message says so explicitly).
     - Default-path triple guard stays intact: when the branch is NOT held elsewhere, `--via-temp-branch` refuses with a hint to use the normal path (this mode is only for the held case).
  2. **Flow:** `mkdtemp` → `git worktree add --detach <tmp> <headSha>` → inside `<tmp>`: `git rebase <base>` (detached-HEAD rebase — no branch is checked out anywhere, the holder worktree is never touched) → on conflict: `git rebase --abort` inside tmp, KEEP the temp worktree, abort `temp-rebase-conflict` with its path + the manual-resolution recipe (the 2026-09-07 vgpu-labs-demo workaround, now first-class) → on success: read the rebased sha, `git push --force-with-lease <remote> <rebasedSha>:refs/heads/<branch>` → `git worktree remove <tmp>` (best-effort; failure = warning).
  3. **Outcome:** `viaTempBranch?: { tempWorktree: string; rebasedTo: string; removed: boolean }`; warnings tell the holder worktree to `git fetch` + hard-reset or re-checkout (its checkout now diverges from its upstream).
  - Extend `PREPARE_ABORT_REASONS`: `pr-not-open`, `head-mismatch`, `temp-worktree-add-failed`, `temp-rebase-conflict`, `temp-push-failed`.
- Test: `tests/prepare-recipe.test.ts` (new describe; fake client + fake spawn recording `worktree add/remove`, rebase, push) + `tests/prepare-feature-branch-cli.test.ts` if it exists (argv: flag combos → usage errors).

**Steps:**
- [ ] Failing tests: guard matrix (closed PR, stale remote head, dirty caller, non-held branch, local divergence warning), happy path (worktree added at headSha, rebase, push `sha:refs/heads/branch`, worktree removed), conflict path (temp kept, path reported), push-failure path.
- [ ] Implement `runViaTempBranch` + reason exports.
- [ ] CLI wiring + usage text; `--dry-run` support (record commands, spawn nothing — same discipline as `runPrepare`).
- [ ] Extend the MC-7-style membership guard to the new `PREPARE_ABORT_REASONS` entries.

**Acceptance criteria:**
- The exact 2026-09-07 scenario (branch held in a worktree with ACTIVE dirty work) rebases + force-pushes without mutating the holder worktree, verified by a test asserting zero spawns with cwd inside the holder path.
- Every abort is structured + exit 1; conflicts leave a resolvable temp worktree with instructions.
- Default `prepare` path behavior byte-identical (existing `prepare-recipe.test.ts` untouched and green).

---

### MC-4 — Docs-only fast path (`.agents/` joins the matrix-irrelevant prefixes)

**Size:** S · **Risk:** low-medium (scope-narrowing — mitigate with a coverage note + the fail-open guard for everything else)

**Scope:**
- Modify: `bun-apps/s2-agent-ext-devops/src/changed-packages.ts:124` — `MATRIX_IRRELEVANT_PREFIXES = [".planning/", "bun-apps/tests/", ".agents/"]`, with the coverage note extended: `.agents/` holds read-in-session docs (skills SKILL.md, hermes `memory/`) — nothing compiled; its structural guards (skill frontmatter, cross-skill reference) run in `regression-gates` regardless of package scoping. NOT added: root `docs/` (does not exist today — do not pre-list a nonexistent tree), package-internal `*.md` (still maps to its package — conservative).
- Test: `tests/changed-packages.test.ts` — a diff of only `.agents/memory/MEMORY.md` → all-false map (zero packages, gates still run); mixed `.agents/` + one package file → exactly that package + dependents; `.agents/` + one root `scripts/` file → still fail-open all-true (the guard that a malicious/unlisted path cannot sneak through).

**Steps:**
- [ ] Failing tests for the three diff shapes above.
- [ ] One-line list edit + comment.
- [ ] Note in the comment: a future compiled artifact under `.agents/` must be re-reviewed (the prefix list is the review surface).

**Acceptance criteria:**
- PR #2185's shape (one-file `.agents/memory/MEMORY.md` chore) computes an empty package set → `runLocalCi` skips the per-package loop, structural gates still run (the `.planning/`-only PRs already prove this path works — same mechanism, `changed-packages.ts:109-124`).
- Any path outside the three prefixes + `bun-apps/<pkg>/` still fails open to the full matrix.

---

### MC-5 — Post-merge kept-branch visibility (structured, not buried)

**Size:** S · **Risk:** low

**Scope:**
- Modify: `bun-apps/s2-agent-ext-devops/src/merge-pr-after-ci-cli.ts` — `PrFinishOutcome` gains `cleanup?: { localKept?: { branch: string; worktree: string } }`, populated from `runLocalBranchCleanup`'s existing `heldElsewhere` result field (`branch-cleanup.ts:43`); the existing note string stays byte-identical (tests pin it — `branch-cleanup.ts:112-114`).
- Modify: `bun-apps/s2-agent-ext-devops/src/branch-recipe.ts` (`buildSweepPlan`) + `src/branch-logic.ts` inputs — thread the holder path into the `worktree-locked` reason: `"worktree-locked (held at /path/to/wt)"`. `buildSweepPlan` currently uses `client.worktrees()` (branch names); switch to `client.worktreeList()` (already on `BranchClient`, `branch-recipe.ts:81`) so the path is available without new client surface.
- Test: `tests/branch-recipe.test.ts`, `tests/merge-pr-after-ci-cli.test.ts`.

**Steps:**
- [ ] Failing test: merge with the head branch held elsewhere → outcome JSON carries `cleanup.localKept` and the sweep plan's keep-bucket reason names the path.
- [ ] Implement both surfaces; keep all existing note/reason strings for the non-held paths unchanged.

**Acceptance criteria:**
- An operator reading the merge receipt sees the kept local branch + which worktree holds it without re-running anything; `sweep-merged-branches` dry-run says where each `worktree-locked` branch lives.

---

### MC-6 — Worktree report / prune CLI

**Size:** S · **Risk:** low (report-only default; `--prune` is one `git worktree prune`)

**Scope:**
- Create: `bun-apps/s2-agent-ext-devops/src/worktree-doctor-cli.ts` — parses `git worktree list --porcelain` (fields: `worktree`, `HEAD`, `branch`/`detached`, `prunable` + reason text) into `{ path, head, branch?, detached?, prunable?, prunableReason? }[]`; prints JSON on stdout (same contract as sibling CLIs: exit 0 report / 1 abort / 2 usage). `--prune` → run `git worktree prune` then re-list; report what disappeared. Pure parser exported for tests.
- Test: `tests/worktree-doctor-cli.test.ts` — porcelain fixtures (normal, detached, bare, prunable-with-reason, prunable-without-reason), prune flow with fake spawn, usage errors.

**Steps:**
- [ ] Failing parser tests → implement parser → CLI argv + JSON wiring → prune path.
- [ ] Manual sanity: run against this repo (currently shows ≥2 prunable `/private/tmp/dp-*` entries — measured 2026-09-07).

**Acceptance criteria:**
- `bun src/worktree-doctor-cli.ts` lists every worktree with prunable flags + reasons; `--prune` clears them and reports the delta; no other CLI changes.

---

## Sequencing (PR grouping + dependency order)

| PR | Tickets | Why this order |
|----|---------|----------------|
| 1 | **MC-7 + MC-4** | MC-7 pins the exit-code contract FIRST so MC-1/MC-2 can add abort reasons without unpinned drift; MC-4 is an independent one-liner riding along (different files, zero overlap). Both S — one cheap PR that immediately removes the ~8-min docs-only tax. |
| 2 | **MC-1** | Highest operator pain per minute wasted (~2 min per blocked merge, recurring). Depends on MC-7's table (adds `e2e-credentials-missing`). |
| 3 | **MC-2** | Second pain (manual re-runs to diagnose). Depends on MC-7 (abort payload extension); independent of MC-1. |
| 4 | **MC-5 + MC-6** | Both S, both visibility-only, no interaction with 1–3. Batched to keep PR count down. |
| 5 | **MC-3** | The L ticket, deliberately last: new mutating flow, needs the calmest base; entirely independent of 1–4, so it can also slip without blocking anything. |

Dependency edges: `MC-7 → MC-1, MC-2` (reason-table membership guard would fail otherwise). Everything else parallelizable. Each PR: `prepare-feature-branch-cli` → implement → package gates green → `merge-pr-after-ci` (which, from PR 2 onward, benefits from the previous PR's own improvements — dogfooding in order).

---

## Guards — what must NOT change

1. **Abort exit codes:** every abort → 1; usage → 2; success/dry-run/help → 0. No new exit codes. (MC-7 exists to enforce this.)
2. **Preserve-list semantics:** `DEFAULT_PRESERVE_PATHS` parking stays bracketed around the ONE tree mutation; all other uncommitted tracked dirt still aborts `dirty_tree` (fail-closed). No ticket touches `src/preserve.ts`.
3. **Triple worktree safety:** the default `prepare` path's detached-head + worktree-conflict guards abort with ZERO spawns. `--via-temp-branch` is an explicit opt-in that never mutates ANY pre-existing worktree (holder included); the default path is untouched.
4. **Inline JSON payload shape:** `detail` stays the ≤40-line/4 000-char tail; full logs live only on disk (`MC-2`). Passing rows stay key-absent (`detailOf` spread discipline).
5. **Fail-open change detection:** every path outside `MATRIX_IRRELEVANT_PREFIXES` ∪ `bun-apps/<pkg>/` ∪ aliases still escalates to the full matrix. `.agents/` is the ONLY new prefix.
6. **Structural gates are never skipped:** docs-only fast path affects the package matrix only; the `regression-gates` suite (derived from the workflow) runs unconditionally.
7. **Hermetic tests:** no test reads operator `~/.pi/**`, `~/.zshrc`, or ambient env — every consumer gets an injected seam (#2186 discipline).
8. **Gate-source-of-truth:** the gate list stays derived from `.github/workflows/ci.yml.disabled` via `readCiGates`; no hand-added gates beyond the documented oneshot-smoke/deploy-e2e exceptions.

---

## Open questions for the operator

1. **MC-1 severity:** hard-abort on missing credentials (recommended — the alternative burns ~2 min per occurrence) vs. warning-only? And do you want a `--skip-e2e-preflight` escape hatch, or is `--assume-ci-green <sha>` sufficient as the bypass?
2. **MC-1 rc-grep scope:** port the rc-file grep (matches `check-deploy-e2e.sh`'s existing behavior for `ZAI_API_KEY`) for BOTH keys, or ambient-env-only with the abort message telling you to source it? (Recommended: port it — the bash gate already established the precedent; the #2186 hermetic rule governs tests, not the live CLI.)
3. **MC-2 retention:** keep every `output/ci-logs/<label>-<ts>/` forever (gitignored, zero repo cost) or prune to last N=10 per label? (Recommended: forever + a one-line README in the dir.)
4. **MC-3 conflict residue:** on `temp-rebase-conflict`, keep the temp worktree for manual resolution (recommended — it preserves the resolved halfway state) or always clean up and re-create on retry?
5. **MC-6 wiring:** should `merge-pr-after-ci`'s post-merge `fetchPrune()` also report prunable worktrees (advisory note), or stay fully separate? (`git fetch --prune` does NOT prune worktree registrations — they are different registries.)
6. **Artifact home:** this plan lives flat at `.planning/plans/` per your instruction; per repo convention a 7-ticket arc would normally be an effort folder (`.planning/2026-09-07-devops-merge-chain-ux/` with `map.md` + `tickets/`). Promote it, or execute straight from this file with executing-plans/SDD?

---

## Self-review checklist (run at plan level)

- **Coverage:** each of the 7 context items maps to exactly one ticket (1→MC-1, 2→MC-2, 3→MC-3, 4→MC-4, 5→MC-5, 6→MC-6, 7→MC-7). ✔
- **No placeholders:** every ticket names files, functions, abort reasons, and test assertions. ✔
- **Type consistency:** `PR_FINISH_ABORT_REASONS` (new, MC-7) vs `PREPARE_ABORT_REASONS` (existing, extended in MC-3); `failureLogWriter`/`logFiles`/`logDir` named identically in recipe + CLIs; `heldElsewhere` (existing `branch-cleanup.ts:43`) is the source for `cleanup.localKept`. ✔
