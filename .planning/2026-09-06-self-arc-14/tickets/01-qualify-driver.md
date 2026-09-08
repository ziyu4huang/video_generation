# t01 — qualify.ts sweep driver

**status: ready** · package: `s2-agent-ext-subagent` (+ allowlist row in `s2-agent-ext-devops`)

## Goal

Replace the ad-hoc 3-batch shell loop with one committed, allowlisted orchestrator:
`bun-apps/s2-agent-ext-subagent/scripts/qualify.ts`.

## Steps

1. Write `qualify.ts` with the D4 contract:
   - `--sh <launcher>` (required; default may point at repo source tree ONLY for unit-mode),
     `--scenarios a,b,c` (default: all 10), `--concurrency N` (default 3), `--out <root>`
     (default `output/qualify-<ts>/`).
   - Per scenario: spawn `bun <scripts>/tui-drive.ts --scenario <id> --sh <sh> --out <root>/<id>`
     as an INDEPENDENT process (D2); record exit code, wall ms (`Date.now()` around the
     spawn), receipt path. Never import tui-drive.ts.
   - Read each `<out>/<id>/receipt.json`; derive pass/fail from the scenario's own check
     fields + child exit code; UNKNOWN/missing receipt = red (never silently skipped).
   - Emit `<out>/summary.json` + `<out>/summary.md` (table: scenario · pass/fail · wall ms ·
     receipt path; rpc cross-check column left as `—` until t02).
   - Exit nonzero on any red; print the table to stdout.
2. Add the allowlist row `bun-apps/s2-agent-ext-subagent/scripts/qualify.ts` to
   `ALLOWED_RUNNABLE_ENTRIES` in `bun-apps/s2-agent-ext-devops/tests/scripts-dir-contract.test.ts` (D7).
3. Unit test (`tests/qualify-summary.test.ts`, NO spawns): feed FIXTURE receipts (one green,
   one red, one missing) through the summary/exit-code logic; assert table content and exit
   aggregation. Follow `bench-base-tech.test.ts`'s no-LLM/no-live-spawn precedent.

## Constraints

- tui-drive.ts: ZERO diffs. `output/` scratch: never committed.
- Boot gate semantics stay inside tui-drive receipts — qualify only aggregates (D5).

## Done when

- `bun run check && bun run typecheck && bun test` green in BOTH touched packages;
  schema-cost +0 (no tool descriptions touched); driving the SOURCE tree end-to-end
  (`--sh` at repo default) produces summary.md with all-10 rows and a sane exit code.
