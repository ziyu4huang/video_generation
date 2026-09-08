# t02 — Run the audit with real children; deterministically verify every red

Status: open · Phase 2 · Needs: t01 · Blocks: t03

## Goal

The workflow runs ONCE (bounded re-runs allowed for `timeout` verdicts only)
with 27 real zai/glm-5.3 children across all 26 ext packages; every red the
synthesizer reports is re-run by the executor with exact commands; every item
lands in a classification table. Children transcripts are evidence — the
executor's re-runs are the receipts (D3).

## Steps

1. **Pre-flight (D8)**: check `bun-apps/node_modules/@repo/*` symlink health;
   repair dangling ones (`ln -s ../../<pkg>`) BEFORE running — fake reds from
   broken symlinks are the known trap (operating learning #2).
2. Source `ZAI_API_KEY` from `~/.zshrc` (not inherited by tool shells — arc-16
   measured); export `PI_MODEL=zai/glm-5.3` (never flash); run the t01 recipe.
   Capture stdout JSON + journal + children transcripts under
   `output/self-arc17-audit-<ts>/` (scratch — NEVER committed, NEVER deleted).
3. Expect 15–30 min; record actual wall-clock, `agentCount` (must be 27),
   token spend if reported.
4. **Verify**: for EVERY entry in the synthesizer's `reds` (and every
   `suspectedFlake`), the executor re-runs that package's failing gate
   deterministically — same command, fresh shell, cwd = the package dir.
   Record exit code + the failing excerpt. A red that does not reproduce is a
   flake (note the child transcript); a reproduced red is real.
5. Classify every line of the result: **real-red / flake / pre-existing-warning
   / improvement-room**. Pre-existing knowns (esc-settle-detector warning,
   `.distill-state.json.tmp` gitignore) must appear in the table explicitly —
   their absence means the audit is blind, which is itself a finding.
6. Write the classification table + counts into this ticket's Resolution and
   the map's Context (committed); raw receipts stay in output/ (scratch).

## Acceptance

- `runWorkflow` result JSON `ok:true`, `agentCount` 27, 26/26 packages have a
  verdict (no package lost to a batch wedge).
- Every synthesizer red has an executor re-run receipt (command + exit code).
- Classification table committed (map or ticket Resolution); known dormants
  confirmed surfaced.

## Evidence

output journal + transcripts (scratch, cited by path); executor re-run logs;
committed table.
