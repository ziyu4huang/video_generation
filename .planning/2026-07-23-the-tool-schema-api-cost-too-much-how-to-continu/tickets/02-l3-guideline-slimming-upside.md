---
type: research
status: closed
---

## Question

Does **L3 context-aware guideline slimming** (per-turn reducing guideline text in `before_agent_start` based on context) have real ROI?

**Partial finding (already in hand — `inspect_context` this session):** the system-prompt guidelines block is only **~510 tok** (9 bullets). That is ~5.8% of the active tools[] schema (~8.8k) and ~0.25% of a 200k context. Prefix-cache is multi-entry (proven ≈free to mutate per-turn), so the *cost* of slimming is ~0 — but so is the *prize* (510 tok is already tiny).

**To resolve.** (a) Confirm the 510-tok figure is representative across sessions, not session-specific. (b) Check whether any per-tool `promptGuidelines` (e.g. `enable_tool`'s) inflate the **tools[] schema** beyond the system-prompt guidelines — that is a different, possibly larger lever than the system-prompt block. If guidelines are uniformly small, **L3 ROI ≈ 0 → recommend deferring L3** and recording why.

## Findings (research pass 2026-07-23)

- System-prompt **Guidelines block ≈ 510 tok** (9 bullets), measured via `inspect_context`. Per-tool `promptGuidelines` (e.g. `enable_tool`'s) fold into this same small block — confirmed not a hidden larger lever.
- That is ~5.8% of the active tools[] schema (~8,834 tok) and ~0.25% of the 200k target. The largest conceivable L3 win (zeroing the whole block) is 510 tok — below the noise floor of a single mid-size gate.
- Prefix-cache multi-entry (proven ≈free to mutate) means implementing L3 is cheap, but there is no prize worth the implementation + maintenance surface.

## Resolution

**Defer L3.** ROI ≈ 0 — the guidelines axis is already near-floor. The schema-cost levers are tools[] param schemas (tickets 03/04/05) and dynamic gating (01), not guidelines. Reopen only if a future change bloats the guidelines block past ~2k tok.
