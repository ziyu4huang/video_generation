# t03 — Reviewer-dispatch twin: `arc-review.ts` (the quality gate goes symmetric)

## Goal

The reviewer dispatched at review time runs the SAME big model as the
planner. Today the asymmetry is: planner = zai/glm-5.3 double-pinned via
arc-plan.ts; reviewer = harness builtin flash. `arc-review.ts` mirrors
arc-plan.ts so a review dispatch is a one-command, receipted, GLM 5.3 pass.

## Files

- `bun-apps/s2-agent-ext-subagent/scripts/arc-review.ts` (new) — mirrors
  `scripts/arc-plan.ts` (read it first; keep structure parallel).
- `bun-apps/s2-agent-ext-devops/tests/scripts-dir-contract.test.ts` — +1
  allowlist line (`bun-apps/s2-agent-ext-subagent/scripts/arc-review.ts`).

## Behavior (mirror of arc-plan.ts)

```
bun bun-apps/s2-agent-ext-subagent/scripts/arc-review.ts --prompt-file <file> [--out <dir>] [--cwd <dir>]
```

- `--prompt-file` REQUIRED; `--out` default `output/arc-review`; `--cwd`
  default process.cwd().
- `loadAgentRegistry(cwd)` → instructions prefix. STEP 1: inspect the
  registry's defs for a reviewer-typed def; if one exists with an acceptable
  model pin, use it and record `agentType: <that>` in the receipt; otherwise
  `hard-problem` (arc-plan's def) carries a review-framed task — record the
  choice + reason in the receipt (`agentTypeResolved` field).
- `spawnSubagent` with `model: "zai/glm-5.3"` DOUBLE-pinned — copy arc-plan's
  comment verbatim in spirit: the explicit spec wins outright; "glm-5.3" is a
  substring of "glm-5.3-flash" and must never match loosely.
- `maxTurns: 40` (a reviewer reading a diff burns turns the same way).
- Writes `review.md` (child's answer verbatim) + `review-receipt.json`:
  `startedAt/finishedAt/elapsedMs/cwd/agentTypeResolved/requestedModel:
  "zai/glm-5.3"/failure/usage/turns`. Exit 1 on failure, printing the failure
  kind + first 800 chars, exactly like arc-plan.
- If `spawnSubagent`'s spec supports a `name` field, pass `name:
  "arc-reviewer"` so reviewer-harvest can match it (verify at step 1; record
  supported-or-not in the receipt either way).

## Verification (verify, do NOT re-implement)

reviewer-harvest.ts (PR #2170) already harvests s2-agent-dispatched reviewers
via the pi-harness run-archive fallback (`~/.pi/subagents/runs`). After the
dogfood dispatch (below), run:

```
bun bun-apps/s2-agent-ext-devops/scripts/reviewer-harvest.ts --name arc-reviewer --timeout 0
```

Expect: verdict found via the fallback. If the fallback misses, FILE the gap
as a follow-up ticket with the miss evidence — harvesting fixes are NOT in
this arc's scope.

## Steps

1. Read arc-plan.ts + the spawnSubagent spec (name field, result shape) +
   the agent registry defs; record findings in the ticket resolution.
2. Implement; allowlist line; subagent package gates green
   (`bun run --cwd bun-apps/s2-agent-ext-subagent check && typecheck && test`
   — resolve real script names from its package.json).
3. Dogfood: THIS arc's own review gate (t06, pre-merge) dispatches through
   arc-review.ts on the branch — review prompt = this PR's diff + map.
   Receipt the dispatch + the harvest check into `evidence/t03-*` (committed
   by t04).

## Acceptance

- arc-review.ts runs end-to-end (the dogfood run IS the smoke test); receipt
  shows `requestedModel: "zai/glm-5.3"` + real usage/turns/elapsed.
- Allowlist updated; both packages' gates green.
- Harvest-fallback verification receipt exists (found, or gap filed).

## Out of scope

- Rewriting reviewer-harvest or the harness builtin reviewer.
- Wiring arc-review into any skill/SOP text beyond the close-out usage
  (SOP updates ride the successor's documentation pass if needed).
