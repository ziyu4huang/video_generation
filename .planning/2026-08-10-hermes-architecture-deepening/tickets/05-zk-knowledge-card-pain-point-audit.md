---
type: research
status: open
claimed:
blocked by: (none)
---
# 05 — zk knowledge-card pain-point audit (gates the wave)

From the 2026-08-16 simplify-&-robusten grilling round. This audit GATES the whole wave — nothing downstream (C3 split, kp21 drift, backend tests) starts until it closes.

## Question
Where does `bun-apps/pi-agent-ext-knowledge-card` actually hurt? Scan for:
- LOC hotspots (size as a smell, not a metric)
- duplicated logic across modules
- test-coverage gaps (hot paths with zero direct tests)

## Acceptance
- Findings written up here (or an appended note), severity-tagged.
- Findings become follow-up tickets on this map — or amend wave tickets 06/08 where they overlap.

## Notes
- Acceptance gate for the wave = deletion-test + invariants (e.g. "memories column list declared exactly once") — never raw LOC counts.
- Blocks ticket 06 (C3 split) by design: the split's shape may change on findings.
