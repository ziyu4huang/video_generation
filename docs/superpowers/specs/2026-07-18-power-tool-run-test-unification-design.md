# Design: Unify run-test.sh across pi-agent and pi-agent-ext-power-tool

## Problem

`bun-apps/pi-agent/run-test.sh` provides a tiered effort-level test launcher
(`quick|medium|high|readonly|full`) for pi-agent itself. None of the 19
`pi-agent-ext-*` packages have an equivalent script — each just exposes a flat
`"test": "bun test"` (or a `check && build && test:unit` variant) in
`package.json`. This design scopes the unification down to the first pair:
`pi-agent` (already done, no change) and `pi-agent-ext-power-tool` (needs a
new `run-test.sh`). Remaining `pi-agent-ext-*` packages are out of scope for
this design — each will get its own design/plan once this pair proves the
pattern.

## Scope

- **pi-agent**: no change. Already has `run-test.sh` with the target CLI shape.
- **pi-agent-ext-power-tool**: add `run-test.sh` with the same CLI shape
  (`quick|medium|high|readonly|full`, `--list`, `--effort=`, extra-flag
  forwarding, colorized `step()` output), self-contained (no shared lib —
  matches pi-agent's current style; revisit extraction once 3+ packages exist).

## Existing test layers in power-tool

power-tool already has an informal L0/L1/L2 vocabulary (see
`src/__tests__/l2-e2e.test.ts` header and `pi-agent/PRD.md`), but the code
does not actually implement a standalone L1 (deterministic subprocess, no real
model). Every test in `l2-e2e.test.ts` spawns the real `pi-agent` CLI, which
internally calls the configured LLM (LM Studio) to produce the tool response —
there is no way to exercise "real CLI, no model" today. All of `l2-e2e.test.ts`
is gated by a single `PI_RUN_L2=1` flag; unreachable services (LM Studio on
`:1234`, vault-mind on `:8000`) cause per-test `test.skip` with the reason in
the test title.

This design does not add a true L1 tier. It accepts that `high` and `full`
share the same underlying content (typecheck + unit + the `PI_RUN_L2` suite)
and differ only in skip-vs-fail behavior when required services are down.

## Tier mapping

| Tier | Command | Notes |
|---|---|---|
| `quick` | `bun test` | `PI_RUN_L2` unset — L2 tests self-skip at registration (no network probe), fast |
| `medium` (default) | `tsc --noEmit` && `bun test` | Adds a typecheck pass, mirrors pi-agent medium's "+build" step; still no L2 |
| `high` | medium + `PI_RUN_L2=1 bun test` | Runs the full suite including L2; unreachable LM Studio/vault-mind → per-test skip (existing blocker logic) |
| `readonly` | `PI_RUN_L2=1 bun test src/__tests__/l2-e2e.test.ts` | Opt-in, isolated to just the L2 file; skip allowed. Not part of the `full` rollup's default path — mirrors pi-agent's "opt-in, not in the main stack" positioning |
| `full` | quick + medium + high + readonly, with `PI_REQUIRE_L2=1` | Same content as `high`, but service-unreachable must FAIL, not skip |

## Code change required: `PI_REQUIRE_L2`

`l2-e2e.test.ts` currently only supports skip-on-unreachable. Add a second env
var:

- `PI_REQUIRE_L2=1` (only meaningful when `PI_RUN_L2=1` is also set): when a
  tool's blockers are non-empty (service unreachable), register a failing
  `test()` whose assertion message includes the blocker reasons, instead of
  `test.skip()`.
- Without `PI_REQUIRE_L2`, behavior is unchanged (skip, as today).

This is the only test-file change in scope. No other test files change.

## run-test.sh structure (power-tool)

Same shape as `bun-apps/pi-agent/run-test.sh`:

- `set -uo pipefail` (not `set -e`) — a failing tier reports via captured `rc`
  instead of aborting the script.
- `step()` helper: runs a named command, captures start/elapsed/rc, prints a
  colored ✓/✗ summary line, tails the log on failure, folds into `OVERALL`.
- Arg parsing: positional `quick|medium|high|readonly|full`, `--effort=`,
  `--list`/`-l`, everything else forwarded to `bun test`.
- Exit code 0 iff every selected step passed.

```bash
run_unit()      { bun test }                                    # quick
run_typecheck() { tsc --noEmit }                                 # medium (+ run_unit)
run_l2()        { PI_RUN_L2=1 bun test }                         # high (+ medium)
run_l2_only()   { PI_RUN_L2=1 bun test src/__tests__/l2-e2e.test.ts }  # readonly
run_l2_strict() { PI_RUN_L2=1 PI_REQUIRE_L2=1 bun test }          # full (replaces run_l2)
```

## Error handling

Identical to pi-agent's script: `set -uo pipefail`, explicit `rc=$?` capture
per step (no `|| true`, which would mask failures), failed-step log tail
surfaced via stderr, `OVERALL` accumulates across steps.

## Testing plan

Manual verification after implementation (no meta-tests for a test-runner
script):

1. `./run-test.sh quick` — passes fast, no typecheck, no LM Studio dependency.
2. `./run-test.sh medium` — typecheck runs, still no LM Studio dependency.
3. `./run-test.sh high` with LM Studio **off** — L2 tests skip with reason in
   output; overall still passes (skip ≠ fail).
4. `./run-test.sh high` with LM Studio **on** — L2 tests actually execute.
5. `./run-test.sh readonly` — only `l2-e2e.test.ts` runs.
6. `./run-test.sh full` with LM Studio **off** — overall FAILS (proves
   `PI_REQUIRE_L2` turns skip into fail).
7. `./run-test.sh --list` — output style matches pi-agent's `--list`.
