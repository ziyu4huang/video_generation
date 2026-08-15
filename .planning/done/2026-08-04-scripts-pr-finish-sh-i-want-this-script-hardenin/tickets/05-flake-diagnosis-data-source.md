type: research
status: closed
claimed: chart+work session (2026-08-04)
resolved: 2026-08-04
blocked by: 03-flake-judgment-design (closed)

## Question

Can the agent ground the flake-judgment rubric (decided in #03) in **raw `gh pr checks`
output** (per-check name / duration / conclusion, via plain bash), or must `pr_status`
be **enriched** to expose per-check detail? This decides whether "new tooling" is
necessary — the lean escape clause.

Context: `pr_status` currently returns a **tally** (`pass`/`fail`/`pending`) — see
`extensions/devops.ts` `pr_status` render + `src/gh.ts` `parseChecks`. But the rubric in
#03 needs per-check **name** (to map to a package), **duration** (10m16s timeout vs a
sub-second assertion failure), and **conclusion** (timeout/cancelled vs a real failure
log). Raw `gh pr checks` (bash) already exposes all three.

Hypothesis (to confirm once #03 lands the rubric predicates): raw `gh pr checks` is
sufficient → **no new tooling** → stays lean. Enriching `pr_status` is only warranted if
the rubric needs *structured* per-check data the agent can't reliably parse from text, or
if we want the diagnosis itself testable through a typed tool surface.

## Resolution

**Raw `gh pr checks` is sufficient; no `pr_status` enrichment, no new tooling. Stays lean.**

Verified live against the flake PR #1023 (`gh pr checks 1023 --json …`): the available
JSON fields are exactly `name`, `state`, `startedAt`, `completedAt`, `workflow`, `bucket`,
`link`, `event`, `description`. That covers every predicate in #03's rubric:

- `name` → package mapping (`test · pi-agent-ext-movie-director`, `determinism · <pkg>`).
- `state` → the **conclusion-equivalent** (`FAILURE` / `TIMED_OUT` / `CANCELLED` /
  `STARTUP_FAILURE` / `SUCCESS` …) — the same granularity `pr-finish.sh`'s `ci_running()`
  switches on. **There is no separate `conclusion` field; `state` carries it.** (#03's
  rubric wording updated from "conclusion" to `state`.)
- `startedAt` + `completedAt` → duration (the 10m16s timeout cue).
- `gh pr diff --name-only` → the changed-files set for the untouched-by-diff predicate.

`pr_status` (tally-only) is NOT used for diagnosis — the skill reads raw `gh pr checks`;
`await_pr_merge` / `pr_status` still handle the merge + one-shot snapshot.

**Decision: no new devops tooling for v1.** Revisit only if a future rubric needs
structured per-check data through a typed tool — #03's rubric does not. Closes the lean
scope cleanly.
