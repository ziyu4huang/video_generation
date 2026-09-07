# Ticket 04 — Live receipts: tui-drive `cc-parity` scenario (chain + code-reviewer)

Status: open · Phase 2 · Package: `bun-apps/s2-agent-ext-subagent` (harness) ·
Rides the implementation PR

## Goal

1–2 live flagship flows on the REAL TUI with REAL zai/glm-5.3 children,
receipted on BOTH the source tree and the deployed tree — the LLM-proof leg the
unit suites (t01/t02) deliberately omit. Reuse the 9-scenario harness; do NOT
duplicate the existing sweep.

## Context

- `scripts/tui-drive.ts` (allowlisted): 9 scenarios; none covers chaining or
  code-reviewer. Harness already encodes the pty learnings: TERM=xterm-256color,
  primary-DA responder + kitty silence, ~64-byte chunked feed, paced REAL
  wall-clock keypresses (a freshly-mounted dialog eats the first one), settle
  judged ONLY on live markers (spinner / `Working…` / `esc to interrupt`), gate
  gestures on CHILD evidence not parent spinner (self-arc-9 finding).
- Probe/agent definitions are seedable by the driver (cc-parity-2 seeds probe
  defs, tui-drive.ts:104); fixtures from t01 are reusable for the planted-bug file.

## Work

- Add scenario `cc-parity` to tui-drive.ts: seed a fixture worktree (planted-bug
  file + read-only reviewer agent def, Edit/Write excluded), then ONE parent
  prompt driving both flows:
  1. **Chain**: spawn child #1 to read file F and output a marker phrase; when it
     returns, spawn child #2 whose task embeds child #1's exact marker; let both
     settle.
  2. **Code-reviewer**: route a read-only reviewer child over F; it returns
     findings naming the planted defect; NO file is edited.
- Receipt checks (`receipt.json`, per-scenario required list):
  `twoSpawnRowsSettled` (≥2 settled spawn rows, gated on child evidence),
  `chainTokenPropagated` (latched from the second child's task/result line —
  whichever surface carries it), `reviewerFindings` (screen shows the planted
  defect), `fileUnchanged` (driver-side sha256 pre/post — not a screen check),
  `modelIsGlm` + **`childrenNotFlash`** (every settled child row's model segment
  is glm-5.3 — map D5: never flash this arc).
- Runs: source tree, then deployed tree (`--sh` → deployed s2-agent.sh), receipts
  under `output/self-arc12-cc-parity-{src,deployed}-<date>/` (output/ is scratch —
  never commit; cite paths in map at close-out).
- **Bundle Reality Check (learning #1, guard form per map D7)**: this PR plans no
  production-code change. IF any `src/` file changed, first
  `grep -c <new-symbol> <versionDir>/s2-agent.js` on the deployed tree and only
  then trust the deployed receipt — the version label is not the content.
- 9-scenario sweep stays green (existing required-checks table must keep passing;
  add `cc-parity` to `requiredByScenario`).

## Gates

Same package gates as t01; no new runnable script (scenario added to an existing
allowlisted file → no scripts-dir-contract delta). Live runs need ZAI_API_KEY
(harness parses at runtime; without it the TUI silently falls back to lm-studio —
the `modelIsGlm` check catches that).

## Done when

Source + deployed receipts pass with all checks true; sweep green; no `output/`
paths committed; catalog (t03) row for this receipt exists.
