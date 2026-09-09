# t02 — steer verb on list_subagent_runs (run-id mid-run steering)

Status: open
Files: `bun-apps/s2-agent-ext-subagent/src/subagent-runs-tool.ts` (schema + execute +
description), the live-run lookup seam it needs (verify: `src/background-run-manager.ts`,
live registry used by spawnLive), tests in `bun-apps/s2-agent-ext-subagent/tests/`.
Schema-cost: delta MUST be generated and cited in the PR body:
`bun bun-apps/s2-agent/src/cli.ts tools-metrics --schema-cost --json` (map D8).

## Goal

Expose the existing mid-run steer capability to the model by RUN ID: the pi
`sendMessage` opts already admit `deliverAs?: "followUp" | "nextTurn" | "steer"`
(`src/background-run-manager.ts:194`, `src/parent-message-bus.ts:93`), but both wirers
hardcode `followUp`+`triggerTurn`, and `send_message` only steers NAMED team agents
(`src/send-message-tool.ts:312-313`, `result.steered`). Nothing lets the model steer
the background run whose id `list_subagent_runs` itself hands out.

## Verified facts (planner, 2026-09-09)

- `list_subagent_runs` (`src/subagent-runs-tool.ts:241-258`) already owns
  list/get/wait/stop over `{persistence, liveRegistry}` options — steer is the
  consistent fifth verb (smallest schema delta, same shape).
- The wake seam is proven in production (PR #1800 lineage per bgm:8 comments):
  followUp queues while streaming, fresh turn when idle.

## Work items

1. **Locate the injection seam** (Fog-of-war item): how a LIVE run's child session (or
   its manager handle) is reachable from the tool's `liveRegistry` — t01's receipt
   truth-chain is not needed here, but the seam choice is: prefer delivering the
   operator text through the same `CustomMessage` + deliverAs path the wirers use,
   `deliverAs: "steer"` when the host supports it, falling back to
   `"followUp" + triggerTurn` (identical degradation semantics as both wirers).
2. **Schema**: extend the action union with `steer` requiring `id: string` +
   `message: string` (non-empty, length-capped consistent with send_message's cap —
   reuse its constant if exported).
3. **Execute**: resolve the run in the LIVE registry first (steering a terminal/unknown
   run returns an actionable error naming `list` for rediscovery — mirror `wait`'s
   non-error timeout posture for terminal-but-known runs).
4. **Description + promptSnippet**: one clause each — steer is for background runs BY
   ID; named teammates go through `send_message`. State the fallback behavior.
5. **Tests (fake background run, no LLM)**: steer a fake live run → deliverer called
   with the message and the chosen deliverAs; steer unknown id → error; steer
   terminal run → non-error informational result; follow the `fakeSpawn`/registry
   fakes precedent in `tests/subagent-tool.test.ts:49`.

## Acceptance

- Package gate set green; new tests cover all three steer outcomes.
- Schema-cost delta generated post-change and pasted into the PR body (expected small:
   one action variant + two fields + description/promptSnippet growth).
- No change to send_message's named-agent path (map D6 boundary).

## Out of scope

UI for steering, cross-tool policy engine, anything in tui-drive.ts (t04 receipts the
verb later).
