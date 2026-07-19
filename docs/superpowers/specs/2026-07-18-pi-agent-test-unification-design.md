# pi-agent.sh test coverage + unified test infrastructure — design

Date: 2026-07-18

## Problem

`./pi-agent.sh` (a symlink to `bun-apps/pi-agent/run.sh`) is the launcher for the
whole pi-agent stack. Its own package (`bun-apps/pi-agent`) already has a
tiered `run-test.sh` (quick/medium/high/readonly/full) covering build, patch,
and extension-loading behavior via `bun test` — but nothing exercises the
launcher shell script itself (symlink resolution, entry-mode detection,
`--upgrade`/`--update-help` handling).

Separately, the 20 `pi-agent-ext-*` packages each have unit tests
(`bun test` via `package.json`'s `test` script) but:

- none have a local "does my extension actually load into pi-agent" contract
  test — that check only exists centrally, in `pi-agent`'s
  `extension-contract.test.ts`, which loads every manifest extension together.
- none have a `run-test.sh` — `pi-agent` is the only package with one.
- there is no repo-root entry point that runs everything uniformly.
  `manifest.json` already has a per-extension `testGate` field (used by 11 of
  ~20 entries) but it is inert — only displayed by `ext-doctor.ts`, never
  executed by anything.

## Goals

1. Add shell-level e2e coverage for `pi-agent.sh` / `run.sh` itself.
2. Give every `pi-agent-ext-*` package a local regression ("contract") test
   that verifies its extension factory loads cleanly under a mock `pi`.
3. Give every `pi-agent-ext-*` package its own `run-test.sh`, mirroring
   `pi-agent`'s tiered-launcher pattern (simplified to 2 tiers).
4. Add a repo-root `run-all-tests.sh` that runs `pi-agent`'s `run-test.sh` +
   every extension's `run-test.sh`, making `manifest.json`'s `testGate` field
   load-bearing.

Out of scope: production code changes, new shared npm packages/libraries,
CI wiring (this design only produces the scripts/tests; hooking them into CI
is a separate follow-up).

## Component 1 — Launcher e2e test (`pi-agent`, `high` tier)

New file: `bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts`.

Spawns real child processes against `run.sh` (not just `bun test` internals).
Uses a `beforeAll`/`afterAll`-managed tmp dir for all fixtures — no writes
into the repo tree.

Coverage:

- **Symlink resolution** — symlink `run.sh` into a tmp dir under a different
  name, run it with `PIAGENT_DEBUG=1`, assert the debug line reports the real
  package `SCRIPT_DIR`, not the symlink's directory.
- **Entry detection (4 branches)** — 4 tmp fixture dirs, each pre-populated
  with just the marker files for one mode:
  - `pi-agent.js` alone → deployed (bundle)
  - `pi-agent.js` + `packages/` → deployed (release)
  - `pi-agent.js` + `.deploy-portable` → deployed (portable)
  - `src/cli.ts` alone → source (dev)

  Each fixture's entry file is a stub (echoes argv + env, exits 0) — these
  tests exercise `run.sh`'s branching logic, not a real pi boot. Assert
  `PIAGENT_DEBUG=1` reports the expected `mode=` string per fixture.
- **`--update-help`** — run it, assert exit 0 and output contains the expected
  key strings (`update-pi.sh`, `--check`, `--rebuild`). Content-presence
  check, not a byte-exact snapshot, so wording tweaks don't break the test.
- **`--upgrade` / `-U` passthrough** — stub `update-pi.sh` in a fixture dir
  (records received args to a file, exits 0, no real network call). Invoke
  `run.sh --upgrade --check`, assert the stub received `--check` and that
  `run.sh` never falls through to `exec bun`.
- **Read-only deploy env exports** — in the portable/readonly fixture, assert
  `JITI_FS_CACHE` and `PI_CODING_AGENT_DIR` land in the stub's environment.

This file becomes its own `step()` inside `run-test.sh`'s `run_extensions()`
tier (`high`), since it needs real process spawns and shouldn't run at
`quick`/`medium`.

## Component 2 — Per-package contract test (regression case)

Every `pi-agent-ext-*` package gets a `contract.test.ts`, placed in whichever
test directory convention the package already uses (`__tests__/` or
`tests/`). Modeled on `pi-agent`'s own `extension-contract.test.ts`, but
scoped to just that package's own factory/factories.

Each test:

- imports the extension's factory export(s) directly (the entry path the
  manifest points at)
- builds a small mock `pi` object (registerTool/registerCommand recording
  variant of `pi-agent`'s own mock — copied per package, not shared as a
  library; each package's `bun test` root is independent, and a ~20-line mock
  object doesn't justify new shared infrastructure)
- asserts: factory call doesn't throw; ≥1 tool or command registered; every
  tool has non-empty `name`/`label`/`description`; every command has a
  `handler` function
- packages with multiple manifest entries get one assertion block per entry

This shifts left what `pi-agent`'s aggregate contract test currently only
catches centrally — a package's own `bun test` now fails immediately if a
change breaks its extension-loading contract, without needing to run
`pi-agent`'s cross-package suite.

## Component 3 — Per-package `run-test.sh`

Each of the 20 `pi-agent-ext-*` packages gets a `run-test.sh`, a simplified
2-tier version of `pi-agent`'s pattern (no build/deploy stage exists at this
layer):

```
quick — bun test (the package's existing test script as-is: plain bun test,
        biome check && bun test, npm run check && build && test:unit, etc. —
        unchanged)
full  — quick + contract.test.ts re-asserted standalone + (only for packages
        with a real sibling dependency, e.g. flux2/krea2/ltx → pi-vlm) that
        sibling's quick tier
```

For most packages `quick` and `full` are identical — expected, not a flaw;
it gives every package the same CLI surface (`./run-test.sh`,
`./run-test.sh --list`, `./run-test.sh full`) so the root runner can call
them uniformly. Same color/step/summary helper functions as `pi-agent`'s
`run-test.sh`, duplicated per package (consistent with this repo's existing
style of small duplicated bash helpers rather than a cross-package shared
file).

## Component 4 — Root-level unified runner

New file: `run-all-tests.sh` at repo root.

- Reads `bun-apps/pi-agent/run-dir/manifest.json`, extracts each extension
  entry's package name and its `testGate` if declared.
- For every `bun-apps/pi-agent-ext-*` directory (the authoritative list, not
  just what's manifest-wired — some packages aren't in the manifest but still
  need testing), resolves its run command in priority order:
  1. manifest `testGate`, if declared
  2. `./run-test.sh` (once Component 3 lands)
  3. `bun run test` (fallback for anything not yet migrated)
- Also runs `bun-apps/pi-agent/run-test.sh` as its own step (default tier
  `medium`, overridable via `--effort`).
- Same `step()` helper (colored ✓/✗, elapsed time, tail-of-log-on-failure) as
  `pi-agent`'s script; single overall exit code.
- Flags:
  - `./run-all-tests.sh` — default, each package's `quick` tier
  - `./run-all-tests.sh full` — each package's `full` tier + `pi-agent`'s
    `full` tier (the expensive/nightly path)
  - `--only=<pkg>` — scope to one package, for fast iteration
  - `--list` — print resolved commands per package without running (audits
    which packages still fall back to the bare `bun run test`)

This makes `manifest.json`'s `testGate` field load-bearing for the first
time — today it's inert, display-only metadata in `ext-doctor.ts`.

## Rollout order

1. Launcher e2e test (Component 1) — self-contained, no dependency on other
   components.
2. Per-package contract test (Component 2) — write the mock-pi + assertion
   template once, then apply it per package (20 independent, parallelizable
   tasks).
3. Per-package `run-test.sh` (Component 3) — same template-and-apply
   pattern; pairs naturally with step 2 but has no hard dependency on it.
4. Root `run-all-tests.sh` (Component 4) — depends on step 3 (needs each
   package's `run-test.sh` to exist).
5. Update `CLAUDE.md`'s Testing section to document `./run-all-tests.sh` as
   the top-level entry point, alongside the existing per-package commands
   (which stay valid/documented as-is).

Steps 2–3's 20-package repetition should be planned as one bite-sized task
per package, not one giant task — a natural fit for parallel execution once
an implementation plan exists.

## Non-goals / explicitly out of scope

- No new shared npm package/library for the mock-`pi` helper — duplicated
  per package on purpose.
- No CI wiring in this pass.
- No changes to any production (non-test) code path.
- No change to existing per-package `test` scripts' underlying behavior
  (biome/npm check steps etc. stay exactly as they are today; `run-test.sh`
  wraps them, doesn't replace them).
