---
effort: 2026-08-28-win32-launcher-stdout
created: 2026-08-28
last: 2026-08-28 (charted via grill-me-with-docs — user anchored launcher 真修; spec + 3 tickets seeded)
status: active
---

# Wayfinder map: 2026-08-28-win32-launcher-stdout

## Destination

The user-facing win32 launcher speaks: `s2-agent.cmd --help` and `--ext-list`
print real output on windows-latest, `crossos-deploy-verify` asserts them as
PASS (not skip), and the durable record — upgraded bun pin or ratified
skip-contract ADR, whichever measurement selects — plus a refreshed local
dist closes the deploy-hygiene tail.

## Context

- Measured 2026-08-28 (this machine, from GH Actions logs): run
  **33120905596** (fail, windows-latest, bun 1.4.0) layer diag — bun-direct
  `--ext-list` 1299B / `--help` 10045B, ps1-direct 0B, cmd-shim 0B,
  cmd-echo 22B (`diag-cmd-echo-marker`), cmd-bun 0B, **cmd-bun-file 0B in
  file** (round 3, PR #2109: bun as cmd's child writes NOTHING even with
  `>` redirection — not a pipe-inheritance problem). Run **33121706417**
  (green, main HEAD, bun 1.4.0, 2026-08-27 22:14Z): green via
  skip-classification — ext-load/tools-probe `skip` with note "bun#12108
  (runtime verified via bun-direct)". Deployed tree itself healthy: boot
  pass, 15 extensions load, file2md-ocr pass.
- **The bun#12108 attribution is wrong** (fact-checked 2026-08-28):
  upstream #12108 is "Bun terminates windows batch script" — batch
  termination, not stdout loss. The real upstream issue is unidentified;
  classic Windows console-buffer-vs-pipe mechanism class per
  nodejs/node#51018 and the PowerShell exe-output literature.
- The `bun-version` workflow_dispatch input exists (PR #2110,
  `.github/workflows/crossos-deploy-verify.yml:33`, default "1.4.0") but
  has **never been exercised with a newer bun** — the green run used 1.4.0.
- Deployed local dist is 3+ merges stale (predates #2108 /loop
  consolidation, #2113 pathology injection); measured 2026-08-28 from the
  prior session's next-goal record.
- Launcher history: #2106 (cmd invokes bun directly — powershell layer
  dropped piped stdout), #2107 (round 2: cmd isolation), #2109 (round 3:
  file-redirection variant).

## Tickets

**Execution order:** 01 → 02 → 03 (fully forced by `blocking:` edges — 01
feeds 02's fix-path verdict, 02 feeds 03's record; confirmed 2026-08-28).

| Ticket | Status | Summary |
|---|---|---|
| `tickets/01-measure-upstream-truth.md` | open | bun-version matrix via the dispatch input + real upstream issue (find/file); correct the wrong #12108 notes; fix-path verdict |
| `tickets/02-launcher-speaks.md` | open | Implement the selected fix (repo-wide pin bump per D2, or no-console-spawn shim); verify flips skip→PASS, windows-latest green |
| `tickets/03-record-and-refresh-dist.md` | open | ADR/docs record of the standing contract + local dist re-deploy with verify-deploy-e2e green |

## Decisions

- D1 (2026-08-28, grill — user): anchor = launcher 真修. The skip-classified
  green is a workaround receipt, not the contract; destination is a launcher
  that actually speaks. (Alternative anchors offered and declined: root-cause
  investigation only; shrink the entry contract; reviewer-subagent fix.)
- D2 (2026-08-28, grill — user): 測量後升 pin — if newer bun fixes the layer,
  bump the repo-wide pin (single runtime, upholds crossos-deploy D7) gated
  on full `local_ci` + `main-health`; version-split only as a gate-red
  fallback, deviation recorded.
- D3 (2026-08-28, fact-check): bun#12108 is the WRONG upstream citation;
  correcting it everywhere it appears is in scope (workflow comment +
  verify-recipe note).
- D4 (2026-08-28, scope — user): subagent-family work (reviewer-subagent
  comms fix) is deliberately OUT — the next effort after this one drains.

## Frontier

Ticket 01 (measure upstream truth) — nothing blocks it, its receipts decide
ticket 02's path (upgrade vs shim), and the dispatch hatch (#2110 input)
already exists: it is one `workflow_dispatch` + log read away from starting.

## Fog of war

- The real upstream bun issue for stdout-loss-as-console-child: unknown —
  found-or-filed is ticket 01's acceptance.
- Whether any current bun release fixes the layer: unmeasured (the input
  exists but was never run with a newer version).
- The no-console-spawn workaround hypothesis (bun writes via WriteConsole
  when it has a console, bypassing handles): plausible against the
  cmd-bun-file 0B evidence but UNPROVEN — a diag variant must prove it
  before any shipped shim rewrites (ticket 02).
- macOS/Linux launcher behavior is assumed unaffected (probes pass there);
  not re-measured by this effort.

## Cross-effort links

Builds-on: 2026-08-26-s2agent-crossos-deploy — the launcher chain, the
verify lane, and D7 (deployed runtime = running Bun.version) all come from
that effort; its Frontier anticipated exactly this follow-through ("expect
the first crossos-deploy-verify dispatch to iterate as small follow-up
PRs"). Supersedes (next-goal focus only, not the effort): the
cc-parity-task-powertool queue head — that effort stays open with tickets
05–13 pending; its loop resumes after this one drains (D4).
