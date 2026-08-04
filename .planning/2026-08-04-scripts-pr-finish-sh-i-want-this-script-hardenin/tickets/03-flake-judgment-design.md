type: grilling
status: closed
claimed: 2026-08-04 grill-session
resolved: 2026-08-04
blocked by: —

## Question

How is the **rerun-vs-abort** judgment encoded in the skill — so it is genuinely
"intelligent" (the thing a fixed script cannot do) but not just unaccountable vibes?
This is the spine of the effort: #05 (data source) and #06 (proof bar) both depend on
it.

Live evidence motivating it: PR #1023 (docs-only) had `test · pi-agent-ext-movie-director`
fail at 10m16s. A fixed gate (`pr-finish.sh`, `await_pr_merge`) sees "1 non-passing →
abort". An agent sees "the failing package is untouched by this diff + a 10-min timeout
= flake → rerun once." That gap *is* the prize.

Candidate shapes to grill (recommendation first):

- **(c) ⭐ Rubric spine + human-escalation escape hatch** — a concrete, testable rubric
  for the common flake signals (failing check's package **untouched by the PR diff**
  AND (duration > N min OR known-flaky-suite) AND conclusion ≠ a real assertion error →
  rerun **once**; a second failure, or a real assertion failure, or a failing package
  the diff *does* touch → **abort / surface to human**). The escalation branch is where
  discretion lives. Captures the intelligence repeatably + stays safe.
- **(a) Pure rubric, no escape** — same rubric, deterministic end-to-end. Most
  testable; least "agentic" when a genuinely ambiguous case arrives.
- **(b) Pure agent discretion** — list the signals, let the agent reason fresh each
  time. Maximally agentic, but non-reproducible and hard to prove.

Grill to a decision: which shape, and the exact rubric predicates (esp. "untouched by
diff" — how computed: changed-files set vs failing-check's package path?).

## Resolution

**Flake-judgment = rubric spine + human-escalation escape hatch.** Resolved across three grills (shape → trigger → escape-hatch UX).

**1. Shape** — rubric + escape hatch (not pure rubric, not pure discretion). Grounded in the fact that a check name *encodes its package* (`test · <pkg>` / `determinism · <pkg>` → `bun-apps/<pkg>/`), so the central predicate is cheaply computable, not vibes.

**2. Rerun trigger (the rubric):**
- Map each failing check → package via its `name`.
- Compute the PR's changed-files (`gh pr diff --name-only`).
- **Untouched** (no changed file under `bun-apps/<pkg>/`) → **rerun that job once** (`gh run rerun <run-id> --failed`), then re-await via `await_pr_merge`.
- **Touched**, OR a **monorepo-level check** (`changed packages`, `regression gates`, `check-deploy-paths`, `clean-launch self-heal`, …), OR an **unmappable** name → **do NOT auto-rerun**; abort + surface.
- **Shared-code guard**: if the PR touches shared infra (`bun-apps/tests/`, root configs, `bun-apps/pi-agent/run-dir/manifest.json`, …) treat it as *touches all packages* → package-scoped failures are NOT auto-rerun (could be a real cross-package break). Exact shared-dir set pinned when writing the skill.
- After one rerun, **still failing → abort + surface** (never loop).
- The check's `state` (FAILURE vs TIMED_OUT/CANCELLED/STARTUP_FAILURE) and duration (`startedAt`→`completedAt`) are REPORTED cues in the escape-hatch block, not rerun gates (R2 trigger).

**3. Escape-hatch UX** — on escalation, surface ONE compact block: failing check name + `state` + duration; the diff-relevance verdict ("untouched by this PR" vs "IS touched — likely real"); a one-line recommendation; the ready-to-run commands (`gh run rerun <id> --failed`, `gh pr checks <n>`). Then **STOP** — no looping, no confirm-prompt.

**Execution vehicle (couples to #05):** the rubric lives in the skill prose; the agent does the mapping + diff-intersection + `gh run rerun` via bash + re-await via `await_pr_merge`. `gh pr checks --json` exposes `name`/`state`/`startedAt`/`completedAt`/`workflow` — everything the rubric needs — so #05 confirms no new tooling is required.

Unblocks #05 (data source) and #06 (proof bar). Graduates the map's "abort/error UX" fog into this resolution.
