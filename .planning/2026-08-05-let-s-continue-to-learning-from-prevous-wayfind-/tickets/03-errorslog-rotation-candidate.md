---
type: grilling
status: open
blocked by: 01
---

# 03 — The errors.log-rotation candidate: adopt, shelve, or drop?

## Question

`REJECTED.md` lists a **pending candidate** (not yet rejected): *"Per-entry char budget shared between curated memory and raw error capture — auto-captured stack traces (`errorCapture`) compete with curated failures for `failureCharLimit`. Proposed replacement: an append-only `errors.log` capped by rotation, not by the curated char-budget. Status: candidate."*

The audit ([01](01-audit-the-failure-store.md)) found **0 raw `errorCapture` traces currently in the store** — #854 rate-limiting has suppressed them. So decide:

- **Adopt** the `errors.log` separation as a forward guard (raw → `errors.log`; promotion path raw→curated on recurrence)?
- **Shelve** it (revisit only if errorCapture surges again), and focus the budget purely on curated dedup/decay?
- **Drop** it entirely (mark rejected in REJECTED.md with the audit as rationale)?

This ticket also gates the **promotion-path** and **DB↔.md sync** fog patches on the map.

## Context

- `errorCapture` config: `src/config.ts` default `true`; rate-limit knobs in `src/types.ts` (`errorCaptureRateLimit`, `errorCaptureRateWindowMs`, `errorCaptureDedupCacheSize`, all per #854).
- Lock architecture (per failure memory): `proper-lockfile` on the `.md` source-of-truth sits above the repository layer — a new `errors.log` would share that lock path.

## Recommendation seed

Lean **shelve** (with a measurable trigger to re-open): the candidate solves a problem the audit shows isn't currently biting, and dedup/decay are higher-leverage. But the decision is the user's — adopting it is defensible if the goal is a clean raw/curated seam regardless of current volume.
