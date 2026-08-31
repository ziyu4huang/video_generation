---
type: task
blocking: 01
status: done
---

# 02 — Make the win32 launcher deliver output; verify asserts PASS

## Question

Can the user-facing launcher chain (`s2-agent.cmd` / `s2-agent.ps1`) be made
to relay the runtime's stdout on windows-latest — and the verify lane flipped
from skip-classification back to honest PASS?

## What to build

Implement the fix path ticket 01's verdict selects: (a) if a newer bun
unblocks it — bump the repo-wide bun pin per D2 (single runtime, D7), gated
on full devops `local_ci` AND `main-health` green (bun-1.4 divergence traps
are recorded; the gates are the blast-radius guard), version-split ONLY as a
gate-red fallback with the deviation recorded; or (b) if no bun version
fixes it — a shim-side workaround (leading candidate from the measurement:
spawn bun with no inherited console, e.g. DETACHED / CREATE_NO_WINDOW from
the .cmd/.ps1 entry, forcing stdout-handle writes; prove it with a diag
variant BEFORE rewriting the shipped shims). Then flip the verify recipe's
ext-load / tools-probe probes from `skip` back to real verdicts keyed on
launcher-mediated stdout being nonempty. `crossos-deploy-verify`
windows-latest must be green with `pass` verdicts (not skip) and the
layer-diag table showing nonzero bytes for the launcher variants.

## Acceptance

- [x] Launcher-mediated probes return nonzero stdout on windows-latest —
      diag table receipt (ps1-direct / cmd-shim byte counts > 0). — ACHIEVED
      with a DEVIATION on the route: ps1-relay is measured DEAD (powershell
      loses its OWN Write-Output under the no-console spawn: ps1-echo 0B,
      run 33385015007), so the acceptance's anticipated ps1-direct counts
      can never be nonzero. The proven chain is BUN AS PARENT:
      `cmd-bun-relay-file` receipt — relay file 1288B `--ext-list` /
      10307B `--help` (runs 33386049681 / 33388819180, `bun-relay-route:
      WORKS`) — shipped as `s2-agent-relay.js`, consumer-declared
      `S2_RELAY_FORCE=file` (bun's isTTY is console-presence based and
      LIES in the piped shape: `bun-isTTY-truth stdout.isTTY=true
      stdin.isTTY=true`, run 33388819180).
- [x] Verify recipe asserts these as PASS/FAIL (skip-classification removed
      or narrowed to a true-unknown only); windows-latest run green with
      `pass` verdicts. — Skip NARROWED to the true unknown (even bun-direct
      dead = environment cannot verify); a silent launcher with a speaking
      bun-direct is now a FAIL. Receipt: run 33390691377 windows-latest
      SUCCESS — `boot:pass ext-load:pass cwd-independence:pass
      tools-probe:skip providers-catalog:pass` (tools-probe skip is the
      by-contract provider-unavailable skip, identical to ubuntu's; its
      win32 fast-fail window widened to 60s via `classifyRun fastFailMs` —
      the provider-absent exit measures 34.3s through the relay lane vs
      <1s on POSIX, run 33389820559).
- [x] If the pin was bumped: `local_ci` + `main-health` green receipts; if
      version-split fallback taken: deviation + reason recorded here. —
      N/A: route (b) shim workaround, NO bun pin change (route (a) was
      closed by ticket 01's matrix). Deviation recorded above (bun-relay
      route instead of the anticipated ps1/DIRECTED-console route).

## Resolution (2026-08-31)

Route (b), proven diag-first across 6 GH-Actions iterations (runs
33385015007 → 33390691377), each killing the previous hypothesis:

1. **ps1 no-console relay (iteration 1) REFUTED** — powershell.exe loses
   its own output in the piped spawn shape; no ps1-shaped chain can
   re-emit anything.
2. **bun-as-parent relay (iterations 2-3) PROVEN** — a `bun -e` relay
   spawns the core directly (the bun-direct lane) and, as cmd's child
   (own stdout dead, fs alive), writes the capture to files itself;
   `.cmd` `type`s them (cmd's own writes flow, cmd-type 21B).
3. **isTTY branching (iterations 4-5) REFUTED** — bun's isTTY is
   console-presence based: `stdout.isTTY=true AND stdin.isTTY=true` in
   the console-attached piped shape. Branching is consumer-declared
   instead (`S2_RELAY_FORCE=file|direct|unset`); the .ps1 auto-derives
   it from the handle-based `[Console]::IsOutputRedirected`.
4. **Green (iteration 6-8)** — run 33390691377: both matrix rows SUCCESS,
   launcher-mediated probes honest PASS.

Shipped surface: `s2-agent-relay.js` + rewritten `s2-agent.cmd` /
`s2-agent.ps1` tails in `bun-apps/s2-agent-ext-devops/src/deploy/run.ts`;
verify-recipe env `S2_RELAY_FORCE=file` on win32 launcher spawns +
true-unknown skip narrowing; `classifyRun fastFailMs`; providers-catalog
dummy env keys (first crossos exposure of that probe — env-keyed baked
providers can never list on keyless runners; blocks the green box, fixed
in the same arc). Residual: a piping consumer that does NOT set
`S2_RELAY_FORCE=file` on a runner-shaped spawn still sees 0B (upstream
bun bug, no fix as of 1.4.0; documented in the .cmd header) — ticket 03
records the contract.
