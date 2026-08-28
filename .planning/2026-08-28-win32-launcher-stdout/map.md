---
effort: 2026-08-28-win32-launcher-stdout
created: 2026-08-28
last: 2026-08-29 (PARKED → deploy worktree: user re-scope — "it's deploy jobs"; ownership + queue head transferred to ../video_generation__deploy via its next-goal handoff; tickets 02/03 stay open)
status: parked (owned by the deploy worktree agent as of 2026-08-29)
---

# Wayfinder map: 2026-08-28-win32-launcher-stdout

> **PARKED 2026-08-29 (user):** this effort is deploy-domain work — ownership
> transferred to the agent running the `video_generation__deploy` worktree
> (handed off via that worktree's `output/` next-goal). Tickets 02 and 03
> remain OPEN with all receipts below; the chartering worktree
> (`video_generation__subagent`) re-scoped to s2-agent-ext-subagent +
> s2-agent-ext-ultracode and will NOT execute this queue. NOTE for the
> receiving agent: ticket 01's verdict supersedes the old "wait for bun
> >1.4.0" standing trigger — no upgrade path is measurable; the shim
> workaround route (ticket 02) is the way forward.

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
| `tickets/01-measure-upstream-truth.md` | closed | Matrix measured (1.4.0 buggy; 1.3.14 install-dead; canary unacquirable); NO matching upstream issue, filing skipped (D5); #12108 notes corrected; verdict: shim workaround required |
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
- D5 (2026-08-29, user): NO upstream filing at oven-sh/bun — internal
  descriptive record only. (Searched first: no matching issue exists;
  bun#12108 is batch termination, not stdout loss. The ready-to-file
  minimal repro lives in ticket 01's close-out if this is ever revisited.)

## Frontier

Ticket 02 (launcher speaks) — ticket 01 closed 2026-08-29: the version
matrix is measured and the upgrade path is DEAD on all three fronts
(1.4.0 = latest stable AND buggy; 1.3.14 = windows workspace install
fails at bun-types@1.3.14 link ENOENT, run 33220283080; canary
1.4.0-canary.20260828.1 = no GitHub release assets, D7 acquisition
cannot fetch). 01's verdict routes 02 to the shim workaround: prove the
no-console-spawn hypothesis with a diag variant FIRST (bun.exe with an
inherited console plausibly writes via WriteConsole, bypassing stdio
handles — consistent with cmd-bun-file 0B), then rewrite the shipped
.cmd/.ps1 entries around whatever the proof shows, then flip the verify
recipe's skip-classification back to honest PASS.

## Fog of war

- ~~The real upstream bun issue~~ RESOLVED 2026-08-29 (ticket 01): none
  exists (searched); filing deliberately skipped (D5).
- ~~Whether any current bun release fixes the layer~~ RESOLVED 2026-08-29
  (ticket 01): no measurable upgrade path — verdict is shim workaround.
- The no-console-spawn workaround hypothesis (bun writes via WriteConsole
  when it has a console, bypassing handles): plausible against the
  cmd-bun-file 0B evidence but UNPROVEN — a diag variant must prove it
  before any shipped shim rewrites (ticket 02).
- Could a canary ever be measured? Only by extending deploy acquisition to
  the npm channel (canaries have no GitHub release assets) — not charted;
  revisit only if the shim route also fails.
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
