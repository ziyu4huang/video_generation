# t02 — deployed complex matrix, both lanes + comparison v2

Parent: `.planning/2026-09-06-self-arc-15/map.md` (D1, D3, D5, D6, D7, D8).
Gated on t01. Results committed in the SAME implementation PR (arc-13
precedent).

## Goal

The full complex matrix — bun-terminal × rpc over the four scored cases —
executed deployed-only, with generated comparison-v2 artifacts committed under
`.planning/2026-09-06-self-arc-15/results/`.

## Matrix

- Lanes: `bun-terminal`, `rpc` ONLY (bun-pty N/A by arbitration; tmux lost —
  map D1 descope).
- Launcher: `/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current/s2-agent.sh`
  (re-verify `ls` + record version string in every receipt — arc-13 D9).
- Cases: `cx-multi-turn`, `cx-swarm-abort`, `cx-long-output`, `cx-error-path`;
  unique nonce per run (`s<date><seq>`); receipts under
  `output/bench15-<tech>-<nonce>/` (scratch, NEVER committed; never delete a
  failing receipt — it is evidence).
- Per case × lane: `bun scripts/bench-base-tech.ts --suite complex --tech <lane>
  --sh <deployed>/s2-agent.sh --out <dir> --nonce <n>` (or `--all` scoped to
  complex).
- steer-midturn: if t01's discovery said the deployed TUI plausibly queues
  mid-turn typing → run the OPTIONAL paired case (unscored, map D5);
  otherwise a capability-matrix row + optional rpc-only `steer` probe receipt.

## Re-run rule (flake ≠ signal)

Any FAIL → exactly ONE re-run with a fresh nonce and DISTINCT framing (arc-13
robustness lesson: identical literal repeats make GLM-5.3 drop sentinels on
rep 3). Classification: FAIL+FAIL = signal; FAIL+PASS = flake (recorded as
such in comparison-v2, never silently dropped). Model-drop on BOTH lanes
(e.g. `CXK-` code forgotten) is model compliance, not lane fragility — the
identical stimulus per lane makes it cancel; note it in honest notes.

## Comparison v2 (generated, committed)

Extend `compare.ts` so `--suite complex --all` emits, under this effort's
`results/`:

1. `comparison-v2.json` + `comparison-v2.md` — per-case verdict matrix
   (lane × case: pass / fail / flake / n/a) with per-step ms.
2. **Dimension table**: continuity (`cx-multi-turn`) · mid-flight control
   (`cx-swarm-abort`: abort→all-terminal ms, abort visibility per lane) ·
   long-output fidelity (`cx-long-output`: linesSeen/20, bytesLatched vs
   bytesReceived ratios — map D3) · error visibility (`cx-error-path`: which
   surface shape surfaced, latency to surface).
3. **Capability row** for steer-midturn (paired-possible / rpc-only, with the
   discovery evidence pointer).
4. Base-suite reference row citing arc-13's committed
   `2026-09-06-self-arc-13/results/comparison.md` numbers (0.834 / 0.847).

Nothing hand-written: the table is the generator's output (arc-13 D6).

## Honest notes (record in results + map at close-out)

- Screen-lane step ms remain post-verified-submit residuals where submit
  blocks (arc-13 known bias — publish raw ms, don't correct).
- bytesLatched vs bytesReceived measures RENDERED EVIDENCE SIZE, not
  information content — state the interpretation once, in the table header.

## Done when

8/8 lane×case cells hold a verdict (pass/fail/flake/n/a — no driver crash, no
LaneUnavailable); re-runs classified; `results/comparison-v2.{json,md}`
generated + committed; receipts listed in the implementation PR description
(paths + one-line outcomes).
