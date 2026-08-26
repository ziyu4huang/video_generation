---
type: prototype
status: closed
blocked by: 03
resolution: closed 2026-08-27 — s2-agent.ps1 + s2-agent.cmd shipped in every tree; real-Windows friction measurement DEFERRED with blocker named (no Windows host, no CI windows runner)
---

# 04 — PowerShell launcher `s2-agent.ps1`

## Question

What does the Windows launcher look like — a `s2-agent.ps1` that mirrors the
bash launcher's contract (own-dir resolution, `bin\bun` exec on
`s2-agent.js`, PATH prepend for children, `S2-AGENT_CODING_AGENT_DIR` env,
Chrome/Edge discovery), plus whatever entry shim double-click/`cmd` users
need?

## Resolution (2026-08-27)

**Answer: `.ps1` twin + `.cmd` entry shim, shipped in EVERY tree.**

- **`s2-agent.ps1`** (`S2_AGENT_PS1` template, `deploy/run.ts` beside
  `S2_AGENT_SH`): PowerShell twin with native spellings of the same
  contract — own-dir via `$PSScriptRoot`; dashed env var set natively via
  `[Environment]::SetEnvironmentVariable("S2-AGENT_CODING_AGENT_DIR", …,
  "Process")` (the `env(1)` workaround is a bash-only problem);
  operator-facing input stays `PI_CODING_AGENT_DIR`, default
  `$HOME\.pi\agent`; `JITI_FS_CACHE` default `0`; Chrome/Edge probe walks
  `LOCALAPPDATA`/`ProgramFiles`/`ProgramFiles(x86)` (guarded — the latter is
  null on 32-bit Windows and `Join-Path $null` throws); PATH prepend uses
  `;` (Windows separator) so session-spawned children resolve the shipped
  bun; `S2_AGENT_BUN` override honored; runtime resolved as
  `bin\bun.exe` (D7's Windows artifact) with a `bin\bun` fallback for
  pre-bun.exe tree shapes; `& $_bun … @args` + `exit $LASTEXITCODE` for
  args passthrough and exit-code propagation.
- **`s2-agent.cmd`** (`S2_AGENT_CMD` template): the cmd.exe / double-click
  entry shim — `powershell.exe -NoProfile -ExecutionPolicy Bypass -File
  "%~dp0s2-agent.ps1" %*`. The Bypass flag is the execution-policy answer:
  the default Restricted policy cannot block the deploy's own launcher and
  no one-time `Set-ExecutionPolicy` is asked of the user.
- **Staged in every tree** (`deploy/run.ts`, beside the `.sh` write): a
  darwin/linux tree carrying them is inert text weight, and both directions
  of the run.ts swap escape hatch stay usable. No chmod equivalent — the
  `.ps1` is only ever exec'd via the shim's `powershell.exe -File`, never a
  POSIX exec.
- **Verified**: devops `bun run check` (tsc) clean; canonical `bun run
  test` 910 pass / 0 fail; `PI_AGENT_E2E=1 bun test tests/deploy-e2e.test.ts`
  green against a REAL full deploy — the tree ships both files and the
  contract assertions (dashed env var, bun.exe resolution + S2_AGENT_BUN
  override, PATH prepend, args passthrough, Bypass shim) all pass.
  Independent reviewer pass over the diff (see effort history).

## Deferred with blocker named (friction measurement)

Real-Windows execution-policy friction is **not yet measured** — blockers:

1. No Windows host exists in this effort's reach (mac build host only).
2. No CI windows runner precedent: every workflow in `.github/workflows/`
   runs `ubuntu-latest` only (measured 2026-08-27 by grep over runs-on).

Deferred TO ticket 06 (cross-OS verification strategy): when 06 picks a
Windows verification channel (real box or a `windows-latest` CI job), the
first thing it must measure is `.cmd` double-click + `-p` headless spawn of
the .ps1 under the DEFAULT Restricted policy — the Bypass shim is designed
for exactly that, but it is unproven until run. Also unverified on
Windows: console inheritance for the interactive TUI through
`powershell.exe -File`, and whether `verify-deploy-e2e`'s direct-spawn
pattern (`deploy-e2e-recipe.ts` spawns `./s2-agent.sh`) needs a
`.cmd`-spawn twin when it gains a win32 target.

## Notes for the resolver

- The dashed env var that forced `env(1)` in bash (`run.ts:219,282`) is
  native in PowerShell (`$env:"S2-AGENT_CODING_AGENT_DIR" = …`).
- Template lives in `deploy/run.ts:227-283` (heredoc) — the ps1 needs its
  own template + `chmod`-equivalent (none needed; execution policy is the
  real friction — measure it).
- Chrome resolution (`run.ts:263-273`) needs Windows paths (per-user
  Chrome/Edge under LOCALAPPDATA).
- `verify-deploy-e2e` spawns the launcher directly — the ps1 must be
  spawnable from pwsh with args passthrough (`-p "…"` etc.).
