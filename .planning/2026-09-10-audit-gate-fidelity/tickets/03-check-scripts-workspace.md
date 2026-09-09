---
type: task
status: open
---

# 03 — check-scripts-workspace: `check` in all 26 ext packages + contract pin

## Question

Can every `s2-agent-ext-*` package define a `check` script derived from its
existing tooling — so the 19-package silent lint gap closes and cannot
regress?

## What to build

A mechanical sweep over the 19 packages whose `package.json` lacks `check`
(measured census 2026-09-09: archify, btw, compact, flux2, hyperframes,
knowledge-card, krea2, ltx, movie-director, obsidian, power-tool,
prompt-history, research-tool, sv-analyzer, task, tool-gate, web-access,
webui, zai-mcp), plus the pin. Per D7's derivation rule: package has a biome
config → `"check": "biome check ."`; package's existing gates are tsc-only →
`"check": "tsc --noEmit"` (devops/hermes-memory precedent); no new tooling
invented. Run each new `check` script once and fix nothing silent: a package
whose check goes red on first run gets the red recorded in the PR (fix only
mechanical lint violations; a real finding becomes successor material — the
arc-17 triage rule). Then add the workspace contract test in devops tests
(beside the `scripts-dir-contract` precedent): every
`bun-apps/s2-agent-ext-*` package.json defines `check` AND `test`, derived
from the filesystem (re-running the census), not a hard-coded list. The
mapping table (package → chosen check command → first-run verdict) goes in
the PR body.

## Acceptance

- [ ] All 26 `s2-agent-ext-*` package.json files define `check` (and `test`
      where the package has tests), each derived per D7
- [ ] Every new check script has been run once; verdicts recorded in the PR
      (green, mechanical-fix, or named successor material)
- [ ] Contract test in devops pins the 26/26 census from the filesystem
- [ ] devops canonical gates green including the new contract test
- [ ] Mapping table in the PR body; no package gained new dev tooling
