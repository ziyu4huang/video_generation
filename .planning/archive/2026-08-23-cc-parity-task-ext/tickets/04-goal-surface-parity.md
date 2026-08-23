---
ticket: 04-goal-surface-parity
effort: cc-parity-task-ext
type: task
status: closed
created: 2026-08-23
last: 2026-08-23
---
# 04 — /goal command-surface parity with CC

> Spec §3 D5 (revised), map Fog of war "surface-parity gap". Machinery untouched.

## Goal

The `/goal` command accepts CC's exact surface syntax while keeping s2-agent's
superset machinery (auditor/reviewer/shield/quota-retry) byte-for-byte.

## What to build

Measured gap 2026-08-23 (`src/goal/commands.ts`, CC docs `code.claude.com/docs/en/goal`):

- Already parity: `MAX_OBJECTIVE_LENGTH = 4_000` (commands.ts:48, matches CC's
  4,000-char cap exactly), `stop` alias (commands.ts:94), `status` subcommand.
- Add clear aliases: `off`, `reset`, `none`, `cancel` → `{ kind: "clear" }`
  (CC: stop/off/reset/none/cancel all clear).
- No-arg `/goal`: CC shows current/most-recent goal status; ours prints
  "Usage: /goal <goal_to_complete>" (commands.ts:189). Change no-arg → `{ kind: "show" }`
  (most-recent-goal memory: keep it simple — active goal, else "No active goal";
  CC's "most recently achieved" history display is YAGNI unless state already has it).
- Verdict naming: auditor emits approved/disapproved/impossible (auditor.ts:13);
  CC's evaluator says Not yet met / Met / Impossible. Align only the USER-FACING
  status strings (status.ts / overlay) to CC's wording if that is a display map, not
  a prompt-protocol change — auditor's three-way verdict protocol and its tests stay
  untouched. If the strings are load-bearing beyond display, skip this bullet and
  record why in the result.
- Completions: extend `GOAL_ARGUMENT_COMPLETIONS` with the new aliases.

## Acceptance

- `/goal off|reset|none|cancel|stop` all clear; `/goal` with no args shows status.
- `/goal <condition>` with >4,000 chars still rejected with the existing message.
- Auditor/reviewer protocol and their tests unchanged.
- Goal command tests extended for aliases + no-arg show.

## Gate

`( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test )`

## Result

**closed 2026-08-23** — clear aliases off/reset/none/cancel added (stop already existed) to `parseCommand`'s clear branch with trailing-args usage errors; `GOAL_ARGUMENT_COMPLETIONS` clear row documents the aliases.

Measured corrections to the ticket's premise:
- No-arg `/goal` ALREADY returned `{ kind: "show" }` (commands.ts `tokens.length === 0` branch) — no change needed; pinned by a new test.
- The 4,000-char cap lives in `validateObjective` (the lifecycle gate), not parseCommand — already CC-exact; pinned by a new boundary test (4001 rejected / 4000 accepted).
- Verdict display naming SKIPPED as the ticket allowed: approved/disapproved/impossible is the auditor's XML-marker prompt protocol (`<approved/>` markers parsed into fields, auditor.ts:107-110) — load-bearing beyond display; renaming display strings alone would fork the vocabulary without buying parity (s2-agent's auditor ≈ CC's small-model evaluator, different protocol by design, D5).

Gate: tsc clean; 41/41 commands tests; full package 869 pass / 0 fail.
