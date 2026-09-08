---
id: t04
effort: 2026-09-06-self-arc-13
status: open
phase: 2 — evaluate
estimate: M
depends: t01, t02, t03
---

# t04 — full matrix run on the deployed tree + generated comparison + recommendation

## Goal

Run every lane × every case (robustness 3×) against the DEPLOYED launcher, generate the
comparison artifacts, commit them under `results/`, and record the recommendation as a
map Decision citing the generated numbers.

## Scope

- Single sweep: `bench.ts --all --sh /Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current/s2-agent.sh
  --out output/bench13-all-<ts>` — sequential lanes, shared nonce, ≥10 s cooldowns
  (spec §6). Partial reruns via `--skip` are fine; the FINAL sweep must be one run.
- Verify receipts BEFORE trusting them (learning 1): each receipt records sh path +
  version string; spot-check a failing arm by reading its actual evidence (snaps /
  protocol lines) before scoring — never delete a failing receipt.
- Generated outputs: `comparison.json` (raw metrics, per-lane score denominators,
  capability matrix, adapter LOC from `wc -l`) + `comparison.md` (human table). Copy both
  into `.planning/2026-09-06-self-arc-13/results/` and commit (D6).
- Map updates: append the recommendation Decision (D7 rule applied mechanically —
  role rule, incumbent margin, rpc complement verdict) with the numbers inline; resolve
  remaining Fog-of-war entries (tmux settle verdict, script quirks, rpc shapes) with
  citations to the receipts; flip ticket statuses.

## Done-when

- 4 lanes × 6 cases of receipts exist (N/A-with-evidence acceptable per D8; bun-pty may
  be N/A per t02 arbitration) in ONE sweep directory.
- `results/comparison.{json,md}` committed and generated — zero hand-edited numbers.
- Map carries the recommendation Decision + updated Fog of war; `status: recommendation-made`.
- Gates green for the implementation PR (ext-subagent + devops sets; schema-cost +0).

## Out-of-scope

any production-harness migration work — a losing incumbent produces the successor goal only.
