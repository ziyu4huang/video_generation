# Spec — win32 launcher stdout (真修)

Effort: 2026-08-28-win32-launcher-stdout · Anchored 2026-08-28 via grill-me-with-docs
(user decisions D1–D3 below; single-anchor devops effort).

## Problem Statement

On windows-latest, a user who invokes the deployed `s2-agent.cmd` (or
`s2-agent.ps1`) entry gets ZERO output on stdout/stderr while the process
exits 0 — the CLI appears to do nothing. The deployed tree itself is healthy
(bun-direct probes return full payloads), so a Windows user with a perfectly
good install experiences a silent, unusable launcher. The current
`crossos-deploy-verify` lane is green only because the launcher-layer failures
were re-classified as `skip` with a `bun#12108` note — and that attribution is
wrong (see Implementation Decisions).

## Solution

The user-facing win32 launcher delivers real output: `s2-agent.cmd --help`
prints help, `--ext-list` prints the extension manifest, through the same
entry a user types. The verify lane then asserts these as PASS (not skip).
If — and only if — measurement proves the layer unfixable at repo scope, the
skip-classification is formally ratified as the documented contract via an
ADR, with the workaround path documented for users.

## User Stories

1. As a Windows user, I want `s2-agent.cmd --help` to print the help text,
   so that I can discover the CLI's commands without a silent exit.
2. As a Windows user, I want the launcher to relay everything the runtime
   prints, so that piped/scripted use (`s2-agent.cmd -p "…" | findstr …`)
   works the same as on macOS/Linux.
3. As a repo maintainer, I want `crossos-deploy-verify` windows-latest to
   FAIL when the launcher loses output, so that a regression like this can
   never silently re-classify itself green.
4. As a repo maintainer, I want the upstream bun issue correctly identified
   (or filed with a minimal repro), so that future upgrades can point at
   the real fix version instead of a wrong issue number.
5. As a repo maintainer, I want the deployed local dist refreshed and
   verify-deploy-e2e green, so that `<outRoot>/current` matches main HEAD
   (it is currently 3+ merges stale).
6. As a fresh agent session, I want the measurement receipts (which bun
   versions exhibit the bug) recorded in the effort map, so that the fix
   decision is re-derivable without re-running the matrix.

## Implementation Decisions

- **D1 (grill, 2026-08-28)**: anchor = launcher 真修. The prior session's
  skip-classification green (run 33121706417) is a workaround receipt, not
  the accepted contract. Destination = launcher actually speaks, verify
  asserts PASS.
- **D2 (grill, 2026-08-28)**: 測量後升 pin — if a newer bun fixes the layer,
  bump the repo-wide bun pin (single runtime, upholds crossos-deploy D7:
  deployed runtime = running Bun.version) gated on full `local_ci` +
  `main-health`; fall back to a version split only if those gates go red
  (recorded bun-1.4 divergence traps make the blast radius real).
- **D3 (fact-checked, 2026-08-28)**: the `bun#12108` attribution in the
  workflow comment and verify-recipe note is WRONG — that upstream issue is
  "Bun terminates windows batch script", a different bug (batch termination,
  not stdout loss). The real upstream issue must be found or filed; the
  wrong notes corrected.
- Working mechanism hypothesis (to be confirmed by ticket 01 measurement,
  NOT pre-decided): `cmd-bun-file` delivering 0 bytes into a real file —
  while `cmd-echo` delivers 22B and bun-direct delivers full payloads —
  suggests bun.exe writes via the console API (WriteConsole) when it has an
  attached console, bypassing inherited stdio handles entirely; a no-console
  spawn (DETACHED / CREATE_NO_WINDOW) from the shim is the candidate
  in-repo workaround if no bun upgrade fixes it.
- Verify recipe: the ext-load / tools-probe `skip` classification flips back
  to `pass`/`fail` verdicts keyed on the launcher variants actually
  delivering bytes; the layer-diag table stays (it is the receipt).
- The `bun-version` workflow_dispatch input (added #2110) stays as the
  measurement hatch; default follows the repo pin.

## Testing Decisions

- The authoritative test is the existing `crossos-deploy-verify` lane on
  windows-latest: launcher-mediated probes must return nonzero stdout and
  the verdicts must be `pass`. No new lane; the lane that exists becomes
  honest again.
- Unit-side: the deploy-e2e recipe's layer-diag assertions (if any are
  unit-pinned) update alongside the verdict flip; keep them deterministic.
- Local gates per repo SOP: devops `local_ci` (≤5 min) change-scoped;
  `main-health` only for the repo-wide pin-bump path (D2), since that
  touches every package's runtime.
- Measurement receipts (run IDs, bun versions, diag tables) land in the
  effort map's Context / ticket close-outs — evidence, not prose.

## Out of Scope

- Reviewer-subagent comms fix (subagent family) — next effort, user-scoped
  out of this one.
- Issue #1862 find-polluter upstream port — unrelated to this destination.
- New detectors, macOS/Linux launcher changes (both platforms already
  deliver; do not touch what works).
- Budget/cost features (cc-parity-task-powertool queue remains its own
  effort; this re-scope supersedes its next-goal head but does not close
  the effort).

## Further Notes

- Cross-effort: Builds-on `2026-08-26-s2agent-crossos-deploy` (launcher
  chain, verify lane, D7 single-runtime). Its map's Frontier anticipated
  exactly this: "expect the first crossos-deploy-verify dispatch to iterate
  as small follow-up PRs".
- Measured baseline at anchor time (2026-08-28, runs 33120905596 fail /
  33121706417 green-skip, windows-latest, bun 1.4.0): bun-direct 1299B
  (--ext-list) / 10045B (--help); ps1-direct 0B; cmd-shim 0B; cmd-echo 22B;
  cmd-bun 0B; cmd-bun-file 0B in file.
