# Read-only deploy (the default)

> **Tech note** — recorded 2026-07-03.

Since 2026-07-03, `../pi-agent-ext-devops/scripts/deploy.ts` **freezes every deploy by default**:
`chmod -R a-w` the out-dir and write a `.deploy-readonly` marker. `--no-freeze`
opts out (the e2e harness uses it to clean up). A re-deploy auto-`chmod -R u+w`s
the frozen tree before `rmSync`.

## Why read-only is free at runtime

All per-user state routes to `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), NEVER
the deploy tree:

- **pi** `getAgentDir()` (`node_modules/.../pi-coding-agent/dist/config.js`):
  reads `PI_CODING_AGENT_DIR` (APP_NAME=pi), falls back to `~/.pi/agent`.
  Sessions: `PI_CODING_AGENT_SESSION_DIR` → `~/.pi/agent/sessions`.
- **pi-hermes-memory** `src/paths.ts:8-9`: its sqlite DB reads the SAME
  `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. (Not the deploy dir.)
- **jiti fs cache** (`node_modules/.cache/jiti`): only potentially writes for
  compiled `.ts`. Bundle/Standalone ship pre-compiled `.js` → no jiti → no cache
  write. `--snapshot` ships `.ts` source, so jiti IS in the load path; on the
  current jiti version its unset default is already no-FS-cache, so a frozen
  snapshot deploy runs even WITHOUT `JITI_FS_CACHE=0` (verified by mutation:
  removing the export, `doctor --smoke` still PASS, zero-write snapshot still
  holds). `run.sh` sets `JITI_FS_CACHE=0` anyway as DEFENSIVE insurance against a
  future jiti that flips that default to write-back.

The provider catalog is baked into the artifact and the model selection + API
keys live in `~/.pi/agent` or the env — see `docs/provider-model-config.md`.
None of those write the deploy tree, so freezing it costs nothing.

## `run.sh` env hardening

When the `.deploy-readonly` marker is present, `run.sh` exports:

```sh
export JITI_FS_CACHE="${JITI_FS_CACHE:-0}"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
```

Invoke `run.sh` from a NON-deploy cwd (so `<cwd>/.pi` isn't the frozen tree).

## Contract guard

`./run-test.sh readonly` (a tier, ~6s) — runs the contract for the two modes
with different runtime write-paths: it freezes BOTH a bundle deploy AND a
`--snapshot` deploy, and for each runs `doctor` + `--smoke` from a foreign cwd
via `run.sh`, asserting `matched > 0` AND a before/after `find` snapshot of the
frozen tree is IDENTICAL (zero writes leaked in) AND per-user state landed in
`PI_CODING_AGENT_DIR`. The snapshot loop is the one that exercises jiti loading
`.ts` under a frozen tree. Also folded into `full`. Test file:
`src/__tests__/e2e-readonly.test.ts`; the existing `e2e-extensions` deploys
`--no-freeze`.

## Cleanup gotcha

A frozen tmp deploy needs `chmod -R u+w` before `rmSync` or EPERMs (the test's
`afterAll` does this).

## Usage

```sh
bun ../pi-agent-ext-devops/scripts/deploy.ts /opt/pi-agent        # frozen by default
sudo chown -R root:wheel /opt/pi-agent     # truly read-only
cd ~/project && /opt/pi-agent/run.sh       # runs; state → ~/.pi/agent
bun ../pi-agent-ext-devops/scripts/deploy.ts /tmp/dev --no-freeze # opt out of freeze (iteration)
```

## Note on `doctor --fix`

**Removed.** `--fix` used to `bun install` into the deploy dir, which is exactly
the write a frozen deploy is built to reject — but it never actually ran (its
planner gated on deploy modes nothing produces), and its one action cannot
repair any mode that does exist. See
[README § `doctor --fix` — REMOVED](../README.md#doctor---fix--removed).

Nothing about a read-only deploy needs an opt-out any more: `doctor` is pure and
offline, and `doctor --smoke` spawns a probe that writes only to `~/.pi/agent`.
A frozen deploy that fails its checks is repaired by re-deploying it, not by
mutating it in place. Passing `--fix` prints a note and runs the checks anyway.
