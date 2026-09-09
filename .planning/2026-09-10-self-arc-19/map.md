---
effort: 2026-09-10-self-arc-19
created: 2026-09-10
last: 2026-09-10
status: done
---

# Wayfinder map: 2026-09-10-self-arc-19 — LOOP-INTEGRITY: the loop's own metadata moves from discipline to tooling

## Destination

The self-develop loop's metadata integrity is enforced by machines, not discipline: arc numbers are claimed by atomic append into a committed ledger (`.planning/arc-ledger.json`) whose CI guard goes red on any duplicate claim — in-tree, proven red on a synthetic duplicate-claim fixture, and cross-checked against `origin/main` for the parallel-session class; repointing the goal-queue pointer is ONE command (`repoint-next-goal.ts`) that validates the target, deletes byte-duplicate stale goal files, and verifies frontmatter dates against filenames; the arc REVIEWER rides the same double-pinned zai/glm-5.3 as the planner via `arc-review.ts`, making the quality gate symmetric; load-bearing receipts referenced by committed maps live committed under `.planning/<effort>/evidence/` with size caps (arc-17's audit JSON is the migrated specimen); the 19-package check-script question is closed as a recorded adopt-or-reject per class (not a fix spree); and the arc dogfoods every tool at its own close-out — its review gate dispatches through `arc-review.ts`, its successor is repointed via the new pointer tooling. One implementation PR through the devops chain; schema-cost +0 (no tool descriptions, no registry code touched).

## Context (measured 2026-09-10, this session, this machine)

- **Charter is pre-approved** (do not re-litigate): queue head
  `output/next-goal-20260910-040000.md` (read this session) + exploration report
  `output/explore-selfarc-deep/plan.md` (read this session; copied to
  `evidence/` by t04 — committed copy is canonical). 2026-09-10 produced THREE
  instances of one structural class: dual arc-18 claims (4th collision in the
  series), a rebase relocation that git-rm'd an already-merged map from main
  (restored byte-identical via #2243; caught only by verify-merge full-scope),
  and a stale byte-duplicate goal file surviving in the queue with LATEST
  pointing at the wrong filename.
- **The collision residue is REAL and SHIPPED**: `ls .planning/` this session
  shows 19 `2026-*self-arc-*/` dirs covering numbers 3–18, of which SIX share
  numbers pairwise — self-arc-13 (`2026-09-06` + `2026-09-08`),
  self-arc-14 (`2026-09-06` + `2026-09-08`), self-arc-15 (`2026-09-06` +
  `2026-09-09`) — and ALL six say `status: done` in frontmatter (sed, this
  session). They are grandfathered shipped efforts, not deletable residue: the
  ledger must encode them with annotations, not erase them.
- **The planner twin to mirror** (read this session,
  `bun-apps/s2-agent-ext-subagent/scripts/arc-plan.ts`): `loadAgentRegistry(cwd).get("hard-problem")`
  → `spawnSubagent` with `model: "zai/glm-5.3"` DOUBLE-pinned (explicit spec wins
  outright so "glm-5.3" never loosely matches "glm-5.3-flash"), `maxTurns: 40`,
  writes `plan.md` + `plan-receipt.json` (`requestedModel`, `usage`, `turns`,
  `elapsedMs`, `failure`), exit 1 on failure.
- **Allowlist is a one-line contract** (read this session,
  `bun-apps/s2-agent-ext-devops/tests/scripts-dir-contract.test.ts`
  `ALLOWED_RUNNABLE_ENTRIES`): `arc-plan.ts` is listed; `arc-review.ts` and
  `repoint-next-goal.ts` each need exactly one added line.
- **Validator surface today** (grep of `src/validate-next-goal.ts`, this
  session): exports `validateNextGoalFile` / `doctorNextGoal` /
  `NEXT_GOAL_FILENAME_RE` / `MAX_RETENTION = 10`. There is NO byte-duplicate
  deletion and NO frontmatter-date-vs-filename check — both are net-new in t02.
- **Reviewer harvest already has the fallback** (sed of
  `bun-apps/s2-agent-ext-devops/scripts/reviewer-harvest.ts`, this session):
  `--name <n>` required; claude-glm harness root is PRIMARY, the pi-harness run
  archive (`~/.pi/subagents/runs`) is the FALLBACK (PR #2170) — and
  `spawnSubagent`-dispatched children land exactly there. t03 VERIFIES this
  path; it does not re-implement it.
- **t-permanence specimen**: `output/self-arc17-audit-result.json` = 46,432
  bytes (ls, this session), cited by exactly ONE committed map
  (`.planning/2026-09-09-self-arc-17/map.md`, grep) — small, text, and the
  strongest live case of a committed map citing gitignored scratch.
- **Loud-skip specimen**: hermes shipped `localDescribe` in
  `bun-apps/s2-agent-ext-hermes-memory/tests/store/surreal/_helpers.ts`
  (arc-18 t02); sv-analyzer's tests live in
  `bun-apps/s2-agent-ext-sv-analyzer/tests/sv-analyzer.test.ts` (ls, this session).
- **Guard-test family**: wayfind owns `.planning` semantics guards
  (`tests/map-frontmatter.test.ts`, `scripts/effort-audit.ts`); devops owns
  repo-hygiene contracts (`tests/artifact-leak.test.ts`,
  `tests/scripts-dir-contract.test.ts`). The ledger guard joins the wayfind
  family (D2).
- **gitignore facts** (read this session): `/output/` ignored (lines 60, 134)
  — output/ is NEVER committed; `.planning/<effort>/` artifacts stay committed
  (line 108 comment); a root-level `.planning/arc-ledger.json` is committable.

## Tickets

Execution order: **t01 ledger → t02 pointer → t03 reviewer twin → t04
permanence → t05 decision → t06 closeout.** Dependencies: t01's red-bar ritual
is a two-commit sequence on this branch (red BEFORE trusted green); t04 runs
before t05 because the decision doc reads the arc-17 audit JSON from its
committed evidence copy; t01–t05 ALL ride ONE implementation PR; t06 dogfoods
t03 (this arc's own review gate) and t02 (successor LATEST repoint) — the PR's
review pass runs `arc-review.ts` from the branch before merge.

Phase 1 — integrity core:
- [ ] `tickets/01-arc-ledger-guard.md` — committed `.planning/arc-ledger.json`
      + wayfind guard test; bootstrap-encodes all 19 historical dirs (six
      dup-number entries grandfathered with notes); duplicate claims fail CI;
      synthetic fixture proves RED before the rule is trusted green;
      origin/main cross-check for the parallel-session class.
- [ ] `tickets/02-queue-pointer-repoint.md` — `repoint-next-goal.ts`: one
      command = validate target + delete byte-duplicate stale goal files
      (newest-filename wins) + verify frontmatter dates vs filename + atomically
      repoint `output/LATEST-next-goal.md` + doctor. Validator stays pure;
      allowlist +1 line.

Phase 2 — symmetric gate:
- [ ] `tickets/03-arc-review-dispatch-twin.md` — `arc-review.ts` mirroring
      arc-plan.ts (spawnSubagent, zai/glm-5.3 double-pinned, plan-style receipt
      with model/usage/elapsed, exit 1 on failure); allowlist +1 line; VERIFY
      reviewer-harvest's pi-harness fallback harvests it (no re-implementation);
      dogfooded as this arc's own review gate.

Phase 3 — durable memory + remainder:
- [ ] `tickets/04-evidence-permanence.md` — define + adopt the
      `.planning/<effort>/evidence/` convention (caps: ≤256KB/file, ≤1MB/effort,
      text/JSON only); migrate the arc-17 audit JSON + update its map citation;
      land THIS arc's own evidence (planner prompt + receipts, exploration
      report copy, red-bar + dry-run receipts).
- [ ] `tickets/05-check-script-decision.md` — recorded adopt-or-reject per
      class for the 19 packages (input = the committed arc-17 JSON from t04),
      NOT a fix spree; sv-analyzer wasm skip loudness via the hermes
      localDescribe pattern (only if currently silent).

Phase 4 — closeout:
- [ ] `tickets/06-closeout-dogfood.md` — one PR via devops chain; review gate
      via arc-review.ts; verify-merge FULL-SCOPE (the #2243 lesson); map
      Shipped-as; successor strict v2 validated and LATEST repointed VIA
      `repoint-next-goal.ts`; memory update.

## Decisions

- **D1 (2026-09-10)**: Arc number 19 is the FIRST machine-checked claim — it
  is recorded in the bootstrap ledger with `branch: self-arc-19-loop-integrity`
  at branch time (branch already created; the claim rides this PR). The old
  "max folder is N, so N+1 is free" discipline check RETIRES; from now on the
  ledger is the claim, and the guard is the check.
- **D2 (2026-09-10)**: Ledger = `.planning/arc-ledger.json` (committed,
  root-level); guard = wayfind `tests/arc-ledger.test.ts` over logic in
  wayfind `src/arc-ledger.ts` (pure `validateLedger(root, opts)` so fixtures
  are testable). Reason: wayfind already owns `.planning` semantics guards
  (`map-frontmatter.test.ts`); devops keeps its own scripts-dir/artifact
  contracts. Historical duplicate numbers are `grandfathered: true` entries
  with notes — encoded, never erased.
- **D3 (2026-09-10)**: Red-bar proof is two-layer: (a) PERMANENT — the
  synthetic duplicate-claim fixture stays in
  `tests/fixtures/arc-ledger-duplicate/` and the test asserts the guard
  REJECTS it, so weakening the rule re-reddens CI forever; (b) RITUAL — on
  this branch, the fixture lands in a commit BEFORE the uniqueness rule, the
  red run is receipted into `evidence/`, then the rule lands and goes green.
  A guard that has never been seen red is a guard that has never been seen
  work.
- **D4 (2026-09-10)**: Pointer tooling is a NEW write-path runnable
  (`bun-apps/s2-agent-ext-devops/scripts/repoint-next-goal.ts`, logic in
  `src/repoint-next-goal.ts`), reusing `validateNextGoalFile` /
  `doctorNextGoal` as-is. Reason: `validate-next-goal.ts` is a pure validator
  (exit-code contract, JSON stdout); grafting writes onto it muddies both. New
  runnable ⇒ one allowlist line.
- **D5 (2026-09-10)**: `arc-review.ts` mirrors `arc-plan.ts` structurally —
  same spawn machinery, same double-pinned `zai/glm-5.3` (explicit spec wins;
  "glm-5.3" is a substring of "glm-5.3-flash" and must never match loosely),
  plan-style receipt (`requestedModel`, `usage`, `turns`, `elapsedMs`,
  `failure`), exit 1 on failure. The asymmetry being fixed: planner = GLM 5.3
  double-pinned, reviewer-at-review-time = harness builtin flash. Reviewer
  instructions resolve from the SAME registry; if no reviewer-typed def
  exists, `hard-problem`'s def carries a review-framed task (resolved at t03
  time, recorded in the receipt). Harvest fallback (PR #2170) is verified, not
  re-implemented.
- **D6 (2026-09-10)**: Evidence convention: `.planning/<effort>/evidence/` is
  the committed home for load-bearing receipts referenced by maps; caps
  ≤256KB/file, ≤1MB/effort, text/JSON only (no binaries); maps cite the
  committed copy, never `output/`. This arc adopts it for its own evidence AND
  migrates the one live violation (arc-17 audit JSON, 46KB — well under cap).
  Retro-migrating other scratch is explicitly out of scope.
- **D7 (2026-09-10)**: Check-script standardization is a RECORDED DECISION,
  not a sweep: the 19 packages get adopt-or-reject per class with rationale
  (input = committed arc-17 audit JSON); adopted classes become queued
  maintenance arcs, not this arc's code. sv-analyzer's wasm skip loudness is
  the ONE small code change allowed here, and only if it is currently silent.
- **D8 (2026-09-10)**: Carried constraints: children/planner/reviewer LLM =
  zai/glm-5.3, never flash; ONE implementation PR through the devops chain
  (map + tickets + evidence ride it); `output/` is never committed (evidence/
  is the committed tier); schema-cost +0 — no tool descriptions, no registry
  code, no extension entries touched; new src files are test-imported only,
  so deployed bundles are expected UNCHANGED (assert via the chain's
  iff-src-changed rule at t06).

## Frontier

`t01` — the ledger guard. Nothing downstream is verifiable without it: t06's
close-out is the first consumer of the claim procedure it defines, the
red-bar ritual sets the evidence pattern t04 commits, and it is the smallest
complete unit of the charter ("arc numbers stop colliding" is the failure that
recurred four times). It is also fully self-contained: one JSON file, one src
module, one test, one fixture, zero behavior risk to any shipped package.

## Fog of war

- **spawnSubagent `name` field**: arc-plan.ts passes none; reviewer-harvest
  needs `--name` to find the child. Whether the spec supports `name` (or what
  the pi-runs record keys on) is unverified — t03 step 1; if unsupported, the
  fallback verification falls back to matching by transcript content/recency,
  and the gap is filed as a follow-up ticket, not fixed here.
- **origin/main reachability inside a bun test**: `git show
  origin/main:.planning/arc-ledger.json` may differ across worktrees/CI. The
  cross-check skips LOUDLY (stderr note) when unavailable — never silently.
  Note: the cross-check only has teeth once the ledger EXISTS on main (i.e.,
  after this PR merges); before that, in-tree uniqueness + the fixture carry
  the guard.
- **LATEST pointer form**: whether `output/LATEST-next-goal.md` is a symlink
  or a content file is unverified — t02 step 0 reads it and preserves the
  existing form (learning #2: verify the artifact, then trust the label).
- **Newest-wins edge**: when the pointer target IS a byte-duplicate of a newer
  filename (the exact 2026-09-10 live case), t02 re-targets to the newest and
  reports — but interaction with `supersedes:` chains when the deleted dup is
  itself superseded-by is unmeasured until the dry-run receipt exists.
- **Reviewer agentType**: whether the registry has a reviewer-typed def with
  the right model pin is unverified (D5 fallback covers it).
- **The 19-package class taxonomy** is unknown until enumerated from the
  committed arc-17 JSON at t05 time; the decision doc's classes must fit what
  is actually there, not a pre-invented taxonomy.
- **map-frontmatter.test.ts adjacency**: it may already assert things the
  ledger entries also assert (e.g., effort/folder match) — t01 reads it first
  and extends rather than duplicating.

## Cross-effort links

- Builds-on: `2026-09-09-self-arc-18` (maintenance-mode series lineage; its
  t02 `localDescribe` specimen is t05's sv-analyzer pattern) and
  `2026-09-09-planning-audit` (planning-audit adjacency: the ledger guard is
  the machine check that effort's findings implied).
- Shares-decision-with: `2026-09-09-self-arc-17` D5 (one implementation PR,
  schema-cost +0, redeploy only iff src/ changed — mirrored as D8 here via
  arc-18's D6 mirror of the same rule).
- Absorbs (no folder exists to link): the dead test-hygiene premise's
  remainder (19-package check-script question + skip loudness) → t05, per the
  queue head's premise revision.
- Absorbed-by: none.

## Shipped-as (2026-09-10, #2250 + close-out)

All six tickets shipped in ONE implementation PR (#2250, squash 9feaa180,
verify-merge CLEAN, branch spent; review gate ran through the arc's own
t03 tooling — GLM-5.3 reviewer, VERDICT: APPROVE, zero blockers/should-fix,
three recorded nits). Deviations and live catches, faithfully:

- **t02's first dry-run caught two false receipts in the handoff that
  chartered this arc**: the queue head shipped missing two mandatory
  strict-v2 sections despite a "validated, exit=0" claim, and the "removed"
  byte-duplicate was still in the queue. Queue repaired in place; receipts in
  `evidence/t02-dry-run.json`. (Learning #2 twice, against our own output.)
- **t03's harvest seam is receipted, not fixed**: reviewer-harvest --name
  arc-reviewer returns absent (exit 1) for a core-spawnSubagent dispatch —
  the receipt IS the harvest; support filed as successor work
  (`evidence/t03-harvest-check.txt`).
- **The ledger met its first live incident the day it shipped**: parallel
  branches (#2248-era) landed `2026-09-09-self-arc-19-subagent` and
  `2026-09-09-self-arc-20-dev-pipeline` on main before the ledger did, and
  the docs-only PR window (#2251) skips package gates, so completeness went
  red only here. Fixed in close-out: both encoded as grandfathered entries —
  and the fifth same-number collision (dual arc-19) is recorded, not erased.
- **Redeploy receipt**: 0.10.3+g9feaa18 — runtime bytes identical (cached);
  the ext standalone shim DID change (6,062,167 → 6,061,511 bytes,
  dead-code elimination around the new test-only modules), so the full
  deployed qualify sweep ran per the iff-src-changed rule: 10/10 green with
  rpc-pair (`evidence/t06-sweep-summary.md`).
- Schema-cost +0 asserted by local_ci's tools-metrics check in the merge run.

Successor: strict-v2 handoff written and repointed VIA the arc's own
repoint-next-goal.ts (the tool's first real write on its author's close-out).
