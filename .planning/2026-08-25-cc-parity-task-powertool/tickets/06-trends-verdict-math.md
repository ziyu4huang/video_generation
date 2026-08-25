# Ticket 06 — Trends verdict math: partial windows + zero-baseline

Status: pending

## Why

`aggregate()` (src/history/aggregate.ts:130-139) issues `regressed`/
`improved` verdicts when `windows.length >= 2` with minEvents on the
BASELINE only — the final window can hold a single session, so one noisy
session against a full baseline yields a confident verdict. And a failure
mode NEWLY INTRODUCED by a change (the exact regression question the tool
exists to answer) has zero baseline occurrences and reads "insufficient
signal (0 baseline event(s))" even at +50pp on a large recent window
(aggregate.ts:137-139).

## Scope

1. **Recent-window floor**: a verdict additionally requires the recent
   window to carry signal — `recent.sessions >= windowSize/2` (or an
   occurrences floor mirroring minEvents when baseline > 0). Below the
   floor: `insufficient-signal` with the reason naming the recent window,
   not the baseline.
2. **Zero-baseline branch**: `baseline.occurrences === 0 && recent.occurrences
   >= floor` ⇒ a distinct `"new"` verdict (shown as new/regressed-family in
   the report) — never "insufficient signal". Keep 0-vs-0 as insufficient.
3. **Report rendering**: the agent-trends output names the new verdict and
   keeps the existing `regressed`/`improved`/`insufficient-signal` rows
   untouched otherwise; help text updated.
4. Tests: partial-final-window (1-session recent vs 10-session baseline ⇒
   insufficient), zero-baseline hot-recent ⇒ `new`, zero-vs-zero ⇒
   insufficient, and the existing verdict table re-pinned (no behavior
   change for well-fed windows).

Not in scope: time/commit segmentation (ticket 07); detector changes;
volatility threshold mechanics (unchanged).

## Done-when

- [ ] The two false-verdict classes are impossible (tests above).
- [ ] `new` verdict renders in agent-trends; existing well-fed verdicts
      byte-identical (test-pinned).
- [ ] Canonical gates green; PR merged CLEAN. (Hard edge: lands BEFORE
      ticket 07 consumes verdicts for commit comparisons.)
