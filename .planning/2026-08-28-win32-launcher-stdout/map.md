---
effort: 2026-08-28-win32-launcher-stdout
created: 2026-08-28
last: 2026-08-31 (ticket 02 CLOSED — bun-relay shipped, windows-latest green with honest PASS verdicts, run 33390691377; Frontier → ticket 03)
status: active
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
| `tickets/02-launcher-speaks.md` | closed | bun-relay shipped (`s2-agent-relay.js` + rewritten .cmd/.ps1, `S2_RELAY_FORCE` consumer-declared branching); verify skip narrowed to true-unknown; windows-latest GREEN run 33390691377 (ext-load/cwd-independence/providers-catalog honest PASS); + providers-catalog dummy-env-keys fix + classifyRun fastFailMs |
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
- D6 (2026-08-31, ticket 02 measurement): the workaround lane is BUN AS
  PARENT — powershell.exe loses its OWN Write-Output in the piped spawn
  shape (ps1-echo 0B, run 33385015007), so no ps1-shaped relay is viable;
  a bun relay spawning the core directly works, and as a shell's child
  (own stdout dead, fs alive) writes the capture to files the entry shim
  emits. Interactive console use never broke.
- D7 (2026-08-31, ticket 02 measurement): relay branching is
  CONSUMER-DECLARED (`S2_RELAY_FORCE=file|direct|unset`) — bun's isTTY is
  console-presence based and reports stdout.isTTY=true AND stdin.isTTY=true
  in the console-attached piped spawn shape (run 33388819180), so NO
  relay-side TTY heuristic can distinguish a human console from an
  invisible spawned console. The .ps1 auto-derives the flag from the
  handle-based `[Console]::IsOutputRedirected`; the .cmd documents the
  contract for piping consumers.

## Frontier

Ticket 03 (record + refresh dist) — ticket 02 closed 2026-08-31 with the
launcher chain verified green on windows-latest (run 33390691377:
ext-load / cwd-independence / providers-catalog honest PASS through the
real shipped `.cmd`). 03 records the durable contract (ADR: the consumer-
declared `S2_RELAY_FORCE` skip-contract + the residual — a piping
consumer that does NOT set the flag on a runner-shaped spawn still sees
0B, upstream bun bug, no fix as of 1.4.0), folds in the crossos
deploy-report `if-no-files-found: error` hardening, re-deploys the local
dist via `deploy-cli.ts`, and verifies with `verify-deploy-e2e` green.

## Fog of war

- ~~The real upstream bun issue~~ RESOLVED 2026-08-29 (ticket 01): none
  exists (searched); filing deliberately skipped (D5).
- ~~Whether any current bun release fixes the layer~~ RESOLVED 2026-08-29
  (ticket 01): no measurable upgrade path — verdict is shim workaround.
- ~~The no-console-spawn workaround hypothesis~~ REFUTED 2026-08-31
  (ticket 02): the ps1 no-console relay route is dead (powershell loses
  its own output); the proven route is the bun-as-parent relay (D6).
- Why bun-as-a-shell's-child writes NOTHING even to a cmd `>` file handle
  while exiting 0: mechanism still unidentified (WriteConsole-class
  theory fits but unproven); irrelevant to the shipped workaround — the
  bun-parent lane sidesteps it.
- Could a canary ever be measured? Only by extending deploy acquisition to
  the npm channel (canaries have no GitHub release assets) — not charted;
  revisit only if the shim route also fails. (Shim route SHIPPED — this
  is now dormant.)
- macOS/Linux launcher behavior is assumed unaffected (probes pass there);
  ubuntu re-verified green in the same matrix runs 2026-08-31.

## Cross-effort links

Builds-on: 2026-08-26-s2agent-crossos-deploy — the launcher chain, the
verify lane, and D7 (deployed runtime = running Bun.version) all come from
that effort; its Frontier anticipated exactly this follow-through ("expect
the first crossos-deploy-verify dispatch to iterate as small follow-up
PRs"). Supersedes (next-goal focus only, not the effort): the
cc-parity-task-powertool queue head — that effort stays open with tickets
05–13 pending; its loop resumes after this one drains (D4).
Shares-decision-with: 2026-08-29-reviewer-harvest — sibling outcome of the
same 2026-08-29 user re-scope (this effort parked to the deploy worktree;
reviewer-harvest is what the chartering worktree does instead — its D4
promised exactly that).
