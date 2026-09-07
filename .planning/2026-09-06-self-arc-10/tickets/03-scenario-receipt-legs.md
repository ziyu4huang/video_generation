# t03 — `--scenario workflow` receipt: source + deployed legs

## (a) Verified findings

- The pty drive harness exists:
  `bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts` with a `--scenario`
  table (self-arc-9 added `scenarioSwarm` — the multi-child batch-abort
  scenario; run artifacts under `output/self-arc9-swarm-{src,deployed}-20260907/`
  with `receipt.json` + `snap-NN-*.txt`).
- Discipline (self-arc-9 map, Findings): receipts LATCHED inside polling
  loops; gestures gated on CHILD evidence, not the parent's spinner (the
  parent fires long before any child exists); no reopen kicks — stay in the
  OPEN viewer; live markers only (spinner frames / `Working…` / `esc to
  interrupt`), never transcript text, as settle signals.

## (b) Implementation steps

1. Read `scenarioSwarm` in `scripts/tui-drive.ts` first (fog of war: exact
   stub-model scripting shape), then add `--scenario workflow` mirroring it:
   - Submit a REAL background workflow via the workflow tool — a 2-agent
     script where agent 1 `sleep 10`s (the real abort/pause window; mirrors
     swarm's `sleep 10` task).
   - Open `/subagents` once child evidence exists (`1/2` or `2/2 agents` in
     the row preview — the preview segment proves registration + progress,
     not just a bare row).
2. Receipt latches (all rendered truth from the OPEN viewer):
   - `wfRowVisible`: Running section contains a row with the `workflow` badge
     and a `k/2 agents` preview segment.
   - `wfStopFromViewer`: x-key on the workflow row → confirm → row's terminal
     evidence (entry gone from Running, per endInFlight) latched by polling,
     no reopen.
   - `wfPausedGlyph` (stretch, only if the scenario can sequence a pause
     gesture): paused glyph on the wf row while paused, running glyph after
     resume. If sequencing two control gestures proves fragile, drop to unit
     coverage only — note it in the map, never fake it.
3. Source leg: run against the worktree; keep every failing intermediate
   receipt as evidence (never delete a failing receipt).
4. Deployed leg: devops chain (branch → `bun run check` + `bun test` in EVERY
   touched package → PR → merge-pr-after-ci → sync → redeploy), then the SAME
   `--scenario workflow` against the deployed tree. Grep the deployed bundle
   for a new symbol (e.g. `markLiveStatus`) — property names survive
   minification — BEFORE trusting the version label (operating learning #1:
   the label is not the content; core-hash now covers workspace srcs).

## (c) Tests

- The scenario IS the integration test; unit coverage lives in t01/t02.
- Acceptance: both run dirs' `receipt.json` show every intended latch true;
   snapshots archived under `output/self-arc10-workflow-{src,deployed}-<date>/`.

## (d) Risks / descopes

- pty quirks (learnings #3–#5): paced REAL wall-clock sleeps after the dialog
   mount, `TERM=xterm-256color`, ≤64-byte awaited chunks, DA answered /
   kitty-silent — the harness already encodes these; do not regress them.
- Deployed host runs extension code frozen at process start (learning #6) —
   the deployed leg must start a FRESH session, not reuse a pre-merge host.
- Descoped if time-boxed: `wfPausedGlyph` (unit tests still cover pause).

## Execution order

1. t01 (vocabulary; riskiest compile-wide edit, everything renders it)
2. t02 (levers + labels; touches 4 packages, all gates)
3. t03 (receipt legs; proves it live)

## Definition of done

- `wf:` rows on /subagents + the dock: badged `workflow`, status tracks
  pause/resume/stop, x-key stops the run — each behavior covered by a unit
  test with file:symbol citations in the ticket.
- Every touched package green: `bun run check && bun test` (core-runtime,
  ext-subagent, ext-ultracode, ext-task).
- Schema-cost baseline UNCHANGED (`bun scripts/check-schema-cost.ts` clean —
  no tool descriptions touched).
- `--scenario workflow` receipts latched on BOTH source and deployed trees;
  deployed bundle grep-verified for the new symbol before the label was
  trusted.
- `esc-settle-detector.ts` pre-existing biome warning untouched.
- `.planning/2026-09-06-self-arc-10/` committed and pushed; PR squash-merged
  via the devops chain; map `status: done` with Findings updated.
