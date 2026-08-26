---
type: prototype
status: open
blocked by: 03
---

# 04 — PowerShell launcher `s2-agent.ps1`

## Question

What does the Windows launcher look like — a `s2-agent.ps1` that mirrors the
bash launcher's contract (own-dir resolution, `bin\bun` exec on
`s2-agent.js`, PATH prepend for children, `S2-AGENT_CODING_AGENT_DIR` env,
Chrome/Edge discovery), plus whatever entry shim double-click/`cmd` users
need?

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
