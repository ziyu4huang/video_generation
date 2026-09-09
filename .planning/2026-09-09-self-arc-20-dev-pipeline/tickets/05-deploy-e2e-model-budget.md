# Ticket 05 — deploy-e2e model-call budget knob + SKIP receipts

## Goal

The s2-agent-sh deploy e2e's `model-call` probe currently SKIPs whenever the
one-shot wall exceeds a hardcoded budget (observed 2026-09-09: 45.2s wall >
35s budget under LM Studio contention with 4 large models resident — the
probe note itself says "inconclusive, not a tree regression" and mentions a
300s cap). Give the probe an explicit, configurable budget and make SKIP
verdicts carry a machine-readable receipt so deploys under contention are
recorded as environment-limited, never silently green.

## Constraints

- Work in `bun-apps/s2-agent-ext-devops/src/` (the deploy e2e lives there —
  `verify-deploy-e2e-cli.ts` + the deploy/ dir; find the probe
  implementation by grepping for "model-call" / the 35s / 300s constants).
- Backwards-compatible CLI: existing flags keep working; add `--help`
  entries. If the probe reads env vars, follow the existing env naming
  convention in that file.
- No behavior change when the budget is not set: same defaults, same SKIP
  semantics — the knob only WIDENS the budget (never below the current
  default floor unless explicitly asked).
- The overall e2e verdict stays conservative: a SKIP still yields verdict
  "skip", never "pass" — but the JSON for each skipped probe now includes
  why (budget ms, observed ms, retry advice) in a structured field.
- NO git mutations. NO `bun install`.

## Steps

1. Read `verify-deploy-e2e-cli.ts` + the probe it drives (grep "model-call",
   "35", "300" in bun-apps/s2-agent-ext-devops/src/deploy*/).
2. Add the budget flag/env (e.g. `--model-call-budget-ms` / env override)
   with validation (integer > 0; reject nonsense loudly).
3. Enrich SKIP results with structured receipt fields (budgetMs, observedMs,
   hint). Keep prose notes intact — downstream humans read them.
4. Update `--help` + the devops-workflow SKILL.md §"Plain pi sessions" CLI
   list line for verify-deploy-e2e-cli.ts (one line, mention the new flag).
5. Tests: the devops package has tests for deploy e2e pieces — add/extend a
   unit test for budget parsing/validation + SKIP receipt shape. Run
   `cd bun-apps/s2-agent-ext-devops && bun test` green (full suite; it is
   ~35s).
   Do NOT run a real deploy.

## Acceptance

- `bun bun-apps/s2-agent-ext-devops/src/verify-deploy-e2e-cli.ts --help`
  documents the knob.
- Unit tests green; suite green.
- Report: flag/env names, defaults table, files changed.
